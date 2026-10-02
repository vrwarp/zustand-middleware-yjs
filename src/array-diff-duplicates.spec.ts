/*
 * Regression: the array diff's lookahead must not delete and re-insert
 * elements that did not change just because a duplicate value (null, 0, an
 * equal object...) sits inside the lookahead window.
 *
 * Replacing ONLY slot 0 of [A, {id:2,q:1}, null, {id:3}] with null gives
 * [null, {id:2,q:1}, null, {id:3}]. At index 0 the lookahead used to see
 * a[2] === null === b[0] and treat that as proof that A and {id:2} were
 * deleted, then re-insert {id:2,q:1} and null further on. In the Y.Array that
 * tombstones the untouched element's Y.Map and creates a fresh copy, so a
 * concurrent remote edit to that element is silently lost.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle } from ".";
import { getChanges } from "./diff";
import { patchSharedType } from "./patching";

interface Item { id: number; q?: number }
interface ListState { items: (Item | null)[] }

const before = (): (Item | null)[] => [{ "id": 1 }, { "id": 2, "q": 1 }, null, { "id": 3 }];
const slotZeroReplaced = (): (Item | null)[] => [null, { "id": 2, "q": 1 }, null, { "id": 3 }];

const makeStore = (doc: Y.Doc, seed: (Item | null)[]) =>
  createStore<ListState>()(
    yjs(doc, "store", (): ListState => ({ "items": seed }), { "disableYText": true })
  );

/*
 * Two peers share `seed`, then edit it concurrently (no sync in between) and
 * exchange updates both ways. Explicit flushes and update exchange, no timers.
 */
const syncConcurrentEdits = async <T>(
  seed: T[],
  editOnPeer1: (items: T[]) => T[],
  editOnPeer2: (items: T[]) => T[]
): Promise<{ docs: Y.Doc[]; stores: { getState: () => { items: T[] } }[] }> => {
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();
  const create = (doc: Y.Doc, items: T[]) =>
    createStore<{ items: T[] }>()(
      yjs(doc, "store", () => ({ items }), { "disableYText": true })
    );
  const store1 = create(doc1, seed);

  store1.setState((state) => ({ "items": [...state.items] }));
  getYjsStoreHandle(store1).flush();
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

  const store2 = create(doc2, []);

  expect(store2.getState().items).toEqual(seed);

  store1.setState((state) => ({ "items": editOnPeer1(state.items) }));
  getYjsStoreHandle(store1).flush();
  store2.setState((state) => ({ "items": editOnPeer2(state.items) }));
  getYjsStoreHandle(store2).flush();

  const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
  const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));

  Y.applyUpdate(doc2, update1);
  Y.applyUpdate(doc1, update2);
  await Promise.resolve();
  await Promise.resolve();

  return { "docs": [doc1, doc2], "stores": [store1, store2] };
};

const itemsOf = (doc: Y.Doc): unknown =>
  (doc.getMap("store").get("items") as Y.Array<unknown>).toJSON();

describe("array diff with duplicate values inside the lookahead window", () => {
  it("does not touch unchanged elements when only slot 0 is replaced", () => {
    const changes = getChanges(before(), slotZeroReplaced());

    // Only slot 0 changed, so a correct diff never needs more than a
    // delete + insert (or a single update) — never four operations that
    // remove and recreate {id:2} and the null after it.
    expect(changes.length).toBeLessThanOrEqual(2);
  });

  it("keeps the Y.Map of an untouched array element instead of recreating it", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("store");

    doc.transact(() => {
      patchSharedType(map, { "items": before() }, { "disableYText": true });
    });

    const items = map.get("items") as Y.Array<unknown>;
    const untouchedMiddle = items.get(1);
    const untouchedLast = items.get(3);

    doc.transact(() => {
      patchSharedType(map, { "items": slotZeroReplaced() }, { "disableYText": true });
    });

    expect(items.toJSON()).toEqual(slotZeroReplaced());
    // The elements nobody changed must be the same shared types as before.
    expect(items.get(1)).toBe(untouchedMiddle);
    expect(items.get(3)).toBe(untouchedLast);
  });

  it("preserves a concurrent remote edit to an element the local write left unchanged", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Peer 1 seeds the doc; peer 2 hydrates from it.
    const store1 = makeStore(doc1, before());
    const handle1 = getYjsStoreHandle(store1);

    store1.setState((state) => ({ "items": [...state.items] }));
    handle1.flush();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const store2 = makeStore(doc2, []);
    const handle2 = getYjsStoreHandle(store2);

    expect(store2.getState().items).toEqual(before());

    // Concurrent, unsynced edits:
    // peer 1 replaces ONLY slot 0 with null...
    store1.setState({ "items": slotZeroReplaced() });
    handle1.flush();
    // ...while peer 2 sets q:99 on {id:2} (slot 1).
    store2.setState((state) => ({
      "items": state.items.map((item, index) => (index === 1 && item ? { ...item, "q": 99 } : item)),
    }));
    handle2.flush();

    // Exchange updates both ways, then let inbound patches land.
    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));

    Y.applyUpdate(doc2, update1);
    Y.applyUpdate(doc1, update2);
    await Promise.resolve();
    await Promise.resolve();

    const expected = [null, { "id": 2, "q": 99 }, null, { "id": 3 }];

    expect((doc1.getMap("store").get("items") as Y.Array<unknown>).toJSON()).toEqual(expected);
    expect((doc2.getMap("store").get("items") as Y.Array<unknown>).toJSON()).toEqual(expected);
    expect(store1.getState().items).toEqual(expected);
    expect(store2.getState().items).toEqual(expected);
  });

  it("preserves the concurrent edit when the local write keeps element identity", async () => {
    const { docs, stores } = await syncConcurrentEdits<Item | null>(
      before(),
      // Peer 1 replaces slot 0 and keeps every other element's identity...
      (items) => items.map((item, index) => (index === 0 ? null : item)),
      // ...while peer 2 sets q:99 on {id:2}.
      (items) => items.map((item, index) => (index === 1 && item ? { ...item, "q": 99 } : item))
    );
    const expected = [null, { "id": 2, "q": 99 }, null, { "id": 3 }];

    for (const doc of docs) {
      expect(itemsOf(doc)).toEqual(expected);
    }
    for (const store of stores) {
      expect(store.getState().items).toEqual(expected);
    }
  });

  it("merges concurrent edits to neighbouring slots of a primitive array without growing it", async () => {
    // Peer 1 sets slot 0 to 3 (a value already in the array) while peer 2
    // sets slot 1 to 5. Recreating slot 1 on peer 1's side used to merge into
    // [5, 3, 2, 3]: the array grew and the stale 2 came back.
    const { docs, stores } = await syncConcurrentEdits<number>(
      [1, 2, 3],
      () => [3, 2, 3],
      () => [1, 5, 3]
    );

    for (const doc of docs) {
      expect(itemsOf(doc)).toEqual([3, 5, 3]);
    }
    for (const store of stores) {
      expect(store.getState().items).toEqual([3, 5, 3]);
    }
  });
});
