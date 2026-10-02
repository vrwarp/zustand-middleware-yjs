/**
 * Regression: the same-tick flush must stay a three-way merge inside an
 * array when the remote change also wrote a sibling key.
 *
 * When a local set() and a foreign transaction land in the same tick (in
 * either order), the pending local write is flushed while the remote change
 * is in the doc but not yet in state. The README promises that this flush
 * "writes only what the local batch changed, so it cannot revert a remote
 * change the store has not applied yet", and that inside an array both sides
 * changed this "holds per element as long as the remote change only edited
 * elements".
 *
 * The per-element route was abandoned whenever ANY ancestor of the array was
 * touched by the remote transaction. The store's data map is an ancestor of
 * every top-level array, so a remote set() that also wrote an unrelated
 * top-level key (or a sibling key of a record holding the array) sent the
 * array down the doc-vs-new diff, which rewrote the remotely edited element
 * with the stale local copy, even an element the local batch never touched.
 * Only a change to the key the array sits under can re-place it; a remote
 * re-placement of the array itself must still write the local version.
 *
 * A string both sides changed is not merged per character: the local write
 * wins (keeping both edits would also be fine), but it is never lost, never
 * interleaved with the remote edit, and every peer converges.
 *
 * Every test drives a real two-peer setup: a "local" doc hosting the store
 * and a "remote" doc standing in for another device, bridged synchronously
 * so a remote edit reaches the local doc in the same tick it is made. The two
 * competing edits are issued synchronously back-to-back in the order under
 * test, and `settle()` drains every queued microtask (the middleware only
 * schedules microtasks) before asserting.
 */
import { createStore } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/** Drains all pending microtasks (outbound flushes and inbound batches). */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

/**
 * Two docs kept in sync synchronously in both directions, like a provider
 * that applies updates as soon as they arrive.
 */
const createPeers = (): { local: Y.Doc; remote: Y.Doc } => {
  const local = new Y.Doc();
  const remote = new Y.Doc();

  local.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "from-remote") {
      Y.applyUpdate(remote, update, "from-local");
    }
  });
  remote.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "from-local") {
      Y.applyUpdate(local, update, "from-remote");
    }
  });

  return { local, remote };
};

// Keep the sampled DEV tripwire out of the picture (it uses Math.random()).
let savedSamplingRate: number;

beforeAll(() => {
  savedSamplingRate = __scopedDiffDevSampling.rate;
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = savedSamplingRate;
});

const modes: [string, boolean][] = [
  ["legacy full diff", false],
  ["scopedDiff", true],
];

type Order = "local set() first" | "remote transaction first";

const orders: Order[] = ["local set() first", "remote transaction first"];

/** Issues both edits synchronously, in the same tick, in the given order. */
const inSameTick = (order: Order, local: () => void, remote: () => void): void => {
  if (order === "local set() first") {
    local();
    remote();
  } else {
    remote();
    local();
  }
};

