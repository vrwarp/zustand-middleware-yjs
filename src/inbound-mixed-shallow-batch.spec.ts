/*
 * Inbound batches that mix a root-level event with a deep change.
 *
 * Under scopedDiff the observer keeps each remote event's full path, so a
 * deep change is reconciled at that path (computeInboundStateForPaths)
 * instead of re-reading the whole top-level key (docs/performance.md §11).
 * Events that are only visible at the top level — a top-level primitive
 * written, a top-level key added or deleted, an edit inside a top-level
 * Y.Array (its path is cut to one segment) — have to take the key-scoped
 * route. They are tracked with ONE batch-wide flag, though, so a single such
 * event sends EVERY change in the batch down the key-scoped route, and the
 * hot key that only had a deep change is serialized and diffed in full:
 * O(total library) per batch again.
 *
 * Top-level keys reconcile independently, so a shallow event on key K only
 * needs K re-read. These tests pin that: in a mixed batch, the hot key's
 * Y.Map is never serialized, and the receiver's Y.Map/Y.Array `toJSON()`
 * count is the deep part's count plus the shallow keys' own size — flat in
 * library size. Correctness guards (one notification per batch, convergence,
 * merge-defaults delete suppression) pin what a fix must keep.
 *
 * The remote peer is a raw Y.Doc (no store attached), so every counted
 * `toJSON()` call is the receiver's.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

interface Device { cfi: string; pct: number; tags: string[] }
type Tree = Record<string, Record<string, Device>>;
interface MixedState {
  progress: Tree;
  currentBookId: string;
  recent: string[];
}

const SYNCED = ["progress", "currentBookId", "recent"];

const makeTree = (books: number): Tree => {
  const tree: Tree = {};

  for (let index = 0; index < books; index = index + 1) {
    tree[`book-${String(index)}`] = {
      "device-0": { "cfi": `cfi-${String(index)}`, "pct": index / 100, "tags": ["a", "b"] },
      "device-1": { "cfi": `cfi-${String(index)}b`, "pct": index / 100, "tags": ["c"] },
    };
  }

  return tree;
};

const makeInitial = (books: number): MixedState => {
  return { "progress": makeTree(books), "currentBookId": "book-0", "recent": ["book-0", "book-1", "book-2"] };
};

interface ReceiverOptions {
  hydration?: "replace" | "merge-defaults";
  scopeKey?: string;
}

/**
 * A remote raw Y.Doc and a receiving store, both holding the same `books`
 * tree. The doc layout is written by a seeding store, so it is exactly the
 * middleware's mapping (objects -> Y.Map, arrays -> Y.Array, strings
 * primitive under disableYText).
 *
 * @param books - Library size.
 * @param options - Receiver hydration mode / scope.
 * @returns The fixture.
 */
const makeReceiver = (books: number, { hydration = "replace", scopeKey }: ReceiverOptions = {}) => {
  const options = {
    "disableYText": true,
    "scopedDiff": true,
    "syncedKeys": SYNCED,
    hydration,
    ...(scopeKey === undefined ? {} : { "scope": { "key": scopeKey } }),
  };
  const seedDoc = new yjs.Doc();
  const seeder = createStore<MixedState>()(yjsMiddleware(seedDoc, "root", () => makeInitial(books), options));

  // An empty doc is only written on the first flush, and only in full once
  // the store is hydrated (a new doc, so mark it).
  getYjsStoreHandle(seeder).markHydrated();
  seeder.setState((state) => { return { "progress": { ...state.progress } } });
  getYjsStoreHandle(seeder).flush();

  const remoteDoc = new yjs.Doc();
  const receiverDoc = new yjs.Doc();

  yjs.applyUpdate(remoteDoc, yjs.encodeStateAsUpdate(seedDoc));
  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(seedDoc));

  const receiver = createStore<MixedState>()(
    yjsMiddleware(
      receiverDoc,
      "root",
      (): MixedState => { return { "progress": {}, "currentBookId": "", "recent": [] } },
      options
    )
  );

  if (Object.keys(receiver.getState().progress).length !== books) {
    throw new Error("receiver did not hydrate");
  }

  const storeMap = (doc: yjs.Doc): yjs.Map<unknown> => {
    const root = doc.getMap("root");

    return scopeKey === undefined ? root : root.get(scopeKey) as yjs.Map<unknown>;
  };
  const remote = storeMap(remoteDoc);
  const remoteProgress = remote.get("progress") as yjs.Map<yjs.Map<yjs.Map<unknown>>>;

  /** One deep change: book-3 / device-0 / cfi. */
  const deepWrite = (value: string): void => {
    (remoteProgress.get("book-3") as yjs.Map<yjs.Map<unknown>>).get("device-0")?.set("cfi", value);
  };

  /**
   * Runs each writer in its own remote transaction, delivers all of them to
   * the receiver in one tick (one inbound batch), drains the batch, and
   * returns how many Y.Map / Y.Array `toJSON()` calls the receiver made.
   */
  const deliver = async (...writers: (() => void)[]): Promise<number> => {
    const updates = writers.map((writer) => {
      const vector = yjs.encodeStateVector(remoteDoc);

      remoteDoc.transact(writer);

      return yjs.encodeStateAsUpdate(remoteDoc, vector);
    });
    const mapSpy = jest.spyOn(yjs.Map.prototype, "toJSON");
    const arraySpy = jest.spyOn(yjs.Array.prototype, "toJSON");

    try {
      for (const update of updates) {
        yjs.applyUpdate(receiverDoc, update);
      }
      await Promise.resolve();
      await Promise.resolve();

      return mapSpy.mock.calls.length + arraySpy.mock.calls.length;
    } finally {
      mapSpy.mockRestore();
      arraySpy.mockRestore();
    }
  };

  const receiverProgress = storeMap(receiverDoc).get("progress") as yjs.Map<yjs.Map<unknown>>;

  return { remote, remoteDoc, receiver, receiverDoc, receiverProgress, deepWrite, deliver };
};

