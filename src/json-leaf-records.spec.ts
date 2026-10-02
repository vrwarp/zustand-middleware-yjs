/*
 * Cold-start floor: immutable leaf records stored as nested Y.Maps.
 *
 * The middleware deep-maps every object to a Y.Map with one Yjs item per
 * field. For append-only, never-edited records — versicle's
 * `progress.<book>.<device>.readingSessions[]` — field-level CRDT merging
 * buys nothing, but each record costs one ContentType item plus one keyed
 * item per field (6 structs for a 5-field session), and each record a trim
 * removes leaves 2 permanent structs (the deleted wrapper item plus the
 * merged GC run of its fields) instead of 1. That multiplies struct count,
 * snapshot bytes, Yjs decode at every app launch, and the hydration
 * `toJSON` walk, which calls `Y.Map#toJSON` once per record.
 *
 * The fix is opt-in: `jsonElementKeys: string[]`. Arrays under a listed
 * key keep being Y.Arrays (appends and splices still merge at element
 * level), but their object/array ELEMENTS are stored as plain JSON values
 * (ContentAny) and replaced wholesale when they change.
 *
 * The counter tests below failed before the option existed (it was ignored,
 * so every record was a Y.Map). The "contract" tests passed then and must
 * keep passing: both representations must hold the same state, and old
 * Y.Map elements must keep working. The invariant tests pin what a JSON
 * element must be: diff-equal to its state (an unchanged element is never
 * rewritten, whatever non-JSON values it holds), identical to what peers
 * decode, and never shared with store state.
 *
 * Every cost is pinned with structural counters (Yjs struct counts, update
 * bytes with pinned client IDs, toJSON call counts) or scaling ratios — no
 * wall-clock thresholds. The DEV scopedDiff tripwire is pinned off because
 * it serializes the whole map at random.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle, type YjsOptions } from ".";

interface Session {
  cfiRange: string;
  startTime: number;
  endTime: number;
  type: string;
  label: string;
}

interface DeviceProgress {
  currentCfi: string;
  lastRead: number;
  readingSessions: Session[];
}

interface ProgressState {
  progress: Record<string, Record<string, DeviceProgress>>;
}

type JsonLeafOptions = YjsOptions;

const SESSION_FIELDS = 5;

const makeSession = (n: number): Session => ({
  "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0),epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:80)`,
  "startTime": 1_700_000_000_000 + (n * 60_000),
  "endTime": 1_700_000_000_000 + (n * 60_000) + 45_000,
  "type": n % 5 === 0 ? "tts" : "page",
  "label": `Chapter ${String(n % 30)}: section ${String(n)}`,
});

const makeSessions = (from: number, count: number): Session[] =>
  Array.from({ "length": count }, (unused, index) => makeSession(from + index));

const baseOptions = (isScopedDiff: boolean, isJsonLeaves: boolean): JsonLeafOptions => ({
  "disableYText": true,
  "scopedDiff": isScopedDiff,
  "syncedKeys": ["progress"],
  ...(isJsonLeaves ? { "jsonElementKeys": ["readingSessions"] } : {}),
});

const makeProgressStore = (
  doc: yjs.Doc,
  sessions: Session[],
  options: JsonLeafOptions
): StoreApi<ProgressState> =>
  createStore<ProgressState>()(
    yjsMiddleware<ProgressState>(
      doc,
      "progress",
      (): ProgressState => ({
        "progress": {
          "book-0": {
            "device-0": { "currentCfi": "epubcfi(/6/4!/4/0:0)", "lastRead": 0, "readingSessions": sessions },
          },
        },
      }),
      options
    )
  );

const flush = (store: StoreApi<ProgressState>): void => {
  getYjsStoreHandle(store).flush();
};

/** Immutable update of the single device branch. */
const updateDevice = (
  store: StoreApi<ProgressState>,
  update: (device: DeviceProgress) => DeviceProgress
): void => {
  store.setState((state) => {
    const perBook = state.progress["book-0"];

    return {
      "progress": {
        ...state.progress,
        "book-0": { ...perBook, "device-0": update(perBook["device-0"]) },
      },
    };
  });
};

/** Writes the declared defaults (the first flush is triggered by a set). */
const writeInitialState = (store: StoreApi<ProgressState>): void => {
  updateDevice(store, (device) => ({ ...device }));
  flush(store);
};

/** A versicle page turn: rewrite position fields, append one session, cap 500 -> 300. */
const pageTurn = (store: StoreApi<ProgressState>, n: number): void => {
  updateDevice(store, (device) => {
    let sessions = [...device.readingSessions, makeSession(n)];

    if (sessions.length > 500) {
      sessions = sessions.slice(-300);
    }

    return {
      ...device,
      "currentCfi": `epubcfi(/6/4!/4/${String(n)}:0)`,
      "lastRead": n,
      "readingSessions": sessions,
    };
  });
  flush(store);
};

