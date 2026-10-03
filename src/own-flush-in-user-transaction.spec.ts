import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle } from ".";

/**
 * Regression: the store's own outbound write must never come back as a
 * remote (inbound) batch, even when it is flushed inside a transaction the
 * caller opened on the same doc (e.g. an atomic migration dual-write:
 * `doc.transact(() => { store.setState(...); handle.flush(); ... })`).
 *
 * Yjs reuses the outer transaction for a nested `doc.transact(fn, origin)`
 * and ignores the inner origin, so a flush inside a caller's transaction is
 * committed under the CALLER's origin. The store's own write must still be
 * recognised as local: subscribers are notified once (by the local setState),
 * and the hydration signals (hasHydrated / whenHydrated / onLoaded) are not
 * triggered by it — the doc has not been loaded from anywhere yet.
 */

/** Let every queued microtask (outbound flush, inbound batch) run. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

interface State {
  x: number;
}

const setup = (scopedDiff: boolean) => {
  const doc = new Y.Doc();
  const onLoaded = jest.fn();
  const store = createStore<State>(
    yjs(doc, "store", () => ({ x: 0 }), { onLoaded, scopedDiff }),
  );
  const handle = getYjsStoreHandle(store);
  const listener = jest.fn();
  store.subscribe(listener);

  let whenHydratedResolved = false;
  void handle.whenHydrated().then(() => {
    whenHydratedResolved = true;
  });

  return {
    doc,
    store,
    handle,
    listener,
    onLoaded,
    whenHydratedResolved: () => whenHydratedResolved,
  };
};

describe.each([
  ["full diff", false],
  ["scopedDiff", true],
])("a local write flushed inside a caller's doc.transact (%s)", (_label, scopedDiff) => {
  it("control: a plain local write + flush is not echoed back and does not hydrate", async () => {
    const { doc, store, handle, listener, onLoaded, whenHydratedResolved } = setup(scopedDiff);

    store.setState({ x: 5 });
    handle.flush();
    await drain();

    expect(doc.getMap("store").get("x")).toBe(5);
    expect(store.getState().x).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(handle.hasHydrated()).toBe(false);
    expect(whenHydratedResolved()).toBe(false);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it.each([
    ["no origin", null],
    ["a caller origin", "migration"],
  ])(
    "with %s: the store's own write is not re-applied as remote and does not flip hydration",
    async (_originLabel, origin) => {
      const { doc, store, handle, listener, onLoaded, whenHydratedResolved } = setup(scopedDiff);

      doc.transact(() => {
        store.setState({ x: 5 });
        handle.flush();
      }, origin);
      await drain();

      // Sanity: the write reached the doc and the store.
      expect(doc.getMap("store").get("x")).toBe(5);
      expect(store.getState().x).toBe(5);

      // One notification: the local setState. No echo re-applied as remote.
      expect(listener).toHaveBeenCalledTimes(1);

      // The doc was never loaded from anywhere: the store's own write must not
      // count as hydration.
      expect(handle.hasHydrated()).toBe(false);
      expect(whenHydratedResolved()).toBe(false);
      expect(onLoaded).not.toHaveBeenCalled();
    },
  );
});

/*
 * Guards against an over-broad fix: only the store's OWN write in the
 * caller's transaction is local. Whatever else the caller writes to the
 * store's map in the same transaction is still a remote change.
 */
describe.each([
  ["full diff", false],
  ["scopedDiff", true],
])("foreign writes in the same caller transaction (%s)", (_label, scopedDiff) => {
  interface TwoKeys {
    x: number;
    y: number;
    z: { a: number };
  }

  const setupTwoKeys = () => {
    const doc = new Y.Doc();
    const rootMap = doc.getMap("store");
    const store = createStore<TwoKeys>(
      yjs(doc, "store", () => ({ x: 0, y: 0, z: { a: 1 } }), { scopedDiff }),
    );
    const handle = getYjsStoreHandle(store);

    // Backfill every key so the doc holds the whole state (z as a Y.Map).
    store.setState({ x: 1, y: 1, z: { a: 1 } });
    handle.flush();

    return { doc, rootMap, store, handle };
  };

  it("a different key written by the caller after the flush reaches the store", async () => {
    const { doc, rootMap, store, handle } = setupTwoKeys();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      rootMap.set("y", 7);
    });
    await drain();

    expect(store.getState()).toEqual({ x: 5, y: 7, z: { a: 1 } });
  });

  it("the flushed key overwritten by the caller after the flush reaches the store", async () => {
    const { doc, rootMap, store, handle } = setupTwoKeys();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      rootMap.set("x", 9);
    });
    await drain();

    expect(rootMap.get("x")).toBe(9);
    expect(store.getState()).toEqual({ x: 9, y: 1, z: { a: 1 } });
  });

  it("a nested value the caller changes after the flush reaches the store", async () => {
    const { doc, rootMap, store, handle } = setupTwoKeys();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      (rootMap.get("z") as Y.Map<unknown>).set("a", 2);
    });
    await drain();

    expect(store.getState()).toEqual({ x: 5, y: 1, z: { a: 2 } });
  });

  it("a key the caller deletes after the flush is deleted from the store", async () => {
    const { doc, rootMap, store, handle } = setupTwoKeys();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      rootMap.delete("y");
    });
    await drain();

    expect(store.getState()).toEqual({ x: 5, z: { a: 1 } });
  });
});

