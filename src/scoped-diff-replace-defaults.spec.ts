import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/**
 * Regression: `scopedDiff` under the DEFAULT hydration (`'replace'`) must not
 * lose the declared defaults of keys the user never touched.
 *
 * The scoped outbound flush writes only the top-level keys that changed, so a
 * key still at its declared default is never written to the doc. Every full
 * inbound patch under `'replace'` (creation-time hydration on reload, the
 * legacy full inbound patch on a peer without `scopedDiff`, the scoped
 * child-replacement patch under `scope`) treats a doc-absent key as deleted —
 * the untouched setting silently becomes `undefined`. Without `scopedDiff`
 * the first flush writes every key and the same reload keeps the default.
 *
 * The contract asserted here is user-visible store state only (not doc
 * contents): eager backfill of absent keys in the scoped flush, a full first
 * flush, or anything equivalent satisfies it. The live peer WITHOUT
 * `scopedDiff` rules out a reader-side-only fix (making `scopedDiff` readers
 * keep doc-absent defaults): that peer only keeps `theme` if the writer put
 * it in the doc. Every case also asserts writer/reader convergence — the
 * deeper failure is permanent divergence between peers.
 *
 * The writer starts on a NEW doc, so it is marked hydrated first, as its
 * provider does once the doc is synced and this store's map is empty. A
 * writer that has not hydrated may be writing into a doc that has not loaded
 * yet and must not backfill (scoped-diff-prehydration-backfill.spec.ts).
 */

interface Settings {
  theme: string;
  fontSize: number;
  setFont: (fontSize: number) => void;
}

const creator = (set: (partial: Partial<Settings>) => void): Settings => ({
  theme: "light",
  fontSize: 14,
  setFont: (fontSize) => set({ fontSize }),
});

const OPTS = { disableYText: true } as const;

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

/** Drains queued microtasks (the inbound batch is queueMicrotask-scheduled). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

/** Copies `doc` into a fresh Y.Doc — what a page reload / new device sees. */
const reloadDoc = (doc: Y.Doc): Y.Doc => {
  const copy = new Y.Doc();

  replicate(doc, copy);

  return copy;
};

const syncedSettings = (state: Settings): Pick<Settings, "theme" | "fontSize"> => ({
  theme: state.theme,
  fontSize: state.fontSize,
});

