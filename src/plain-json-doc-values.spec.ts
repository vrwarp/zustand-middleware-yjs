/*
 * Regression: a plain JSON object or array stored directly in the doc
 * (ContentAny — e.g. `map.set("cfg", { a: 1 })` written by a migration,
 * server code, or another writer — rather than a Y.Map / Y.Array) hydrates
 * into the store fine, but outbound diffs never update it. Both sides of the
 * diff are records (or arrays), so the parent emits a `pending` change and
 * recurses into the raw value as if it were a shared type, which writes
 * nothing: under a Y.Map the child changes are computed and then dropped
 * (the raw value is not a Y.Map / Y.Array / Y.Text), and under a Y.Array the
 * value has no toJSON(), so it is stringified ("[object Object]" / "1,2")
 * and the string-vs-object diff yields no changes. The doc keeps the stale
 * value forever while the store shows the new one, so peers and reloads lose
 * the local edits, and the next inbound patch reverts the store itself.
 *
 * Contract: after a local set() and flush, the doc mirrors the store,
 * whatever representation the doc used for the old value.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

interface State {
  cfg: { a: number };
  arr: number[];
}

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const writeRawJson = (map: Y.Map<unknown>): void => {
  // Plain JS values: stored as ContentAny, not as Y.Map / Y.Array.
  map.set("cfg", { "a": 1 });
  map.set("arr", [1, 2]);
};

beforeEach(() => {
  // Run the scopedDiff DEV convergence check on every flush (instead of a
  // random 2% sample) so the scoped variants fail deterministically and the
  // library's own invariant doubles as an assertion.
  __scopedDiffDevSampling.rate = 1;
});

afterEach(() => {
  __scopedDiffDevSampling.rate = 0.02; // restore the default
});

describe.each([
  ["full diff", false],
  ["scopedDiff", true],
])("plain JSON values stored in the doc (%s)", (_label, scopedDiff) => {
  it("updates a raw object/array written before store creation", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("s");

    writeRawJson(map);

    const store = createStore<State>()(
      yjs(doc, "s", () => ({ "cfg": { "a": 0 }, "arr": [] as number[] }), { scopedDiff })
    );

    await drain();

    // Hydration from the raw values works.
    expect(store.getState()).toEqual({ "cfg": { "a": 1 }, "arr": [1, 2] });

    store.setState({ "cfg": { "a": 2 }, "arr": [3] });
    getYjsStoreHandle(store).flush();

    expect(store.getState()).toEqual({ "cfg": { "a": 2 }, "arr": [3] });
    expect(map.toJSON()).toEqual({ "cfg": { "a": 2 }, "arr": [3] });
  });

  it("updates a raw object/array written after store creation", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("s");

    const store = createStore<State>()(
      yjs(doc, "s", () => ({ "cfg": { "a": 0 }, "arr": [] as number[] }), { scopedDiff })
    );

    getYjsStoreHandle(store).flush();
    await drain();

    writeRawJson(map);
    await drain();

    expect(store.getState()).toEqual({ "cfg": { "a": 1 }, "arr": [1, 2] });

    store.setState({ "cfg": { "a": 2 }, "arr": [3] });
    getYjsStoreHandle(store).flush();

    expect(map.toJSON()).toEqual({ "cfg": { "a": 2 }, "arr": [3] });
  });

  it("updates raw values nested inside a Y.Array and a Y.Map", async () => {
    interface NestedState {
      list: unknown[];
      outer: Record<string, unknown>;
    }

    const doc = new Y.Doc();
    const map = doc.getMap("s");
    const list = new Y.Array<unknown>();
    const outer = new Y.Map<unknown>();

    // Shared containers whose children are plain (ContentAny) JSON values.
    list.insert(0, [{ "a": 1 }, [1, 2]]);
    outer.set("cfg", { "a": 1 });
    map.set("list", list);
    map.set("outer", outer);

    const store = createStore<NestedState>()(
      yjs(doc, "s", () => ({ "list": [] as unknown[], "outer": {} }), { scopedDiff })
    );

    await drain();

    expect(store.getState()).toEqual({
      "list": [{ "a": 1 }, [1, 2]],
      "outer": { "cfg": { "a": 1 } },
    });

    store.setState({ "list": [{ "a": 2 }, [3]], "outer": { "cfg": { "a": 2 } } });
    getYjsStoreHandle(store).flush();

    expect(map.toJSON()).toEqual({
      "list": [{ "a": 2 }, [3]],
      "outer": { "cfg": { "a": 2 } },
    });
  });

  it("propagates the edit to a peer replicating the doc", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("s");

    writeRawJson(map);

    const store = createStore<State>()(
      yjs(doc, "s", () => ({ "cfg": { "a": 0 }, "arr": [] as number[] }), { scopedDiff })
    );

    await drain();

    store.setState({ "cfg": { "a": 2 }, "arr": [3] });
    getYjsStoreHandle(store).flush();

    const peer = new Y.Doc();

    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    expect(peer.getMap("s").toJSON()).toEqual({ "cfg": { "a": 2 }, "arr": [3] });
  });

  it("keeps the local edit when an unrelated remote write arrives", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("s");

    writeRawJson(map);

    const store = createStore<State>()(
      yjs(doc, "s", () => ({ "cfg": { "a": 0 }, "arr": [] as number[] }), { scopedDiff })
    );

    await drain();

    store.setState({ "cfg": { "a": 2 }, "arr": [3] });
    getYjsStoreHandle(store).flush();

    // Any later inbound patch re-reads the doc; a stale raw value there
    // would revert the store on the very device that made the edit.
    map.set("other", 5);
    await drain();

    expect(store.getState()).toMatchObject({ "cfg": { "a": 2 }, "arr": [3] });
  });
});
