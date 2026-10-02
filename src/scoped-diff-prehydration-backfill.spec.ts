import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/**
 * Regression: under `scopedDiff` with the default `'replace'` hydration, a
 * local write flushed BEFORE the persisted / synced doc has loaded must touch
 * only the keys it changed.
 *
 * The usual app startup order creates the store on an empty Y.Doc and lets
 * the persistence provider (y-idb) or the first sync (y-cinder) apply the
 * stored update afterwards. If a set() is flushed in between (a startup
 * action, or the first action on a new device before sync), the scoped flush
 * must not also write every untouched declared default into the still-empty
 * doc: each such default becomes a Y.Map item concurrent with the real,
 * persisted value, and Yjs resolves that conflict by clientID. When the
 * local clientID is the higher one, the defaults win: persisted settings are
 * replaced by declared defaults on this device and on every peer, and a
 * state-carried `__schemaVersion: 1` (the migration dual-write) beats the
 * doc's 2, disarming the poison pill.
 *
 * The contract asserted is user-visible: after the merge, store and doc hold
 * the persisted values for every key this session did not change, plus the
 * session's own write; a v1 client goes obsolete against a v2 doc. Any fix
 * that defers the absent-key backfill until the doc has loaded (or otherwise
 * avoids writing untouched defaults into an unloaded doc) satisfies it. Two
 * guards pin what such a fix must keep: with the clientIDs reversed the
 * persisted values still survive (the session's own write may lose, as any
 * concurrent write may), and a default the loaded doc lacks still reaches
 * the doc once the store has hydrated (the 'replace' backfill itself).
 *
 * Determinism: clientIDs are pinned (the local doc gets the higher one, so a
 * concurrent default would win the Yjs tie-break), the outbound batch is
 * drained with `flush()`, the inbound batch with explicit microtask drains,
 * and the DEV tripwire sampling rate is pinned to 0.
 */

const LOCAL_CLIENT_ID = 2 ** 30;
const EARLIER_SESSION_CLIENT_ID = 1;

/** Drains queued microtasks (the inbound batch is queueMicrotask-scheduled). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

/**
 * The update a persistence provider would load: a doc an earlier session
 * (another clientID) wrote, holding `values` in the named map.
 */
const persistedUpdate = (
  name: string,
  values: Record<string, unknown>,
  clientID = EARLIER_SESSION_CLIENT_ID,
): Uint8Array => {
  const earlier = new Y.Doc();

  earlier.clientID = clientID;
  earlier.transact(() => {
    const map = earlier.getMap(name);

    for (const [key, value] of Object.entries(values)) {
      map.set(key, value);
    }
  });

  return Y.encodeStateAsUpdate(earlier);
};

interface Prefs {
  theme: string;
  fontSize: number;
  lang: string;
  setFont: (fontSize: number) => void;
}

const prefsCreator = (set: (partial: Partial<Prefs>) => void): Prefs => ({
  theme: "light",
  fontSize: 14,
  lang: "en",
  setFont: (fontSize) => set({ fontSize }),
});

const syncedPrefs = (state: Prefs): Omit<Prefs, "setFont"> => ({
  theme: state.theme,
  fontSize: state.fontSize,
  lang: state.lang,
});

interface V1State {
  __schemaVersion: number;
  count: number;
  increment: () => void;
}

const v1Creator = (set: (fn: (state: V1State) => Partial<V1State>) => void): V1State => ({
  // Migration dual-write: the version travels in state so it reaches the doc.
  __schemaVersion: 1,
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
});

