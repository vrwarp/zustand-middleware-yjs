import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { getYjsStoreHandle } from ".";
import { getChanges } from "./diff";

/*
 * NaN is a legal, serializable number (lib0 encodes it as float64 and it
 * round-trips through a Y.Doc as NaN), and it shows up in real stores, e.g.
 * `progress = read / total` with `total === 0`, or `parseFloat("")`.
 *
 * Because `NaN !== NaN`, a value that has NOT changed must still be treated
 * as unchanged. Otherwise every legacy full-tree flush re-writes the NaN key
 * (or array element) with a fresh Yjs item, and that redundant write wins the
 * last-writer-wins conflict against a concurrent remote edit whenever this
 * client has the higher clientID.
 */

type Store = {
  pct: number;
  samples: number[];
  other: number;
  setPct: (pct: number) => void;
  setSamples: (samples: number[]) => void;
  setOther: (other: number) => void;
};

const MAP_NAME = "p";

const createPeer = (clientID: number) => {
  const doc = new Y.Doc();

  doc.clientID = clientID;

  const store = createVanilla<Store>(
    yjs(doc, MAP_NAME, (set) => ({
      pct: Number.NaN,
      samples: [Number.NaN],
      other: 0,
      setPct: (pct) => set({ pct }),
      setSamples: (samples) => set({ samples }),
      setOther: (other) => set({ other }),
    }))
  );

  return { doc, store };
};

/**
 * Drain queued microtasks (inbound batches are delivered via queueMicrotask).
 * Each exchange needs at most one inbound hop per peer, so 5 leaves margin.
 */
const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

/** Exchange the updates each doc has that the other lacks (both directions at once). */
const exchange = (left: Y.Doc, right: Y.Doc): void => {
  const leftToRight = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right));
  const rightToLeft = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left));

  Y.applyUpdate(right, leftToRight, "remote");
  Y.applyUpdate(left, rightToLeft, "remote");
};

/**
 * Two peers whose docs both already hold { pct: NaN, samples: [NaN], other: 0 }.
 * A has the higher clientID, so A wins any concurrent same-key conflict.
 */
const createSyncedPeers = async () => {
  const a = createPeer(2);
  const b = createPeer(1);

  // A's first set() writes the full tree into its (empty) doc.
  a.store.getState().setOther(0);
  getYjsStoreHandle(a.store).flush();

  exchange(a.doc, b.doc);
  await drainMicrotasks();

  const mapA = a.doc.getMap(MAP_NAME);
  const mapB = b.doc.getMap(MAP_NAME);

  // Preconditions: the NaN values round-trip through the doc and reach B.
  expect(mapA.get("pct")).toBeNaN();
  expect(mapB.get("pct")).toBeNaN();
  expect((mapB.get("samples") as Y.Array<number>).toJSON()).toEqual([Number.NaN]);
  expect(b.store.getState().pct).toBeNaN();

  return { a, b, mapA, mapB };
};

describe("NaN values are compared as equal to themselves", () => {
  it("getChanges reports no changes for an unchanged NaN record value or array element", () => {
    expect(getChanges({ pct: Number.NaN }, { pct: Number.NaN })).toEqual([]);
    expect(getChanges([Number.NaN], [Number.NaN])).toEqual([]);
    expect(getChanges({ nested: { samples: [1, Number.NaN] } }, { nested: { samples: [1, Number.NaN] } })).toEqual([]);
  });

  it("keeps 0 and -0 equal and still aligns arrays that mix NaN with other values", () => {
    // NaN-awareness must not come from Object.is, which would split 0 and -0.
    expect(getChanges({ x: 0 }, { x: -0 })).toEqual([]);
    expect(getChanges([0], [-0])).toEqual([]);
    // A NaN element is matched like any other value, never mis-aligned.
    expect(getChanges([Number.NaN, 1], [1])).toEqual([["delete", 0, undefined]]);
    expect(getChanges([1], [Number.NaN, 1])).toEqual([["insert", 0, Number.NaN]]);
    expect(getChanges([Number.NaN], [0.5])).toEqual([["update", 0, 0.5]]);
  });

  it("a legacy flush of an unrelated key does not re-write unchanged NaN values in the doc", async () => {
    const { a, mapA } = await createSyncedPeers();

    const touched: string[] = [];

    mapA.observeDeep((events) => {
      for (const event of events) {
        if (event.path.length === 0) {
          for (const key of event.changes.keys.keys()) {
            touched.push(key);
          }
        } else {
          touched.push(event.path.join("."));
        }
      }
    });

    a.store.getState().setOther(1);
    getYjsStoreHandle(a.store).flush();

    expect(mapA.get("other")).toBe(1);
    // Only `other` changed; the NaN-valued `pct` and `samples[0]` must not be re-written.
    expect(touched).toEqual(["other"]);
  });

  it("an inbound batch that does not touch NaN values keeps their branches' identity", async () => {
    const { a, b } = await createSyncedPeers();
    const samplesBefore = b.store.getState().samples;

    a.store.getState().setOther(3);
    getYjsStoreHandle(a.store).flush();

    exchange(a.doc, b.doc);
    await drainMicrotasks();

    expect(b.store.getState().other).toBe(3);
    // The inbound patch only changed `other`; the NaN array is not re-created.
    expect(b.store.getState().samples).toBe(samplesBefore);
  });

  it("an unrelated local write does not overwrite a concurrent remote edit of a NaN-valued key", async () => {
    const { a, b, mapA, mapB } = await createSyncedPeers();

    // Concurrent, offline from each other: B edits pct, A edits an unrelated key.
    b.store.getState().setPct(0.5);
    a.store.getState().setOther(2);
    getYjsStoreHandle(b.store).flush();
    getYjsStoreHandle(a.store).flush();

    exchange(a.doc, b.doc);
    await drainMicrotasks();

    // A never touched pct, so B's edit must survive the merge on both sides.
    expect(mapB.get("pct")).toBe(0.5);
    expect(mapA.get("pct")).toBe(0.5);
    expect(a.store.getState().pct).toBe(0.5);
    expect(b.store.getState().pct).toBe(0.5);
    expect(a.store.getState().other).toBe(2);
    expect(b.store.getState().other).toBe(2);
  });

  it("an unrelated local write does not duplicate a concurrently replaced NaN array element", async () => {
    const { a, b, mapA, mapB } = await createSyncedPeers();

    // Concurrent: B replaces the NaN sample, A edits an unrelated key.
    b.store.getState().setSamples([0.5]);
    a.store.getState().setOther(2);
    getYjsStoreHandle(b.store).flush();
    getYjsStoreHandle(a.store).flush();

    exchange(a.doc, b.doc);
    await drainMicrotasks();

    // A never touched samples, so B's replacement is the only change.
    expect((mapA.get("samples") as Y.Array<number>).toJSON()).toEqual([0.5]);
    expect((mapB.get("samples") as Y.Array<number>).toJSON()).toEqual([0.5]);
    expect(a.store.getState().samples).toEqual([0.5]);
    expect(b.store.getState().samples).toEqual([0.5]);
  });
});
