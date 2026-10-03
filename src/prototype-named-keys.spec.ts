import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { getChanges } from "./diff";
import { changeType } from "./types";

/**
 * Records keyed by user content (vocabulary words, tag names, user-typed ids)
 * can legitimately contain keys that share a name with an Object.prototype
 * member: "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", ...
 *
 * Removing such a key must propagate exactly like removing any other key, in
 * both directions:
 *   - outbound: the store drops the key -> the Y.Doc drops it too;
 *   - inbound: the Y.Doc drops the key -> the store drops it too.
 *
 * A membership test that walks the prototype chain (`key in record`) still
 * reports these keys as present after the own property is gone, so the delete
 * is silently lost and the entry resurrects on peers / reloads.
 */

const PROTOTYPE_NAMED_KEYS = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
] as const;

describe("getChanges with record keys named like Object.prototype members", () => {
  it.each(PROTOTYPE_NAMED_KEYS)("emits a delete for a removed %s key", (key) => {
    expect(getChanges({ [key]: 1, a: 2 }, { a: 2 }))
      .toStrictEqual([[changeType.delete, key, undefined]]);
  });

  it.each(PROTOTYPE_NAMED_KEYS)("emits an insert for an added %s key", (key) => {
    expect(getChanges({ a: 2 }, { [key]: 1, a: 2 }))
      .toStrictEqual([[changeType.insert, key, 1]]);
  });

  it("does not treat a record with a prototype-named key as equal to one without it", () => {
    expect(getChanges([{ valueOf: 1, a: 2 }], [{ a: 2 }]))
      .toStrictEqual([[changeType.pending, 0, [[changeType.delete, "valueOf", undefined]]]]);
  });
});

/*
 * Pin the scopedDiff DEV sampling tripwire off so every run takes the same
 * code path (it is driven by Math.random()).
 */
const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

// Lets queued inbound microtasks (processBatch) run to completion.
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

interface DictState {
  dict: Record<string, number>;
  list: Record<string, number>[];
}

const makeStore = (doc: Y.Doc, scopedDiff: boolean) =>
  createStore<DictState>()(
    yjs<DictState>(
      doc,
      "s",
      () => ({ dict: {}, list: [] }),
      { disableYText: true, scopedDiff }
    )
  );

