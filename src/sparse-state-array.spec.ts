/*
 * Regression: a hole in the writer's own state array must not hide remote
 * writes to that slot.
 *
 * Sparse arrays are storable: a hole is written to the Y.Array as null, while
 * the writer's state keeps the hole. A peer that later writes that slot must
 * still reach the writer's store (store == doc), and the writer's next flush
 * of an unrelated key must leave the peer's value in the doc instead of
 * writing null back over it (peer convergence without data loss).
 *
 * Inbound, the writer diffs its own state against the doc. If that comparison
 * skips the holes of the state array, the remote write to the hole slot looks
 * like "no change" and is dropped; in legacy (full-tree) mode the next flush
 * diffs the doc against a state whose hole normalizes to null and reverts the
 * peer's write on every replica.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

interface State {
  list: unknown[];
  n: number;
}

/** Let every queued microtask (outbound flush, inbound batch) run. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Two docs that exchange every update synchronously, like a live provider. */
const makeSyncedDocs = (): [Y.Doc, Y.Doc] => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const REMOTE = "sync";

  docA.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      Y.applyUpdate(docB, update, REMOTE);
    }
  });
  docB.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) {
      Y.applyUpdate(docA, update, REMOTE);
    }
  });

  return [docA, docB];
};

/** `[<hole>, 1]`: length 2, index 0 never assigned. */
const sparseList = (): unknown[] => {
  const list: unknown[] = [];

  list[1] = 1;

  return list;
};

/** `[<hole>, 1]` from a preallocated array. */
const preallocatedList = (): unknown[] => {
  const list: unknown[] = new Array(2);

  list[1] = 1;

  return list;
};

/** `[<hole>, 1]` left behind by `delete`. */
const deletedList = (): unknown[] => {
  const list: unknown[] = [0, 1];

  delete list[0];

  return list;
};

let savedRate: number;

beforeEach(() => {
  savedRate = __scopedDiffDevSampling.rate;
  __scopedDiffDevSampling.rate = 0;
});

afterEach(() => {
  __scopedDiffDevSampling.rate = savedRate;
});

