/*
 * Path-scoped inbound patching.
 *
 * `observeDeep` names the exact path of every remote change, but the scoped
 * inbound patch used to keep only the first segment and re-read the whole
 * top-level key — O(total state) per inbound batch on a store whose hot key
 * holds one large tree. These tests pin the branch-scoped behaviour and,
 * more importantly, that it never silently drops a change: anything it
 * cannot reconcile in isolation must escalate to the key-scoped patch.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { getYjsStoreHandle } from ".";
import { computeInboundStateForPaths, minimizeInboundPaths } from "./patching";

interface Device { cfi: string; pct: number; tags: string[] }
type Tree = Record<string, Record<string, Device>>;
interface TreeState { progress: Tree; other: { untouched: boolean } }

const makeTree = (books: number): Tree => {
  const tree: Tree = {};

  for (let index = 0; index < books; index = index + 1) {
    tree[`book-${String(index)}`] = {
      "device-0": { "cfi": `cfi-${String(index)}`, "pct": index / 100, "tags": ["a", "b"] },
      "device-1": { "cfi": `cfi-${String(index)}b`, "pct": index / 100, "tags": ["c"] },
    };
  }

  return tree;
};

/** Two stores bound to two docs, wired so updates flow both ways on demand. */
const makePair = (books: number, scopedDiff: boolean) => {
  const docA = new yjs.Doc();
  const docB = new yjs.Doc();
  const make = (doc: yjs.Doc, seed: Tree) =>
    createStore<TreeState>()(
      yjsMiddleware(
        doc,
        "root",
        (): TreeState => ({ "progress": seed, "other": { "untouched": true } }),
        { "disableYText": true, scopedDiff, "syncedKeys": ["progress"] }
      )
    );

  const storeA = make(docA, makeTree(books));
  /*
   * An empty doc is not seeded at attach — the middleware seeds it on the
   * first write. Make that write explicitly (and flush it, since outbound is
   * microtask-batched) so the receiver hydrates from a populated document.
   */
  const handleA = getYjsStoreHandle(storeA);

  storeA.setState((state) => ({ "progress": { ...state.progress } }));
  handleA.flush();
  yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA));

  const storeB = make(docB, {});

  const syncAtoB = async () => {
    // Flush A's pending write BEFORE encoding, then let B's inbound
    // microtask (and the patch it schedules) run.
    handleA.flush();
    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA, yjs.encodeStateVector(docB)));
    await Promise.resolve();
    await Promise.resolve();
  };

  return { docA, docB, storeA, storeB, syncAtoB };
};

const writeA = (storeA: ReturnType<typeof makePair>["storeA"], mutate: (tree: Tree) => Tree) => {
  storeA.setState((state) => ({ "progress": mutate(state.progress) }));
};

