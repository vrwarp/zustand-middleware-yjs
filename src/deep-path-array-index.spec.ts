/*
 * scopedDiff deep-path inbound must not trust numeric segments of Yjs event
 * paths as element indices.
 *
 * Under `scopedDiff`, every remote event at least two segments deep is
 * reconciled by reading the doc and the store at `event.path` and patching
 * only that branch. Numeric segments in that path are not reliable element
 * indices at the time the batch is processed:
 *
 * 1. Yjs <= 13.6.15 (the installed 13.5.52 included) counts Items, not
 *    elements, in `getPathTo`. Adjacent primitives inserted together merge
 *    into one multi-element item, so a container that follows them gets too
 *    small an index (`[1, 2, {n}]` reports the map at index 1).
 * 2. A local set() in the same tick as a remote edit shifts the array before
 *    the inbound batch runs, so the doc value is written onto a different
 *    store element.
 * 3. A local set() flushed before the inbound batch shifts the DOC array, so
 *    both sides are read at the wrong element, compare equal, and the remote
 *    edit is never applied.
 *
 * Each case leaves the store silently diverged from its doc (or replicates a
 * corrupted array to every peer). These tests assert the user-visible
 * contract: after quiescence, every store matches its doc, and no element is
 * lost, duplicated or misplaced.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle, type YjsOptions } from ".";

/*
 * Inbound and outbound batches are scheduled with queueMicrotask, so a
 * bounded run of awaited promises deterministically drains them.
 */
const drainMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const OPTS = { "disableYText": true, "scopedDiff": true } as const;

const docJson = (doc: Y.Doc): unknown => doc.getMap("root").toJSON();

/** Two peers on separate docs, synced only when the test says so. */
const makePeers = <S extends object>(init: () => S, options: YjsOptions = {}) => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const storeA = createStore<S>()(yjs(docA, "root", init, { ...OPTS, ...options }));
  const storeB = createStore<S>()(yjs(docB, "root", init, { ...OPTS, ...options }));
  const handleA = getYjsStoreHandle(storeA);
  const handleB = getYjsStoreHandle(storeB);
  const syncAToB = (): void => {
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
  };
  const syncBToA = (): void => {
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
  };

  return { docA, docB, handleA, handleB, storeA, storeB, syncAToB, syncBToA };
};