describe.each(modes)("same-tick three-way flush (%s)", (_label, scopedDiff) => {
  describe("a remote element edit that also writes a sibling top-level key", () => {
    type Item = { id: number; b: number };
    type State = { list: Item[]; other: number };

    const setup = async () => {
      const { local, remote } = createPeers();
      const store = createStore<State>()(
        yjs(local, "s", () => ({ list: [] as Item[], other: 0 }), { scopedDiff, disableYText: true })
      );

      store.setState({ list: [{ id: 1, b: 1 }, { id: 2, b: 2 }], other: 0 });
      await settle();
      expect(remote.getMap("s").toJSON()).toEqual({ list: [{ id: 1, b: 1 }, { id: 2, b: 2 }], other: 0 });

      const remoteList = (): Y.Array<Y.Map<number>> => remote.getMap("s").get("list") as Y.Array<Y.Map<number>>;

      return { local, remote, remoteList, store };
    };

    it.each(orders)(
      "%s: a local append keeps the remote edit of an element it never touched",
      async (order) => {
        const { local, remote, remoteList, store } = await setup();

        inSameTick(
          order,
          () => {
            store.setState((state) => ({ list: [...state.list, { id: 3, b: 3 }] }));
          },
          () => {
            // One remote set(): edit list[1].b AND write another top-level key.
            remote.transact(() => {
              remoteList().get(1).set("b", 9);
              remote.getMap("s").set("other", 1);
            });
          }
        );

        await settle();

        const expected = { list: [{ id: 1, b: 1 }, { id: 2, b: 9 }, { id: 3, b: 3 }], other: 1 };

        expect(store.getState()).toEqual(expected);
        expect(local.getMap("s").toJSON()).toEqual(expected);
        expect(remote.getMap("s").toJSON()).toEqual(expected);
      }
    );

    it.each(orders)(
      "%s: a local edit of one element keeps the remote edit of another",
      async (order) => {
        const { local, remote, remoteList, store } = await setup();

        inSameTick(
          order,
          () => {
            store.setState((state) => ({
              list: state.list.map((item) => (item.id === 2 ? { ...item, b: 5 } : item)),
            }));
          },
          () => {
            remote.transact(() => {
              remoteList().get(0).set("b", 9);
              remote.getMap("s").set("other", 1);
            });
          }
        );

        await settle();

        const expected = { list: [{ id: 1, b: 9 }, { id: 2, b: 5 }], other: 1 };

        expect(store.getState()).toEqual(expected);
        expect(local.getMap("s").toJSON()).toEqual(expected);
        expect(remote.getMap("s").toJSON()).toEqual(expected);
      }
    );

    it.each(orders)(
      "%s: a local append keeps the element edit of a remote store's set()",
      async (order) => {
        const { local, remote, store } = await setup();
        const remoteStore = createStore<State>()(
          yjs(remote, "s", () => ({ list: [] as Item[], other: 0 }), { scopedDiff, disableYText: true })
        );

        await settle();
        expect(remoteStore.getState()).toEqual({ list: [{ id: 1, b: 1 }, { id: 2, b: 2 }], other: 0 });

        inSameTick(
          order,
          () => {
            store.setState((state) => ({ list: [...state.list, { id: 3, b: 3 }] }));
          },
          () => {
            remoteStore.setState((state) => ({
              list: state.list.map((item) => (item.id === 2 ? { ...item, b: 9 } : item)),
              other: 1,
            }));
            getYjsStoreHandle(remoteStore).flush();
          }
        );

        await settle();

        const expected = { list: [{ id: 1, b: 1 }, { id: 2, b: 9 }, { id: 3, b: 3 }], other: 1 };

        expect(store.getState()).toEqual(expected);
        expect(remoteStore.getState()).toEqual(expected);
        expect(local.getMap("s").toJSON()).toEqual(expected);
        expect(remote.getMap("s").toJSON()).toEqual(expected);
      }
    );

    it.each(orders)(
      "%s: a remote re-placement of the list still writes the local version",
      async (order) => {
        const { local, remote, store } = await setup();

        inSameTick(
          order,
          () => {
            store.setState((state) => ({ list: [...state.list, { id: 3, b: 3 }] }));
          },
          () => {
            // Same length, so only the key's change reveals the re-placement.
            remote.transact(() => {
              const list = new Y.Array<Y.Map<number>>();

              list.push([1, 2].map((id) => new Y.Map<number>([["id", id], ["b", id === 2 ? 9 : id]])));
              remote.getMap("s").set("list", list);
              remote.getMap("s").set("other", 1);
            });
          }
        );

        await settle();

        const expected = { list: [{ id: 1, b: 1 }, { id: 2, b: 2 }, { id: 3, b: 3 }], other: 1 };

        expect(store.getState()).toEqual(expected);
        expect(local.getMap("s").toJSON()).toEqual(expected);
        expect(remote.getMap("s").toJSON()).toEqual(expected);
      }
    );
  });

  describe("a remote element edit beside a sibling key of a nested record", () => {
    type Item = { id: number; b: number };
    type State = { book: { title: string; list: Item[] } };

    it.each(orders)("%s: a local append keeps the remote edit", async (order) => {
      const { local, remote } = createPeers();
      const store = createStore<State>()(
        yjs(local, "s", () => ({ book: { title: "a", list: [] as Item[] } }), { scopedDiff, disableYText: true })
      );

      store.setState({ book: { title: "a", list: [{ id: 1, b: 1 }, { id: 2, b: 2 }] } });
      await settle();

      const remoteBook = remote.getMap("s").get("book") as Y.Map<unknown>;

      inSameTick(
        order,
        () => {
          store.setState((state) => ({ book: { ...state.book, list: [...state.book.list, { id: 3, b: 3 }] } }));
        },
        () => {
          remote.transact(() => {
            (remoteBook.get("list") as Y.Array<Y.Map<number>>).get(1).set("b", 9);
            remoteBook.set("title", "b");
          });
        }
      );

      await settle();

      const expected = { book: { title: "b", list: [{ id: 1, b: 1 }, { id: 2, b: 9 }, { id: 3, b: 3 }] } };

      expect(store.getState()).toEqual(expected);
      expect(local.getMap("s").toJSON()).toEqual(expected);
      expect(remote.getMap("s").toJSON()).toEqual(expected);
    });
  });

  describe("a subscriber's write in reaction to a remote transaction", () => {
    it("keeps the element edit that transaction made", async () => {
      type Progress = { list: { id: string; b: number }[]; updatedAt: number };

      const { local, remote } = createPeers();
      const options = { scopedDiff, disableYText: true };
      const library = createStore<{ books: Record<string, string> }>()(
        yjs(local, "library", () => ({ books: {} as Record<string, string> }), options)
      );
      const progress = createStore<Progress>()(
        yjs(local, "progress", () => ({ list: [] as Progress["list"], updatedAt: 0 }), options)
      );

      // Every new book gets a progress entry.
      library.subscribe((state) => {
        for (const id of Object.keys(state.books)) {
          if (!progress.getState().list.some((entry) => entry.id === id)) {
            progress.setState((current) => ({ list: [...current.list, { id, b: 0 }] }));
          }
        }
      });

      library.setState({ books: { b1: "one", b2: "two" } });
      await settle();
      expect(remote.getMap("progress").toJSON()).toEqual({ list: [{ id: "b1", b: 0 }, { id: "b2", b: 0 }], updatedAt: 0 });

      // One remote transaction: add a book, and record progress on another.
      remote.transact(() => {
        (remote.getMap("library").get("books") as Y.Map<string>).set("b3", "three");
        (remote.getMap("progress").get("list") as Y.Array<Y.Map<unknown>>).get(1).set("b", 50);
        remote.getMap("progress").set("updatedAt", 1);
      });

      await settle();

      const expected = { list: [{ id: "b1", b: 0 }, { id: "b2", b: 50 }, { id: "b3", b: 0 }], updatedAt: 1 };

      expect(progress.getState()).toEqual(expected);
      expect(local.getMap("progress").toJSON()).toEqual(expected);
      expect(remote.getMap("progress").toJSON()).toEqual(expected);
    });
  });

  describe("a remote Y.Text edit and a local write of the same string", () => {
    type State = { text: string };

    it.each(orders)("%s: the local write lands, never interleaved, and every peer converges", async (order) => {
      const { local, remote } = createPeers();
      const store = createStore<State>()(yjs(local, "t", () => ({ text: "" }), { scopedDiff }));

      store.setState({ text: "hello" });
      await settle();
      expect(remote.getMap("t").get("text")).toBeInstanceOf(Y.Text);
      expect(remote.getMap("t").toJSON()).toEqual({ text: "hello" });

      inSameTick(
        order,
        () => {
          store.setState({ text: "Hello" });
        },
        () => {
          (remote.getMap("t").get("text") as Y.Text).insert(5, " world");
        }
      );

      await settle();

      const { text } = store.getState();

      // The local write wins outright today; keeping both edits would be fine.
      expect(["Hello", "Hello world"]).toContain(text);
      expect(local.getMap("t").toJSON()).toEqual({ text });
      expect(remote.getMap("t").toJSON()).toEqual({ text });
    });
  });
});
