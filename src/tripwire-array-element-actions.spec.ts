/*
 * Regression: the DEV scopedDiff divergence tripwire must not report a
 * divergence for store actions (function-valued keys) or prototype-named keys
 * that live INSIDE ARRAY ELEMENTS. Such keys are never stored in the doc
 * (objectToYMap / toJsonElement skip functions and "constructor" /
 * "prototype" / "__proto__"), so their absence from the doc is by design, at
 * every depth — exactly as it already is for the equivalent record shape.
 *
 * Since the scoped flush backfills keys that are declared in the initial
 * state but absent from the map, an array that is merely declared (never
 * written by any set()) reaches the doc on the first flush, so the false
 * positive fires on ANY sampled flush, not only after the array is written.
 *
 * The sampling rate is pinned to 1 so the check runs on every flush; at the
 * default rate (0.02) the same false positive fires randomly, ~1 flush in 50.
 * handle.flush() drains the outbound batch synchronously, so a tripwire error
 * surfaces as a throw from flush() — deterministic, no timers involved.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

let savedRate: number;

beforeEach(() => {
  savedRate = __scopedDiffDevSampling.rate;
  __scopedDiffDevSampling.rate = 1;
});

afterEach(() => {
  __scopedDiffDevSampling.rate = savedRate;
});

/**
 * Runs `body` while collecting errors thrown from queueMicrotask callbacks:
 * jsdom reports those to the window "error" event (uncaught) instead of
 * propagating them to the caller.
 */
const collectUncaught = async (body: () => Promise<void>): Promise<unknown[]> => {
  const uncaught: unknown[] = [];
  const onError = (event: ErrorEvent): void => {
    uncaught.push(event.error);
    event.preventDefault();
  };

  window.addEventListener("error", onError);

  try {
    await body();
  } finally {
    window.removeEventListener("error", onError);
  }

  return uncaught;
};

interface Item {
  id: number;
  onClick: () => number;
}

interface ItemsState {
  items: Item[];
  n: number;
}

