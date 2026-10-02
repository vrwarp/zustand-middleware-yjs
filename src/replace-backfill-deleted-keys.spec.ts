import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/**
 * Regression: under `scopedDiff` with the default `'replace'` hydration, the
 * scoped flush's backfill of doc-absent top-level keys must not write back a
 * key that a peer or the caller deliberately DELETED from the doc.
 *
 * The backfill (an unchanged state key the map lacks is written whole, so a
 * never-set default reaches the doc) cannot tell a never-written default from
 * a deleted key:
 *
 * 1. Peer: device B (scopedDiff) is created before its doc loads. The update
 * it loads contains a top-level key that device A added and later deleted;
 * Yjs leaves a key added and deleted in one transaction out of
 * `event.changes.keys`, so B's key-scoped inbound patch never drops it from
 * B's state. B's next write backfills it into the doc and it comes back on
 * A and on every peer. A single device does the same to its own delete
 * after an async reload.
 * 2. Caller transaction: `doc.transact(() => { map.delete(k); setState(...);
 * flush(); })`. The observer has not run yet, so the flush backfills `k` in
 * the same transaction and the observer then sees doc == flushed state: the
 * delete reaches neither the doc nor the store.
 *
 * Before the backfill, scoped flushes wrote only the keys that changed, so
 * the deletion stayed in the doc and propagated. Under `'replace'` the doc is
 * authoritative. Only user-visible store state and doc contents are asserted.
 */

/** Drains queued microtasks (outbound flush and inbound batch). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

describe("scopedDiff 'replace' backfill does not resurrect deleted top-level keys", () => {
  let savedRate: number;

  beforeEach(() => {
    // The DEV divergence tripwire samples with Math.random(): never sample.
    savedRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = savedRate;
  });

  interface Prefs {
    count: number;
    meta: { n: number };
    legacyFlag?: boolean;
  }

  const prefsCreator = (): Prefs => ({ count: 0, meta: { n: 1 }, legacyFlag: true });

  it("a key a peer deleted is not written back by a store that loaded the doc after creation", async () => {
    // Device A writes legacyFlag, then removes it (e.g. a migration).
    const docA = new Y.Doc();
    const storeA = createStore<Prefs>(yjs(docA, "prefs", prefsCreator, { scopedDiff: true }));
    const handleA = getYjsStoreHandle(storeA);

    storeA.setState({ count: 1, meta: { n: 2 }, legacyFlag: false });
    handleA.flush();
    await flushMicrotasks();

    storeA.setState({ count: 1, meta: storeA.getState().meta }, true);
    handleA.flush();
    await flushMicrotasks();

    expect(docA.getMap("prefs").has("legacyFlag")).toBe(false);
    expect(Object.hasOwn(storeA.getState(), "legacyFlag")).toBe(false);

    // Device B: the store is created on an empty doc, then persistence/sync
    // loads A's update (the usual app startup order).
    const docB = new Y.Doc();
    const storeB = createStore<Prefs>(yjs(docB, "prefs", prefsCreator, { scopedDiff: true }));
    const handleB = getYjsStoreHandle(storeB);

    replicate(docA, docB);
    await flushMicrotasks();

    expect(handleB.hasHydrated()).toBe(true);
    expect(storeB.getState().count).toBe(1);
    expect(storeB.getState().meta).toEqual({ n: 2 });

    // Any later write on B, synced back to A.
    storeB.setState({ count: 5 });
    handleB.flush();
    await flushMicrotasks();

    replicate(docB, docA);
    await flushMicrotasks();

    expect(storeA.getState().count).toBe(5);
    expect(docA.getMap("prefs").get("count")).toBe(5);

    // Bug: B's flush backfilled legacyFlag:true, undoing A's delete everywhere.
    expect(docB.getMap("prefs").has("legacyFlag")).toBe(false);
    expect(docA.getMap("prefs").has("legacyFlag")).toBe(false);
    expect(Object.hasOwn(storeA.getState(), "legacyFlag")).toBe(false);
  });

  it("a key a store deleted itself is not written back after an async reload", async () => {
    const doc = new Y.Doc();
    const store = createStore<Prefs>(yjs(doc, "prefs", prefsCreator, { scopedDiff: true }));
    const handle = getYjsStoreHandle(store);

    store.setState({ count: 1, meta: { n: 2 }, legacyFlag: false });
    handle.flush();
    store.setState({ count: 1, meta: store.getState().meta }, true);
    handle.flush();
    await flushMicrotasks();

    expect(doc.getMap("prefs").has("legacyFlag")).toBe(false);

    // Reload: a new store on an empty doc, then persistence loads the update.
    const reloadedDoc = new Y.Doc();
    const reloaded = createStore<Prefs>(yjs(reloadedDoc, "prefs", prefsCreator, { scopedDiff: true }));
    const reloadedHandle = getYjsStoreHandle(reloaded);

    replicate(doc, reloadedDoc);
    await flushMicrotasks();

    expect(reloadedHandle.hasHydrated()).toBe(true);

    reloaded.setState({ count: 7 });
    reloadedHandle.flush();
    await flushMicrotasks();

    expect(reloadedDoc.getMap("prefs").get("count")).toBe(7);
    // Bug: the flush backfilled legacyFlag:true over the store's own delete.
    expect(reloadedDoc.getMap("prefs").has("legacyFlag")).toBe(false);
  });

  interface MigState {
    a: number;
    b?: number;
    legacy?: string;
  }

  it("a key the caller deletes in the same transaction as an own flush reaches the store", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("store");
    const store = createStore<MigState>(
      yjs(doc, "store", (): MigState => ({ a: 0, legacy: "default" }), { scopedDiff: true }),
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ a: 1, legacy: "old" });
    handle.flush();
    await flushMicrotasks();

    expect(map.toJSON()).toEqual({ a: 1, legacy: "old" });

    // A migration adds and removes top-level keys and dual-writes through
    // the store atomically.
    doc.transact(() => {
      map.set("b", 99);
      map.delete("legacy");
      store.setState({ a: 2 });
      handle.flush();
    });
    await flushMicrotasks();

    expect(map.get("a")).toBe(2);
    expect(store.getState().a).toBe(2);
    // The scoped flush leaves the caller's own writes alone: its set...
    expect(map.get("b")).toBe(99);
    expect(store.getState().b).toBe(99);

    // ...and its delete. Bug: the in-transaction flush backfilled "legacy",
    // so the delete was lost in both the doc and the store.
    expect(map.has("legacy")).toBe(false);
    expect(Object.hasOwn(store.getState(), "legacy")).toBe(false);
  });
});
