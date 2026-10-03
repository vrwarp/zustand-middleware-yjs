import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs from ".";

/**
 * Regression: a key in the shared Y.Map whose name matches a store ACTION
 * (a function-valued state key) must never replace that action with data.
 *
 * Functions are never replicated outbound, so the doc can only carry such a
 * key through schema drift (an older client stored a data field under that
 * name) or another writer on the same map. Inbound patching must leave the
 * action alone; otherwise the store's action becomes plain data and calling
 * it throws a TypeError. Nothing outbound would ever repair it either,
 * because function values are skipped on the way out.
 */

interface CounterState {
  count: number;
  increment: () => void;
}

type SetCounter = (fn: (state: CounterState) => Partial<CounterState>) => void;

const creator = (set: SetCounter): CounterState => ({
  count: 0,
  increment: () => { set((state) => ({ count: state.count + 1 })); },
});

/**
 * Inbound remote changes are applied in a queued microtask; a zero-delay
 * macrotask runs strictly after all pending microtasks, so this is an
 * ordering guarantee rather than a timing race.
 */
const flushInbound = (): Promise<void> =>
  new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const REMOTE = "remote-writer";

describe("a remote map key named like a store action does not replace the action", () => {
  it("keeps the action a function when a remote transaction sets that key to data", async () => {
    const doc = new Y.Doc();
    const store = createStore<CounterState>()(yjs(doc, "counter", creator));

    // Populate the doc with the store's data first (count = 1).
    store.getState().increment();
    await flushInbound();
    expect(doc.getMap("counter").toJSON()).toEqual({ count: 1 });

    doc.transact(() => {
      doc.getMap("counter").set("increment", 5);
    }, REMOTE);
    await flushInbound();

    expect(typeof store.getState().increment).toBe("function");
    expect(() => { store.getState().increment(); }).not.toThrow();
    expect(store.getState().count).toBe(2);

    // The colliding key is ignored locally, not deleted or overwritten in the doc.
    await flushInbound();
    expect(doc.getMap("counter").toJSON()).toEqual({ count: 2, increment: 5 });
  });

  it("keeps the action a function when a remote replica's update carries that key", async () => {
    // An older client version where "increment" was a data field.
    const legacy = new Y.Doc();

    legacy.transact(() => {
      const map = legacy.getMap("counter");

      map.set("count", 3);
      map.set("increment", { step: 2 });
    });

    const doc = new Y.Doc();
    const store = createStore<CounterState>()(yjs(doc, "counter", creator));

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(legacy));
    await flushInbound();

    // Legitimate data still flows in...
    expect(store.getState().count).toBe(3);
    // ...but the action is untouched.
    expect(typeof store.getState().increment).toBe("function");
    store.getState().increment();
    expect(store.getState().count).toBe(4);
  });

  it("keeps the action a function when the doc already holds that key at store creation", () => {
    const doc = new Y.Doc();

    doc.transact(() => {
      const map = doc.getMap("counter");

      map.set("count", 7);
      map.set("increment", 5);
    }, REMOTE);

    const store = createStore<CounterState>()(yjs(doc, "counter", creator));

    expect(store.getState().count).toBe(7);
    expect(typeof store.getState().increment).toBe("function");
    store.getState().increment();
    expect(store.getState().count).toBe(8);
  });

  it("keeps the action a function on the scopedDiff inbound route", async () => {
    const doc = new Y.Doc();
    const store = createStore<CounterState>()(
      yjs(doc, "counter", creator, { scopedDiff: true }),
    );

    store.getState().increment();
    await flushInbound();
    expect(doc.getMap("counter").toJSON()).toEqual({ count: 1 });

    doc.transact(() => {
      doc.getMap("counter").set("increment", 5);
    }, REMOTE);
    await flushInbound();

    expect(typeof store.getState().increment).toBe("function");
    store.getState().increment();
    expect(store.getState().count).toBe(2);

    await flushInbound();
    expect(doc.getMap("counter").toJSON()).toEqual({ count: 2, increment: 5 });
  });

  it("keeps the action a function on the scopedDiff deep-path inbound route", async () => {
    const doc = new Y.Doc();
    const store = createStore<CounterState>()(
      yjs(doc, "counter", creator, { scopedDiff: true }),
    );

    store.getState().increment();
    await flushInbound();

    const inner = new Y.Map<unknown>();

    doc.transact(() => {
      const increment = new Y.Map<unknown>();

      increment.set("inner", inner);
      doc.getMap("counter").set("increment", increment);
    }, REMOTE);
    await flushInbound();

    // An edit two levels below the store root takes the path-scoped route.
    doc.transact(() => {
      inner.set("x", 1);
    }, REMOTE);
    await flushInbound();

    expect(typeof store.getState().increment).toBe("function");
    store.getState().increment();
    expect(store.getState().count).toBe(2);
  });
});

/**
 * The same guarantee for a function nested inside a record (the Issue 37
 * shape): data replicated under the function's key never replaces it, while
 * the record's other fields keep syncing.
 */
interface NestedState {
  count: number;
  nested: { fn: () => string; v: number };
}

const nestedCreator = (): NestedState => ({
  count: 0,
  nested: { fn: () => "x", v: 1 },
});

describe("a remote nested key named like a nested function does not replace it", () => {
  it("keeps the nested function on the full inbound route", async () => {
    const doc = new Y.Doc();
    const store = createStore<NestedState>()(yjs(doc, "nested", nestedCreator));

    store.setState({ count: 1 });
    await flushInbound();
    expect(doc.getMap("nested").toJSON()).toEqual({ count: 1, nested: { v: 1 } });

    doc.transact(() => {
      const nested = doc.getMap("nested").get("nested") as Y.Map<unknown>;

      nested.set("fn", 5);
      nested.set("v", 2);
    }, REMOTE);
    await flushInbound();

    expect(typeof store.getState().nested.fn).toBe("function");
    expect(store.getState().nested.fn()).toBe("x");
    expect(store.getState().nested.v).toBe(2);
  });

  it("keeps the nested function on the scopedDiff deep-path inbound route", async () => {
    const doc = new Y.Doc();
    const store = createStore<NestedState>()(
      yjs(doc, "nested", nestedCreator, { scopedDiff: true }),
    );

    // The scoped flush writes only changed keys, so touch `nested` too.
    store.setState((state) => ({ count: 1, nested: { ...state.nested } }));
    await flushInbound();
    expect(doc.getMap("nested").toJSON()).toEqual({ count: 1, nested: { v: 1 } });

    const fn = new Y.Map<unknown>();

    doc.transact(() => {
      (doc.getMap("nested").get("nested") as Y.Map<unknown>).set("fn", fn);
    }, REMOTE);
    await flushInbound();
    expect(typeof store.getState().nested.fn).toBe("function");

    // An event whose path ends exactly at the function's key.
    doc.transact(() => {
      fn.set("x", 1);
    }, REMOTE);
    await flushInbound();

    expect(typeof store.getState().nested.fn).toBe("function");
    expect(store.getState().nested.fn()).toBe("x");
    expect(store.getState().nested.v).toBe(1);
  });
});
