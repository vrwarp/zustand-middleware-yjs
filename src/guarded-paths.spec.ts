/*
 * Defensive guards and rarely-taken branches.
 *
 * Mutation testing reported these as uncovered or surviving: code that only
 * runs on inputs the common tests never produce — a remote peer editing one
 * object *inside* an array, a prototype-polluting key arriving over the
 * wire, an out-of-range delete, a Y.Text/string type flip inside an array.
 * They are exactly the paths where a silent defect is most plausible,
 * because nothing else exercises them.
 */
import * as yjs from "yjs";
import { getChanges } from "./diff";
import { arrayToYArray, objectToYMap } from "./mapping";
import {
  computeInboundState,
  computeInboundStateForPaths,
  patchSharedType,
  patchSharedTypeScoped,
  patchState,
} from "./patching";

describe("inbound path traversal through arrays", () => {
  /*
   * A peer editing one object inside an array yields an event path with a
   * NUMERIC segment (…, 'items', 2). That drives the array branches of
   * readDocJsonAtPath / readStateAtPath / setStateAtPath, which no other
   * test reaches.
   */
  const makeDoc = () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      const list = arrayToYArray(
        [{ "id": 0, "label": "a" }, { "id": 1, "label": "b" }, { "id": 2, "label": "c" }],
        { "disableYText": true }
      );
      const branch = new yjs.Map<unknown>();

      branch.set("items", list);
      root.set("data", branch);
    });

    return { doc, root };
  };

  it("patches a single object inside an array at a numeric path segment", () => {
    const { doc, root } = makeDoc();
    const state = {
      "data": { "items": [{ "id": 0, "label": "a" }, { "id": 1, "label": "b" }, { "id": 2, "label": "c" }] },
    };

    doc.transact(() => {
      const list = (root.get("data") as yjs.Map<unknown>).get("items") as yjs.Array<unknown>;

      (list.get(1) as yjs.Map<unknown>).set("label", "CHANGED");
    });

    const next = computeInboundStateForPaths(state, root, [["data", "items", 1]], {});

    expect(next).toBeDefined();
    expect(next?.data.items[1]).toStrictEqual({ "id": 1, "label": "CHANGED" });
    // Siblings in the array keep identity: only the spine is rebuilt.
    expect(next?.data.items[0]).toBe(state.data.items[0]);
    expect(next?.data.items[2]).toBe(state.data.items[2]);
    expect(next?.data.items).not.toBe(state.data.items);
  });

  it("escalates when the array index is out of range in the doc", () => {
    const { root } = makeDoc();
    const state = { "data": { "items": [{ "id": 0 }, { "id": 1 }, { "id": 2 }, { "id": 9 }] } };

    expect(computeInboundStateForPaths(state, root, [["data", "items", 3]], {})).toBeUndefined();
  });

  it("escalates when the array index is out of range in the state", () => {
    const { root } = makeDoc();
    const state = { "data": { "items": [{ "id": 0 }] } };

    expect(computeInboundStateForPaths(state, root, [["data", "items", 2]], {})).toBeUndefined();
  });

  it("escalates on a negative or non-integer index", () => {
    const { root } = makeDoc();
    const state = { "data": { "items": [{ "id": 0 }, { "id": 1 }, { "id": 2 }] } };

    expect(computeInboundStateForPaths(state, root, [["data", "items", -1]], {})).toBeUndefined();
    expect(computeInboundStateForPaths(state, root, [["data", "items", 1.5]], {})).toBeUndefined();
  });

  it("escalates when the path descends through a primitive", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      root.set("data", objectToYMap({ "leaf": 5 }, { "disableYText": true }));
    });

    expect(
      computeInboundStateForPaths({ "data": { "leaf": 5 } }, root, [["data", "leaf", "deeper"]], {})
    ).toBeUndefined();
  });

  /*
   * A prototype-polluting key below the first segment: the first-segment
   * check does not see it, so the guard inside the spine rebuild is what
   * stops it. The state must come back untouched rather than polluted.
   */
  it("refuses to write a dangerous key found below the first path segment", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      const branch = new yjs.Map<unknown>();

      branch.set("__proto__", objectToYMap({ "polluted": true }, { "disableYText": true }));
      root.set("data", branch);
    });

    const state = { "data": { "__proto__": { "polluted": false } } };
    const next = computeInboundStateForPaths(state, root, [["data", "__proto__"]], {});

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(next === undefined || next.data.__proto__.polluted !== true).toBe(true);
  });
});