describe("path-scoped inbound patching", () => {
  it("applies a deep remote change without rebuilding untouched siblings", async () => {
    const { storeA, storeB, syncAtoB } = makePair(30, true);

    await syncAtoB();

    const beforeSibling = storeB.getState().progress["book-9"];
    const beforeTarget = storeB.getState().progress["book-3"]["device-0"];
    const beforeSiblingDevice = storeB.getState().progress["book-3"]["device-1"];

    writeA(storeA, (tree) => ({
      ...tree,
      "book-3": { ...tree["book-3"], "device-0": { ...tree["book-3"]["device-0"], "cfi": "moved" } },
    }));
    await syncAtoB();

    const after = storeB.getState().progress;

    expect(after["book-3"]["device-0"].cfi).toBe("moved");
    // The changed branch is new; every sibling keeps its identity.
    expect(after["book-3"]["device-0"]).not.toBe(beforeTarget);
    expect(after["book-9"]).toBe(beforeSibling);
    expect(after["book-3"]["device-1"]).toBe(beforeSiblingDevice);
  });

  /*
   * The structural proof that the fix does what it claims: reconciling one
   * device branch must not serialize any other book. A `toJSON` spy on a
   * sibling Y.Map catches a regression to whole-key re-reads even if the
   * resulting state happens to be correct.
   */
  it("does not serialize sibling branches of the doc during a deep inbound patch", async () => {
    const { docB, storeA, storeB, syncAtoB } = makePair(20, true);

    await syncAtoB();

    const progressMap = docB.getMap("root").get("progress") as yjs.Map<unknown>;
    const sibling = progressMap.get("book-11") as yjs.Map<unknown>;
    const siblingSpy = jest.spyOn(sibling, "toJSON");
    const wholeTreeSpy = jest.spyOn(progressMap, "toJSON");

    writeA(storeA, (tree) => ({
      ...tree,
      "book-4": { ...tree["book-4"], "device-0": { ...tree["book-4"]["device-0"], "cfi": "scoped" } },
    }));
    await syncAtoB();

    expect(storeB.getState().progress["book-4"]["device-0"].cfi).toBe("scoped");
    expect(siblingSpy).not.toHaveBeenCalled();
    expect(wholeTreeSpy).not.toHaveBeenCalled();

    siblingSpy.mockRestore();
    wholeTreeSpy.mockRestore();
  });

  it("propagates a nested key delete", async () => {
    const { storeA, storeB, syncAtoB } = makePair(5, true);

    await syncAtoB();
    expect(storeB.getState().progress["book-2"]["device-1"]).toBeDefined();

    writeA(storeA, (tree) => {
      const book = { ...tree["book-2"] };

      delete (book as Record<string, unknown>)["device-1"];

      return { ...tree, "book-2": book };
    });
    await syncAtoB();

    expect(storeB.getState().progress["book-2"]["device-1"]).toBeUndefined();
    expect(storeB.getState().progress["book-2"]["device-0"]).toBeDefined();
  });

  it("propagates a whole top-level branch being added (shallow event escalates)", async () => {
    const { storeA, storeB, syncAtoB } = makePair(3, true);

    await syncAtoB();

    writeA(storeA, (tree) => ({
      ...tree,
      "book-new": { "device-0": { "cfi": "fresh", "pct": 0.5, "tags": ["z"] } },
    }));
    await syncAtoB();

    expect(storeB.getState().progress["book-new"]["device-0"].cfi).toBe("fresh");
  });

  it("propagates a mixed batch of deep and shallow changes", async () => {
    const { storeA, storeB, syncAtoB } = makePair(4, true);

    await syncAtoB();

    // One transaction: a deep field edit AND a new top-level book.
    writeA(storeA, (tree) => ({
      ...tree,
      "book-1": { ...tree["book-1"], "device-0": { ...tree["book-1"]["device-0"], "cfi": "deep" } },
      "book-added": { "device-0": { "cfi": "added", "pct": 0, "tags": [] } },
    }));
    await syncAtoB();

    expect(storeB.getState().progress["book-1"]["device-0"].cfi).toBe("deep");
    expect(storeB.getState().progress["book-added"]["device-0"].cfi).toBe("added");
  });

  it("propagates nested array edits", async () => {
    const { storeA, storeB, syncAtoB } = makePair(4, true);

    await syncAtoB();

    writeA(storeA, (tree) => ({
      ...tree,
      "book-2": {
        ...tree["book-2"],
        "device-0": { ...tree["book-2"]["device-0"], "tags": ["a", "b", "c", "d"] },
      },
    }));
    await syncAtoB();

    expect(storeB.getState().progress["book-2"]["device-0"].tags).toStrictEqual(["a", "b", "c", "d"]);
  });

  it("never applies a deep change under a non-synced top-level key", async () => {
    const docA = new yjs.Doc();
    const docB = new yjs.Doc();
    const rootA = docA.getMap("root");

    docA.transact(() => {
      const foreign = new yjs.Map<unknown>();
      const child = new yjs.Map<unknown>();

      child.set("secret", "no");
      foreign.set("nested", child);
      rootA.set("foreign", foreign);
    });

    const storeB = createStore<TreeState>()(
      yjsMiddleware(
        docB,
        "root",
        (): TreeState => ({ "progress": {}, "other": { "untouched": true } }),
        { "disableYText": true, "scopedDiff": true, "syncedKeys": ["progress"] }
      )
    );

    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA));
    await Promise.resolve();
    await Promise.resolve();

    // A deep edit under the foreign key must not reach the store.
    docA.transact(() => {
      ((rootA.get("foreign") as yjs.Map<unknown>).get("nested") as yjs.Map<unknown>).set("secret", "still no");
    });
    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA, yjs.encodeStateVector(docB)));
    await Promise.resolve();
    await Promise.resolve();

    expect((storeB.getState() as unknown as Record<string, unknown>).foreign).toBeUndefined();
  });

  /*
   * The property that matters: for any sequence of remote writes, the
   * path-scoped receiver must end up with exactly the state a receiver that
   * always re-reads the whole key would have.
   */
  it("converges with the key-scoped receiver on arbitrary write sequences (property)", async () => {
    const operation = fc.record({
      "book": fc.integer({ "min": 0, "max": 5 }),
      "device": fc.integer({ "min": 0, "max": 1 }),
      "kind": fc.constantFrom("cfi", "pct", "tags", "addDevice", "dropDevice", "addBook"),
      "value": fc.integer({ "min": 0, "max": 99 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { "minLength": 1, "maxLength": 14 }), async (operations) => {
        const deep = makePair(6, true);
        const flat = makePair(6, false);

        await deep.syncAtoB();
        await flat.syncAtoB();

        for (const op of operations) {
          const bookId = `book-${String(op.book)}`;
          const deviceId = `device-${String(op.device)}`;
          const mutate = (tree: Tree): Tree => {
            if (op.kind === "addBook") {
              return {
                ...tree,
                [`book-${String(op.value)}`]: {
                  "device-0": { "cfi": `c${String(op.value)}`, "pct": 0, "tags": [] },
                },
              };
            }

            const book = tree[bookId] as Record<string, Device> | undefined;

            if (book === undefined) {
              return tree;
            }
            if (op.kind === "addDevice") {
              return {
                ...tree,
                [bookId]: {
                  ...book,
                  [`device-${String(op.value)}`]: { "cfi": "new", "pct": 0, "tags": ["n"] },
                },
              };
            }
            if (op.kind === "dropDevice") {
              const copy = { ...book };

              delete copy[deviceId];

              return { ...tree, [bookId]: copy };
            }

            const device = book[deviceId] as Device | undefined;

            if (device === undefined) {
              return tree;
            }
            if (op.kind === "cfi") {
              return { ...tree, [bookId]: { ...book, [deviceId]: { ...device, "cfi": `c${String(op.value)}` } } };
            }
            if (op.kind === "pct") {
              return { ...tree, [bookId]: { ...book, [deviceId]: { ...device, "pct": op.value } } };
            }

            return {
              ...tree,
              [bookId]: {
                ...book,
                [deviceId]: { ...device, "tags": Array.from({ "length": op.value % 5 }, (u, i) => `t${String(i)}`) },
              },
            };
          };

          writeA(deep.storeA, mutate);
          writeA(flat.storeA, mutate);
          // eslint-disable-next-line no-await-in-loop -- each write must sync before the next
          await deep.syncAtoB();
          // eslint-disable-next-line no-await-in-loop -- each write must sync before the next
          await flat.syncAtoB();
        }

        expect(deep.storeB.getState().progress).toStrictEqual(flat.storeB.getState().progress);
        // And both must equal the source of truth.
        expect(deep.storeB.getState().progress).toStrictEqual(deep.storeA.getState().progress);
      }),
      { "numRuns": 40 }
    );
  });
});