describe.each([
  ["legacy full diff", false],
  ["scopedDiff", true],
])("a remote write into a slot the writer's state holds as a hole (%s)", (_label, scopedDiff) => {
  const setup = () => {
    const [docA, docB] = makeSyncedDocs();
    const storeA = createStore<State>(
      yjs<State>(docA, "m", () => ({ list: [], n: 0 }), { scopedDiff })
    );
    const storeB = createStore<State>(
      yjs<State>(docB, "m", () => ({ list: [], n: 0 }), { scopedDiff })
    );

    return { docA, docB, storeA, storeB };
  };

  it("reaches the writer's store, so the store matches its doc", async () => {
    const { docA, docB, storeA, storeB } = setup();

    storeA.setState({ list: sparseList() });
    getYjsStoreHandle(storeA).flush();
    await drain();

    // Sanity: the hole was stored as null and B received it.
    expect(docA.getMap("m").toJSON().list).toEqual([null, 1]);
    expect(storeB.getState().list).toEqual([null, 1]);

    // Peer B fills the slot A holds as a hole.
    storeB.setState({ list: [5, 1] });
    getYjsStoreHandle(storeB).flush();
    await drain();

    expect(docA.getMap("m").toJSON().list).toEqual([5, 1]);
    expect(docB.getMap("m").toJSON().list).toEqual([5, 1]);

    // A's store must pick up B's write: store == doc.
    expect(storeA.getState().list).toEqual([5, 1]);
    expect(storeA.getState().list[0]).toBe(5);
  });

  it("is not reverted by the writer's next flush of an unrelated key", async () => {
    const { docA, docB, storeA, storeB } = setup();

    storeA.setState({ list: sparseList() });
    getYjsStoreHandle(storeA).flush();
    await drain();

    storeB.setState({ list: [5, 1] });
    getYjsStoreHandle(storeB).flush();
    await drain();

    // A writes a key that has nothing to do with `list`.
    storeA.setState({ n: 1 });
    getYjsStoreHandle(storeA).flush();
    await drain();

    // B's value must survive on every replica.
    expect(docB.getMap("m").toJSON()).toEqual({ list: [5, 1], n: 1 });
    expect(docA.getMap("m").toJSON()).toEqual({ list: [5, 1], n: 1 });
    expect(storeB.getState().list).toEqual([5, 1]);
    expect(storeA.getState().list).toEqual([5, 1]);
  });

  /*
   * Every way of making a hole, and an explicit undefined as the control
   * (stored as null like a hole, and visited by every comparison).
   */
  it.each([
    ["new Array(2)", preallocatedList],
    ["delete arr[0]", deletedList],
    ["explicit undefined (control)", () => [undefined, 1]],
  ])("reaches the writer's store for a slot made by %s", async (_kind, makeList) => {
    const { docA, storeA, storeB } = setup();

    storeA.setState({ list: makeList() });
    getYjsStoreHandle(storeA).flush();
    await drain();

    expect(docA.getMap("m").toJSON().list).toEqual([null, 1]);

    storeB.setState({ list: [5, 1] });
    getYjsStoreHandle(storeB).flush();
    await drain();

    expect(storeA.getState().list).toEqual([5, 1]);
    expect(storeA.getState().list[0]).toBe(5);
  });

  /*
   * A sparse array nested inside an array element is compared by the array
   * diff's lookahead, not by the record-level prefilter.
   */
  it("reaches the writer's store when the sparse array is an array element", async () => {
    const { docA, docB, storeA, storeB } = setup();

    storeA.setState({ list: [sparseList(), "x"] });
    getYjsStoreHandle(storeA).flush();
    await drain();

    expect(docA.getMap("m").toJSON().list).toEqual([[null, 1], "x"]);

    storeB.setState({ list: [[5, 1], "x"] });
    getYjsStoreHandle(storeB).flush();
    await drain();

    expect(storeA.getState().list).toEqual([[5, 1], "x"]);

    storeA.setState({ n: 1 });
    getYjsStoreHandle(storeA).flush();
    await drain();

    expect(docB.getMap("m").toJSON()).toEqual({ list: [[5, 1], "x"], n: 1 });
  });

  it("does not rewrite the stored null on the writer's own later flushes", async () => {
    const { docA, storeA } = setup();

    storeA.setState({ list: sparseList() });
    getYjsStoreHandle(storeA).flush();
    await drain();

    const list = docA.getMap("m").get("list") as Y.Array<unknown>;
    const listEvents = jest.fn();

    list.observeDeep(listEvents);

    storeA.setState({ n: 1 });
    getYjsStoreHandle(storeA).flush();
    await drain();

    expect(docA.getMap("m").toJSON()).toEqual({ list: [null, 1], n: 1 });
    expect(listEvents).not.toHaveBeenCalled();
  });
});

/*
 * A flush made inside a caller's doc.transact shares the caller's origin, so
 * the observer tells the store's own write from the caller's by comparing
 * the doc with what the flush wrote. The hole slot is stored as null: that
 * is the store's own write, while a value the caller puts there is not.
 */
describe.each([
  ["legacy full diff", false],
  ["scopedDiff", true],
])("a sparse array flushed inside a caller's doc.transact (%s)", (_label, scopedDiff) => {
  const setup = () => {
    const doc = new Y.Doc();
    const onLoaded = jest.fn();
    const store = createStore<State>(
      yjs<State>(doc, "m", () => ({ list: [], n: 0 }), { scopedDiff, onLoaded })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ n: 1 });
    handle.flush();

    const listener = jest.fn();

    store.subscribe(listener);

    return { doc, store, handle, listener, onLoaded };
  };

  it("is the store's own write: not re-applied as remote, no hydration", async () => {
    const { doc, store, handle, listener, onLoaded } = setup();

    doc.transact(() => {
      store.setState({ list: sparseList() });
      handle.flush();
    }, "caller");
    await drain();

    expect(doc.getMap("m").toJSON().list).toEqual([null, 1]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(handle.hasHydrated()).toBe(false);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("still applies what the caller writes into the hole slot", async () => {
    const { doc, store, handle } = setup();

    doc.transact(() => {
      store.setState({ list: sparseList() });
      handle.flush();

      const list = doc.getMap("m").get("list") as Y.Array<unknown>;

      list.delete(0);
      list.insert(0, [5]);
    }, "caller");
    await drain();

    expect(doc.getMap("m").toJSON().list).toEqual([5, 1]);
    expect(store.getState().list).toEqual([5, 1]);
  });
});