describe("computeInboundState key filtering", () => {
  it("never copies a dangerous key out of the synced-key whitelist", () => {
    const next = computeInboundState(
      { "keep": 1 },
      { "keep": 2, "__proto__": { "polluted": true } },
      { "syncedKeys": new Set(["keep", "__proto__"]) }
    );

    expect(next).toStrictEqual({ "keep": 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("Y.Array appliers on out-of-range and type-flipped input", () => {
  it("clamps a delete run that overruns the end of the array", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      root.set("list", arrayToYArray([1, 2, 3], { "disableYText": true }));
    });

    // Shrink 3 -> 1: the differ emits a delete run that reaches past the end
    // once earlier deletes have shortened the array.
    doc.transact(() => {
      patchSharedType(root.get("list") as yjs.Array<unknown>, [1], { "disableYText": true });
    });

    expect((root.get("list") as yjs.Array<unknown>).toJSON()).toStrictEqual([1]);
  });

  it("clamps an out-of-range delete in the state applier the same way", () => {
    // patchState mirrors the Y.Array applier; both must agree.
    expect(patchState([1, 2, 3], [1] as unknown[])).toStrictEqual([1]);
    expect(patchState([1], [] as unknown[])).toStrictEqual([]);
  });

  it("repairs a string element that must become Y.Text", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    // Stored as primitive strings (disableYText), then patched with Y.Text on.
    doc.transact(() => {
      root.set("list", arrayToYArray(["alpha", "beta"], { "disableYText": true }));
    });
    doc.transact(() => {
      patchSharedType(root.get("list") as yjs.Array<unknown>, ["alpha", "gamma"], {});
    });

    const list = root.get("list") as yjs.Array<unknown>;

    expect(list.toJSON()).toStrictEqual(["alpha", "gamma"]);
    expect(list.get(1)).toBeInstanceOf(yjs.Text);
  });

  it("repairs a Y.Text element that must become a primitive string", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      root.set("list", arrayToYArray(["alpha", "beta"], {}));
    });
    expect((root.get("list") as yjs.Array<unknown>).get(1)).toBeInstanceOf(yjs.Text);

    doc.transact(() => {
      patchSharedType(root.get("list") as yjs.Array<unknown>, ["alpha", "gamma"], { "disableYText": true });
    });

    const list = root.get("list") as yjs.Array<unknown>;

    expect(list.toJSON()).toStrictEqual(["alpha", "gamma"]);
    expect(typeof list.get(1)).toBe("string");
  });
});

describe("scoped patch skips values that are never replicated", () => {
  it("ignores function-valued children when descending a branch", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "branch": { "keep": 1, "fn": () => "before" } };

    doc.transact(() => {
      patchSharedTypeScoped(root, previous, {}, {});
    });
    doc.transact(() => {
      patchSharedTypeScoped(
        root,
        { "branch": { "keep": 2, "fn": () => "after" } },
        previous,
        {}
      );
    });

    expect(root.toJSON()).toStrictEqual({ "branch": { "keep": 2 } });
  });

  it("ignores a dangerous child key when descending a branch", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "branch": { "keep": 1 } };

    doc.transact(() => {
      patchSharedTypeScoped(root, previous, {}, {});
    });

    const hostile = { "branch": JSON.parse('{"keep":2,"__proto__":{"polluted":true}}') as Record<string, unknown> };

    doc.transact(() => {
      patchSharedTypeScoped(root, hostile, previous, {});
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((root.toJSON() as { branch: Record<string, unknown> }).branch.keep).toBe(2);
  });

  it("drops function values when building a Y.Array", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    // A detached Y.Array holds preliminary content; it only serializes once
    // it is integrated into a document.
    doc.transact(() => {
      root.set("list", arrayToYArray([1, () => "nope", 3] as unknown[], { "disableYText": true }));
    });

    expect((root.get("list") as yjs.Array<unknown>).toJSON()).toStrictEqual([1, 3]);
  });
});