describe("scopedDiff + 'replace': a write flushed before the doc loads does not clobber persisted values", () => {
  let savedRate: number;

  beforeEach(() => {
    savedRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = savedRate;
  });

  it("persisted settings survive a pre-hydration write of another key", async () => {
    const doc = new Y.Doc();

    doc.clientID = LOCAL_CLIENT_ID;

    // Store created on the still-empty doc (the provider loads asynchronously).
    const store = createStore<Prefs>(
      yjs(doc, "prefs", prefsCreator, { disableYText: true, scopedDiff: true }),
    );
    const handle = getYjsStoreHandle(store);

    // A startup action flushed before the persisted doc arrives.
    store.getState().setFont(20);
    handle.flush();
    expect(handle.hasHydrated()).toBe(false);

    // The persistence provider now applies what an earlier session stored.
    Y.applyUpdate(
      doc,
      persistedUpdate("prefs", { theme: "dark", fontSize: 14, lang: "fr" }),
      "idb",
    );
    await flushMicrotasks();

    const expected = { theme: "dark", fontSize: 20, lang: "fr" };

    // Bug: { theme: "light", fontSize: 20, lang: "en" } — the pre-hydration
    // flush also wrote the untouched defaults, and they won the merge.
    expect(doc.getMap("prefs").toJSON()).toEqual(expected);
    expect(syncedPrefs(store.getState())).toEqual(expected);
    // The loaded doc hydrates the store (with the bug, every persisted item
    // lost the merge, so no inbound event fired and it never hydrated).
    expect(handle.hasHydrated()).toBe(true);
  });

  it("a v1 client that wrote before the v2 doc loaded still goes obsolete", async () => {
    const doc = new Y.Doc();

    doc.clientID = LOCAL_CLIENT_ID;

    const onObsolete = jest.fn();
    const store = createStore<V1State>(
      yjs(doc, "shared", v1Creator, {
        scopedDiff: true,
        schemaVersion: 1,
        onObsolete,
      }),
    );
    const handle = getYjsStoreHandle(store);

    store.getState().increment();
    handle.flush();

    // The upgraded (v2) document arrives from persistence / first sync.
    Y.applyUpdate(
      doc,
      persistedUpdate("shared", { __schemaVersion: 2, count: 41 }),
      "idb",
    );
    await flushMicrotasks();

    // Bug: the pre-hydration flush backfilled __schemaVersion: 1, which beat
    // the persisted 2 — the merged doc reads version 1 and the pill never fires.
    expect(doc.getMap("shared").get("__schemaVersion")).toBe(2);
    expect(handle.isObsolete()).toBe(true);
    expect(onObsolete).toHaveBeenCalledTimes(1);
    expect(onObsolete).toHaveBeenCalledWith(2);
  });

  it("guard: with the clientIDs reversed the persisted settings survive too", async () => {
    // Now the local doc has the lower clientID, the earlier session the higher.
    const doc = new Y.Doc();

    doc.clientID = EARLIER_SESSION_CLIENT_ID;

    const store = createStore<Prefs>(
      yjs(doc, "prefs", prefsCreator, { disableYText: true, scopedDiff: true }),
    );

    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    Y.applyUpdate(
      doc,
      persistedUpdate("prefs", { theme: "dark", fontSize: 14, lang: "fr" }, LOCAL_CLIENT_ID),
      "idb",
    );
    await flushMicrotasks();

    // fontSize is a genuine concurrent write: either value may win.
    expect(doc.getMap("prefs").get("theme")).toBe("dark");
    expect(doc.getMap("prefs").get("lang")).toBe("fr");
    expect(syncedPrefs(store.getState())).toEqual(doc.getMap("prefs").toJSON());
  });

  it("guard: a default the loaded doc lacks is backfilled once the store hydrates", async () => {
    const doc = new Y.Doc();

    doc.clientID = LOCAL_CLIENT_ID;

    const store = createStore<Prefs>(
      yjs(doc, "prefs", prefsCreator, { disableYText: true, scopedDiff: true }),
    );

    store.getState().setFont(20);
    getYjsStoreHandle(store).flush();

    // An older persisted doc that never held `lang`.
    Y.applyUpdate(
      doc,
      persistedUpdate("prefs", { theme: "dark", fontSize: 14 }),
      "idb",
    );
    await flushMicrotasks();

    // The store keeps its declared `lang` and the doc now holds it as well,
    // so a 'replace' reload or a peer without scopedDiff keeps it too.
    const expected = { theme: "dark", fontSize: 20, lang: "en" };

    expect(getYjsStoreHandle(store).hasHydrated()).toBe(true);
    expect(syncedPrefs(store.getState())).toEqual(expected);
    expect(doc.getMap("prefs").toJSON()).toEqual(expected);
  });
});
