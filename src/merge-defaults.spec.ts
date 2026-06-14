import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs from ".";

/**
 * Fork contract suite — merge-over-declared-defaults hydration (cases C.1–C.8).
 * With `hydration: 'merge-defaults'`, a top-level inbound DELETE is suppressed
 * iff the key is one of the store's declared defaults. Default option value
 * ('replace') stays the legacy replace-with-delete behavior.
 */

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

interface LibState {
  books: Record<string, { title: string }>;
  fontProfiles: Record<string, { font: string }>;
  addBook: (id: string, title: string) => void;
  setFont: (lang: string, font: string) => void;
}

const RICH_DEFAULTS: LibState["fontProfiles"] = {
  en: { font: "serif" },
  zh: { font: "kai" },
};

const creator = (set: (fn: (s: LibState) => Partial<LibState>) => void): LibState => ({
  books: {},
  fontProfiles: RICH_DEFAULTS,
  addBook: (id, title) =>
    set((state) => ({ books: { ...state.books, [id]: { title } } })),
  setFont: (lang, font) =>
    set((state) => ({ fontProfiles: { ...state.fontProfiles, [lang]: { font } } })),
});

/**
 * A v4-era doc: `books` present, NO `fontProfiles`. Built through a v4-era
 * shaped store (plain strings).
 */
const v4StyleDoc = async (
  books: Record<string, { title: string }> = { b1: { title: "Moby Dick" } },
): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  interface V4State {
    books: Record<string, { title: string }>;
    setBooks: (books: Record<string, { title: string }>) => void;
  }
  const v4Creator = (
    set: (fn: (s: V4State) => Partial<V4State>) => void,
  ): V4State => ({
    books: {},
    setBooks: (next) => set(() => ({ books: next })),
  });
  const store = createStore<V4State>(
    yjs(doc, "lib", v4Creator, { disableYText: true }),
  );
  store.getState().setBooks(books);
  await drain();
  return doc;
};

describe("contract C.1 — top-level default key absent from the map is retained", () => {
  it("initial hydration keeps the declared default (no DELETE reaches the store)", async () => {
    const doc = await v4StyleDoc();
    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );

    expect(store.getState().books).toEqual({ b1: { title: "Moby Dick" } });
    expect(store.getState().fontProfiles).toEqual(RICH_DEFAULTS);
    expect(typeof store.getState().addBook).toBe("function");
  });

  it("late inbound hydration (empty map at creation) retains the absent default", async () => {
    const doc = new Y.Doc();
    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );
    expect(store.getState().fontProfiles).toEqual(RICH_DEFAULTS); // pre-hydration

    replicate(await v4StyleDoc(), doc);
    await drain(); // inbound processBatch — emits a top-level DELETE… suppressed

    expect(store.getState().books).toEqual({ b1: { title: "Moby Dick" } });
    expect(store.getState().fontProfiles).toEqual(RICH_DEFAULTS);
  });

  it("retention keeps the CURRENT value: local writes since creation survive later inbound batches", async () => {
    const doc = new Y.Doc();
    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );
    replicate(await v4StyleDoc(), doc);
    await drain();
    store.getState().setFont("ja", "mincho");
    await drain();

    // Another inbound batch from a doc still lacking fontProfiles: the
    // suppressed DELETE retains the locally-updated value, not the default.
    const remote = new Y.Doc();
    replicate(doc, remote);
    remote.transact(() => {
      remote.getMap("lib").delete("fontProfiles"); // simulate a peer-side absence
      (remote.getMap("lib").get("books") as Y.Map<unknown>).set(
        "b2",
        (() => {
          const entry = new Y.Map();
          entry.set("title", "Walden");
          return entry;
        })(),
      );
    });
    replicate(remote, doc);
    await drain();

    expect(store.getState().books).toEqual({
      b1: { title: "Moby Dick" },
      b2: { title: "Walden" },
    });
    expect(store.getState().fontProfiles).toEqual({
      ...RICH_DEFAULTS,
      ja: { font: "mincho" },
    });
  });
});

describe("contract C.2 — legitimate nested deletions still apply", () => {
  it("a remote books[id] removal propagates under merge-defaults", async () => {
    const docA = new Y.Doc();
    const storeA = createStore<LibState>(
      yjs(docA, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );
    storeA.getState().addBook("b1", "Moby Dick");
    storeA.getState().addBook("b2", "Walden");
    await drain();

    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.transact(() => {
      (docB.getMap("lib").get("books") as Y.Map<unknown>).delete("b1");
    });
    replicate(docB, docA);
    await drain();

    expect(storeA.getState().books).toEqual({ b2: { title: "Walden" } });
  });
});

describe("contract C.3 — present-but-empty beats rich default", () => {
  it("an explicit empty record in the map wins over the declared default entirely", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = doc.getMap("lib");
      map.set("books", new Y.Map());
      map.set("fontProfiles", new Y.Map()); // explicitly synced as EMPTY
    });

    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );

    // Present-but-poorer is an explicit synced value, not an absence: the
    // map value wins, including the nested deletes it implies.
    expect(store.getState().fontProfiles).toEqual({});
  });
});

