/*
 * Perf regression: an inbound batch that changes nothing for this store must
 * not notify its subscribers.
 *
 * patchStore cloned store.getState() and always called setState(next, true);
 * computeInboundState's syncedKeys branch always built a fresh top-level
 * object. Zustand only skips listeners when Object.is(next, current), so every
 * foreign batch that changed nothing for the store (an identical value
 * written concurrently by another device, a key outside syncedKeys written by
 * another store sharing the map, an identical deep value) still produced a
 * new state object: every listener and selector ran, and a nested persist
 * middleware re-serialized and re-wrote the whole state. The deep-path
 * scopedDiff route already avoided this with Object.is.
 *
 * Pinned with counters only: listener calls, state identity and persist
 * setItem calls per no-op batch.
 */
import { isDeepStrictEqual } from "node:util";
import * as fc from "fast-check";
import * as Y from "yjs";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { patchStore } from "./patching";

interface Book {
  title: string;
  progress: number;
}

interface AppState {
  theme: string;
  count: number;
  library: Record<string, Book>;
}

/** Let every queued microtask (outbound flush, inbound batch) run. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const REMOTE = "remote-peer";

/**
 * Seeds the doc the way a provider would before the store attaches, so the
 * store hydrates synchronously at creation and the doc already holds nested
 * Y.Maps for the deep-path cases.
 */
const seedDoc = (doc: Y.Doc): Y.Map<unknown> => {
  const map = doc.getMap("store");

  doc.transact(() => {
    map.set("theme", "dark");
    map.set("count", 0);

    const library = new Y.Map<unknown>();

    map.set("library", library);

    for (const id of ["b1", "b2", "b3"]) {
      const book = new Y.Map<unknown>();

      library.set(id, book);
      book.set("title", `Title ${id}`);
      book.set("progress", 0.5);
    }
  }, REMOTE);

  return map;
};

const initialState = (): AppState => ({
  theme: "light",
  count: 0,
  library: {},
});

interface Mode {
  scopedDiff: boolean;
}

const modes: [string, Mode][] = [
  ["legacy full-tree", { scopedDiff: false }],
  ["scopedDiff", { scopedDiff: true }],
];

const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  // The DEV tripwire is random and serializes; keep counts deterministic.
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

