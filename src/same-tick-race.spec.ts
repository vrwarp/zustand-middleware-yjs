/**
 * Regression: a local set() and a foreign Yjs transaction that land in the
 * SAME event-loop tick must both survive.
 *
 * Outbound (store -> doc) and inbound (doc -> store) are coalesced into two
 * independent microtask batches. Whichever batch runs first used to clobber
 * the other side's not-yet-applied change:
 *
 * - local set() first: the outbound flush diffed the doc (which already holds
 *   the remote edit) against store state (which does not) and wrote the stale
 *   local values back, reverting the remote edit on every peer;
 * - remote transaction first: the inbound batch replaced store state with doc
 *   content that lacks the unflushed local write, so the outbound flush found
 *   nothing to write and the local edit vanished from both store and doc.
 *
 * Every test drives a real two-peer setup (a "local" doc hosting the store and
 * a "remote" doc standing in for another device) bridged synchronously, so a
 * remote edit reaches the local doc in the same tick it is made. Ordering is
 * controlled explicitly: the two competing edits are issued synchronously
 * back-to-back, and `settle()` drains every queued microtask before asserting.
 *
 * Each scenario runs with the legacy full diff and with `scopedDiff`. Some
 * scopedDiff variants already pass (untouched keys are skipped there); they
 * stay as guard rails so a fix for one ordering cannot break the other.
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

/*
 * Run the DEV scopedDiff divergence tripwire on every flush: a doc that is
 * ahead of state only because an inbound batch is still queued is not drift,
 * so it must never fire here (and sampling would make that flaky).
 */
beforeAll(() => {
  __scopedDiffDevSampling.rate = 1;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = 0.02; // restore the default
});

const modes: [string, boolean][] = [
  ["legacy full diff", false],
  ["scopedDiff", true],
];