describe("scopedDiff DEV tripwire — actions inside array elements are not divergence", () => {
  it("does not throw from flush() when an untouched declared array holds an element with an action", () => {
    const doc = new yjs.Doc();
    const store = createStore<ItemsState>()(
      yjsMiddleware(
        doc,
        "m",
        () => ({ "items": [{ "id": 1, "onClick": () => 1 }], "n": 0 }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    // An unrelated, immutable write. `items` is never set().
    store.setState({ "n": 1 });

    expect(() => {
      handle.flush();
    }).not.toThrow();

    // The action is not replicated; everything else is.
    expect(doc.getMap("m").toJSON()).toEqual({ "items": [{ "id": 1 }], "n": 1 });
  });

  it("does not raise an uncaught error from the automatic (microtask) flush", async () => {
    const doc = new yjs.Doc();
    const store = createStore<ItemsState>()(
      yjsMiddleware(
        doc,
        "m",
        () => ({ "items": [{ "id": 1, "onClick": () => 1 }], "n": 0 }),
        { "scopedDiff": true }
      )
    );

    const uncaught = await collectUncaught(async () => {
      store.setState({ "n": 1 });

      // Let the queued outbound flush run on its own.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(uncaught.map(String)).toEqual([]);
    expect(store.getState().n).toBe(1);
    expect(doc.getMap("m").toJSON()).toEqual({ "items": [{ "id": 1 }], "n": 1 });
  });

  it("does not throw from flush() when an immutable set() writes array elements that hold actions", () => {
    const doc = new yjs.Doc();
    const store = createStore<ItemsState>()(
      yjsMiddleware(doc, "m", () => ({ "items": [] as Item[], "n": 0 }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "items": [{ "id": 1, "onClick": () => 1 }, { "id": 2, "onClick": () => 2 }] });

    expect(() => {
      handle.flush();
    }).not.toThrow();
    expect(doc.getMap("m").toJSON()).toEqual({ "items": [{ "id": 1 }, { "id": 2 }], "n": 0 });
  });

  it("does not throw from flush() for an action inside an array element nested under a record", () => {
    interface NestedState {
      lists: Record<string, Item[]>;
      n: number;
    }

    const doc = new yjs.Doc();
    const store = createStore<NestedState>()(
      yjsMiddleware(
        doc,
        "m",
        (): NestedState => ({ "lists": { "a": [{ "id": 1, "onClick": () => 1 }] }, "n": 0 }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "n": 1 });

    expect(() => {
      handle.flush();
    }).not.toThrow();
    expect(doc.getMap("m").toJSON()).toEqual({ "lists": { "a": [{ "id": 1 }] }, "n": 1 });
  });

  it("does not throw from flush() when an array element holds a prototype-named key", () => {
    interface Entry {
      id: number;
      constructor: string;
    }
    interface EntriesState {
      entries: Entry[];
      n: number;
    }

    const doc = new yjs.Doc();
    const store = createStore<EntriesState>()(
      yjsMiddleware(
        doc,
        "m",
        () => ({ "entries": [{ "id": 1, "constructor": "Widget" }], "n": 0 }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "n": 1 });

    expect(() => {
      handle.flush();
    }).not.toThrow();
    expect(doc.getMap("m").toJSON()).toEqual({ "entries": [{ "id": 1 }], "n": 1 });
  });

  it("pairs doc elements with the stored form when the array also holds a function element", () => {
    interface MixedState {
      items: (Item | (() => number))[];
      n: number;
    }

    const doc = new yjs.Doc();
    const store = createStore<MixedState>()(
      yjsMiddleware(
        doc,
        "m",
        (): MixedState => ({ "items": [() => 0, { "id": 1, "onClick": () => 1 }], "n": 0 }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "n": 1 });

    expect(() => {
      handle.flush();
    }).not.toThrow();
    // The function element is dropped, so the record is the doc's element 0.
    expect(doc.getMap("m").toJSON()).toEqual({ "items": [{ "id": 1 }], "n": 1 });
  });

  it("control: the equivalent record shape (action under a record key) passes", () => {
    interface RecordState {
      items: Record<string, Item>;
      n: number;
    }

    const doc = new yjs.Doc();
    const store = createStore<RecordState>()(
      yjsMiddleware(
        doc,
        "m",
        (): RecordState => ({ "items": { "a": { "id": 1, "onClick": () => 1 } }, "n": 0 }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "n": 1 });

    expect(() => {
      handle.flush();
    }).not.toThrow();
    expect(doc.getMap("m").toJSON()).toEqual({ "items": { "a": { "id": 1 } }, "n": 1 });
  });

  it("still catches a genuine mutate-in-place write inside an array element", () => {
    interface Row { id: number; label: string; onClick: () => number }
    interface RowsState { rows: Row[]; n: number }

    const doc = new yjs.Doc();
    const store = createStore<RowsState>()(
      yjsMiddleware(doc, "m", () => ({ "rows": [] as Row[], "n": 0 }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    // Disable the tripwire for the seed write so this case does not depend
    // on the false positive above.
    __scopedDiffDevSampling.rate = 0;
    store.setState({ "rows": [{ "id": 1, "label": "a", "onClick": () => 1 }] });
    handle.flush();
    __scopedDiffDevSampling.rate = 1;

    // Non-idiomatic mutate-in-place write: invisible to Object.is.
    store.setState((s) => {
      s.rows[0].label = "drifted";
      return { "rows": s.rows };
    });

    expect(() => {
      handle.flush();
    }).toThrow(/scopedDiff divergence tripwire/);
  });

  it("still catches a mutate-in-place push of an element that holds an action", () => {
    const doc = new yjs.Doc();
    const store = createStore<ItemsState>()(
      yjsMiddleware(doc, "m", () => ({ "items": [] as Item[], "n": 0 }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    __scopedDiffDevSampling.rate = 0;
    store.setState({ "items": [{ "id": 1, "onClick": () => 1 }] });
    handle.flush();
    __scopedDiffDevSampling.rate = 1;

    // The state array grows past the doc's: an unpaired element is drift.
    store.setState((s) => {
      s.items.push({ "id": 2, "onClick": () => 2 });
      return { "items": s.items };
    });

    expect(() => {
      handle.flush();
    }).toThrow(/scopedDiff divergence tripwire/);
  });
});
