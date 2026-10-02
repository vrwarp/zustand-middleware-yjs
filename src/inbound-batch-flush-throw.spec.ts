/**
 * Regression: an error thrown by the outbound flush that an inbound batch
 * runs first must not wedge inbound sync for the rest of the session.
 *
 * When a foreign transaction and a local set() land in the same tick, the
 * inbound batch flushes the pending local write before it applies the doc to
 * state. That flush can throw: another observer on the doc throws once during
 * the flush transaction (doc.transact rethrows it), or the state holds a value
 * Yjs cannot store (a BigInt: "Unexpected content type"). The error may
 * surface, but the store must keep receiving remote changes: the inbound
 * batch itself and every later remote update still reach the store, so the
 * store converges with the doc once the cause is gone.
 *
 * Ordering is explicit: remote updates are captured from a separate peer doc
 * and applied to the local doc by hand, synchronously, right before the local
 * write; `settle()` drains every queued microtask. The seed write is drained
 * with `settle()`, not handle.flush(): a manual flush leaves its stale
 * outbound microtask queued, and that one would run the local write's flush
 * ahead of the inbound batch instead of from inside it. Errors thrown from
 * queueMicrotask callbacks are reported by jsdom to the window "error" event;
 * they are collected there so they do not fail the test on their own.
 */
import { createStore } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { __scopedDiffDevSampling } from ".";

/** Drains all pending microtasks (outbound flushes and inbound batches). */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const uncaught: unknown[] = [];
const onWindowError = (event: ErrorEvent): void => {
  uncaught.push(event.error);
  event.preventDefault();
};

const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  // The DEV tripwire samples with Math.random(): pin it off.
  __scopedDiffDevSampling.rate = 0;
  window.addEventListener("error", onWindowError);
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
  window.removeEventListener("error", onWindowError);
});

beforeEach(() => {
  uncaught.length = 0;
});

/**
 * A remote peer doc seeded from `local`. `edit` changes the peer's map and
 * returns the resulting update, to be delivered to `local` by hand.
 */
const createRemote = (local: Y.Doc, mapName: string) => {
  const remote = new Y.Doc();

  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));

  const edit = (key: string, value: number): Uint8Array => {
    const before = Y.encodeStateVector(remote);

    remote.getMap(mapName).set(key, value);

    return Y.encodeStateAsUpdate(remote, before);
  };

  return { edit };
};

const modes: [string, boolean][] = [
  ["legacy full diff", false],
  ["scopedDiff", true],
];

describe.each(modes)("an inbound batch whose pre-flush throws (%s)", (_label, scopedDiff) => {
  it("keeps applying remote changes after another observer throws once during the flush", async () => {
    interface State { a: number; b: number; c: number }

    const local = new Y.Doc();
    const store = createStore<State>()(
      yjs(local, "s", () => ({ "a": 0, "b": 0, "c": 0 }), { scopedDiff })
    );

    store.setState({ "a": 1, "b": 1, "c": 1 });
    await settle();
    expect(local.getMap("s").toJSON()).toEqual({ "a": 1, "b": 1, "c": 1 });

    const remote = createRemote(local, "s");

    // Another consumer of the doc that fails once, on the next local
    // transaction it sees (here: the flush the inbound batch runs).
    let armed = false;

    local.getMap("s").observeDeep((_events, transaction) => {
      if (armed && transaction.local) {
        armed = false;
        throw new Error("transient observer failure");
      }
    });

    // Same tick: a remote change lands, then a local write.
    Y.applyUpdate(local, remote.edit("c", 5), "remote");
    armed = true;
    store.setState({ "a": 2 });

    await settle();

    // The observer did throw on the in-batch flush, and the error surfaced.
    expect(armed).toBe(false);
    expect(uncaught).not.toHaveLength(0);

    // A later remote change, after the transient error is long gone.
    Y.applyUpdate(local, remote.edit("b", 7), "remote");

    await settle();

    expect(local.getMap("s").toJSON()).toEqual({ "a": 2, "b": 7, "c": 5 });
    // HEAD: the store stays at { a: 2, b: 1, c: 1 } for good.
    expect(store.getState()).toEqual({ "a": 2, "b": 7, "c": 5 });
  });

  it("keeps applying remote changes after a BigInt the flush cannot store is corrected", async () => {
    interface State { b: number; c: number; big?: bigint | null }

    const local = new Y.Doc();
    const store = createStore<State>()(
      yjs(local, "s", (): State => ({ "b": 0, "c": 0 }), { scopedDiff })
    );

    store.setState({ "b": 1, "c": 1 });
    await settle();
    expect(local.getMap("s").toJSON()).toEqual({ "b": 1, "c": 1 });

    const remote = createRemote(local, "s");

    // Same tick: a remote change lands, then a local write Yjs rejects.
    Y.applyUpdate(local, remote.edit("c", 5), "remote");
    store.setState({ "big": BigInt(10) });

    await settle();

    // The flush did fail (Yjs stored nothing), and the error surfaced.
    expect(local.getMap("s").has("big")).toBe(false);
    expect(uncaught).not.toHaveLength(0);

    // The app corrects the bad value; this flush succeeds.
    store.setState({ "big": null });

    await settle();

    // A later remote change.
    Y.applyUpdate(local, remote.edit("b", 7), "remote");

    await settle();

    expect(local.getMap("s").toJSON()).toEqual({ "b": 7, "c": 5, "big": null });
    // HEAD: the store stays at { b: 1, c: 1, big: null } for good.
    expect(store.getState()).toEqual({ "b": 7, "c": 5, "big": null });
  });
});