const countStructs = (doc: yjs.Doc): number => {
  let count = 0;

  doc.store.clients.forEach((structs) => {
    count = count + structs.length;
  });

  return count;
};

/** Structs that are tombstones (deleted Items and GC runs). */
const countTombstones = (doc: yjs.Doc): number => {
  let count = 0;

  doc.store.clients.forEach((structs) => {
    for (const struct of structs) {
      if (struct.deleted) {
        count = count + 1;
      }
    }
  });

  return count;
};

const sessionsArray = (doc: yjs.Doc): yjs.Array<unknown> => {
  const progress = doc.getMap("progress").get("progress") as yjs.Map<unknown>;
  const perBook = progress.get("book-0") as yjs.Map<unknown>;
  const perDevice = perBook.get("device-0") as yjs.Map<unknown>;

  return perDevice.get("readingSessions") as yjs.Array<unknown>;
};

const newDoc = (clientID: number): yjs.Doc => {
  const doc = new yjs.Doc();

  doc.clientID = clientID;

  return doc;
};

const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each([
  ["scopedDiff", true],
  ["legacy full-tree diff", false],
])("jsonElementKeys struct cost (%s)", (unused, isScopedDiff) => {
  it("stores records under a listed key as plain JSON elements, not Y.Maps", () => {
    const doc = newDoc(1);
    const store = makeProgressStore(doc, makeSessions(0, 10), baseOptions(isScopedDiff, true));

    writeInitialState(store);
    pageTurn(store, 1_000);

    const elements = sessionsArray(doc).toArray();

    expect(elements).toHaveLength(11);
    // Without the option: all 11 elements are Y.Maps.
    expect(elements.filter((element) => element instanceof yjs.AbstractType).length).toBe(0);
    expect(store.getState().progress["book-0"]["device-0"].readingSessions).toEqual(sessionsArray(doc).toJSON());
  });

  it("an appended record adds at most one Yjs struct (without the option: 1 + one per field)", () => {
    const doc = newDoc(1);
    const store = makeProgressStore(doc, makeSessions(0, 20), baseOptions(isScopedDiff, true));

    writeInitialState(store);

    const deltas: number[] = [];

    for (let index = 0; index < 10; index = index + 1) {
      const before = countStructs(doc);

      // Append-only write: no other field changes, so every new struct is the record's.
      updateDevice(store, (device) => ({
        ...device,
        "readingSessions": [...device.readingSessions, makeSession(5_000 + index)],
      }));
      flush(store);
      deltas.push(countStructs(doc) - before);
    }

    // Without the option every delta is 1 + SESSION_FIELDS = 6.
    expect(Math.max(...deltas)).toBeLessThanOrEqual(1);
  });

  it("bulk-written records cost at most one struct each (scaling ratio n vs 4n)", () => {
    const structsFor = (records: number): number => {
      const doc = newDoc(1);
      const store = makeProgressStore(doc, makeSessions(0, records), baseOptions(isScopedDiff, true));

      writeInitialState(store);

      return countStructs(doc);
    };

    const n = 50;
    const perRecord = (structsFor(4 * n) - structsFor(n)) / (3 * n);

    // Without the option: exactly 1 + SESSION_FIELDS = 6 structs per record.
    expect(perRecord).toBeLessThanOrEqual(1);
  });
});