describe("scopedDiff + default 'replace' hydration keeps untouched defaults", () => {
  let savedRate: number;

  beforeEach(() => {
    // Make the DEV divergence tripwire deterministic (never sampled).
    savedRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = savedRate;
  });

  it("baseline (no scopedDiff): an untouched default survives a reload", () => {
    const doc = new Y.Doc();
    const store = createStore<Settings>(yjs(doc, "prefs", creator, OPTS));

    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    const reloaded = createStore<Settings>(
      yjs(reloadDoc(doc), "prefs", creator, OPTS),
    );

    expect(syncedSettings(reloaded.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(reloaded.getState())).toEqual(syncedSettings(store.getState()));
  });

  it("an untouched default survives a reload (store re-created on the persisted doc)", () => {
    const doc = new Y.Doc();
    const store = createStore<Settings>(
      yjs(doc, "prefs", creator, { ...OPTS, scopedDiff: true }),
    );

    getYjsStoreHandle(store).markHydrated(); // new doc, synced and empty
    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    const reloaded = createStore<Settings>(
      yjs(reloadDoc(doc), "prefs", creator, { ...OPTS, scopedDiff: true }),
    );

    // Bug: theme is undefined — the doc only ever received {fontSize: 20} and
    // 'replace' hydration deleted the doc-absent key.
    expect(syncedSettings(reloaded.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(reloaded.getState())).toEqual(syncedSettings(store.getState()));
  });

  it("an untouched default survives on a live peer without scopedDiff", async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const storeA = createStore<Settings>(
      yjs(docA, "prefs", creator, { ...OPTS, scopedDiff: true }),
    );
    const storeB = createStore<Settings>(yjs(docB, "prefs", creator, OPTS));

    getYjsStoreHandle(storeA).markHydrated(); // new doc, synced and empty
    storeA.getState().setFont(20);
    getYjsStoreHandle(storeA).flush();

    replicate(docA, docB);
    await flushMicrotasks();

    expect(getYjsStoreHandle(storeB).hasHydrated()).toBe(true);
    // Bug: the legacy full inbound patch deletes theme on peer B.
    expect(syncedSettings(storeB.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(storeB.getState())).toEqual(syncedSettings(storeA.getState()));
  });

  it("an untouched default survives when the persisted doc loads after store creation", async () => {
    // The usual app startup order: the store is created on an empty doc and
    // the persistence layer applies the stored update afterwards. Passes
    // without the fix too (the scoped inbound path re-reads only fontSize);
    // kept as a guard so a fix for the creation-time path cannot break it.
    const doc = new Y.Doc();
    const store = createStore<Settings>(
      yjs(doc, "prefs", creator, { ...OPTS, scopedDiff: true }),
    );

    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    const loadedDoc = new Y.Doc();
    const reloaded = createStore<Settings>(
      yjs(loadedDoc, "prefs", creator, { ...OPTS, scopedDiff: true }),
    );

    replicate(doc, loadedDoc);
    await flushMicrotasks();

    expect(getYjsStoreHandle(reloaded).hasHydrated()).toBe(true);
    expect(syncedSettings(reloaded.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(reloaded.getState())).toEqual(syncedSettings(store.getState()));
  });

  it("scope + scopedDiff: an untouched default survives a reload", () => {
    const opts = { ...OPTS, scopedDiff: true, scope: { key: "device-a" } };
    const doc = new Y.Doc();
    const store = createStore<Settings>(yjs(doc, "prefs", creator, opts));

    getYjsStoreHandle(store).markHydrated(); // new doc, synced and empty
    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    const reloaded = createStore<Settings>(
      yjs(reloadDoc(doc), "prefs", creator, opts),
    );

    expect(syncedSettings(reloaded.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(reloaded.getState())).toEqual(syncedSettings(store.getState()));
  });

  it("scope + scopedDiff: an untouched default survives when the persisted doc loads after store creation", async () => {
    // The usual startup order again; under scope the arriving child map
    // forces the full (child-replacement) inbound patch, so this loses theme
    // without the fix.
    const opts = { ...OPTS, scopedDiff: true, scope: { key: "device-a" } };
    const doc = new Y.Doc();
    const store = createStore<Settings>(yjs(doc, "prefs", creator, opts));

    getYjsStoreHandle(store).markHydrated(); // new doc, synced and empty
    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    const loadedDoc = new Y.Doc();
    const reloaded = createStore<Settings>(yjs(loadedDoc, "prefs", creator, opts));

    replicate(doc, loadedDoc);
    await flushMicrotasks();

    expect(getYjsStoreHandle(reloaded).hasHydrated()).toBe(true);
    expect(syncedSettings(reloaded.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(reloaded.getState())).toEqual(syncedSettings(store.getState()));
  });

  it("scope + scopedDiff: an untouched default survives on a live peer bound to the same scope", async () => {
    const opts = { ...OPTS, scopedDiff: true, scope: { key: "device-a" } };
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const storeA = createStore<Settings>(yjs(docA, "prefs", creator, opts));
    const storeB = createStore<Settings>(yjs(docB, "prefs", creator, opts));

    getYjsStoreHandle(storeA).markHydrated(); // new doc, synced and empty
    storeA.getState().setFont(20);
    getYjsStoreHandle(storeA).flush();

    // The scoped child map arrives on B as a new root entry: B takes the
    // full (child-replacement) inbound patch.
    replicate(docA, docB);
    await flushMicrotasks();

    expect(getYjsStoreHandle(storeB).hasHydrated()).toBe(true);
    expect(syncedSettings(storeB.getState())).toEqual({ theme: "light", fontSize: 20 });
    expect(syncedSettings(storeB.getState())).toEqual(syncedSettings(storeA.getState()));
  });
});
