import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs from ".";

/**
 * Fork contract suite — `syncedKeys` whitelist (cases B.1–B.6). The option is
 * OFF by default; legacy "all non-function keys" behavior stays pinned by the
 * existing index/patching/batching specs.
 */

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

const countUpdates = (doc: Y.Doc): { count: () => number } => {
  let n = 0;
  doc.on("update", () => {
    n += 1;
  });
  return { count: () => n };
};

interface State {
  shared: Record<string, { label: string }>;
  localOnly: string;
  setShared: (id: string, label: string) => void;
  setLocalOnly: (value: string) => void;
}

const creator = (set: (fn: (s: State) => Partial<State>) => void): State => ({
  shared: {},
  localOnly: "transient",
  setShared: (id, label) =>
    set((state) => ({ shared: { ...state.shared, [id]: { label } } })),
  setLocalOnly: (value) => set(() => ({ localOnly: value })),
});

const SYNCED: readonly string[] = ["shared"];

describe("contract B.1 — non-listed key never written outbound", () => {
  it("the doc stays clean of non-listed keys across flushes (insert, update, delete directions)", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "lib", creator, { syncedKeys: SYNCED }),
    );

    store.getState().setShared("a", "A");
    store.getState().setLocalOnly("changed");
    await drain();

    expect(doc.getMap("lib").toJSON()).toEqual({ shared: { a: { label: "A" } } });

    // Further churn on the non-listed key alone produces NO doc transaction.
    const updates = countUpdates(doc);
    store.getState().setLocalOnly("changed-again");
    await drain();
    expect(updates.count()).toBe(0);
    expect(doc.getMap("lib").toJSON()).toEqual({ shared: { a: { label: "A" } } });
  });
});

describe("contract B.2 — inbound foreign map key is never inserted into state", () => {
  /** A doc whose map carries the synced key plus a stale foreign key (the popover class). */
  const docWithForeignKey = (): Y.Doc => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = doc.getMap("lib");
      const shared = new Y.Map();
      const entry = new Y.Map();
      entry.set("label", "remote");
      shared.set("r1", entry);
      map.set("shared", shared);
      const popover = new Y.Map();
      popover.set("x", 120);
      popover.set("y", 480);
      map.set("popover", popover);
    });
    return doc;
  };

  it("initial hydration (pre-populated map at creation) filters the foreign key", () => {
    const doc = docWithForeignKey();
    const store = createStore<State>(
      yjs(doc, "lib", creator, { syncedKeys: SYNCED }),
    );

    expect(store.getState().shared).toEqual({ r1: { label: "remote" } });
    expect("popover" in store.getState()).toBe(false);
  });

  it("late inbound hydration filters the foreign key too", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "lib", creator, { syncedKeys: SYNCED }),
    );

    replicate(docWithForeignKey(), doc);
    await drain();

    expect(store.getState().shared).toEqual({ r1: { label: "remote" } });
    expect("popover" in store.getState()).toBe(false);
  });
});

describe("contract B.3 — remote updates cannot delete or overwrite a non-listed local key", () => {
  it("a remote write to the non-listed key name is ignored; local value survives remote churn", async () => {
    const docA = new Y.Doc();
    const storeA = createStore<State>(
      yjs(docA, "lib", creator, { syncedKeys: SYNCED }),
    );
    storeA.getState().setShared("a", "A");
    storeA.getState().setLocalOnly("precious-local");
    await drain();

    // Remote peer writes BOTH a conflicting non-listed key and synced data.
    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.transact(() => {
      docB.getMap("lib").set("localOnly", "evil-overwrite");
      const shared = docB.getMap("lib").get("shared") as Y.Map<unknown>;
      const entry = new Y.Map();
      entry.set("label", "B");
      shared.set("b", entry);
    });
    replicate(docB, docA);
    await drain();

    // Synced data applied…
    expect(storeA.getState().shared).toEqual({
      a: { label: "A" },
      b: { label: "B" },
    });
    // …non-listed local key untouched (not overwritten).
    expect(storeA.getState().localOnly).toBe("precious-local");

    // Remote then deletes the key name from the map: still untouched locally.
    docB.transact(() => {
      docB.getMap("lib").delete("localOnly");
    });
    replicate(docB, docA);
    await drain();
    expect(storeA.getState().localOnly).toBe("precious-local");
  });
});