describe("computeInboundStateForPaths escalation contract", () => {
  const makeDoc = () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");

    doc.transact(() => {
      const progress = new yjs.Map<unknown>();
      const book = new yjs.Map<unknown>();

      book.set("cfi", "one");
      progress.set("book-0", book);
      root.set("progress", progress);
    });

    return root;
  };

  it("escalates when the state is missing a branch the doc has", () => {
    const root = makeDoc();
    const result = computeInboundStateForPaths(
      { "progress": {} },
      root,
      [["progress", "book-0"]],
      {}
    );

    expect(result).toBeUndefined();
  });

  it("escalates when the doc is missing a branch the path names", () => {
    const root = makeDoc();
    const result = computeInboundStateForPaths(
      { "progress": { "book-9": { "cfi": "x" } } },
      root,
      [["progress", "book-9"]],
      {}
    );

    expect(result).toBeUndefined();
  });

  it("escalates on a dangerous first segment rather than patching it", () => {
    const root = makeDoc();
    const result = computeInboundStateForPaths({ "progress": {} }, root, [["__proto__", "x"]], {});

    expect(result).toBeUndefined();
  });

  it("ignores (does not escalate on) a path outside syncedKeys", () => {
    const root = makeDoc();
    const state = { "progress": { "book-0": { "cfi": "one" } } };
    const result = computeInboundStateForPaths(state, root, [["foreign", "x"]], {
      "syncedKeys": new Set(["progress"]),
    });

    expect(result).toBe(state);
  });

  it("returns the same state object when nothing actually changed", () => {
    const root = makeDoc();
    const state = { "progress": { "book-0": { "cfi": "one" } } };

    expect(computeInboundStateForPaths(state, root, [["progress", "book-0"]], {})).toBe(state);
  });
});

describe("minimizeInboundPaths", () => {
  it("drops paths covered by a shallower one", () => {
    expect(minimizeInboundPaths([["a", "b", "c"], ["a", "b"], ["a", "z"]]))
      .toStrictEqual([["a", "b"], ["a", "z"]]);
  });

  it("compares segment-wise, not by string prefix", () => {
    // 'b' must not be treated as covering 'bb'.
    expect(minimizeInboundPaths([["a", "bb"], ["a", "b"]]))
      .toStrictEqual([["a", "bb"], ["a", "b"]]);
  });

  it("keeps numeric and string segments distinct only when they differ", () => {
    expect(minimizeInboundPaths([["a", 0, "x"], ["a", 0]])).toStrictEqual([["a", 0]]);
  });
});
