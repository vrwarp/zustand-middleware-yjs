import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

/**
 * Regression: a flush made inside a caller's doc.transact must not ignore
 * what the caller already wrote to the store's map EARLIER in that same
 * transaction (a migration, server-side or helper write that runs before
 * the flush, atomically).
 *
 * Yjs runs observers only when the outermost transaction ends, so at flush
 * time the caller's write is already in the doc but not yet in state, and no
 * inbound batch is pending. The flush must treat it like any other foreign
 * change state has not seen yet:
 * - the full diff (legacy mode) must not write the stale state value back
 *   over it (it used to revert the caller's write silently);
 * - under scopedDiff the DEV divergence tripwire must not report it as
 *   drift (it used to throw out of flush() and abort the caller's
 *   transaction, although nothing mutated state in place).
 */

/** Let every queued microtask (outbound flush, inbound batch) run. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

interface State {
  a: number;
  b: number;
  z: { c: number };
}

const originalSamplingRate = __scopedDiffDevSampling.rate;

afterEach(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

describe.each([
  ["full diff", false, 0],
  ["scopedDiff, tripwire off", true, 0],
  ["scopedDiff, tripwire always sampled", true, 1],
])("a flush after the caller's own write in the same doc.transact (%s)", (_label, scopedDiff, rate) => {
  const setup = async () => {
    __scopedDiffDevSampling.rate = rate;

    const doc = new Y.Doc();
    const rootMap = doc.getMap("m");
    const store = createStore<State>(
      yjs(doc, "m", () => ({ a: 1, b: 1, z: { c: 1 } }), { scopedDiff })
    );
    const handle = getYjsStoreHandle(store);

    // The doc holds the whole state (z as a nested Y.Map).
    store.setState({ a: 2, b: 2, z: { c: 2 } });
    await drain();
    expect(rootMap.toJSON()).toEqual({ a: 2, b: 2, z: { c: 2 } });

    return { doc, rootMap, store, handle };
  };

  it("keeps a top-level key the caller wrote before the flush", async () => {
    const { doc, rootMap, store, handle } = await setup();
    let ranAfterFlush = false;

    expect(() => {
      doc.transact(() => {
        rootMap.set("b", 5);
        store.setState({ a: 3 });
        handle.flush();
        ranAfterFlush = true;
      });
    }).not.toThrow();
    await drain();

    expect(ranAfterFlush).toBe(true);
    expect(rootMap.toJSON()).toEqual({ a: 3, b: 5, z: { c: 2 } });
    expect(store.getState()).toEqual({ a: 3, b: 5, z: { c: 2 } });
  });

  it("keeps a nested value the caller wrote before the flush", async () => {
    const { doc, rootMap, store, handle } = await setup();
    let ranAfterFlush = false;

    expect(() => {
      doc.transact(() => {
        (rootMap.get("z") as Y.Map<unknown>).set("c", 7);
        store.setState({ a: 3 });
        handle.flush();
        ranAfterFlush = true;
      }, "migration");
    }).not.toThrow();
    await drain();

    expect(ranAfterFlush).toBe(true);
    expect(rootMap.toJSON()).toEqual({ a: 3, b: 2, z: { c: 7 } });
    expect(store.getState()).toEqual({ a: 3, b: 2, z: { c: 7 } });
  });

  it("keeps a caller write made before flushing a batch set earlier in the tick", async () => {
    const { doc, rootMap, store, handle } = await setup();

    store.setState({ a: 3 });
    expect(() => {
      doc.transact(() => {
        rootMap.set("b", 5);
        handle.flush();
      });
    }).not.toThrow();
    await drain();

    expect(rootMap.toJSON()).toEqual({ a: 3, b: 5, z: { c: 2 } });
    expect(store.getState()).toEqual({ a: 3, b: 5, z: { c: 2 } });
  });

  it("keeps a top-level key the caller deleted before the flush deleted", async () => {
    const { doc, rootMap, store, handle } = await setup();

    expect(() => {
      doc.transact(() => {
        rootMap.delete("b");
        store.setState({ a: 3 });
        handle.flush();
      });
    }).not.toThrow();
    await drain();

    expect(rootMap.toJSON()).toEqual({ a: 3, z: { c: 2 } });
    expect(store.getState()).toEqual({ a: 3, z: { c: 2 } });
  });
});
