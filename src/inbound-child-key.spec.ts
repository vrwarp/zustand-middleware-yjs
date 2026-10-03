/*
 * Inbound child-key add / delete must cost O(changed child), not O(parent).
 *
 * Yjs reports adding, replacing or removing a key of a Y.Map as ONE event on
 * that map, with `event.keysChanged` naming the keys. Under scopedDiff the
 * observer turns a map-target event into a reconcile of the whole target:
 *
 * - directly under a top-level key (a new book under `progress`, a new
 *   annotation under `annotations`) the store-relative path has length 1,
 *   the batch is flagged shallow, and the key-scoped route serializes and
 *   diffs the ENTIRE top-level value — dragging any deep edits in the same
 *   batch onto that route too;
 * - at depth >= 2 (progress[book][device], annotations[bookId]) the
 *   path-scoped route reads the whole target map, so a scalar-only remote
 *   change re-serializes every sibling field, arrays of sessions included.
 *
 * These specs pin the cost with toJSON call counts (deterministic) and
 * scaling comparisons (n vs 4n siblings), never wall-clock, and check the
 * receiver still mirrors the sender exactly so a narrowing cannot pass by
 * dropping changes. The bulk guards at the end keep a batch that adds or
 * removes many keys at once (an offline catch-up, an import) linear in the
 * batch; only the once-per-parent copy, which leaves no trace outside the
 * patch, is pinned with a ratio of CPU times.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { objectToYMap } from "./mapping";
import { computeInboundStateForPaths, type InboundPath } from "./patching";

interface Session { start: number; end: number; label: string }
interface Device { cfi: string; pct: number; sessions: Session[] }
type Tree = Record<string, Record<string, Device>>;
type State = Record<string, unknown>;

const makeDevice = (seed: number, sessions: number): Device => ({
  "cfi": `cfi-${String(seed)}`,
  "pct": seed / 100,
  "sessions": Array.from({ "length": sessions }, (unused, index) => ({
    "start": index,
    "end": index + 1,
    "label": `s${String(index)}`,
  })),
});

const makeTree = (books: number, sessions: number): Tree => {
  const tree: Tree = {};

  for (let index = 0; index < books; index = index + 1) {
    tree[`book-${String(index)}`] = {
      "device-0": makeDevice(index, sessions),
      "device-1": makeDevice(index + 1000, sessions),
    };
  }

  return tree;
};

/**
 * Sender and receiver stores (scopedDiff, one synced top-level key) on two
 * docs. `prepare` writes on the sender and flushes it, returning the update
 * for the receiver; `deliver` applies it and drains the receiver's batched
 * patch. Keeping them apart lets a spy see only the receiver's work.
 */
const makePair = (key: string, initial: unknown) => {
  const docA = new yjs.Doc();
  const docB = new yjs.Doc();
  const options = { "disableYText": true, "scopedDiff": true, "syncedKeys": [key] };
  const storeA = createStore<State>()(
    yjsMiddleware(docA, "root", (): State => ({ [key]: initial }), options)
  );
  const handleA = getYjsStoreHandle(storeA);

  // An empty doc is seeded on the first write; make it and flush it so the
  // receiver hydrates from a populated document.
  storeA.setState((state) => ({ [key]: { ...(state[key] as State) } }));
  handleA.flush();
  yjs.applyUpdate(docB, yjs.encodeStateAsUpdate(docA));

  const storeB = createStore<State>()(
    yjsMiddleware(docB, "root", (): State => ({ [key]: {} }), options)
  );

  const prepare = (write: (value: State) => State): Uint8Array => {
    const stateVector = yjs.encodeStateVector(docB);

    storeA.setState((state) => ({ [key]: write(state[key] as State) }));
    handleA.flush();

    return yjs.encodeStateAsUpdate(docA, stateVector);
  };

  const deliver = async (update: Uint8Array): Promise<void> => {
    yjs.applyUpdate(docB, update);
    await Promise.resolve();
    await Promise.resolve();
  };

  /*
   * The same write in one update together with a root-map event for the
   * synced key itself (the key replaced by an equal copy): the receiver
   * re-reads that whole key on the key-scoped route, the reference cost a
   * narrowed patch must stay under. A root-map event for a key this store
   * does not sync no longer sends the batch there: only the keys such
   * events name are re-read whole (inbound-mixed-shallow-batch.spec.ts).
   */
  const prepareKeyScoped = (write: (value: State) => State): Uint8Array => {
    const stateVector = yjs.encodeStateVector(docB);
    // A copy with no store attached, so the sender does not react to the
    // replacement while the receiver's work is being counted.
    const copy = new yjs.Doc();

    prepare(write);
    yjs.applyUpdate(copy, yjs.encodeStateAsUpdate(docA));
    copy.getMap("root").set(key, objectToYMap(storeA.getState()[key] as State, { "disableYText": true }));

    return yjs.encodeStateAsUpdate(copy, stateVector);
  };

  return { docB, deliver, key, prepare, prepareKeyScoped, storeA, storeB };
};

