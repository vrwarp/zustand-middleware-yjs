import * as Y from "yjs";
import type { StateCreator } from "zustand";
import { createJSONStorage, devtools, persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle } from ".";

/**
 * Regression: yjs() must not discard the api.setState installed by a middleware
 * it wraps (yjs(doc, name, immer(...)) / persist(...) / devtools(...)).
 *
 * The README promises the middleware "can be composed with other middleware,
 * such as Immer". An inner middleware installs its own api.setState while the
 * wrapped state creator runs; an external store.setState(...) call must still
 * get that middleware's semantics (draft recipes, persistence, devtools
 * logging) AND sync to the Y.Doc. Doc state applied to the store (hydration
 * at creation, remote changes) goes through that middleware too, without
 * being echoed back to the doc.
 */

/*
 * An immer-equivalent middleware, wired exactly like zustand/middleware/immer
 * (immer itself is not a dependency here): api.setState accepts a draft
 * recipe, turns it into a state -> nextState function, and forwards it to the
 * `set` it was given. The draft is a shallow copy, which is enough for the
 * top-level mutations used below.
 */
type DraftSetState<T> = (
  updater: Partial<T> | ((draft: T) => T | void),
  replace?: false
) => void;

const produce =
  <T>(recipe: (draft: T) => T | void) =>
    (base: T): T => {
      const draft = { ...base };
      const result = recipe(draft);

      return result === undefined ? draft : result;
    };

const draftMiddleware =
  <T>(initializer: StateCreator<T>): StateCreator<T> =>
    (set, get, api) => {
      const setWithDrafts: DraftSetState<T> = (updater, replace) => {
        const next =
          typeof updater === "function"
            ? produce(updater as (draft: T) => T | void)
            : updater;

        set(next, replace);
      };

      api.setState = setWithDrafts as typeof api.setState;

      return initializer(api.setState, get, api);
    };

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const memoryStorage = <T = { n: number }>() => {
  const mem = new Map<string, string>();

  return {
    mem,
    storage: createJSONStorage<T>(() => ({
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    })),
  };
};

describe("yjs() wrapping another middleware keeps that middleware's setState", () => {
  it("external draft-recipe setState with an immer-style middleware inside yjs updates the store and the doc", () => {
    interface CountState {
      count: number;
    }

    const doc = new Y.Doc();
    const store = createStore<CountState>()(
      yjs(doc, "s", draftMiddleware<CountState>(() => ({ count: 0 })))
    );

    (store.setState as unknown as DraftSetState<CountState>)((draft) => {
      draft.count = 11;
    });

    // Bug: the recipe reached vanilla setState, returned undefined, and
    // replaced the whole state with undefined.
    expect(store.getState() as CountState | undefined).toEqual({ count: 11 });

    getYjsStoreHandle(store).flush();
    expect(doc.getMap("s").toJSON()).toEqual({ count: 11 });
  });

  it("external setState with persist inside yjs is written to storage and synced to the doc", () => {
    const { mem, storage } = memoryStorage();
    const doc = new Y.Doc();
    const store = createStore<{ n: number }>()(
      yjs(doc, "s", persist(() => ({ n: 0 }), { name: "p", storage }))
    );

    store.setState({ n: 5 });

    expect(store.getState()).toEqual({ n: 5 });

    // Bug: persist's setState wrapper was discarded, so nothing was persisted.
    const persisted = mem.get("p");

    expect(persisted === undefined ? undefined : (JSON.parse(persisted) as { state: { n: number } }).state).toEqual({ n: 5 });

    getYjsStoreHandle(store).flush();
    expect(doc.getMap("s").toJSON()).toEqual({ n: 5 });
  });

  it("a remote change with persist inside yjs is written to storage", async () => {
    const { mem, storage } = memoryStorage();
    const doc = new Y.Doc();
    const store = createStore<{ n: number }>()(
      yjs(doc, "s", persist(() => ({ n: 0 }), { name: "p", storage, skipHydration: true }))
    );

    doc.getMap("s").set("n", 9);
    await drain();

    expect(store.getState()).toEqual({ n: 9 });

    const persisted = mem.get("p");

    expect(persisted === undefined ? undefined : (JSON.parse(persisted) as { state: { n: number } }).state).toEqual({ n: 9 });
  });

  it("doc state applied through an immer-style middleware inside yjs is not echoed back to the doc", async () => {
    interface CountState {
      count: number;
    }

    const doc = new Y.Doc();

    doc.getMap("s").set("count", 3);

    const store = createStore<CountState>()(
      yjs(doc, "s", draftMiddleware<CountState>(() => ({ count: 0 })))
    );
    const outbound = jest.fn();

    doc.on("afterTransaction", (transaction: Y.Transaction) => {
      if (transaction.origin === store) {
        outbound();
      }
    });

    expect(store.getState()).toEqual({ count: 3 });

    doc.getMap("s").set("count", 4);
    await drain();

    expect(store.getState()).toEqual({ count: 4 });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("a set a subscriber makes in reaction to a remote change still syncs with persist inside yjs", async () => {
    interface PairState {
      n: number;
      doubled: number;
      setDoubled: (doubled: number) => void;
    }

    const { storage } = memoryStorage<PairState>();
    const doc = new Y.Doc();

    doc.getMap("s").set("n", 0);
    doc.getMap("s").set("doubled", 0);

    const store = createStore<PairState>()(
      yjs(doc, "s", persist((set) => ({
        n: 0,
        doubled: 0,
        setDoubled: (doubled) => {
          set({ doubled });
        },
      }), { name: "p", storage, skipHydration: true }))
    );

    store.subscribe((state, previous) => {
      if (state.n !== previous.n) {
        state.setDoubled(state.n * 2);
      }
    });

    doc.getMap("s").set("n", 4);
    await drain();

    expect(store.getState()).toMatchObject({ n: 4, doubled: 8 });
    expect(doc.getMap("s").toJSON()).toEqual({ n: 4, doubled: 8 });
  });

  describe("with devtools inside yjs", () => {
    const send = jest.fn();
    const connection = {
      init: jest.fn(),
      send,
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    };
    const globalWindow = window as unknown as {
      __REDUX_DEVTOOLS_EXTENSION__?: { connect: () => typeof connection };
    };

    beforeEach(() => {
      send.mockClear();
      globalWindow.__REDUX_DEVTOOLS_EXTENSION__ = { connect: () => connection };
    });

    afterEach(() => {
      delete globalWindow.__REDUX_DEVTOOLS_EXTENSION__;
    });

    it("external setState is reported to devtools and synced to the doc", () => {
      const doc = new Y.Doc();
      const store = createStore<{ n: number }>()(
        yjs(doc, "s", devtools(() => ({ n: 0 }), { enabled: true }))
      );

      store.setState({ n: 7 });

      expect(store.getState()).toEqual({ n: 7 });

      // Bug: devtools' setState wrapper was discarded, so nothing was sent.
      expect(send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ n: 7 })
      );

      getYjsStoreHandle(store).flush();
      expect(doc.getMap("s").toJSON()).toEqual({ n: 7 });
    });
  });
});