/*
 * The narrowed keys must not be lost when the same inbound batch also holds
 * a remote deep change that would otherwise take the path-scoped route.
 */
it("scopedDiff: a narrowed batch joins a remote deep change from the same tick", async () => {
  const doc = new Y.Doc();
  const rootMap = doc.getMap("store");
  const store = createStore<{ x: number; y: number; z: { b: { c: number } } }>(
    yjs(doc, "store", () => ({ x: 0, y: 0, z: { b: { c: 1 } } }), { scopedDiff: true }),
  );
  const handle = getYjsStoreHandle(store);

  store.setState({ x: 1, y: 1, z: { b: { c: 1 } } });
  handle.flush();

  // A remote deep write (store-relative path ["z", "b"]), then, in the same
  // tick, a caller transaction mixing the store's flush with a foreign key.
  doc.transact(() => {
    ((rootMap.get("z") as Y.Map<unknown>).get("b") as Y.Map<unknown>).set("c", 2);
  }, "remote");
  doc.transact(() => {
    store.setState({ x: 5 });
    handle.flush();
    rootMap.set("y", 7);
  });
  await drain();

  expect(store.getState()).toEqual({ x: 5, y: 7, z: { b: { c: 2 } } });
});

/*
 * With `scope` + `scopedDiff`, the first scoped flush creates the store's
 * child map, which holds only the changed keys when untouched defaults stay
 * lazy (merge-defaults, or a flush made while an inbound batch is
 * unapplied). Echoed back as a remote "scoped child placed" event, that
 * child used to be patched over the whole store, deleting every key it did
 * not hold under 'replace' and notifying subscribers a second time.
 */
describe("scope + scopedDiff: a flush inside a caller's doc.transact", () => {
  interface Scoped {
    x: number;
    y: string;
    z: { a: number };
  }

  const setupScoped = (hydration?: "merge-defaults") => {
    const doc = new Y.Doc();
    const rootMap = doc.getMap("store");

    rootMap.set("devOther", new Y.Map<unknown>([["x", 1]]));

    const store = createStore<Scoped>(
      yjs(doc, "store", () => ({ x: 0, y: "hello", z: { a: 1 } }), {
        scopedDiff: true,
        scope: { key: "devMine" },
        disableYText: true,
        hydration,
      }),
    );
    const handle = getYjsStoreHandle(store);

    handle.markHydrated();

    return { doc, rootMap, store, handle };
  };

  /*
   * Under the default 'replace' hydration the first scoped flush backfills
   * every key, so the child it creates is complete; under merge-defaults the
   * untouched defaults stay lazy and the child holds only the changed key.
   * Either way the echo must not be patched back over the store.
   */
  it.each([
    ["replace", undefined, { x: 5, y: "hello", z: { a: 1 } }],
    ["merge-defaults", "merge-defaults" as const, { x: 5 }],
  ])("that creates the child keeps the keys the partial child does not hold (%s)", async (_label, hydration, child) => {
    const { doc, rootMap, store, handle } = setupScoped(hydration);
    const listener = jest.fn();

    store.subscribe(listener);

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
    }, "batch");
    await drain();

    expect((rootMap.get("devMine") as Y.Map<unknown>).toJSON()).toEqual(child);
    expect(store.getState()).toEqual({ x: 5, y: "hello", z: { a: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("that creates the child still applies what the caller wrote into it", async () => {
    const { doc, rootMap, store, handle } = setupScoped();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      (rootMap.get("devMine") as Y.Map<unknown>).set("y", "remote");
    }, "batch");
    await drain();

    expect(store.getState()).toEqual({ x: 5, y: "remote", z: { a: 1 } });
  });

  it("into an existing child is not echoed, and the caller's write into it applies", async () => {
    const { doc, rootMap, store, handle } = setupScoped();

    store.setState({ x: 1 });
    handle.flush();

    const listener = jest.fn();

    store.subscribe(listener);

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
    }, "batch");
    await drain();

    expect(listener).toHaveBeenCalledTimes(1);

    doc.transact(() => {
      store.setState({ x: 6 });
      handle.flush();
      (rootMap.get("devMine") as Y.Map<unknown>).set("y", "remote");
    }, "batch");
    await drain();

    expect(store.getState()).toEqual({ x: 6, y: "remote", z: { a: 1 } });
  });

  it("then a caller replacing the child is applied like any remote replacement", async () => {
    const replaceChild = (rootMap: Y.Map<unknown>) => {
      rootMap.set("devMine", new Y.Map<unknown>([["x", 9]]));
    };

    // Reference: the same replacement in its own transaction after the flush.
    const reference = setupScoped();

    reference.store.setState({ x: 5 });
    reference.handle.flush();
    reference.doc.transact(() => replaceChild(reference.rootMap), "batch");
    await drain();

    const { doc, rootMap, store, handle } = setupScoped();

    doc.transact(() => {
      store.setState({ x: 5 });
      handle.flush();
      replaceChild(rootMap);
    }, "batch");
    await drain();

    expect(store.getState().x).toBe(9);
    expect(store.getState()).toEqual(reference.store.getState());
  });
});