type Pair = ReturnType<typeof makePair>;

/** Every Y.Map / Y.Array toJSON() call (nested ones included) made by the receiver for `update`. */
const countDeliveryToJson = async (pair: Pair, update: Uint8Array): Promise<number> => {
  const mapSpy = jest.spyOn(yjs.Map.prototype, "toJSON");
  const arraySpy = jest.spyOn(yjs.Array.prototype, "toJSON");

  try {
    await pair.deliver(update);

    return mapSpy.mock.calls.length + arraySpy.mock.calls.length;
  } finally {
    mapSpy.mockRestore();
    arraySpy.mockRestore();
  }
};

/** Every Y.Map / Y.Array toJSON() call (nested ones included) made by the receiver. */
const countReceiverToJson = async (pair: Pair, write: (value: State) => State): Promise<number> =>
  countDeliveryToJson(pair, pair.prepare(write));

/**
 * Record entries materialized by the Object enumeration built-ins while the
 * receiver applies `update`: filtering or rebuilding a record pays one per
 * key, so this is how many entries the patch walked.
 */
const countDeliveryEnumerated = async (pair: Pair, update: Uint8Array): Promise<number> => {
  const originalEntries = Object.entries;
  const originalKeys = Object.keys;
  const originalValues = Object.values;
  const originalFromEntries = Object.fromEntries;
  let count = 0;
  const spies = [
    jest.spyOn(Object, "entries").mockImplementation((value: object) => {
      const result = originalEntries(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "keys").mockImplementation((value: object) => {
      const result = originalKeys(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "values").mockImplementation((value: object) => {
      const result = originalValues(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "fromEntries").mockImplementation((entries: Iterable<readonly unknown[]>) => {
      const list = [...entries];

      count += list.length;

      return originalFromEntries(list as (readonly [PropertyKey, unknown])[]);
    }),
  ];

  try {
    await pair.deliver(update);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  return count;
};

const expectMirrored = (pair: Pair): void => {
  expect(pair.storeB.getState()[pair.key]).toStrictEqual(pair.storeA.getState()[pair.key]);
};

const addBook = (bookId: string) => (tree: State): State => ({
  ...tree,
  [bookId]: { "device-1": makeDevice(7, 2) },
});

const dropBook = (bookId: string) => (tree: State): State => {
  const copy = { ...tree };

  delete copy[bookId];

  return copy;
};

const fieldsOnlyTurn = (bookId: string, cfi: string) => (value: State): State => {
  const tree = value as Tree;

  return {
    ...tree,
    [bookId]: { ...tree[bookId], "device-0": { ...tree[bookId]["device-0"], cfi, "pct": 0.42 } },
  };
};

const sessionTurn = (bookId: string, stamp: number) => (value: State): State => {
  const tree = value as Tree;
  const device = tree[bookId]["device-0"];

  return {
    ...tree,
    [bookId]: {
      ...tree[bookId],
      "device-0": {
        ...device,
        "cfi": `turn-${String(stamp)}`,
        "sessions": [...device.sessions, { "start": stamp, "end": stamp + 1, "label": "new" }],
      },
    },
  };
};

const makeAnnotations = (count: number): State => {
  const record: State = {};

  for (let index = 0; index < count; index = index + 1) {
    record[`ann-${String(index)}`] = { "cfi": `c${String(index)}`, "color": "yellow", "text": `t${String(index)}` };
  }

  return record;
};

beforeAll(() => {
  // The DEV tripwire is random and serializes the whole map when it fires.
  __scopedDiffDevSampling.rate = 0;
});

describe("inbound child-key add / delete under a top-level key", () => {
  it("does not serialize the top-level map or a sibling branch for a remote new child key", async () => {
    const pair = makePair("progress", makeTree(12, 20));
    const progressMap = pair.docB.getMap("root").get("progress") as yjs.Map<unknown>;
    const sibling = progressMap.get("book-5") as yjs.Map<unknown>;
    const wholeKeySpy = jest.spyOn(progressMap, "toJSON");
    const siblingSpy = jest.spyOn(sibling, "toJSON");

    await pair.deliver(pair.prepare(addBook("book-new")));

    expectMirrored(pair);
    expect(wholeKeySpy).not.toHaveBeenCalled();
    expect(siblingSpy).not.toHaveBeenCalled();

    wholeKeySpy.mockRestore();
    siblingSpy.mockRestore();
  });

  it("does not serialize the top-level map or a sibling branch for a remote child-key delete", async () => {
    const pair = makePair("progress", makeTree(12, 20));
    const progressMap = pair.docB.getMap("root").get("progress") as yjs.Map<unknown>;
    const sibling = progressMap.get("book-5") as yjs.Map<unknown>;
    const wholeKeySpy = jest.spyOn(progressMap, "toJSON");
    const siblingSpy = jest.spyOn(sibling, "toJSON");

    await pair.deliver(pair.prepare(dropBook("book-3")));

    expectMirrored(pair);
    expect((pair.storeB.getState().progress as Tree)["book-3"]).toBeUndefined();
    expect(wholeKeySpy).not.toHaveBeenCalled();
    expect(siblingSpy).not.toHaveBeenCalled();

    wholeKeySpy.mockRestore();
    siblingSpy.mockRestore();
  });

  it("costs the same for a remote new book at 4x the library size", async () => {
    const small = makePair("progress", makeTree(8, 10));
    const large = makePair("progress", makeTree(32, 10));

    const smallAdd = await countReceiverToJson(small, addBook("book-new"));
    const largeAdd = await countReceiverToJson(large, addBook("book-new"));
    const smallDrop = await countReceiverToJson(small, dropBook("book-new"));
    const largeDrop = await countReceiverToJson(large, dropBook("book-new"));

    expectMirrored(small);
    expectMirrored(large);
    // O(changed child): the added value is the same size at both scales.
    expect({ "add": largeAdd, "drop": largeDrop }).toStrictEqual({ "add": smallAdd, "drop": smallDrop });
  });

  it("costs the same for a remote annotation add / delete at 4x the annotation count", async () => {
    const small = makePair("annotations", makeAnnotations(100));
    const large = makePair("annotations", makeAnnotations(400));
    const add = (record: State): State => ({ ...record, "ann-new": { "cfi": "n", "color": "blue", "text": "n" } });

    const smallAdd = await countReceiverToJson(small, add);
    const largeAdd = await countReceiverToJson(large, add);
    const smallDrop = await countReceiverToJson(small, dropBook("ann-new"));
    const largeDrop = await countReceiverToJson(large, dropBook("ann-new"));

    expectMirrored(small);
    expectMirrored(large);
    expect({ "add": largeAdd, "drop": largeDrop }).toStrictEqual({ "add": smallAdd, "drop": smallDrop });
  });

  /*
   * One transaction holding a deep edit and a new book (the cold-start
   * catch-up shape) must cost what the two cost separately: the add must
   * not drag the deep edit onto a whole-key re-read.
   */
  it("does not escalate deep edits in the same batch as a child-key add", async () => {
    const small = makePair("progress", makeTree(8, 10));
    const large = makePair("progress", makeTree(32, 10));
    const turnAndAdd = (tree: State): State => addBook("book-new")(sessionTurn("book-2", 1)(tree));

    const smallTogether = await countReceiverToJson(small, turnAndAdd);
    const largeTogether = await countReceiverToJson(large, turnAndAdd);

    expectMirrored(small);
    expectMirrored(large);
    // The deep edit reconciles one device branch and the add one new book,
    // at either library size: nothing else may be read.
    expect(largeTogether).toBe(smallTogether);
  });
});

describe("inbound map-target events at depth >= 2 read only the changed keys", () => {
  it("does not re-serialize sibling fields for a scalar-only remote change", async () => {
    const small = makePair("progress", makeTree(4, 10));
    const large = makePair("progress", makeTree(4, 40));

    const smallTurn = await countReceiverToJson(small, fieldsOnlyTurn("book-1", "moved"));
    const largeTurn = await countReceiverToJson(large, fieldsOnlyTurn("book-1", "moved"));

    expectMirrored(small);
    expectMirrored(large);
    // Only primitives changed: the 10 vs 40 sessions beside them are irrelevant.
    expect(largeTurn).toBe(smallTurn);
  });

  it("does not re-serialize a per-book annotation map to add one annotation", async () => {
    const small = makePair("annotations", { "book-0": makeAnnotations(50), "book-1": makeAnnotations(5) });
    const large = makePair("annotations", { "book-0": makeAnnotations(200), "book-1": makeAnnotations(5) });
    const add = (value: State): State => {
      const byBook = value as Record<string, State>;

      return { ...byBook, "book-0": { ...byBook["book-0"], "ann-new": { "cfi": "n", "color": "pink", "text": "n" } } };
    };

    const smallAdd = await countReceiverToJson(small, add);
    const largeAdd = await countReceiverToJson(large, add);

    expectMirrored(small);
    expectMirrored(large);
    expect(largeAdd).toBe(smallAdd);
  });
});

describe("bulk child-key batches stay linear", () => {
  const SMALL_RECORD = 200;
  const SMALL_BATCH = 50;

  const bulkKeys = (count: number): State => {
    const record: State = {};

    for (let index = 0; index < count; index = index + 1) {
      record[`bulk-${String(index)}`] = { "cfi": `b${String(index)}`, "color": "green", "text": `bulk ${String(index)}` };
    }

    return record;
  };

  const addBulk = (count: number) => (record: State): State => ({ ...record, ...bulkKeys(count) });

  const dropBulk = (count: number) => (record: State): State => {
    const removed = new Set(Object.keys(bulkKeys(count)));
    const kept: State = {};

    for (const key of Object.keys(record)) {
      if (!removed.has(key)) {
        kept[key] = record[key];
      }
    }

    return kept;
  };

  it("reads each added value once for a bulk add, at 4x the batch and record, and less than the key-scoped route", async () => {
    const small = makePair("annotations", makeAnnotations(SMALL_RECORD));
    const large = makePair("annotations", makeAnnotations(4 * SMALL_RECORD));
    const reference = makePair("annotations", makeAnnotations(4 * SMALL_RECORD));

    const smallAdd = await countReceiverToJson(small, addBulk(SMALL_BATCH));
    const largeAdd = await countReceiverToJson(large, addBulk(4 * SMALL_BATCH));
    const keyScoped = await countDeliveryToJson(reference, reference.prepareKeyScoped(addBulk(4 * SMALL_BATCH)));

    expectMirrored(small);
    expectMirrored(large);
    expectMirrored(reference);
    // One read per added value: linear in the batch, independent of the record.
    expect(largeAdd).toBe(4 * smallAdd);
    expect(largeAdd).toBeLessThan(keyScoped);
  });

  it("walks the record once for a bulk delete, at 4x the batch and record, and less than the key-scoped route", async () => {
    const seed = (records: number, batch: number): State => ({ ...makeAnnotations(records), ...bulkKeys(batch) });
    const small = makePair("annotations", seed(SMALL_RECORD, SMALL_BATCH));
    const large = makePair("annotations", seed(4 * SMALL_RECORD, 4 * SMALL_BATCH));
    const reference = makePair("annotations", seed(4 * SMALL_RECORD, 4 * SMALL_BATCH));

    const smallDrop = await countDeliveryEnumerated(small, small.prepare(dropBulk(SMALL_BATCH)));
    const largeDrop = await countDeliveryEnumerated(large, large.prepare(dropBulk(4 * SMALL_BATCH)));
    const keyScoped = await countDeliveryEnumerated(
      reference,
      reference.prepareKeyScoped(dropBulk(4 * SMALL_BATCH))
    );

    expectMirrored(small);
    expectMirrored(large);
    expectMirrored(reference);
    expect(Object.keys(large.storeB.getState().annotations as State)).toHaveLength(4 * SMALL_RECORD);
    // One filter for all removals: 4x the entries. One filter per removed key: 16x.
    expect(largeDrop).toBeLessThanOrEqual(5 * smallDrop);
    expect(largeDrop).toBeLessThan(keyScoped);
  });

  /** A doc whose `annotations` map holds `width` entries plus `added`; state holds them plus `removed`. */
  const makeWideParent = (width: number, changed: number) => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const docAnnotations = new yjs.Map<unknown>();
    const stateAnnotations: State = {};

    doc.transact(() => {
      root.set("annotations", docAnnotations);

      for (let index = 0; index < width; index = index + 1) {
        docAnnotations.set(`ann-${String(index)}`, `c${String(index)}`);
        stateAnnotations[`ann-${String(index)}`] = `c${String(index)}`;
      }
      for (let index = 0; index < changed; index = index + 1) {
        docAnnotations.set(`added-${String(index)}`, { "cfi": `a${String(index)}` });
        stateAnnotations[`removed-${String(index)}`] = `r${String(index)}`;
      }
    });

    const keyPaths = (prefix: string, count: number): InboundPath[] =>
      Array.from({ "length": count }, (unused, index) => ["annotations", `${prefix}-${String(index)}`]);

    return { keyPaths, root, "state": { "annotations": stateAnnotations } };
  };

  it("reads each key path a bounded number of times, whatever the batch size", () => {
    /** Copies of `paths` whose segments count every read. */
    const withReadCounter = (paths: readonly InboundPath[]) => {
      const counter = { "reads": 0 };
      const counted = paths.map((path) => {
        const copy: (string | number)[] = [];

        for (const [index, step] of path.entries()) {
          Object.defineProperty(copy, index, {
            "enumerable": true,
            "get": () => {
              counter.reads = counter.reads + 1;

              return step;
            },
          });
        }

        return copy as InboundPath;
      });

      return { counted, counter };
    };

    const readsPerPath = (batch: number): number => {
      const { keyPaths, root, state } = makeWideParent(100, batch);
      const { counted, counter } = withReadCounter(keyPaths("added", batch));
      const next = computeInboundStateForPaths(state, root, [], { "keyPaths": counted });

      expect(next?.annotations[`added-${String(batch - 1)}`]).toStrictEqual({ "cfi": `a${String(batch - 1)}` });

      return counter.reads / batch;
    };

    const small = readsPerPath(250);
    const large = readsPerPath(1000);

    // O(depth) reads per path at any batch size; comparing every path with
    // every kept path makes the figure grow 4x with the batch.
    expect(large).toBeLessThanOrEqual(2 * small);
  });

  it("copies a wide parent once per batch, not once per changed key", () => {
    const WIDTH = 5000;
    const CHANGED = 64;
    const { keyPaths, root, state } = makeWideParent(WIDTH, CHANGED);
    const batches = {
      "addMany": keyPaths("added", CHANGED),
      "addOne": keyPaths("added", 1),
      "dropMany": keyPaths("removed", CHANGED),
      "dropOne": keyPaths("removed", 1),
    };

    // Correctness first: every named key is applied, nothing else changes.
    const patched = computeInboundStateForPaths(state, root, [], {
      "keyPaths": [...batches.addMany, ...batches.dropMany],
    });

    expect(Object.keys(patched?.annotations ?? {})).toHaveLength(WIDTH + CHANGED);
    expect(patched?.annotations["added-7"]).toStrictEqual({ "cfi": "a7" });
    expect(patched?.annotations).not.toHaveProperty("removed-7");

    const cpuMs = (paths: InboundPath[]): number => {
      const start = process.cpuUsage();

      computeInboundStateForPaths(state, root, [], { "keyPaths": paths });

      const used = process.cpuUsage(start);

      return (used.user + used.system) / 1000;
    };
    const fastest = { "addMany": Infinity, "addOne": Infinity, "dropMany": Infinity, "dropOne": Infinity };

    // Warm up every shape, then interleave and keep the fastest sample.
    for (let run = 0; run < 8; run = run + 1) {
      for (const [name, paths] of Object.entries(batches)) {
        const sample = cpuMs(paths);

        if (run > 0) {
          fastest[name as keyof typeof fastest] = Math.min(fastest[name as keyof typeof fastest], sample);
        }
      }
    }

    /*
     * Every batch copies (or filters) the 5,000-key parent once; the other
     * 63 keys add only a small read each, so both ratios stay near 1. One
     * copy or filter per key makes them about 64.
     */
    expect(fastest.addMany / Math.max(fastest.addOne, 0.05)).toBeLessThanOrEqual(8);
    expect(fastest.dropMany / Math.max(fastest.dropOne, 0.05)).toBeLessThanOrEqual(8);
  });
});

describe("key-path removals", () => {
  it("keep an own \"__proto__\" key as data, never as the prototype", () => {
    const doc = new yjs.Doc();
    const root = doc.getMap<unknown>("root");
    const books = new yjs.Map<unknown>();

    doc.transact(() => {
      root.set("books", books);
      books.set("a", 1);
    });

    // JSON.parse (or persist rehydration) can put an own "__proto__" key in state.
    const state = JSON.parse('{"books":{"__proto__":{"injected":true},"a":1,"b":2}}') as {
      books: Record<string, unknown>;
    };
    const patched = computeInboundStateForPaths(state, root, [], { "keyPaths": [["books", "b"]] });

    expect(patched).toBeDefined();
    expect(Object.hasOwn(patched?.books ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(patched?.books)).toBe(Object.prototype);
    expect(patched?.books.injected).toBeUndefined();
    expect(Object.keys(patched?.books ?? {})).toEqual(["__proto__", "a"]);
  });
});