describe("contract C.4 — the fontProfiles scenario end-to-end", () => {
  it("v4-shaped doc + store declaring fontProfiles: doc fields hydrate, default retained (no migration needed)", async () => {
    const doc = await v4StyleDoc({
      b1: { title: "Moby Dick" },
      b2: { title: "紅樓夢" },
    });

    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );

    // Every field present in the doc hydrated…
    expect(store.getState().books).toEqual({
      b1: { title: "Moby Dick" },
      b2: { title: "紅樓夢" },
    });
    // …and the newly-declared default survived.
    expect(store.getState().fontProfiles).toEqual(RICH_DEFAULTS);
  });
});

describe("contract C.5 — hydration: 'replace' stores are byte-identical to legacy", () => {
  it("explicit replace behaves exactly like the unset option (per-store flip independence)", async () => {
    const doc1 = await v4StyleDoc();
    const doc2 = new Y.Doc();
    replicate(doc1, doc2);

    const legacyStore = createStore<LibState>(
      yjs(doc1, "lib", creator, { disableYText: true }),
    );
    const explicitReplaceStore = createStore<LibState>(
      yjs(doc2, "lib", creator, { hydration: "replace", disableYText: true }),
    );

    expect("fontProfiles" in legacyStore.getState()).toBe(false); // A.5 (D2)
    expect("fontProfiles" in explicitReplaceStore.getState()).toBe(false);
    expect(explicitReplaceStore.getState().books)
      .toEqual(legacyStore.getState().books);
  });
});

describe("contract C.6 — merge-defaults combined with syncedKeys against an old doc with junk keys", () => {
  it("declared defaults retained, junk keys filtered, listed data hydrated", async () => {
    const doc = await v4StyleDoc();
    doc.transact(() => {
      const popover = new Y.Map();
      popover.set("x", 12);
      doc.getMap("lib").set("popover", popover); // pre-hotfix junk key
    });

    const store = createStore<LibState>(
      yjs(doc, "lib", creator, {
        hydration: "merge-defaults",
        syncedKeys: ["books", "fontProfiles"],
        disableYText: true,
      }),
    );

    expect(store.getState().books).toEqual({ b1: { title: "Moby Dick" } });
    expect(store.getState().fontProfiles).toEqual(RICH_DEFAULTS);
    expect("popover" in store.getState()).toBe(false);
  });
});

describe("contract C.7 — backfill of a retained default to the doc", () => {
  it("legacy full diff: the NEXT outbound flush of any key backfills the retained default", async () => {
    const doc = await v4StyleDoc();
    const store = createStore<LibState>(
      yjs(doc, "lib", creator, { hydration: "merge-defaults", disableYText: true }),
    );

    // Retained default is NOT yet in the doc.
    expect(doc.getMap("lib").has("fontProfiles")).toBe(false);

    // A write to an unrelated key full-diffs state-vs-map and converges the doc.
    store.getState().addBook("b9", "Backfill Trigger");
    await drain();

    expect((doc.getMap("lib").get("fontProfiles") as Y.Map<unknown>).toJSON())
      .toEqual(RICH_DEFAULTS);
  });
});

describe("contract C.8 — top-level delete of a key NOT in defaults still applies", () => {
  it("a stale state key with no declared default is deleted by inbound patches", async () => {
    // A store that DOES declare 'popover' writes it (the pre-hotfix world)…
    interface OldUIState {
      annotations: Record<string, { text: string }>;
      popover: { x: number } | null;
      init: () => void;
    }
    const oldCreator = (
      set: (fn: (s: OldUIState) => Partial<OldUIState>) => void,
    ): OldUIState => ({
      annotations: {},
      popover: null,
      init: () =>
        set(() => ({ annotations: { a1: { text: "hi" } }, popover: { x: 7 } })),
    });
    const docA = new Y.Doc();
    const oldStore = createStore<OldUIState>(
      yjs(docA, "anno", oldCreator, { disableYText: true }),
    );
    oldStore.getState().init();
    await drain();

    // …a NEW-state store (merge-defaults, no popover default) hydrates it
    // because it is still in the doc (no syncedKeys in this scenario):
    interface NewUIState {
      annotations: Record<string, { text: string }>;
      add: (id: string, text: string) => void;
    }
    const newCreator = (
      set: (fn: (s: NewUIState) => Partial<NewUIState>) => void,
    ): NewUIState => ({
      annotations: {},
      add: (id, text) =>
        set((state) => ({ annotations: { ...state.annotations, [id]: { text } } })),
    });
    const docB = new Y.Doc();
    replicate(docA, docB);
    const store = createStore<NewUIState>(
      yjs(docB, "anno", newCreator, {
        hydration: "merge-defaults",
        disableYText: true,
      }),
    );
    expect(
      (store.getState() as unknown as Record<string, unknown>)["popover"],
    ).toEqual({ x: 7 });

    // A migration-style transaction deletes the key at the doc level: the
    // top-level DELETE reaches the store because 'popover' is NOT a declared
    // default of this store (merge-defaults only shields declared defaults).
    const docC = new Y.Doc();
    replicate(docB, docC);
    docC.transact(() => {
      docC.getMap("anno").delete("popover");
    });
    replicate(docC, docB);
    await drain();

    expect("popover" in store.getState()).toBe(false);
    expect(store.getState().annotations).toEqual({ a1: { text: "hi" } });
  });
});