/** Spies on the receiver's hot-key map and one untouched sibling book. */
const spyOnHotKey = (receiverProgress: yjs.Map<yjs.Map<unknown>>) => {
  const hotKey = jest.spyOn(receiverProgress, "toJSON");
  const sibling = jest.spyOn(receiverProgress.get("book-7") as yjs.Map<unknown>, "toJSON");

  return {
    hotKey,
    sibling,
    restore: () => {
      hotKey.mockRestore();
      sibling.mockRestore();
    },
  };
};

describe("inbound batches mixing a root-level event with a deep change (scopedDiff)", () => {
  let previousRate: number;

  beforeEach(() => {
    previousRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = previousRate;
  });

  it("does not serialize the hot key when a top-level primitive is written in the same transaction", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20);
    const spies = spyOnHotKey(receiverProgress);

    await deliver(() => {
      deepWrite("moved");
      remote.set("currentBookId", "book-3");
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("moved");
    expect(receiver.getState().currentBookId).toBe("book-3");
    expect(spies.hotKey).not.toHaveBeenCalled();
    expect(spies.sibling).not.toHaveBeenCalled();
    spies.restore();
  });

  /*
   * The scaling pin: a deep-only batch already costs the same at every
   * library size (§11); a mixed batch must too. The shallow key here is a
   * primitive, so it serializes nothing — the mixed batch may cost no more
   * than its deep part.
   */
  it("keeps a mixed batch's toJSON count flat in library size and equal to its deep part", async () => {
    const measure = async (books: number) => {
      const { remote, deepWrite, deliver } = makeReceiver(books);
      const deepOnly = await deliver(() => { deepWrite("deep-only"); });
      const mixed = await deliver(() => {
        deepWrite("mixed");
        remote.set("currentBookId", "book-3");
      });

      return { deepOnly, mixed };
    };

    const small = await measure(10);
    const large = await measure(40);

    // Control (holds today): the deep route is already flat.
    expect(large.deepOnly).toBe(small.deepOnly);
    // The mixed batch: O(changed branch), not O(library).
    expect({ "mixedAt10": small.mixed, "mixedAt40": large.mixed }).toStrictEqual({
      "mixedAt10": small.deepOnly,
      "mixedAt40": large.deepOnly,
    });
  });

  it("does not serialize the hot key when the root-level write is a separate transaction in the same tick", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20);
    const spies = spyOnHotKey(receiverProgress);

    await deliver(
      () => { deepWrite("first-txn"); },
      () => { remote.set("currentBookId", "book-5"); }
    );

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("first-txn");
    expect(receiver.getState().currentBookId).toBe("book-5");
    expect(spies.hotKey).not.toHaveBeenCalled();
    expect(spies.sibling).not.toHaveBeenCalled();
    spies.restore();
  });

  /*
   * An edit inside a top-level Y.Array names a one-segment path (the array
   * key), which needs the key-scoped route — for that key. The array is the
   * only thing that should be serialized besides the deep branch.
   */
  it("does not serialize the hot key when a top-level array is edited alongside a deep change", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20);
    const deepOnly = await deliver(() => { deepWrite("warm"); });
    const spies = spyOnHotKey(receiverProgress);
    const mixed = await deliver(() => {
      deepWrite("with-array");
      (remote.get("recent") as yjs.Array<string>).insert(0, ["book-3"]);
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("with-array");
    expect(receiver.getState().recent).toStrictEqual(["book-3", "book-0", "book-1", "book-2"]);
    expect(spies.hotKey).not.toHaveBeenCalled();
    expect(spies.sibling).not.toHaveBeenCalled();
    // The deep part plus one serialization of the small top-level array.
    expect(mixed).toBeLessThanOrEqual(deepOnly + 1);
    spies.restore();
  });

  it("does not serialize the hot key when a top-level key is deleted alongside a deep change", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20);
    const spies = spyOnHotKey(receiverProgress);

    await deliver(() => {
      deepWrite("with-delete");
      remote.delete("currentBookId");
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("with-delete");
    // 'replace' hydration: a remote top-level delete reaches the store.
    expect(Object.hasOwn(receiver.getState(), "currentBookId")).toBe(false);
    expect(spies.hotKey).not.toHaveBeenCalled();
    spies.restore();
  });

  /*
   * Stores that share one named map with disjoint `syncedKeys` see each
   * other's top-level writes as root-map events. Such a write is ignored by
   * the syncedKeys gate — and must not cost this store a whole-key re-read
   * of its own hot key either.
   */
  it("does not serialize the hot key when a non-synced top-level key is written alongside a deep change", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20);
    const spies = spyOnHotKey(receiverProgress);

    await deliver(() => {
      deepWrite("foreign-neighbour");
      remote.set("otherStoresKey", "x");
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("foreign-neighbour");
    expect(Object.hasOwn(receiver.getState(), "otherStoresKey")).toBe(false);
    expect(spies.hotKey).not.toHaveBeenCalled();
    spies.restore();
  });

  it("does not serialize the hot key under `scope` when a top-level primitive is written alongside a deep change", async () => {
    const { remote, receiver, receiverProgress, deepWrite, deliver } = makeReceiver(20, { "scopeKey": "device-A" });
    const spies = spyOnHotKey(receiverProgress);

    await deliver(() => {
      deepWrite("scoped-store");
      remote.set("currentBookId", "book-3");
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("scoped-store");
    expect(receiver.getState().currentBookId).toBe("book-3");
    expect(spies.hotKey).not.toHaveBeenCalled();
    spies.restore();
  });

  // ---- Correctness guards a fix must keep (these hold today) ----

  it("notifies subscribers exactly once per mixed batch and converges on the remote doc", async () => {
    const { remote, remoteDoc, receiver, deepWrite, deliver } = makeReceiver(12);
    const before = receiver.getState();
    let notifications = 0;
    const unsubscribe = receiver.subscribe(() => { notifications = notifications + 1; });

    await deliver(
      () => {
        deepWrite("guard");
        remote.set("currentBookId", "book-3");
      },
      () => { (remote.get("recent") as yjs.Array<string>).delete(0, 1); }
    );
    unsubscribe();

    expect(notifications).toBe(1);

    const after = receiver.getState();
    const { progress, currentBookId, recent } = remoteDoc.getMap("root").toJSON() as MixedState;

    expect({ "progress": after.progress, "currentBookId": after.currentBookId, "recent": after.recent })
      .toStrictEqual({ progress, currentBookId, recent });
    // Untouched branches keep their identity.
    expect(after.progress["book-7"]).toBe(before.progress["book-7"]);
    expect(after.progress["book-3"]["device-1"]).toBe(before.progress["book-3"]["device-1"]);
  });

  it("still suppresses a top-level delete of a declared default under merge-defaults in a mixed batch", async () => {
    const { remote, receiver, deepWrite, deliver } = makeReceiver(12, { "hydration": "merge-defaults" });

    await deliver(() => {
      deepWrite("merge-defaults");
      remote.delete("recent");
    });

    expect(receiver.getState().progress["book-3"]["device-0"].cfi).toBe("merge-defaults");
    // `recent` is a declared default: its top-level delete is suppressed.
    expect(Object.hasOwn(receiver.getState(), "recent")).toBe(true);
  });
});