describe.each([
  { scopedDiff: false },
  { scopedDiff: true },
])("record keys named like Object.prototype members (scopedDiff: $scopedDiff)", ({ scopedDiff }) => {
  describe("outbound: deleting the key from the store deletes it from the doc", () => {
    it.each(PROTOTYPE_NAMED_KEYS)("removes %s from a record", (key) => {
      const doc = new Y.Doc();
      const store = makeStore(doc, scopedDiff);
      const handle = getYjsStoreHandle(store);

      store.setState({ dict: { [key]: 1, a: 2 } });
      handle.flush();

      expect(doc.getMap("s").toJSON().dict).toEqual({ [key]: 1, a: 2 });

      store.setState({ dict: { a: 2 } });
      handle.flush();

      expect(doc.getMap("s").toJSON().dict).toEqual({ a: 2 });
      expect(store.getState().dict).toEqual({ a: 2 });
    });

    it("removes a prototype-named key from a record inside an array element", () => {
      const doc = new Y.Doc();
      const store = makeStore(doc, scopedDiff);
      const handle = getYjsStoreHandle(store);

      store.setState({ list: [{ valueOf: 1, a: 2 }] });
      handle.flush();

      expect(doc.getMap("s").toJSON().list).toEqual([{ valueOf: 1, a: 2 }]);

      store.setState({ list: [{ a: 2 }] });
      handle.flush();

      expect(doc.getMap("s").toJSON().list).toEqual([{ a: 2 }]);
    });

    it("a reloaded peer does not resurrect the deleted entry", async () => {
      const docA = new Y.Doc();
      const storeA = makeStore(docA, scopedDiff);
      const handleA = getYjsStoreHandle(storeA);

      storeA.setState({ dict: { toString: 1, a: 2 } });
      handleA.flush();
      storeA.setState({ dict: { a: 2 } });
      handleA.flush();

      // A fresh peer (or a reload from persistence) hydrates from the doc.
      const docB = new Y.Doc();

      replicate(docA, docB);
      const storeB = makeStore(docB, scopedDiff);

      await drain();

      expect(storeB.getState().dict).toEqual({ a: 2 });
    });
  });

  describe("inbound: a remote delete of the key removes it from the store", () => {
    it("drops prototype-named keys the doc dropped", async () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const storeA = makeStore(docA, scopedDiff);
      const storeB = makeStore(docB, scopedDiff);
      const seeded = {
        hello: 1,
        valueOf: 2,
        toString: 3,
        hasOwnProperty: 4,
      };

      storeA.setState({ dict: seeded });
      getYjsStoreHandle(storeA).flush();
      replicate(docA, docB);
      await drain();

      expect(storeB.getState().dict).toEqual(seeded);

      // Remote peer A removes the entries directly on its Y.Map.
      const wordsA = docA.getMap("s").get("dict") as Y.Map<unknown>;

      docA.transact(() => {
        wordsA.delete("valueOf");
        wordsA.delete("toString");
        wordsA.delete("hasOwnProperty");
      });
      expect(wordsA.toJSON()).toEqual({ hello: 1 });

      replicate(docA, docB);
      await drain();

      expect((docB.getMap("s").get("dict") as Y.Map<unknown>).toJSON()).toEqual({ hello: 1 });
      expect(storeB.getState().dict).toEqual({ hello: 1 });
    });

    it("drops a single remotely-deleted prototype-named key", async () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const storeA = makeStore(docA, scopedDiff);
      const storeB = makeStore(docB, scopedDiff);

      storeA.setState({ dict: { hello: 1, valueOf: 2 } });
      getYjsStoreHandle(storeA).flush();
      replicate(docA, docB);
      await drain();

      expect(storeB.getState().dict).toEqual({ hello: 1, valueOf: 2 });

      (docA.getMap("s").get("dict") as Y.Map<unknown>).delete("valueOf");
      replicate(docA, docB);
      await drain();

      expect(storeB.getState().dict).toEqual({ hello: 1 });
    });

    it("a later local edit does not write the remotely-deleted key back", async () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const storeA = makeStore(docA, scopedDiff);
      const storeB = makeStore(docB, scopedDiff);

      storeA.setState({ dict: { hello: 1, valueOf: 2 } });
      getYjsStoreHandle(storeA).flush();
      replicate(docA, docB);
      await drain();

      (docA.getMap("s").get("dict") as Y.Map<unknown>).delete("valueOf");
      replicate(docA, docB);
      await drain();

      // An ordinary edit on B after the remote delete.
      storeB.setState({ dict: { ...storeB.getState().dict, world: 3 } });
      getYjsStoreHandle(storeB).flush();

      expect(docB.getMap("s").toJSON().dict).toEqual({ hello: 1, world: 3 });
      expect(storeB.getState().dict).toEqual({ hello: 1, world: 3 });
    });

    it("picks up prototype-named keys a remote peer adds", async () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const storeA = makeStore(docA, scopedDiff);
      const storeB = makeStore(docB, scopedDiff);

      storeA.setState({ dict: { hello: 1 } });
      getYjsStoreHandle(storeA).flush();
      replicate(docA, docB);
      await drain();

      // The store-action guard must not mistake an inherited
      // Object.prototype member for an action and drop the insert.
      const wordsA = docA.getMap("s").get("dict") as Y.Map<unknown>;

      docA.transact(() => {
        wordsA.set("valueOf", 2);
        wordsA.set("toString", 3);
      });
      replicate(docA, docB);
      await drain();

      expect(storeB.getState().dict).toEqual({ hello: 1, valueOf: 2, toString: 3 });
    });
  });
});