describe("deep-equality prefilter type handling", () => {
  it("treats a string and a non-string as different", () => {
    // A string on either side short-circuits to "not equal" without
    // descending; both orders must behave the same.
    expect(getChanges({ "v": "text" }, { "v": 5 } as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(getChanges({ "v": 5 }, { "v": "text" } as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it("treats arrays of differing length as different without descending", () => {
    expect(getChanges({ "v": [1, 2] }, { "v": [1, 2, 3] }).length).toBeGreaterThan(0);
  });

  it("returns no changes for identical nested structures", () => {
    const shared = { "a": [1, { "b": 2 }], "c": { "d": [3] } };

    expect(getChanges(shared, JSON.parse(JSON.stringify(shared)) as Record<string, unknown>)).toStrictEqual([]);
  });

  it("distinguishes a record from an array at the same key", () => {
    expect(getChanges({ "v": { "0": 1 } }, { "v": [1] } as unknown as Record<string, unknown>).length)
      .toBeGreaterThan(0);
  });
});

describe("path-scoped patch value-shape handling", () => {
  const docWith = (build: (root: yjs.Map<unknown>) => void) => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => { build(root); });

    return root;
  };

  it("escalates a path with only one segment", () => {
    const root = docWith((r) => { r.set("data", objectToYMap({ "x": 1 }, { "disableYText": true })); });

    // A single segment is a whole top-level key: the key-scoped route owns
    // it (it is the level where suppressTopLevelDeleteKeys applies).
    expect(computeInboundStateForPaths({ "data": { "x": 1 } }, root, [["data"]], {})).toBeUndefined();
  });

  it("replaces rather than diffs when the two sides have different shapes", () => {
    const root = docWith((r) => {
      const branch = new yjs.Map<unknown>();

      branch.set("field", arrayToYArray([1, 2], { "disableYText": true }));
      r.set("data", branch);
    });
    // State holds a record where the doc holds an array.
    const next = computeInboundStateForPaths(
      { "data": { "field": { "not": "an array" } } },
      root,
      [["data", "field"]],
      {}
    );

    expect(next?.data.field).toStrictEqual([1, 2]);
  });

  it("replaces a primitive with the doc value at the same path", () => {
    const root = docWith((r) => { r.set("data", objectToYMap({ "n": 42 }, { "disableYText": true })); });
    const next = computeInboundStateForPaths({ "data": { "n": 7 } }, root, [["data", "n"]], {});

    expect(next?.data.n).toBe(42);
  });

  it("diffs two strings at the same path rather than replacing blindly", () => {
    const root = docWith((r) => { r.set("data", objectToYMap({ "s": "hello world" }, { "disableYText": true })); });
    const next = computeInboundStateForPaths({ "data": { "s": "hello there" } }, root, [["data", "s"]], {});

    expect(next?.data.s).toBe("hello world");
  });

  it("handles a null value on the state side", () => {
    const root = docWith((r) => { r.set("data", objectToYMap({ "maybe": { "v": 1 } }, { "disableYText": true })); });
    const next = computeInboundStateForPaths({ "data": { "maybe": null } }, root, [["data", "maybe"]], {});

    expect(next?.data.maybe).toStrictEqual({ "v": 1 });
  });

  it("handles a null value on the doc side", () => {
    const root = docWith((r) => { r.set("data", objectToYMap({ "maybe": null }, { "disableYText": true })); });
    const next = computeInboundStateForPaths({ "data": { "maybe": { "v": 1 } } }, root, [["data", "maybe"]], {});

    expect(next?.data.maybe).toBeNull();
  });

  it("treats an array and a record as different shapes, not as records", () => {
    const root = docWith((r) => {
      const branch = new yjs.Map<unknown>();

      branch.set("field", objectToYMap({ "0": "zero" }, { "disableYText": true }));
      r.set("data", branch);
    });
    const next = computeInboundStateForPaths({ "data": { "field": ["zero"] } }, root, [["data", "field"]], {});

    expect(Array.isArray(next?.data.field)).toBe(false);
    expect(next?.data.field).toStrictEqual({ "0": "zero" });
  });
});

describe("prototype-pollution guards reject each dangerous key by name", () => {
  it.each(["__proto__", "constructor", "prototype"])("refuses to apply the key %s", (key) => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const hostile = JSON.parse(`{"safe":1,"${key}":{"polluted":true}}`) as Record<string, unknown>;

    doc.transact(() => {
      patchSharedType(root, hostile, { "disableYText": true });
    });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(root.get(key)).toBeUndefined();
    expect(root.get("safe")).toBe(1);
  });
});

describe("scoped patch presence handling", () => {
  it("inserts a branch that is absent from the previous state", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "kept": { "v": 1 } };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    doc.transact(() => {
      patchSharedTypeScoped(root, { "kept": { "v": 1 }, "added": { "v": 2 } }, previous, {});
    });

    expect(root.toJSON()).toStrictEqual({ "kept": { "v": 1 }, "added": { "v": 2 } });
  });

  it("removes a branch that is absent from the new state", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "kept": { "v": 1 }, "doomed": { "v": 2 } };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    doc.transact(() => { patchSharedTypeScoped(root, { "kept": { "v": 1 } }, previous, {}); });

    expect(root.toJSON()).toStrictEqual({ "kept": { "v": 1 } });
  });

  it("replaces an array with a record at the same key", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "field": [1, 2] as unknown };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    doc.transact(() => { patchSharedTypeScoped(root, { "field": { "a": 1 } }, previous, {}); });

    expect(root.toJSON()).toStrictEqual({ "field": { "a": 1 } });
  });

  it("replaces a record with an array at the same key", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "field": { "a": 1 } as unknown };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    doc.transact(() => { patchSharedTypeScoped(root, { "field": [1, 2] }, previous, {}); });

    expect(root.toJSON()).toStrictEqual({ "field": [1, 2] });
  });

  it("ignores a function newly introduced at a key", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "v": 1 as unknown };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    doc.transact(() => { patchSharedTypeScoped(root, { "v": () => "nope" }, previous, {}); });

    expect(root.toJSON()).toStrictEqual({ "v": 1 });
  });

  it("repairs a Y.Map key whose string must become Y.Text", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "note": "before" };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, { "disableYText": true }); });
    expect(typeof root.get("note")).toBe("string");

    doc.transact(() => { patchSharedTypeScoped(root, { "note": "after" }, previous, {}); });

    expect(root.get("note")).toBeInstanceOf(yjs.Text);
    expect(root.toJSON()).toStrictEqual({ "note": "after" });
  });

  it("repairs a Y.Map key whose Y.Text must become a plain string", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const previous = { "note": "before" };

    doc.transact(() => { patchSharedTypeScoped(root, previous, {}, {}); });
    expect(root.get("note")).toBeInstanceOf(yjs.Text);

    doc.transact(() => {
      patchSharedTypeScoped(root, { "note": "after" }, previous, { "disableYText": true });
    });

    expect(typeof root.get("note")).toBe("string");
    expect(root.toJSON()).toStrictEqual({ "note": "after" });
  });
});