describe("jsonElementKeys tombstones, bytes and hydration work", () => {
  it("a 500 -> 300 trim leaves at most one tombstone per removed record (without the option: 2)", () => {
    const doc = newDoc(1);
    const store = makeProgressStore(doc, [], baseOptions(true, true));

    writeInitialState(store);

    // 500 sessions, each appended by its own page turn (as on a real device).
    for (let turn = 1; turn <= 500; turn = turn + 1) {
      pageTurn(store, turn);
    }
    expect(sessionsArray(doc).length).toBe(500);

    const tombstonesBefore = countTombstones(doc);

    // Append-only write that trips the cap: 201 head records are removed.
    updateDevice(store, (device) => ({
      ...device,
      "readingSessions": [...device.readingSessions, makeSession(9_999)].slice(-300),
    }));
    flush(store);
    expect(sessionsArray(doc).length).toBe(300);

    const tombstonesPerRemoved = (countTombstones(doc) - tombstonesBefore) / 201;

    expect(tombstonesPerRemoved).toBeLessThanOrEqual(1);
  });

  it("the same page-turn history encodes to a smaller snapshot (pinned client IDs)", () => {
    const snapshotBytes = (isJsonLeaves: boolean): number => {
      const doc = newDoc(7);
      const store = makeProgressStore(doc, makeSessions(0, 100), baseOptions(true, isJsonLeaves));

      writeInitialState(store);
      for (let turn = 1; turn <= 300; turn = turn + 1) {
        pageTurn(store, 1_000 + turn);
      }

      return yjs.encodeStateAsUpdate(doc).byteLength;
    };

    const ratio = snapshotBytes(true) / snapshotBytes(false);

    // Without the option the ratio is 1. Field keys and per-item
    // headers are no longer encoded once per field per record.
    expect(ratio).toBeLessThanOrEqual(0.9);
  });

  it("cold-start hydration Y.Map#toJSON calls do not grow with the record count", () => {
    const hydrationMapToJsonCalls = (records: number): number => {
      const writerDoc = newDoc(1);
      const writerStore = makeProgressStore(writerDoc, makeSessions(0, records), baseOptions(true, true));

      writeInitialState(writerStore);
      for (let turn = 1; turn <= 20; turn = turn + 1) {
        pageTurn(writerStore, 1_000 + turn);
      }

      // App launch: the persisted doc is loaded, then the store attaches.
      const launchDoc = newDoc(2);

      yjs.applyUpdate(launchDoc, yjs.encodeStateAsUpdate(writerDoc));

      const spy = jest.spyOn(yjs.Map.prototype, "toJSON");
      const launched = makeProgressStore(launchDoc, [], baseOptions(true, true));
      const calls = spy.mock.calls.length;

      spy.mockRestore();
      expect(launched.getState().progress["book-0"]["device-0"].readingSessions).toHaveLength(records + 20);

      return calls;
    };

    const n = 40;

    // Without the option: one extra Y.Map#toJSON per record (3n here).
    expect(hydrationMapToJsonCalls(4 * n) - hydrationMapToJsonCalls(n)).toBe(0);
  });

  it("a page turn's outbound flush and inbound patch do not serialize every record", async () => {
    const mapToJsonCallsPerTurn = async (records: number): Promise<number> => {
      const senderDoc = newDoc(1);
      const sender = makeProgressStore(senderDoc, makeSessions(0, records), baseOptions(true, true));

      writeInitialState(sender);

      const receiverDoc = newDoc(2);

      yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(senderDoc));

      const receiver = makeProgressStore(receiverDoc, [], baseOptions(true, true));

      senderDoc.on("update", (update: Uint8Array) => {
        yjs.applyUpdate(receiverDoc, update);
      });

      const spy = jest.spyOn(yjs.Map.prototype, "toJSON");

      const before = receiver.getState().progress;

      // One page turn: outbound flush on the sender, then drain the
      // receiver's microtask-batched inbound patch.
      pageTurn(sender, 77_777);
      await Promise.resolve();

      const calls = spy.mock.calls.length;

      spy.mockRestore();
      expect(receiver.getState().progress).not.toBe(before);
      expect(receiver.getState().progress).toEqual(sender.getState().progress);

      return calls;
    };

    const n = 40;
    const small = await mapToJsonCallsPerTurn(n);
    const large = await mapToJsonCallsPerTurn(4 * n);

    // Without the option both sides call toJSON on every Y.Map element of the array (2 x 3n here).
    expect(large - small).toBe(0);
  });
});

/*
 * Contract guards: these passed before the option existed (it was ignored,
 * so both stores were identical) and must keep passing with it.
 */
