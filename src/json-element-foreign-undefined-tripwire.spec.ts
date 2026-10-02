/*
 * Regression: the DEV scopedDiff divergence tripwire must not fire for a
 * `jsonElementKeys` element that a foreign (or legacy) writer stored with an
 * `undefined` nested inside an array.
 *
 * Elements of a `jsonElementKeys` array are plain JSON values (ContentAny),
 * and lib0 keeps `undefined` inside such values, both locally and after an
 * encode/decode round trip. The library's own writes normalize a nested
 * undefined to null, but another writer can store e.g. `[[undefined]]`. The
 * store then holds a copy of that element, and the tripwire's full
 * doc-vs-state diff must see the two as equal: a later, unrelated scoped
 * flush that never touches the array is not a divergence. The legacy
 * full-tree diff does not throw for the same doc, and must not rewrite the
 * element on every flush either.
 *
 * The same holds for a foreign plain JSON value stored directly under a map
 * key: the inbound patch may store its nested undefined as null in state,
 * and the doc's undefined must still compare equal to it.
 *
 * The sampling rate is pinned to 1 so the tripwire runs on every flush.
 * handle.flush() drains the outbound batch synchronously, so a tripwire
 * error surfaces as a throw from flush(); the inbound batch is drained by
 * awaiting microtasks explicitly. No timers are involved.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

const originalSamplingRate = __scopedDiffDevSampling.rate;

afterEach(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

interface State {
  [key: string]: unknown;
  n: number;
}

const newDoc = (clientID: number): yjs.Doc => {
  const doc = new yjs.Doc();

  doc.clientID = clientID;

  return doc;
};

/** Lets the middleware's inbound (microtask) batch run. */
const drainMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

/**
 * Creates a seeded, flushed store, then lets a foreign writer (another
 * client, or an older build) edit the doc's map through raw Yjs and drains
 * the inbound batch.
 */
const setupWithForeignWrite = async (
  initialState: State,
  options: { jsonElementKeys: string[]; scopedDiff: boolean },
  write: (map: yjs.Map<unknown>) => void
) => {
  __scopedDiffDevSampling.rate = 1;

  const doc = newDoc(1);
  const store = createStore<State>()(
    yjsMiddleware<State>(doc, "m", (): State => initialState, options)
  );
  const handle = getYjsStoreHandle(store);

  // A new doc, synced and empty: hydrated, so the seed flush writes every
  // declared key under scopedDiff too.
  handle.markHydrated();
  store.setState({ "n": 1 });
  handle.flush();

  const remote = newDoc(2);

  yjs.applyUpdate(remote, yjs.encodeStateAsUpdate(doc));
  write(remote.getMap("m"));
  yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(remote, yjs.encodeStateVector(doc)), "remote-origin");
  await drainMicrotasks();

  return { doc, handle, "map": doc.getMap("m"), store };
};

/**
 * Two unrelated writes (n = 2, n = 3), each flushed on its own. Neither may
 * throw; returns how many doc events touched `key` during the SECOND flush
 * (the first may normalize a value once, the second must find it stable).
 */
const flushUnrelatedWrites = (
  { handle, map, store }: Awaited<ReturnType<typeof setupWithForeignWrite>>,
  key: string
): number => {
  store.setState({ "n": 2 });

  expect(() => {
    handle.flush();
  }).not.toThrow();
  expect(map.get("n")).toBe(2);

  let keyEvents = 0;
  const observer = (events: yjs.YEvent<yjs.AbstractType<unknown>>[]): void => {
    for (const event of events) {
      if (event.target !== map || event.changes.keys.has(key)) {
        keyEvents += 1;
      }
    }
  };

  map.observeDeep(observer);
  store.setState({ "n": 3 });

  expect(() => {
    handle.flush();
  }).not.toThrow();

  map.unobserveDeep(observer);
  expect(map.get("n")).toBe(3);

  return keyEvents;
};

describe.each([
  ["scopedDiff", true],
  ["legacy full-tree diff", false],
])("jsonElementKeys element with a nested undefined from a foreign writer (%s)", (unused, isScopedDiff) => {
  it("does not trip the DEV divergence tripwire on a later unrelated flush", async () => {
    const setup = await setupWithForeignWrite(
      { "items": [{ "id": 1 }], "n": 0 },
      { "jsonElementKeys": ["items"], "scopedDiff": isScopedDiff },
      (map) => {
        // A plain JSON element holding an undefined nested inside an array.
        (map.get("items") as yjs.Array<unknown>).insert(1, [[[undefined]]]);
      }
    );

    expect((setup.store.getState().items as unknown[]).length).toBe(2);
    expect(flushUnrelatedWrites(setup, "items")).toBe(0);
  });

  it("does not trip it for a record element whose field holds such an array", async () => {
    const setup = await setupWithForeignWrite(
      { "items": [{ "id": 1 }], "n": 0 },
      { "jsonElementKeys": ["items"], "scopedDiff": isScopedDiff },
      (map) => {
        (map.get("items") as yjs.Array<unknown>).insert(1, [{ "tags": [undefined] }]);
      }
    );

    expect((setup.store.getState().items as unknown[]).length).toBe(2);
    expect(flushUnrelatedWrites(setup, "items")).toBe(0);
  });

  it("control: the same element in an array outside jsonElementKeys does not trip it", async () => {
    const setup = await setupWithForeignWrite(
      { "items": [{ "id": 1 }], "n": 0 },
      { "jsonElementKeys": [], "scopedDiff": isScopedDiff },
      (map) => {
        (map.get("items") as yjs.Array<unknown>).insert(1, [[[undefined]]]);
      }
    );

    expect((setup.store.getState().items as unknown[]).length).toBe(2);
    expect(flushUnrelatedWrites(setup, "items")).toBe(0);
  });

  it("does not trip it for a foreign plain JSON map value that replaces a synced key", async () => {
    const setup = await setupWithForeignWrite(
      { "data": { "a": [1] }, "n": 0 },
      { "jsonElementKeys": [], "scopedDiff": isScopedDiff },
      (map) => {
        map.set("data", { "a": [undefined] });
      }
    );

    // The inbound batch has run (in whichever form state keeps the element).
    expect((setup.store.getState().data as { a: unknown[] }).a[0] ?? null).toBeNull();
    expect(flushUnrelatedWrites(setup, "data")).toBe(0);
  });
});