describe("contract B.4 — __schemaVersion is implicitly synced when schemaVersion is set", () => {
  it("inbound: __schemaVersion enters state while other unlisted keys stay filtered; outbound never deletes it from the doc", async () => {
    const docA = new Y.Doc();
    const storeA = createStore<State>(
      yjs(docA, "lib", creator, { syncedKeys: SYNCED, schemaVersion: 5 }),
    );
    storeA.getState().setShared("a", "A");
    await drain();

    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.transact(() => {
      docB.getMap("lib").set("__schemaVersion", 5); // equal — not a poison pill
      docB.getMap("lib").set("junk", "unlisted");
    });
    replicate(docB, docA);
    await drain();

    const stateA = storeA.getState() as unknown as Record<string, unknown>;
    expect(stateA["__schemaVersion"]).toBe(5); // implicit synced key landed
    expect("junk" in stateA).toBe(false); // ordinary unlisted key filtered

    // Outbound after hydration: local churn neither deletes nor rewrites it.
    storeA.getState().setShared("b", "B");
    await drain();
    expect(docA.getMap("lib").get("__schemaVersion")).toBe(5);

    // The poison pill is unaffected by the whitelist.
    const onObsolete = jest.fn();
    const docC = new Y.Doc();
    replicate(docA, docC);
    const storeC = createStore<State>(
      yjs(docC, "lib", creator, { syncedKeys: SYNCED, schemaVersion: 5, onObsolete }),
    );
    const docD = new Y.Doc();
    replicate(docC, docD);
    docD.getMap("lib").set("__schemaVersion", 6);
    replicate(docD, docC);
    await drain();
    expect(onObsolete).toHaveBeenCalledWith(6);
    expect(storeC.getState().shared).toEqual({
      a: { label: "A" },
      b: { label: "B" },
    }); // creation-time hydration only; the v6 transaction never patched state
  });

  it("without the schemaVersion option, __schemaVersion is NOT implicitly synced", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "lib", creator, { syncedKeys: SYNCED }),
    );

    const remote = new Y.Doc();
    remote.transact(() => {
      remote.getMap("lib").set("__schemaVersion", 5);
    });
    replicate(remote, doc);
    await drain();

    expect("__schemaVersion" in store.getState()).toBe(false);
  });
});

describe("contract B.5 — resurrection guard for keys dropped from syncedKeys", () => {
  it("a doc key no longer whitelisted is neither deleted outbound nor inserted inbound", async () => {
    // Era N: a client that still syncs 'legacy' writes it into the doc.
    const doc = new Y.Doc();
    interface OldState {
      shared: Record<string, { label: string }>;
      legacy: string;
      init: () => void;
    }
    const oldCreator = (
      set: (fn: (s: OldState) => Partial<OldState>) => void,
    ): OldState => ({
      shared: {},
      legacy: "",
      init: () =>
        set(() => ({ legacy: "old-doc-value", shared: { a: { label: "A" } } })),
    });
    const oldStore = createStore<OldState>(
      // v4-era plain-string encoding
      yjs(doc, "lib", oldCreator, { disableYText: true }),
    );
    oldStore.getState().init();
    await drain();
    expect(doc.getMap("lib").get("legacy")).toBe("old-doc-value");

    // Era N+1: same doc, store no longer declares or syncs 'legacy'.
    const docNext = new Y.Doc();
    replicate(doc, docNext);
    const store = createStore<State>(
      yjs(docNext, "lib", creator, { syncedKeys: SYNCED }),
    );

    // Inbound: never inserted into state.
    expect("legacy" in store.getState()).toBe(false);

    // Outbound: flushes do not delete it from the doc (only a migration may).
    store.getState().setShared("b", "B");
    await drain();
    expect(docNext.getMap("lib").get("legacy")).toBe("old-doc-value");
    expect(store.getState().shared).toEqual({
      a: { label: "A" },
      b: { label: "B" },
    });
  });
});

describe("contract B.6 — dev-mode loud misconfiguration failures", () => {
  it("throws at store creation when a syncedKeys entry is missing from the initial state", () => {
    const doc = new Y.Doc();
    expect(() =>
      createStore<State>(
        yjs(doc, "lib", creator, { syncedKeys: ["shraed"] }),
      ),
    ).toThrow(/syncedKeys entry "shraed" is not a key/);
  });

  it("throws at store creation when a syncedKeys entry is a function", () => {
    const doc = new Y.Doc();
    expect(() =>
      createStore<State>(
        yjs(doc, "lib", creator, { syncedKeys: ["setShared"] }),
      ),
    ).toThrow(/syncedKeys entry "setShared" of store "lib" is a function/);
  });
});