describe("scopedDiff deep-path inbound with array-index path segments", () => {
  /*
   * Fails only on Yjs <= 13.6.15: from 13.6.16 `getPathTo` counts elements,
   * so this passes there without a library fix. The stale-index cases below
   * fail on every Yjs version.
   */
  it("applies remote edits to objects that follow primitives in the same array", async () => {
    interface Marks { book: { marks: (number | { n: number })[] } }
    const { docB, handleA, storeA, storeB, syncAToB } =
      makePeers((): Marks => ({ "book": { "marks": [] } }));

    // One insert: 1 and 2 merge into a single two-element Yjs item.
    storeA.setState({ "book": { "marks": [1, 2, { "n": 10 }, { "n": 20 }] } });
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().book.marks).toEqual([1, 2, { "n": 10 }, { "n": 20 }]);

    // Remote edit of marks[2].n (Yjs <= 13.6.15 reports the path as marks[1]).
    storeA.setState((state) => ({
      "book": { "marks": state.book.marks.map((mark, index) => (index === 2 ? { "n": 11 } : mark)) },
    }));
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().book.marks).toEqual([1, 2, { "n": 11 }, { "n": 20 }]);
    expect(storeB.getState()).toEqual(docJson(docB));

    // Remote edit of marks[3].n must land on element 3, not element 2.
    storeA.setState((state) => ({
      "book": { "marks": state.book.marks.map((mark, index) => (index === 3 ? { "n": 21 } : mark)) },
    }));
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().book.marks).toEqual([1, 2, { "n": 11 }, { "n": 21 }]);
    expect(storeB.getState()).toEqual(docJson(docB));
  });

  it("does not lose or duplicate elements when a local prepend races a remote element edit", async () => {
    interface Items { k: { items: { v: number | string }[] } }
    const { docA, docB, handleA, handleB, storeA, storeB, syncAToB, syncBToA } =
      makePeers((): Items => ({ "k": { "items": [] } }));

    storeA.setState({ "k": { "items": [{ "v": 0 }, { "v": 1 }, { "v": 2 }, { "v": 3 }] } });
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().k.items).toEqual([{ "v": 0 }, { "v": 1 }, { "v": 2 }, { "v": 3 }]);

    // Peer A edits items[3]; B receives it, then prepends locally in the
    // same task, before its inbound batch runs.
    storeA.setState((state) => ({
      "k": { "items": state.k.items.map((item, index) => (index === 3 ? { "v": 33 } : item)) },
    }));
    handleA.flush();
    syncAToB();
    storeB.setState((state) => ({ "k": { "items": [{ "v": "NEW" }, ...state.k.items] } }));
    await drainMicrotasks();

    // Quiesce: B's write reaches A.
    handleB.flush();
    syncBToA();
    await drainMicrotasks();

    // Every replica agrees.
    expect(docJson(docA)).toEqual(docJson(docB));
    expect(storeA.getState()).toEqual(docJson(docA));
    expect(storeB.getState()).toEqual(docJson(docB));

    /*
     * At worst the racing local prepend is lost; the remote edit must be
     * kept and no unrelated element may be lost, duplicated or misplaced.
     */
    const { items } = storeB.getState().k;

    expect(items.filter((item) => item.v === "NEW").length).toBeLessThanOrEqual(1);
    expect(items.filter((item) => item.v !== "NEW")).toEqual([
      { "v": 0 },
      { "v": 1 },
      { "v": 2 },
      { "v": 33 },
    ]);
  });

  it("applies a remote element edit that arrives after an unflushed local prepend", async () => {
    interface Todos { k: { items: { id: number; done?: boolean }[] } }
    const { docA, docB, handleA, handleB, storeA, storeB, syncAToB, syncBToA } =
      makePeers((): Todos => ({ "k": { "items": [] } }));

    storeA.setState({ "k": { "items": [{ "id": 1 }, { "id": 2 }, { "id": 3 }] } });
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().k.items).toEqual([{ "id": 1 }, { "id": 2 }, { "id": 3 }]);

    // B prepends locally (flush queued), then A's edit of {id:2} arrives in
    // the same task. B's flush runs before its inbound batch.
    storeB.setState((state) => ({ "k": { "items": [{ "id": 0 }, ...state.k.items] } }));
    storeA.setState((state) => ({
      "k": { "items": state.k.items.map((item) => (item.id === 2 ? { ...item, "done": true } : item)) },
    }));
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState()).toEqual(docJson(docB));
    expect(storeB.getState().k.items.find((item) => item.id === 2)?.done).toBe(true);

    // Quiesce: B's prepend reaches A.
    handleB.flush();
    syncBToA();
    await drainMicrotasks();

    const expected = [{ "id": 0 }, { "id": 1 }, { "done": true, "id": 2 }, { "id": 3 }];

    expect(docJson(docA)).toEqual(docJson(docB));
    expect(storeA.getState().k.items).toEqual(expected);
    expect(storeB.getState().k.items).toEqual(expected);
  });

  it("applies a remote element edit after an unflushed local prepend under scope", async () => {
    interface Todos { k: { items: { id: number; done?: boolean }[] } }
    const { docB, handleA, storeA, storeB, syncAToB } =
      makePeers((): Todos => ({ "k": { "items": [] } }), { "scope": { "key": "device" } });
    const scopedJson = (doc: Y.Doc): unknown =>
      (doc.getMap("root").get("device") as Y.Map<unknown>).toJSON();

    storeA.setState({ "k": { "items": [{ "id": 1 }, { "id": 2 }, { "id": 3 }] } });
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState().k.items).toEqual([{ "id": 1 }, { "id": 2 }, { "id": 3 }]);

    // Same race as above, with the event path one segment deeper.
    storeB.setState((state) => ({ "k": { "items": [{ "id": 0 }, ...state.k.items] } }));
    storeA.setState((state) => ({
      "k": { "items": state.k.items.map((item) => (item.id === 2 ? { ...item, "done": true } : item)) },
    }));
    handleA.flush();
    syncAToB();
    await drainMicrotasks();

    expect(storeB.getState()).toEqual(scopedJson(docB));
    expect(storeB.getState().k.items.find((item) => item.id === 2)?.done).toBe(true);
  });
});
