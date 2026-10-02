import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/**
 * Regression: a caller's doc.transact that contains this store's own flush
 * (e.g. an atomic dual-write: `doc.transact(() => { store.setState(...);
 * handle.flush(); ... })`) and also deletes a top-level key that the flush
 * itself created in that same transaction.
 *
 * The doc ends the transaction without the key, so the store must drop it
 * too (store == doc), and later unrelated flushes must not write the key
 * back into the doc (and so to every peer).
 *
 * Yjs leaves a key that did not exist before a transaction and was added and
 * deleted inside it out of `event.changes.keys` (and a deleted key is not in
 * `map.keys()` either), so a narrowing of the caller's batch that only takes
 * candidates from those never sees the deleted key and treats the whole batch
 * as a local echo.
 *
 * History: the two full-diff variants passed before the own-flush narrowing
 * (the whole batch was taken as remote and fully patched); plain scopedDiff
 * already kept the key then, as its inbound route read the same
 * `changes.keys`.
 */

/** Run every queued microtask (inbound batch, queued outbound flush). */
const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

interface State {
  keep: number;
  draft?: string;
}

interface Variant {
  scopedDiff: boolean;
  scope?: { key: string };
}

const variants: [string, Variant][] = [
  ["full diff (default)", { scopedDiff: false }],
  ["scopedDiff", { scopedDiff: true }],
  ["scope, full diff", { scopedDiff: false, scope: { key: "device" } }],
  ["scope, scopedDiff", { scopedDiff: true, scope: { key: "device" } }],
];

beforeEach(() => {
  // The DEV tripwire samples with Math.random(): keep it out of this test.
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = 0.02;
});

describe.each(variants)(
  "a caller deletes a key its transaction's own flush created (%s)",
  (_label, { scopedDiff, scope }) => {
    const setup = () => {
      const doc = new Y.Doc();
      const store = createStore<State>(
        yjs(doc, "s", () => ({ keep: 1 }), { scopedDiff, scope }),
      );
      const handle = getYjsStoreHandle(store);
      /** The store's data map in the doc (the scope child under `scope`). */
      const dataMap = (): Y.Map<unknown> => {
        const root = doc.getMap("s");

        return scope === undefined ? root : root.get(scope.key) as Y.Map<unknown>;
      };
      const docJson = (): Record<string, unknown> => dataMap().toJSON();
      /** The store's data in a fresh peer built from the doc's update. */
      const peerJson = (): Record<string, unknown> => {
        const peer = new Y.Doc();

        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        const peerRoot = peer.getMap("s");

        return scope === undefined
          ? peerRoot.toJSON()
          : (peerRoot.get(scope.key) as Y.Map<unknown>).toJSON();
      };

      return { doc, store, handle, dataMap, docJson, peerJson };
    };

    it("drops the key from the store, and the next unrelated flush does not resurrect it", async () => {
      const { doc, store, handle, dataMap, docJson, peerJson } = setup();

      // The doc has no 'draft' before this transaction: the store's flush
      // creates it (and 'keep'), then the caller deletes it.
      doc.transact(() => {
        store.setState({ draft: "x" });
        handle.flush();
        expect(docJson()).toEqual({ keep: 1, draft: "x" });
        dataMap().delete("draft");
      });
      await flushMicrotasks();

      expect(docJson()).toEqual({ keep: 1 });
      // store == doc: the caller's deletion reaches the store.
      expect(store.getState()).toEqual({ keep: 1 });

      // An unrelated local write must not write 'draft' back.
      store.setState({ keep: 2 });
      handle.flush();
      await flushMicrotasks();

      expect(docJson()).toEqual({ keep: 2 });
      expect(peerJson()).toEqual({ keep: 2 });
      expect(store.getState()).toEqual({ keep: 2 });
    });

    it("drops the key too when the doc already holds the store and the caller has an origin", async () => {
      const { doc, store, handle, dataMap, docJson, peerJson } = setup();

      // An earlier flush: the doc (and under scope, the child) already holds
      // the store, but still no 'draft'.
      store.setState({ keep: 2 });
      handle.flush();
      expect(docJson()).toEqual({ keep: 2 });

      doc.transact(() => {
        store.setState({ draft: "x" });
        handle.flush();
        expect(docJson()).toEqual({ keep: 2, draft: "x" });
        dataMap().delete("draft");
      }, "migration");
      await flushMicrotasks();

      expect(docJson()).toEqual({ keep: 2 });
      expect(store.getState()).toEqual({ keep: 2 });

      store.setState({ keep: 3 });
      handle.flush();
      await flushMicrotasks();

      expect(docJson()).toEqual({ keep: 3 });
      expect(peerJson()).toEqual({ keep: 3 });
      expect(store.getState()).toEqual({ keep: 3 });
    });
  },
);