describe("jsonElementKeys contract (both representations hold the same state)", () => {
  type Operation =
    | { kind: "append"; count: number }
    | { kind: "trimHead"; keep: number }
    | { kind: "removeAt"; at: number; count: number }
    | { kind: "replaceAt"; at: number }
    | { kind: "editAt"; at: number }
    | { kind: "turn" };

  const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
    fc.record({ "kind": fc.constant("append" as const), "count": fc.integer({ "min": 1, "max": 30 }) }),
    fc.record({ "kind": fc.constant("trimHead" as const), "keep": fc.integer({ "min": 0, "max": 40 }) }),
    fc.record({
      "kind": fc.constant("removeAt" as const),
      "at": fc.nat({ "max": 60 }),
      "count": fc.integer({ "min": 1, "max": 25 }),
    }),
    fc.record({ "kind": fc.constant("replaceAt" as const), "at": fc.nat({ "max": 60 }) }),
    fc.record({ "kind": fc.constant("editAt" as const), "at": fc.nat({ "max": 60 }) }),
    fc.record({ "kind": fc.constant("turn" as const) })
  );

  const applyOperation = (sessions: Session[], operation: Operation, seed: number): Session[] => {
    const at = sessions.length === 0 ? 0 : ("at" in operation ? operation.at % sessions.length : 0);

    switch (operation.kind) {
      case "append": {
        return [...sessions, ...makeSessions(seed, operation.count)];
      }
      case "trimHead": {
        return operation.keep === 0 ? [] : sessions.slice(-operation.keep);
      }
      case "removeAt": {
        return [...sessions.slice(0, at), ...sessions.slice(at + operation.count)];
      }
      case "replaceAt": {
        return sessions.length === 0
          ? sessions
          : sessions.map((session, index) => (index === at ? makeSession(seed) : session));
      }
      case "editAt": {
        return sessions.length === 0
          ? sessions
          : sessions.map((session, index) => (index === at ? { ...session, "label": `edited ${String(seed)}` } : session));
      }
      default: {
        return [...sessions, makeSession(seed)];
      }
    }
  };

  it.each([
    ["scopedDiff", true],
    ["legacy full-tree diff", false],
  ])("writers and cold-started readers agree for append/splice/replace sequences (%s)", (unused, isScopedDiff) => {
    fc.assert(
      fc.property(
        fc.integer({ "min": 0, "max": 40 }),
        fc.array(operationArbitrary, { "minLength": 1, "maxLength": 12 }),
        (initialCount, operations) => {
          const initial = makeSessions(0, initialCount);
          const jsonDoc = newDoc(1);
          const mapDoc = newDoc(1);
          const jsonStore = makeProgressStore(jsonDoc, initial, baseOptions(isScopedDiff, true));
          const mapStore = makeProgressStore(mapDoc, initial, baseOptions(isScopedDiff, false));

          writeInitialState(jsonStore);
          writeInitialState(mapStore);

          let expected = initial;

          operations.forEach((operation, step) => {
            expected = applyOperation(expected, operation, 10_000 * (step + 1));

            const next = expected;

            for (const store of [jsonStore, mapStore]) {
              updateDevice(store, (device) => ({ ...device, "lastRead": step, "readingSessions": next }));
              flush(store);
            }
          });

          expect(jsonDoc.getMap("progress").toJSON()).toEqual(mapDoc.getMap("progress").toJSON());
          expect(sessionsArray(jsonDoc).toJSON()).toEqual(expected);
          expect(jsonStore.getState().progress).toEqual(mapStore.getState().progress);

          // Cold start from the JSON-leaf doc, as a launch with y-idb would.
          const launchDoc = newDoc(2);

          yjs.applyUpdate(launchDoc, yjs.encodeStateAsUpdate(jsonDoc));

          const launched = makeProgressStore(launchDoc, [], baseOptions(isScopedDiff, true));

          expect(launched.getState().progress).toEqual(jsonStore.getState().progress);
        }
      ),
      { "numRuns": 40 }
    );
  });

  it("concurrent appends from two devices converge with the option on both", async () => {
    const docA = newDoc(1);
    const storeA = makeProgressStore(docA, makeSessions(0, 5), baseOptions(true, true));

    writeInitialState(storeA);

    const docB = newDoc(2);

    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA));

    const storeB = makeProgressStore(docB, [], baseOptions(true, true));

    // Both append while offline, then exchange updates.
    pageTurn(storeA, 100);
    pageTurn(storeA, 101);
    pageTurn(storeB, 200);

    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA, yjs.encodeStateVector(docB)));
    yjs.applyUpdate(docA, yjs.encodeStateAsUpdate(docB, yjs.encodeStateVector(docA)));
    // Drain both stores' microtask-batched inbound patches.
    await Promise.resolve();

    const sessionsA = storeA.getState().progress["book-0"]["device-0"].readingSessions;
    const sessionsB = storeB.getState().progress["book-0"]["device-0"].readingSessions;

    expect(sessionsA).toHaveLength(8);
    expect(sessionsA).toEqual(sessionsB);
    expect(sessionsA).toEqual(sessionsArray(docA).toJSON());
    expect(sessionsB).toEqual(sessionsArray(docB).toJSON());
  });

  it("a doc written with Y.Map elements keeps working for a client using the option", async () => {
    const oldDoc = newDoc(1);
    const oldStore = makeProgressStore(oldDoc, makeSessions(0, 30), baseOptions(true, false));

    writeInitialState(oldStore);

    const newClientDoc = newDoc(2);

    yjs.applyUpdate(newClientDoc, yjs.encodeStateAsUpdate(oldDoc));

    const newStore = makeProgressStore(newClientDoc, [], baseOptions(true, true));

    expect(newStore.getState().progress).toEqual(oldStore.getState().progress);

    // Append, edit an old element, and trim the head through the new client.
    updateDevice(newStore, (device) => ({
      ...device,
      "readingSessions": [
        ...device.readingSessions.slice(5).map((session, index) => (index === 0 ? { ...session, "label": "edited" } : session)),
        makeSession(500),
      ],
    }));
    flush(newStore);

    const expected = newStore.getState().progress["book-0"]["device-0"].readingSessions;

    expect(sessionsArray(newClientDoc).toJSON()).toEqual(expected);

    yjs.applyUpdate(oldDoc, yjs.encodeStateAsUpdate(newClientDoc, yjs.encodeStateVector(oldDoc)));
    await Promise.resolve();
    expect(oldStore.getState().progress["book-0"]["device-0"].readingSessions).toEqual(expected);
  });
});