describe.each(modes)("no-op inbound batches (%s)", (_label, { scopedDiff }) => {
  const setup = (syncedKeys?: string[]) => {
    const doc = new Y.Doc();
    const map = seedDoc(doc);
    const store = createStore<AppState>()(
      yjs(doc, "store", initialState, {
        scopedDiff,
        disableYText: true,
        syncedKeys,
      }),
    );

    // Sanity: hydrated from the seeded doc at creation.
    expect(store.getState().theme).toBe("dark");
    expect(Object.keys(store.getState().library)).toEqual(["b1", "b2", "b3"]);

    const listener = jest.fn();

    store.subscribe(listener);

    return { doc, map, store, listener };
  };

  it("control: a foreign batch that changes a synced value notifies exactly once", async () => {
    const { doc, map, store, listener } = setup(["theme", "count", "library"]);

    doc.transact(() => {
      map.set("theme", "sepia");
    }, REMOTE);
    await drain();

    expect(store.getState().theme).toBe("sepia");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("an identical value written to a synced top-level key does not notify", async () => {
    const { doc, map, store, listener } = setup(["theme", "count", "library"]);
    const before = store.getState();

    // Another device concurrently wrote the value this store already holds.
    doc.transact(() => {
      map.set("theme", "dark");
    }, REMOTE);
    await drain();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getState()).toBe(before);
  });

  it("an identical value written without syncedKeys does not notify", async () => {
    const { doc, map, store, listener } = setup();
    const before = store.getState();

    doc.transact(() => {
      map.set("count", 0);
    }, REMOTE);
    await drain();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getState()).toBe(before);
  });

  it("a write to a key outside syncedKeys (another store on the same map) does not notify", async () => {
    const { doc, map, store, listener } = setup(["theme", "count", "library"]);
    const before = store.getState();

    doc.transact(() => {
      map.set("otherStoreKey", 42);
    }, REMOTE);
    await drain();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getState()).toBe(before);
  });

  it("an identical deep value does not notify", async () => {
    const { doc, map, store, listener } = setup(["theme", "count", "library"]);
    const before = store.getState();
    const book = (map.get("library") as Y.Map<unknown>).get("b2") as Y.Map<unknown>;

    doc.transact(() => {
      book.set("progress", 0.5);
    }, REMOTE);
    await drain();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getState()).toBe(before);
  });

  it("listener fan-out stays at zero across many no-op batches with many subscribers", async () => {
    const { doc, map, store, listener } = setup(["theme", "count", "library"]);
    const SUBSCRIBERS = 20;
    const BATCHES = 10;
    const selectorRuns = { count: 0 };

    for (let index = 0; index < SUBSCRIBERS; index = index + 1) {
      store.subscribe((state) => {
        selectorRuns.count = selectorRuns.count + 1;
        void Object.keys(state.library).length;
      });
    }

    for (let batch = 0; batch < BATCHES; batch = batch + 1) {
      doc.transact(() => {
        map.set("theme", "dark");
      }, REMOTE);
      await drain();
    }

    // Was SUBSCRIBERS x BATCHES = 200 selector runs for zero state change.
    expect(selectorRuns.count).toBe(0);
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it("a nested persist middleware does not re-write storage for a no-op batch", async () => {
    const doc = new Y.Doc();
    const map = seedDoc(doc);
    const writes: string[] = [];
    const storage = createJSONStorage<AppState>(() => ({
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    }));
    const store = createStore<AppState>()(
      yjs(
        doc,
        "store",
        persist(initialState, { name: "app", storage, skipHydration: true }),
        { scopedDiff, disableYText: true, syncedKeys: ["theme", "count", "library"] },
      ),
    );

    expect(store.getState().theme).toBe("dark");

    const writesAfterHydration = writes.length;

    doc.transact(() => {
      map.set("theme", "dark");
    }, REMOTE);
    await drain();

    // Was one full JSON.stringify(state) + storage.setItem per no-op batch.
    expect(writes.length - writesAfterHydration).toBe(0);
  });

  it("an outer persist middleware does not re-write storage for a no-op batch", async () => {
    const doc = new Y.Doc();
    const map = seedDoc(doc);
    const writes: string[] = [];
    const storage = createJSONStorage<AppState>(() => ({
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    }));
    // persist(yjs(...)): persist installs its setState wrapper before running
    // yjs, which captures it as the setState its inbound patches go through.
    const store = createStore<AppState>()(
      persist(
        yjs(doc, "store", initialState, {
          scopedDiff,
          disableYText: true,
          syncedKeys: ["theme", "count", "library"],
        }),
        { name: "app", storage, skipHydration: true },
      ),
    );

    expect(store.getState().theme).toBe("dark");

    const writesAfterHydration = writes.length;

    doc.transact(() => {
      map.set("theme", "dark");
    }, REMOTE);
    await drain();

    expect(writes.length - writesAfterHydration).toBe(0);

    // Control: a real change still reaches storage, once.
    doc.transact(() => {
      map.set("theme", "sepia");
    }, REMOTE);
    await drain();

    expect(writes.length - writesAfterHydration).toBe(1);
    expect(JSON.parse(writes.at(-1) ?? "null")).toMatchObject({ state: { theme: "sepia" } });
  });

  it("a no-op first inbound batch resolves whenHydrated without notifying", async () => {
    const doc = new Y.Doc();
    const map = doc.getMap("store");
    const store = createStore<AppState>()(
      yjs(doc, "store", initialState, { scopedDiff, disableYText: true }),
    );
    const handle = getYjsStoreHandle(store);
    const listener = jest.fn();

    store.subscribe(listener);
    expect(handle.hasHydrated()).toBe(false);

    // The remote doc holds exactly the store's defaults.
    doc.transact(() => {
      map.set("theme", "light");
      map.set("count", 0);
      map.set("library", new Y.Map<unknown>());
    }, REMOTE);
    await drain();

    // Hydration must still be signalled by a batch that changed nothing.
    expect(handle.hasHydrated()).toBe(true);
    await expect(handle.whenHydrated()).resolves.toBeUndefined();
    expect(store.getState()).toEqual({ theme: "light", count: 0, library: {} });
    expect(listener).toHaveBeenCalledTimes(0);
  });
});

/*
 * Several stores bound to ONE map with disjoint syncedKeys: every local write
 * of one store is a foreign batch for all the others. Each of those batches
 * changes nothing for them, yet each notified its subscribers: N-1 spurious
 * notification fan-outs per write.
 */
