import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle, __scopedDiffDevSampling } from ".";

/**
 * Fork contract suite — the api.yjs store handle (cases E.1–E.4): hasHydrated /
 * whenHydrated / markHydrated / flush / isObsolete, modeled on
 * zustand/persist's api.persist. whenHydrated's "resolution strictly follows
 * setState" is the structural replacement for a provider's
 * nested-queueMicrotask ordering hack.
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
  books: Record<string, { title: string }>;
  addBook: (id: string, title: string) => void;
}

const creator = (set: (fn: (s: State) => Partial<State>) => void): State => ({
  books: {},
  addBook: (id, title) =>
    set((state) => ({ books: { ...state.books, [id]: { title } } })),
});

const seededDoc = async (): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  const store = createStore<State>(yjs(doc, "lib", creator, { disableYText: true }));
  store.getState().addBook("b1", "Moby Dick");
  await drain();
  return doc;
};

describe("contract E.1 — whenHydrated resolves after the synchronous initial patch", () => {
  it("a store created on a pre-populated map is hydrated immediately", async () => {
    const doc = await seededDoc();
    const store = createStore<State>(yjs(doc, "lib", creator, { disableYText: true }));
    const handle = getYjsStoreHandle(store);

    expect(handle.hasHydrated()).toBe(true); // synchronous — no microtask needed
    await handle.whenHydrated(); // already-resolved promise
    expect(store.getState().books).toEqual({ b1: { title: "Moby Dick" } });
  });
});

describe("contract E.2 — whenHydrated resolves after the first inbound batch, strictly after setState", () => {
  it("an awaiter always observes hydrated state", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(yjs(doc, "lib", creator, { disableYText: true }));
    const handle = getYjsStoreHandle(store);
    expect(handle.hasHydrated()).toBe(false);

    // Subscribe BEFORE the data arrives: the continuation must observe the
    // patched state (resolution strictly follows the hydrating setState).
    let observedAtResolution: State | undefined;
    const resolution = handle.whenHydrated().then(() => {
      observedAtResolution = store.getState();
    });

    replicate(await seededDoc(), doc);
    await resolution;

    expect(handle.hasHydrated()).toBe(true);
    expect(observedAtResolution?.books).toEqual({ b1: { title: "Moby Dick" } });
  });
});

describe("contract E.3 — markHydrated", () => {
  it("resolves the empty-doc case, is idempotent, and is safe after real hydration", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(yjs(doc, "lib", creator, { disableYText: true }));
    const handle = getYjsStoreHandle(store);
    expect(handle.hasHydrated()).toBe(false);

    // The provider's call: doc synced, this store's map legitimately empty.
    handle.markHydrated();
    expect(handle.hasHydrated()).toBe(true);
    await handle.whenHydrated();

    handle.markHydrated(); // idempotent
    expect(handle.hasHydrated()).toBe(true);

    // Later real inbound data still applies normally.
    replicate(await seededDoc(), doc);
    await drain();
    expect(store.getState().books).toEqual({ b1: { title: "Moby Dick" } });

    // And calling markHydrated on a really-hydrated store is a no-op.
    const hydratedDoc = await seededDoc();
    const hydratedStore = createStore<State>(
      yjs(hydratedDoc, "lib", creator, { disableYText: true }),
    );
    const hydratedHandle = getYjsStoreHandle(hydratedStore);
    expect(hydratedHandle.hasHydrated()).toBe(true);
    hydratedHandle.markHydrated();
    expect(hydratedStore.getState().books).toEqual({ b1: { title: "Moby Dick" } });
  });
});

describe("contract E.4 — hasHydrated consistency and flush()", () => {
  it("flush() drains the pending outbound microtask synchronously, exactly once", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(yjs(doc, "lib", creator, { disableYText: true }));
    const handle = getYjsStoreHandle(store);
    const updates = countUpdates(doc);

    store.getState().addBook("b1", "Moby Dick");
    // Not flushed yet (microtask pending)…
    expect(doc.getMap("lib").size).toBe(0);

    handle.flush(); // …drained synchronously, no await needed
    expect((doc.getMap("lib").get("books") as Y.Map<unknown>).toJSON())
      .toEqual({ b1: { title: "Moby Dick" } });
    expect(updates.count()).toBe(1);

    // The stale scheduled microtask is a no-op: no duplicate transaction.
    await drain();
    expect(updates.count()).toBe(1);

    // flush() with nothing pending is a no-op.
    handle.flush();
    expect(updates.count()).toBe(1);
  });

  it("isObsolete() reflects the poison pill", async () => {
    const docA = new Y.Doc();
    const store = createStore<State>(
      yjs(docA, "lib", creator, { disableYText: true, schemaVersion: 5 }),
    );
    const handle = getYjsStoreHandle(store);
    expect(handle.isObsolete()).toBe(false);

    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.getMap("lib").set("__schemaVersion", 6);
    replicate(docB, docA);
    await drain();

    expect(handle.isObsolete()).toBe(true);
  });

  it("getYjsStoreHandle throws on a store without the middleware", () => {
    const plain = createStore<State>(creator);
    expect(() => getYjsStoreHandle(plain)).toThrow(/no `yjs` handle/);
  });
});

describe("contract D.3 (end-to-end) — the DEV scoped-diff tripwire fails loudly through flush()", () => {
  it("a mutate-in-place set() throws at the (sampled) flush", () => {
    __scopedDiffDevSampling.rate = 1;
    try {
      const doc = new Y.Doc();
      const store = createStore<State>(
        yjs(doc, "lib", creator, { disableYText: true, scopedDiff: true }),
      );
      const handle = getYjsStoreHandle(store);
      store.getState().addBook("b1", "Moby Dick");
      handle.flush();

      // Non-idiomatic mutate-in-place write: invisible to Object.is.
      store.setState((s) => {
        s.books["b1"].title = "Drifted";
        return { books: s.books };
      });
      expect(() => handle.flush()).toThrow(/scopedDiff divergence tripwire/);
    } finally {
      __scopedDiffDevSampling.rate = 0.02;
    }
  });
});