describe("baseline: the cost the option removes (Y.Map elements)", () => {
  it("documents the per-record struct cost without the option: 1 + one per field, and 2 tombstones per trimmed record", () => {
    const doc = newDoc(1);
    const store = makeProgressStore(doc, [], baseOptions(true, false));

    writeInitialState(store);
    for (let turn = 1; turn <= 500; turn = turn + 1) {
      pageTurn(store, turn);
    }

    const before = countStructs(doc);

    updateDevice(store, (device) => ({ ...device, "readingSessions": [...device.readingSessions, makeSession(9_000)] }));
    flush(store);
    expect(countStructs(doc) - before).toBe(1 + SESSION_FIELDS);

    const tombstonesBefore = countTombstones(doc);

    updateDevice(store, (device) => ({ ...device, "readingSessions": device.readingSessions.slice(-300) }));
    flush(store);
    expect((countTombstones(doc) - tombstonesBefore) / 201).toBe(2);
  });
});

/*
 * What a stored JSON element must be. A first prototype cleaned elements
 * with JSON.parse(JSON.stringify(...)) and handed the doc's own element
 * objects to store state: an element holding an undefined field (or NaN, a
 * Date, a function...) then never matched its state and was rewritten on
 * every flush, and mutating a hydrated element in place changed the local
 * doc without a Yjs operation, so replicas diverged.
 */
