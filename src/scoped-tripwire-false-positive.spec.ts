/*
 * Regression: the DEV scopedDiff divergence tripwire must only fire on a
 * genuine mutate-in-place write. It must NOT throw for an immutable store
 * whose doc is legitimately ahead of the store (a remote change whose inbound
 * microtask has not run yet) or whose state holds a NaN (NaN !== NaN).
 *
 * The sampling rate is pinned to 1 so the check runs on every flush; at the
 * default rate (0.02) the same false positives fire randomly, ~1 flush in 50.
 * handle.flush() drains the outbound batch synchronously, so a tripwire error
 * surfaces as a throw from flush() — deterministic, no timers involved.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

afterEach(() => {
  __scopedDiffDevSampling.rate = 0.02; // restore the default
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

describe("scopedDiff DEV tripwire — no false positives for immutable stores", () => {
  it("does not throw when a remote top-level update lands between set() and the flush", async () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { a: number; b: number }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "a": 1, "b": 1 }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    // Seed the doc so both keys exist on both sides.
    store.setState({ "a": 1, "b": 1 });
    handle.flush();

    // Immutable local write to `a`, then (same tick, before the inbound
    // microtask runs) a remote peer's write to `b` reaches the doc.
    store.setState({ "a": 2 });
    doc.transact(() => {
      doc.getMap("s").set("b", 99);
    }, "remote-origin");

    expect(() => {
      handle.flush();
    }).not.toThrow();

    // The inbound batch brings the remote change in; doc and store agree.
    await Promise.resolve();
    expect(store.getState()).toEqual({ "a": 2, "b": 99 });
    expect(doc.getMap("s").toJSON()).toEqual({ "a": 2, "b": 99 });
  });

  it("does not raise an uncaught error from the automatic (microtask) flush in the same race", async () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { a: number; b: number }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "a": 1, "b": 1 }), { "scopedDiff": true })
    );

    const uncaught = await collectUncaught(async () => {
      store.setState({ "a": 1, "b": 1 });
      getYjsStoreHandle(store).flush();

      // No manual flush: the outbound microtask (queued first by setState)
      // runs before the inbound microtask queued by the remote transaction.
      store.setState({ "a": 2 });
      doc.transact(() => {
        doc.getMap("s").set("b", 99);
      }, "remote-origin");

      await Promise.resolve();
      await Promise.resolve();
    });

    expect(uncaught.map(String)).toEqual([]);
    expect(store.getState()).toEqual({ "a": 2, "b": 99 });
    expect(doc.getMap("s").toJSON()).toEqual({ "a": 2, "b": 99 });
  });

  it("does not raise an uncaught error when a provider update and a set() settle in the same tick", async () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { a: number; b: number }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "a": 1, "b": 1 }), { "scopedDiff": true })
    );

    store.setState({ "a": 1, "b": 1 });
    getYjsStoreHandle(store).flush();

    // A real peer that has seen the seed, then edits `b`.
    const peer = new yjs.Doc();

    yjs.applyUpdate(peer, yjs.encodeStateAsUpdate(doc));
    peer.getMap("s").set("b", 99);
    const update = yjs.encodeStateAsUpdate(peer, yjs.encodeStateVector(doc));

    // Two async sources settle in one microtask checkpoint: the app's own
    // action, and a provider (y-idb, a network sync) delivering the update.
    const uncaught = await collectUncaught(async () => {
      await Promise.all([
        Promise.resolve().then(() => {
          store.setState({ "a": 2 });
        }),
        Promise.resolve().then(() => {
          yjs.applyUpdate(doc, update, "provider");
        }),
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(uncaught.map(String)).toEqual([]);
    expect(store.getState()).toEqual({ "a": 2, "b": 99 });
    expect(doc.getMap("s").toJSON()).toEqual({ "a": 2, "b": 99 });
  });

  it("does not throw when a remote nested delete lands between set() and the flush", async () => {
    __scopedDiffDevSampling.rate = 1;

    interface State {
      progress: Record<string, { cfi: string }>;
      other: number;
    }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(
        doc,
        "s",
        (): State => ({
          "progress": { "book-1": { "cfi": "a" }, "book-2": { "cfi": "b" } },
          "other": 0,
        }),
        { "disableYText": true, "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    // Seed the doc with both top-level keys.
    store.setState((state) => ({ "progress": { ...state.progress }, "other": 1 }));
    handle.flush();

    // Immutable local write to a DIFFERENT top-level key; meanwhile a remote
    // peer deletes progress["book-2"] before the inbound microtask runs.
    store.setState({ "other": 2 });
    const progressMap = doc.getMap("s").get("progress") as yjs.Map<unknown>;

    doc.transact(() => {
      progressMap.delete("book-2");
    }, "remote-origin");

    expect(() => {
      handle.flush();
    }).not.toThrow();

    await Promise.resolve();
    expect(store.getState().progress).toEqual({ "book-1": { "cfi": "a" } });
    expect(doc.getMap("s").toJSON()).toEqual({
      "progress": { "book-1": { "cfi": "a" } },
      "other": 2,
    });
  });

  it("does not throw for a NaN value written immutably inside a nested record", () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { stats: { pct: number } }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "stats": { "pct": 0 } }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    // e.g. a progress percentage computed as 0 / 0 for an empty book.
    store.setState({ "stats": { "pct": 0 / 0 } });
    expect(() => {
      handle.flush();
    }).not.toThrow();

    expect(Number.isNaN(store.getState().stats.pct)).toBe(true);
    expect(Number.isNaN((doc.getMap("s").toJSON() as State).stats.pct)).toBe(true);
  });

  it("does not throw for a NaN value written immutably at the top level", () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { ratio: number; other: number }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "ratio": 0, "other": 0 }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "ratio": Number.NaN });
    expect(() => {
      handle.flush();
    }).not.toThrow();

    // A later flush of an unrelated key must not trip on the stored NaN.
    store.setState({ "other": 1 });
    expect(() => {
      handle.flush();
    }).not.toThrow();

    expect(Number.isNaN(store.getState().ratio)).toBe(true);
    expect(doc.getMap("s").get("ratio")).toBeNaN();
  });

  it("does not throw for a NaN array element written immutably", () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { samples: number[] }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(doc, "s", () => ({ "samples": [1] }), { "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "samples": [1, Number.NaN] });
    expect(() => {
      handle.flush();
    }).not.toThrow();

    expect((doc.getMap("s").get("samples") as yjs.Array<number>).toJSON()).toEqual([1, Number.NaN]);
  });

  it("still catches a mutate-in-place write once the pending inbound batch has run", async () => {
    __scopedDiffDevSampling.rate = 1;

    interface State { a: number; b: number; items: Record<string, { n: number }> }

    const doc = new yjs.Doc();
    const store = createStore<State>()(
      yjsMiddleware(
        doc,
        "s",
        (): State => ({ "a": 1, "b": 1, "items": { "x": { "n": 1 } } }),
        { "scopedDiff": true }
      )
    );
    const handle = getYjsStoreHandle(store);

    store.setState((state) => ({ "items": { ...state.items } }));
    handle.flush();

    // The race from above: quiet while the remote change is pending.
    store.setState({ "a": 2 });
    doc.transact(() => {
      doc.getMap("s").set("b", 99);
    }, "remote-origin");
    expect(() => {
      handle.flush();
    }).not.toThrow();
    await Promise.resolve();

    // Non-idiomatic mutate-in-place write (same `items` reference).
    store.setState((state) => {
      state.items.x.n = 2;

      return { "items": state.items };
    });
    expect(() => {
      handle.flush();
    }).toThrow(/scopedDiff divergence tripwire/);
  });
});
