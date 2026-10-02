import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { patchSharedType } from "./patching";

/**
 * Regression: the outbound diff emits a nested `pending` change for an array
 * element at its POST-shift index (bIndex), but the patcher looked up that
 * element's batch-start `previousState` by the same index. After an earlier
 * insert/delete in the same change list that slot holds a DIFFERENT element,
 * so the Y.Map delete guard ("key absent from previousState = concurrent
 * remote insert, keep it") tested the wrong record:
 *   - a genuine local key delete in a shifted element was skipped, leaving the
 *     doc permanently diverged from the store (default and scopedDiff modes);
 *   - with the slot out of range the guard was disabled, so a concurrent
 *     remote field insert into a shifted element was deleted.
 */

type Item = { id: string; tmp?: number; done?: boolean };

interface ListState {
  list: Item[];
}

const makeStore = (doc: Y.Doc, options?: { scopedDiff?: boolean }) =>
  createStore<ListState>()(yjs(doc, "s", () => ({ list: [] as Item[] }), options));

const docList = (doc: Y.Doc): unknown =>
  (doc.getMap("s").toJSON() as { list?: unknown }).list;

describe("array element pending patches align previousState with the element being patched", () => {
  // Keep failures deterministic: the DEV divergence tripwire samples randomly
  // after scoped flushes; the assertions below check convergence explicitly.
  const originalSamplingRate = __scopedDiffDevSampling.rate;

  beforeAll(() => {
    __scopedDiffDevSampling.rate = 0;
  });

  afterAll(() => {
    __scopedDiffDevSampling.rate = originalSamplingRate;
  });

  describe.each([
    ["legacy full diff", {}],
    ["scopedDiff", { scopedDiff: true }],
  ])("%s", (_label, options) => {
    it("deletes a key from an element that shifted left after a removal earlier in the array", () => {
      const doc = new Y.Doc();
      const store = makeStore(doc, options);
      const handle = getYjsStoreHandle(store);

      store.setState({ list: [{ id: "w" }, { id: "x" }, { id: "y", tmp: 1 }] });
      handle.flush();
      expect(docList(doc)).toEqual([{ id: "w" }, { id: "x" }, { id: "y", tmp: 1 }]);

      // One immutable update: drop the first element AND remove `tmp` from y.
      store.setState({ list: [{ id: "x" }, { id: "y" }] });
      handle.flush();

      expect(store.getState().list).toEqual([{ id: "x" }, { id: "y" }]);
      expect(docList(doc)).toEqual(store.getState().list);
    });

    it("deletes a key from an element that shifted right after an insertion earlier in the array", () => {
      const doc = new Y.Doc();
      const store = makeStore(doc, options);
      const handle = getYjsStoreHandle(store);

      store.setState({ list: [{ id: "x" }, { id: "y", tmp: 1 }, { id: "z" }] });
      handle.flush();

      // Prepend `n` AND remove `tmp` from y; batch-start list[2] = {id:'z'} lacks `tmp`.
      store.setState({ list: [{ id: "n" }, { id: "x" }, { id: "y" }, { id: "z" }] });
      handle.flush();

      expect(store.getState().list).toEqual([{ id: "n" }, { id: "x" }, { id: "y" }, { id: "z" }]);
      expect(docList(doc)).toEqual(store.getState().list);
    });

    it("deletes a key from a shifted element when the shift and the delete are separate set() calls in one tick", async () => {
      const doc = new Y.Doc();
      const store = makeStore(doc, options);
      const handle = getYjsStoreHandle(store);

      store.setState({ list: [{ id: "w" }, { id: "x" }, { id: "y", tmp: 1 }] });
      handle.flush();

      // Two set() calls batched into one microtask flush.
      store.setState((state) => ({ list: state.list.slice(1) }));
      store.setState((state) => ({
        list: state.list.map(({ tmp: _tmp, ...item }) => item),
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(store.getState().list).toEqual([{ id: "x" }, { id: "y" }]);
      expect(docList(doc)).toEqual(store.getState().list);
    });

    it("keeps a concurrent remote field insert into an element shifted by a local prepend", async () => {
      const doc = new Y.Doc();
      const store = makeStore(doc, options);
      const handle = getYjsStoreHandle(store);

      store.setState({ list: [{ id: "x" }, { id: "y" }] });
      handle.flush();

      const remote = new Y.Doc();

      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));

      // Same tick: a local prepend (flush still pending) and a remote peer
      // adding `done` to y, which the local store has not seen yet.
      store.setState((state) => ({ list: [{ id: "n" }, ...state.list] }));
      ((remote.getMap("s").get("list") as Y.Array<Y.Map<unknown>>).get(1)).set("done", true);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The local flush (which runs first) must not delete the remote insert.
      // Only the doc is asserted: the store side is the inbound path's job.
      expect(docList(doc)).toEqual([{ id: "n" }, { id: "x" }, { id: "y", done: true }]);
    });
  });

  it("scopedDiff: trimming a capped list (keep last N) while closing the newest session removes its `live` flag", () => {
    interface Session { id: string; start: number; live?: boolean }
    interface SessionsState { readingSessions: Session[] }

    const doc = new Y.Doc();
    const store = createStore<SessionsState>()(
      yjs(doc, "s", () => ({ readingSessions: [] as Session[] }), { scopedDiff: true })
    );
    const handle = getYjsStoreHandle(store);

    const sessions: Session[] = Array.from({ length: 26 }, (_unused, i) => ({
      id: `session-${i}`,
      start: i,
    }));

    sessions[25] = { ...sessions[25], live: true };
    store.setState({ readingSessions: sessions });
    handle.flush();
    expect((doc.getMap("s").toJSON() as SessionsState).readingSessions).toHaveLength(26);

    // One set(): keep the last 11 sessions and close the live one.
    store.setState((state) => {
      const kept = state.readingSessions.slice(-11);
      const { live: _live, ...closed } = kept[kept.length - 1];

      return { readingSessions: [...kept.slice(0, -1), closed] };
    });
    handle.flush();

    const docSessions = (doc.getMap("s").toJSON() as SessionsState).readingSessions;

    expect(docSessions).toEqual(store.getState().readingSessions);
    expect(docSessions[docSessions.length - 1]).not.toHaveProperty("live");
  });

  it("patchSharedType keeps a concurrent remote field insert into an element shifted by a local insertion", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<unknown>("s");

    // Batch start (the local user's view): list = [x, y].
    const previousState = { list: [{ id: "x" }, { id: "y" }] };

    patchSharedType(root, previousState);

    // A remote peer concurrently adds `done` to y; the local store has not seen it.
    const remote = new Y.Doc();

    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    ((remote.getMap("s").get("list") as Y.Array<Y.Map<unknown>>).get(1)).set("done", true);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
    expect(docList(doc)).toEqual([{ id: "x" }, { id: "y", done: true }]);

    // Local, ignorant of `done`: prepend n. Nothing about y changed locally.
    patchSharedType(root, { list: [{ id: "n" }, { id: "x" }, { id: "y" }] }, { previousState });

    expect(docList(doc)).toEqual([{ id: "n" }, { id: "x" }, { id: "y", done: true }]);
  });
});