describe("jsonElementKeys element invariants", () => {
  class Bookmark {
    public at: number;

    public constructor(at: number) {
      this.at = at;
    }

    public describe(): string {
      return `at ${String(this.at)}`;
    }
  }

  interface ListState {
    list: Record<string, unknown>[];
    n: number;
  }

  /** Every kind of value JSON cannot represent or the doc stores differently from state. */
  const makeOddRecord = (n: number): Record<string, unknown> => ({
    "id": n,
    "label": n % 2 === 0 ? undefined : `chapter ${String(n)}`,
    "score": Number.NaN,
    "ceiling": Number.POSITIVE_INFINITY,
    "floor": Number.NEGATIVE_INFINITY,
    "offset": -0,
    "at": new Date(1_700_000_000_000 + n),
    "format": { "render": () => "x", "size": n },
    "constructor": "a key named constructor",
    "bookmark": new Bookmark(n),
    "tags": ["a", undefined, () => 1, [undefined]],
    "bytes": new Uint8Array([1, 2, n % 256]),
  });

  /** One kind of non-JSON value per case, so each churn source shows on its own. */
  const oddFields: [string, (n: number) => Record<string, unknown>][] = [
    ["an undefined optional field", (n) => ({ "label": n % 2 === 0 ? undefined : `chapter ${String(n)}` })],
    ["NaN", () => ({ "score": Number.NaN })],
    ["Infinity and -Infinity", () => ({ "ceiling": Number.POSITIVE_INFINITY, "floor": Number.NEGATIVE_INFINITY })],
    ["-0", () => ({ "offset": -0 })],
    ["a Date", (n) => ({ "at": new Date(1_700_000_000_000 + n) })],
    ["a nested function", (n) => ({ "format": { "render": () => "x", "size": n } })],
    ["a key named constructor", () => ({ "constructor": "a key named constructor" })],
    ["a class instance", (n) => ({ "bookmark": new Bookmark(n) })],
    ["a nested array holding undefined and a function", () => ({ "tags": ["a", undefined, () => 1, [undefined]] })],
    ["a Uint8Array", (n) => ({ "bytes": new Uint8Array([1, 2, n % 256]) })],
  ];

  /** What objectToYMap(makeOddRecord(n)).toJSON() reads back. */
  const storedOddRecord = (n: number): Record<string, unknown> => ({
    "id": n,
    "label": n % 2 === 0 ? undefined : `chapter ${String(n)}`,
    "score": Number.NaN,
    "ceiling": Number.POSITIVE_INFINITY,
    "floor": Number.NEGATIVE_INFINITY,
    "offset": -0,
    "at": {},
    "format": { "size": n },
    "bookmark": { "at": n },
    "tags": ["a", null, [null]],
    "bytes": { "0": 1, "1": 2, "2": n % 256 },
  });

  const makeListStore = (
    doc: yjs.Doc,
    list: Record<string, unknown>[],
    isScopedDiff: boolean,
    isJsonLeaves = true
  ): StoreApi<ListState> =>
    createStore<ListState>()(
      yjsMiddleware<ListState>(
        doc,
        "list",
        (): ListState => ({ list, "n": 0 }),
        {
          "disableYText": true,
          "scopedDiff": isScopedDiff,
          ...(isJsonLeaves ? { "jsonElementKeys": ["list"] } : {}),
        }
      )
    );

  const listArray = (doc: yjs.Doc): yjs.Array<unknown> => doc.getMap("list").get("list") as yjs.Array<unknown>;

  /** Items in a Y.Array's list, deleted ones included: a rewrite adds a tombstone and an item. */
  const countArrayItems = (yarray: yjs.Array<unknown>): number => {
    let count = 0;

    for (let item = yarray._start; item !== null; item = item.right) {
      count = count + 1;
    }

    return count;
  };

  /** The doc JSON and the JSON of a peer that decoded the whole doc. */
  const decodedCopyJson = (doc: yjs.Doc, name: string): unknown => {
    const decoded = newDoc(99);

    yjs.applyUpdate(decoded, yjs.encodeStateAsUpdate(doc));

    return decoded.getMap(name).toJSON();
  };

  describe.each([
    ["scopedDiff", true],
    ["legacy full-tree diff", false],
  ])("(%s)", (unused, isScopedDiff) => {
    it.each(oddFields)("never rewrites an unchanged element holding %s; an append adds exactly one struct", (unusedKind, odd) => {
      const makeRecord = (n: number): Record<string, unknown> => ({ "id": n, ...odd(n) });

      const run = (isJsonLeaves: boolean): yjs.Doc => {
        const doc = newDoc(1);
        const store = makeListStore(doc, Array.from({ "length": 20 }, (unusedElement, index) => makeRecord(index)), isScopedDiff, isJsonLeaves);
        const handle = getYjsStoreHandle(store);

        store.setState({ "n": 1 });
        handle.flush();

        const yarray = listArray(doc);

        for (let step = 0; step < 10; step = step + 1) {
          // Odd steps append a record; even steps only write an unrelated key.
          const isAppend = step % 2 === 1;
          const elementsBefore = yarray.toArray();
          const itemsBefore = countArrayItems(yarray);
          const updates: Uint8Array[] = [];
          const onUpdate = (update: Uint8Array): void => {
            updates.push(update);
          };

          doc.on("update", onUpdate);
          store.setState((state) => ({
            "n": state.n + 1,
            ...(isAppend ? { "list": [...state.list, makeRecord(100 + step)] } : {}),
          }));
          handle.flush();
          doc.off("update", onUpdate);

          if (!isJsonLeaves) {
            continue;
          }

          const elementsAfter = yarray.toArray();

          // The very same stored objects: nothing was deleted and re-inserted.
          elementsBefore.forEach((element, index) => {
            expect(elementsAfter[index]).toBe(element);
          });
          expect(countArrayItems(yarray) - itemsBefore).toBe(isAppend ? 1 : 0);

          // The flush wrote one struct for the appended record and one for
          // the `n` overwrite, and deleted only the overwritten `n`.
          expect(updates).toHaveLength(1);

          const { structs, ds } = yjs.decodeUpdate(updates[0]);
          let deleted = 0;

          ds.clients.forEach((items) => {
            for (const item of items) {
              deleted = deleted + item.len;
            }
          });
          expect(structs).toHaveLength(isAppend ? 2 : 1);
          expect(deleted).toBe(1);
        }

        return doc;
      };

      const jsonDoc = run(true);

      expect(listArray(jsonDoc).toArray().some((element) => element instanceof yjs.AbstractType)).toBe(false);
      // Stored exactly as the Y.Map path reads its elements back.
      expect(listArray(jsonDoc).toJSON()).toStrictEqual(listArray(run(false)).toJSON());
    });

    it("stores what a Y.Map element would read back, and what a peer decodes", () => {
      const write = (isJsonLeaves: boolean): yjs.Doc => {
        const doc = newDoc(1);
        const store = makeListStore(doc, [makeOddRecord(0), makeOddRecord(1)], isScopedDiff, isJsonLeaves);
        const handle = getYjsStoreHandle(store);

        store.setState({ "n": 1 });
        handle.flush();
        // Append, then replace an element (a changed record is rewritten whole).
        store.setState((state) => ({ "list": [...state.list, makeOddRecord(2)] }));
        handle.flush();
        store.setState((state) => ({
          "list": state.list.map((record, index) => (index === 1 ? { ...record, "label": undefined, "score": -0 } : record)),
        }));
        handle.flush();

        return doc;
      };

      const jsonDoc = write(true);
      const mapDoc = write(false);

      expect(listArray(jsonDoc).toArray().some((element) => element instanceof yjs.AbstractType)).toBe(false);
      expect(listArray(jsonDoc).toJSON()).toStrictEqual(listArray(mapDoc).toJSON());
      expect(listArray(jsonDoc).toJSON()[1]).toStrictEqual({ ...storedOddRecord(1), "label": undefined, "score": -0 });
      // The in-memory elements round-trip lib0's encoding unchanged.
      expect(decodedCopyJson(jsonDoc, "list")).toStrictEqual(jsonDoc.getMap("list").toJSON());
    });

    it("store state never shares objects with doc content, so in-place mutation cannot fork replicas", async () => {
      const writerDoc = newDoc(1);
      const writer = makeProgressStore(writerDoc, makeSessions(0, 3), baseOptions(isScopedDiff, true));

      writeInitialState(writer);

      const writerSessions = (): Session[] => writer.getState().progress["book-0"]["device-0"].readingSessions;

      // Outbound: the writer's state objects are not what its doc stores.
      writerSessions()[0].label = "MUTATED BY WRITER";
      expect(sessionsArray(writerDoc).toJSON()[0]).toEqual(makeSession(0));

      // Hydration: a cold-started reader's elements are its own copies.
      const readerDoc = newDoc(2);

      yjs.applyUpdate(readerDoc, yjs.encodeStateAsUpdate(writerDoc));

      const reader = makeProgressStore(readerDoc, [], baseOptions(isScopedDiff, true));
      const readerSessions = (): Session[] => reader.getState().progress["book-0"]["device-0"].readingSessions;

      writerDoc.on("update", (update: Uint8Array) => {
        yjs.applyUpdate(readerDoc, update);
      });

      readerSessions()[1].label = "MUTATED BY READER";
      expect(sessionsArray(readerDoc).toJSON()[1]).toEqual(makeSession(1));

      // Inbound: an append-only write names the listed array itself as the changed path.
      updateDevice(writer, (device) => ({ ...device, "readingSessions": [...device.readingSessions, makeSession(3)] }));
      flush(writer);
      await Promise.resolve();
      expect(readerSessions()).toHaveLength(4);
      readerSessions()[3].label = "MUTATED AFTER INBOUND";
      expect(sessionsArray(readerDoc).toJSON()[3]).toEqual(makeSession(3));

      // Whatever the reader's next flush writes, it writes as Yjs operations.
      updateDevice(reader, (device) => ({ ...device, "lastRead": 1 }));
      flush(reader);
      yjs.applyUpdate(writerDoc, yjs.encodeStateAsUpdate(readerDoc, yjs.encodeStateVector(writerDoc)));
      await Promise.resolve();

      expect(readerDoc.getMap("progress").toJSON()).toStrictEqual(writerDoc.getMap("progress").toJSON());
      expect(decodedCopyJson(readerDoc, "progress")).toStrictEqual(readerDoc.getMap("progress").toJSON());
      expect(decodedCopyJson(writerDoc, "progress")).toStrictEqual(writerDoc.getMap("progress").toJSON());
    });

    it("inbound elements under a top-level listed key are copies, not doc content", async () => {
      const writerDoc = newDoc(1);
      const readerDoc = newDoc(2);
      const writer = makeListStore(writerDoc, [{ "id": 0 }], isScopedDiff);
      const writerHandle = getYjsStoreHandle(writer);

      writer.setState({ "n": 1 });
      writerHandle.flush();
      yjs.applyUpdate(readerDoc, yjs.encodeStateAsUpdate(writerDoc));

      const reader = makeListStore(readerDoc, [], isScopedDiff);

      writerDoc.on("update", (update: Uint8Array) => {
        yjs.applyUpdate(readerDoc, update);
      });

      // Under scopedDiff an edit of a top-level array re-reads that key whole.
      writer.setState((state) => ({ "list": [...state.list, { "id": 1, "tags": ["x"] }], "n": 2 }));
      writerHandle.flush();
      await Promise.resolve();

      const appended = reader.getState().list[1];

      expect(appended).toStrictEqual({ "id": 1, "tags": ["x"] });
      appended.id = -1;
      (appended.tags as string[]).push("MUTATED");
      expect((readerDoc.getMap("list").toJSON() as ListState).list[1]).toStrictEqual({ "id": 1, "tags": ["x"] });
    });

    it("inbound elements of a branch added under a top-level key are copies, not doc content", async () => {
      const writerDoc = newDoc(1);
      const readerDoc = newDoc(2);
      const writer = makeProgressStore(writerDoc, makeSessions(0, 2), baseOptions(isScopedDiff, true));

      writeInitialState(writer);
      yjs.applyUpdate(readerDoc, yjs.encodeStateAsUpdate(writerDoc));

      const reader = makeProgressStore(readerDoc, [], baseOptions(isScopedDiff, true));

      writerDoc.on("update", (update: Uint8Array) => {
        yjs.applyUpdate(readerDoc, update);
      });

      // Under scopedDiff a new map key is read on its own (a key path).
      writer.setState((state) => ({
        "progress": {
          ...state.progress,
          "book-1": {
            "device-0": { "currentCfi": "epubcfi(/6/8!/4/0:0)", "lastRead": 1, "readingSessions": makeSessions(5, 2) },
          },
        },
      }));
      flush(writer);
      await Promise.resolve();

      const added = reader.getState().progress["book-1"]["device-0"].readingSessions;

      expect(added).toStrictEqual(makeSessions(5, 2));
      added[0].label = "MUTATED AFTER INBOUND";

      const stored = (readerDoc.getMap("progress").toJSON() as ProgressState).progress["book-1"]["device-0"];

      expect(stored.readingSessions[0]).toStrictEqual(makeSession(5));
    });
  });

  it("clients with and without the option converge on one doc", async () => {
    const jsonClientDoc = newDoc(1);
    const jsonClient = makeProgressStore(jsonClientDoc, makeSessions(0, 10), baseOptions(true, true));

    writeInitialState(jsonClient);

    const mapClientDoc = newDoc(2);

    yjs.applyUpdate(mapClientDoc, yjs.encodeStateAsUpdate(jsonClientDoc));

    const mapClient = makeProgressStore(mapClientDoc, [], baseOptions(true, false));

    expect(mapClient.getState().progress).toEqual(jsonClient.getState().progress);

    // Offline on both: the old client edits one record, trims and appends;
    // the new client appends.
    updateDevice(mapClient, (device) => ({
      ...device,
      "readingSessions": [
        ...device.readingSessions.slice(2).map((session, index) => (index === 3 ? { ...session, "label": "edited" } : session)),
        makeSession(500),
      ],
    }));
    flush(mapClient);
    pageTurn(jsonClient, 600);

    yjs.applyUpdate(mapClientDoc, yjs.encodeStateAsUpdate(jsonClientDoc, yjs.encodeStateVector(mapClientDoc)));
    yjs.applyUpdate(jsonClientDoc, yjs.encodeStateAsUpdate(mapClientDoc, yjs.encodeStateVector(jsonClientDoc)));
    await Promise.resolve();

    const sessions = sessionsArray(jsonClientDoc).toJSON();

    expect(sessions).toHaveLength(10);
    expect(sessionsArray(mapClientDoc).toJSON()).toEqual(sessions);
    expect(jsonClient.getState().progress).toEqual(mapClient.getState().progress);
    expect(jsonClient.getState().progress["book-0"]["device-0"].readingSessions).toEqual(sessions);
    // The old client wrote what it changed as Y.Maps.
    expect(sessionsArray(jsonClientDoc).toArray().filter((element) => element instanceof yjs.AbstractType)).toHaveLength(2);

    // Changed by the new client, an old-style element becomes JSON again.
    updateDevice(jsonClient, (device) => ({
      ...device,
      "readingSessions": device.readingSessions.map((session) => (session.label === "edited" ? { ...session, "label": "edited twice" } : session)),
    }));
    flush(jsonClient);
    yjs.applyUpdate(mapClientDoc, yjs.encodeStateAsUpdate(jsonClientDoc, yjs.encodeStateVector(mapClientDoc)));
    await Promise.resolve();

    expect(sessionsArray(jsonClientDoc).toArray().filter((element) => element instanceof yjs.AbstractType)).toHaveLength(1);
    expect(mapClient.getState().progress).toEqual(jsonClient.getState().progress);
    expect(sessionsArray(mapClientDoc).toJSON()).toEqual(sessionsArray(jsonClientDoc).toJSON());
  });

  it("concurrent changes to one element converge without merging fields (the documented trade-off)", async () => {
    const docA = newDoc(1);
    const storeA = makeProgressStore(docA, makeSessions(0, 3), baseOptions(true, true));

    writeInitialState(storeA);

    const docB = newDoc(2);

    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA));

    const storeB = makeProgressStore(docB, [], baseOptions(true, true));
    const editFirst = (store: StoreApi<ProgressState>, edit: Partial<Session>): void => {
      updateDevice(store, (device) => ({
        ...device,
        "readingSessions": device.readingSessions.map((session, index) => (index === 0 ? { ...session, ...edit } : session)),
      }));
      flush(store);
    };

    editFirst(storeA, { "label": "from A" });
    editFirst(storeB, { "type": "from B" });

    yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA, yjs.encodeStateVector(docB)));
    yjs.applyUpdate(docA, yjs.encodeStateAsUpdate(docB, yjs.encodeStateVector(docA)));
    await Promise.resolve();

    const sessions = sessionsArray(docA).toJSON() as Session[];

    // Each client replaced the whole element: both replacements survive.
    expect(sessions).toHaveLength(4);
    expect(sessions.slice(0, 2)).toEqual([
      { ...makeSession(0), "label": "from A" },
      { ...makeSession(0), "type": "from B" },
    ]);
    expect(sessionsArray(docB).toJSON()).toEqual(sessions);
    expect(storeA.getState().progress).toEqual(storeB.getState().progress);
  });
});