describe.each(modes)("same-tick local set() and remote transaction (%s)", (_label, scopedDiff) => {
  type XY = { x: number; y: number };

  const setup = async () => {
    const { local, remote } = createPeers();
    const store = createStore<XY>()(
      yjs(local, "s", () => ({ x: 0, y: 0 }), { scopedDiff })
    );

    store.setState({ x: 1, y: 1 });
    await settle();

    expect(remote.getMap("s").toJSON()).toEqual({ x: 1, y: 1 });

    return { local, remote, store };
  };

  it("local set() then remote edit of another key: neither edit is reverted", async () => {
    const { local, remote, store } = await setup();

    // Same tick: local write first, remote write second.
    store.setState({ y: 2 });
    remote.getMap("s").set("x", 5);

    await settle();

    expect(store.getState()).toEqual({ x: 5, y: 2 });
    expect(local.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
    expect(remote.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
  });

  it("remote edit then local set() of another key: the local write is not lost", async () => {
    const { local, remote, store } = await setup();

    // Same tick: remote write first, local write second.
    remote.getMap("s").set("x", 5);
    store.setState({ y: 2 });

    await settle();

    expect(store.getState()).toEqual({ x: 5, y: 2 });
    expect(local.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
    expect(remote.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
  });

  it("remote edit and local set() from two queued microtasks: neither edit is lost", async () => {
    const { local, remote, store } = await setup();

    // Ordinary async interleaving, no synchronous provider callback: the
    // remote edit lands first, the local write in the next microtask.
    queueMicrotask(() => {
      remote.getMap("s").set("x", 5);
    });
    queueMicrotask(() => {
      store.setState({ y: 2 });
    });

    await settle();

    expect(store.getState()).toEqual({ x: 5, y: 2 });
    expect(local.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
    expect(remote.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
  });

  it("handle.flush() while a remote edit is still queued inbound does not revert it", async () => {
    const { local, remote, store } = await setup();

    // Remote write is applied to the doc (inbound batch queued), then the app
    // writes locally and drains outbound synchronously before that batch runs.
    remote.getMap("s").set("x", 5);
    store.setState({ y: 2 });
    getYjsStoreHandle(store).flush();

    await settle();

    expect(store.getState()).toEqual({ x: 5, y: 2 });
    expect(local.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
    expect(remote.getMap("s").toJSON()).toEqual({ x: 5, y: 2 });
  });

  it("local set() then remote text and list edits: the remote edits are not reverted", async () => {
    type Doc = { title: string; list: string[]; y: number };
    const { local, remote } = createPeers();
    const store = createStore<Doc>()(
      yjs(local, "d", () => ({ title: "", list: [] as string[], y: 0 }), { scopedDiff })
    );

    store.setState({ title: "hello", list: ["a"], y: 1 });
    await settle();
    expect(remote.getMap("d").toJSON()).toEqual({ title: "hello", list: ["a"], y: 1 });

    // Same tick: local write to y, then the remote peer edits the other keys.
    store.setState({ y: 2 });
    remote.transact(() => {
      (remote.getMap("d").get("title") as Y.Text).insert(5, " world");
      (remote.getMap("d").get("list") as Y.Array<string>).push(["b"]);
    });

    await settle();

    const expected = { title: "hello world", list: ["a", "b"], y: 2 };

    expect(store.getState()).toEqual(expected);
    expect(local.getMap("d").toJSON()).toEqual(expected);
    expect(remote.getMap("d").toJSON()).toEqual(expected);
  });

  it("remote insert then local insert into the same record: both entries survive", async () => {
    type Library = { books: Record<string, string> };
    const { local, remote } = createPeers();
    const store = createStore<Library>()(
      yjs(local, "lib", () => ({ books: {} as Record<string, string> }), {
        scopedDiff,
        disableYText: true,
      })
    );

    store.setState({ books: { b1: "one" } });
    await settle();
    expect(remote.getMap("lib").toJSON()).toEqual({ books: { b1: "one" } });

    // Same tick: the remote peer adds b3, then the local user adds b2.
    (remote.getMap("lib").get("books") as Y.Map<string>).set("b3", "three");
    store.setState((state) => ({ books: { ...state.books, b2: "two" } }));

    await settle();

    const expected = { books: { b1: "one", b2: "two", b3: "three" } };

    expect(store.getState()).toEqual(expected);
    expect(local.getMap("lib").toJSON()).toEqual(expected);
    expect(remote.getMap("lib").toJSON()).toEqual(expected);
  });

  /*
   * Two stores on one doc. When the library gains a book, app code reacts by
   * seeding that book's reading progress. Both peers start with book b1 at 0
   * progress.
   */
  const setupLibraryAndProgress = async () => {
    type Library = { books: Record<string, string> };
    type Progress = { pct: Record<string, number> };

    const local = new Y.Doc();
    const remote = new Y.Doc();
    const options = { scopedDiff, disableYText: true };

    const library = createStore<Library>()(
      yjs(local, "library", () => ({ books: {} as Record<string, string> }), options)
    );
    const progress = createStore<Progress>()(
      yjs(local, "progress", () => ({ pct: {} as Record<string, number> }), options)
    );

    library.subscribe((state, previous) => {
      for (const id of Object.keys(state.books)) {
        if (!(id in previous.books) && !(id in progress.getState().pct)) {
          progress.setState((current) => ({ pct: { ...current.pct, [id]: 0 } }));
        }
      }
    });

    library.setState({ books: { b1: "one" } });
    await settle();
    expect(progress.getState().pct).toEqual({ b1: 0 });
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));

    return { local, remote, library, progress };
  };

  it("a write made by a subscriber reacting to a remote change survives the same remote update", async () => {
    /*
     * A single remote update touches BOTH maps (a new book plus a progress
     * change for an existing book), so library's inbound batch runs first,
     * its subscriber writes progress, and progress's already-queued inbound
     * batch then runs over that pending write.
     */
    const { local, remote, library, progress } = await setupLibraryAndProgress();

    // The remote device adds b2 and advances b1, in one transaction.
    remote.transact(() => {
      (remote.getMap("library").get("books") as Y.Map<string>).set("b2", "two");
      (remote.getMap("progress").get("pct") as Y.Map<number>).set("b1", 0.1);
    });
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)));

    await settle();

    expect(library.getState().books).toEqual({ b1: "one", b2: "two" });
    // Both the remote progress change and the subscriber's seed must survive.
    expect(progress.getState().pct).toEqual({ b1: 0.1, b2: 0 });
    expect(local.getMap("progress").toJSON()).toEqual({ pct: { b1: 0.1, b2: 0 } });
  });

  it("a subscriber's write survives separate remote updates applied in one local transaction", async () => {
    /*
     * Same race through a provider that applies several pending updates
     * inside one transaction (as y-cinder does): the book and the progress
     * change arrive as two independent remote updates.
     */
    const { local, remote, library, progress } = await setupLibraryAndProgress();
    const updates: Uint8Array[] = [];

    remote.on("update", (update: Uint8Array) => {
      updates.push(update);
    });
    (remote.getMap("library").get("books") as Y.Map<string>).set("b2", "two");
    (remote.getMap("progress").get("pct") as Y.Map<number>).set("b1", 0.1);

    local.transact(() => {
      for (const update of updates) {
        Y.applyUpdate(local, update);
      }
    }, "provider");

    await settle();

    expect(library.getState().books).toEqual({ b1: "one", b2: "two" });
    expect(progress.getState().pct).toEqual({ b1: 0.1, b2: 0 });
    expect(local.getMap("progress").toJSON()).toEqual({ pct: { b1: 0.1, b2: 0 } });
  });
});