describe("several legacy-mode stores sharing one map", () => {
  it("a write by one store does not notify the others", async () => {
    const STORES = 4;
    const doc = new Y.Doc();
    const shared = doc.getMap("shared");

    // Every domain is already in the map (synced from the provider), so each
    // store hydrates its own key at creation. A store whose key were missing
    // would legitimately lose it on the next batch (replace hydration).
    doc.transact(() => {
      for (let index = 0; index < STORES; index = index + 1) {
        shared.set(`key${String(index)}`, 0);
      }
    }, REMOTE);

    const stores = Array.from({ length: STORES }, (_unused, index) =>
      createStore<Record<string, number>>()(
        yjs(doc, "shared", () => ({ [`key${String(index)}`]: 0 }), {
          disableYText: true,
          syncedKeys: [`key${String(index)}`],
        }),
      ),
    );
    const statesBefore = stores.map((store) => store.getState());
    const listeners = stores.map((store) => {
      const listener = jest.fn();

      store.subscribe(listener);

      return listener;
    });

    stores[0].setState({ key0: 1 });
    getYjsStoreHandle(stores[0]).flush();
    await drain();

    expect(shared.get("key0")).toBe(1);
    // The writer is notified by its own local setState, exactly once.
    expect(listeners[0]).toHaveBeenCalledTimes(1);
    // Was 1 each: one full fan-out per foreign batch that changed nothing.
    expect(listeners.slice(1).map((listener) => listener.mock.calls.length)).toEqual(
      Array.from({ length: STORES - 1 }, () => 0),
    );
    // Nothing changed for the other stores: same state object as before.
    expect(stores.slice(1).map((store, index) => store.getState() === statesBefore[index + 1])).toEqual(
      Array.from({ length: STORES - 1 }, () => true),
    );
  });
});

/*
 * patchStore hands store.getState() to computeInboundState uncloned, and only
 * a returned object that is not that input reaches setState. Both rest on
 * the appliers copying whatever they change: an in-place optimization there
 * would corrupt the live store state (and a no-op check on identity would
 * then skip the setState that publishes it). Pinned on a deep-frozen state,
 * which makes any write to the input throw (patching.ts is strict mode).
 */
describe("patchStore reads the store state uncloned", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) {
        deepFreeze(child);
      }
    }

    return value;
  };

  const key = fc.constantFrom("a", "b", "c", "d");
  const jsonValue = fc.letrec((tie) => ({
    json: fc.oneof(
      { depthSize: "small" },
      fc.constant(null),
      fc.boolean(),
      fc.integer({ min: -3, max: 3 }),
      fc.string({ maxLength: 6 }),
      tie("array"),
      tie("object"),
    ),
    array: fc.array(tie("json"), { maxLength: 4 }),
    object: fc.dictionary(key, tie("json"), { maxKeys: 4 }),
  })).json;
  const state = fc.dictionary(key, jsonValue, { maxKeys: 4 });

  it("never writes to the state it patches, and publishes every change", () => {
    fc.assert(
      fc.property(
        state,
        state,
        fc.option(fc.subarray(["a", "b", "c", "d"]), { nil: undefined }),
        (current, target, synced) => {
          const snapshot: unknown = JSON.parse(JSON.stringify(current));
          const store = createStore<Record<string, unknown>>()(() => deepFreeze(current));
          const syncedKeys = synced === undefined ? undefined : new Set(synced);
          const replicated = [...(syncedKeys ?? new Set([...Object.keys(current), ...Object.keys(target)]))];

          patchStore(store, target, { syncedKeys });

          const next = store.getState();

          // The input is untouched (a write to it would have thrown).
          expect(current).toEqual(snapshot);
          // The store now matches the doc on every replicated key.
          for (const name of replicated) {
            expect(Object.hasOwn(next, name)).toBe(Object.hasOwn(target, name));
            expect(next[name]).toEqual(target[name]);
          }
          // Keys outside syncedKeys are left as they were, by identity.
          for (const name of Object.keys(current).filter((other) => !replicated.includes(other))) {
            expect(next[name]).toBe(current[name]);
          }
          // Identity is kept exactly when no replicated key differed.
          const isUnchanged = replicated.every((name) =>
            Object.hasOwn(current, name) === Object.hasOwn(target, name) &&
            isDeepStrictEqual(current[name], target[name]));

          expect(Object.is(next, current)).toBe(isUnchanged);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keeps a frozen state intact when top-level deletes are suppressed", () => {
    const current = deepFreeze({ a: { list: [1, 2, 3], text: "hello" }, b: 1 });
    const store = createStore<Record<string, unknown>>()(() => current);

    patchStore(store, { a: { list: [3, 1], text: "help" } }, { suppressTopLevelDeleteKeys: new Set(["b"]) });

    expect(store.getState()).toEqual({ a: { list: [3, 1], text: "help" }, b: 1 });
    expect(current).toEqual({ a: { list: [1, 2, 3], text: "hello" }, b: 1 });
  });
});
