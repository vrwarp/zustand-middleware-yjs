/*
 * Y.Array bulk primitive inserts/updates (docs/performance.md §16).
 *
 * The array differ emits one change per element (an append of k elements is
 * [insert, n], [insert, n + 1], ...; a rewrite is k contiguous updates, or k
 * `pending` diffs for string elements). When the Y.Array applier issued one
 * `yarray.insert(i, [value])` per change, Yjs paid a quadratic walk for any
 * element whose integration consumes exactly one clock — primitives (numbers,
 * booleans, null, strings under disableYText) and empty Y.Maps/Y.Arrays:
 * the elements one transaction inserts get consecutive clocks from the same
 * client, and on every insert Yjs's findMarker walks left across the whole
 * mergeable run inserted so far. Y.Map elements WITH fields break the run
 * (their field items take clocks in between), so the object-array benches
 * in index.ts never showed it.
 *
 * Each scenario runs through the real middleware (disableYText, scopedDiff,
 * as versicle binds its stores) and reports, besides timings, deterministic
 * counters from one extra untimed run:
 * - insertCalls / deleteCalls: Y.Array insert/delete calls in the flush;
 * - itemVisits: reads of Item#deleted, which every Yjs list walk performs on
 *   each item it steps over — quadratic work shows as ~4x per doubling.
 *
 * Run alone with:
 *   npx ts-node -T -P bench/tsconfig.json bench/yarray-runs.ts
 */
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle, type YjsStoreHandle } from "../src";
import { bench, type BenchResult, formatTable } from "./harness";

type Recorder = (result: BenchResult, meta: Record<string, string | number>) => void;

interface ListState {
  list: unknown[];
}

interface ListFixture {
  doc: yjs.Doc;
  handle: YjsStoreHandle;
  store: StoreApi<ListState>;
}

interface FlushCounters {
  insertCalls: number;
  deleteCalls: number;
  itemVisits: number;
  items: number;
  updateBytes: number;
}

const makeIds = (count: number, offset: number): string[] =>
  { return Array.from({ "length": count }, (unused, index) => `book-${String(index + offset).padStart(7, "0")}`) };

const makeNumbers = (count: number, offset: number): number[] =>
  { return Array.from({ "length": count }, (unused, index) => index + offset) };

const makeObjects = (count: number, offset: number): Record<string, unknown>[] =>
  { return Array.from({ "length": count }, (unused, index) => ({ "id": `o${String(index + offset)}`, "n": index + offset })) };

/** A store bound to `list`, flushed once so the doc already holds `initial`. */
const makeListFixture = (initial: unknown[]): ListFixture => {
  const doc = new yjs.Doc();
  const store = createStore<ListState>(
    yjsMiddleware(doc, "shelf", () => ({ "list": initial }), {
      "disableYText": true,
      "scopedDiff": true,
    })
  );
  const handle = getYjsStoreHandle(store);

  // First flush: the whole list in one arrayToYArray insert (not measured).
  store.setState({ "list": [...initial] });
  handle.flush();

  return { doc, handle, store };
};

const countItems = (doc: yjs.Doc): number => {
  let items = 0;

  doc.store.clients.forEach((clientItems) => {
    items = items + clientItems.length;
  });

  return items;
};

/**
 * Replaces a prototype property for the duration of a measurement; returns
 * the function that restores the original descriptor.
 */
const instrument = (
  target: object,
  key: string,
  replace: (original: PropertyDescriptor) => PropertyDescriptor
): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(target, key);

  if (original === undefined) {
    throw new Error(`yjs internals changed: ${key} is not an own prototype property; update this probe`);
  }

  Object.defineProperty(target, key, replace(original));

  return () => { Object.defineProperty(target, key, original); };
};

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

/** A descriptor's getter typed as a plain field (not a method signature). */
interface GetterField {
  get?: unknown;
}

/** Counts calls of a prototype method. */
const countCalls = (target: object, key: string, onCall: () => void): (() => void) =>
  { return instrument(target, key, (original) => {
    const method = original.value as AnyMethod;

    return {
      ...original,
      value(this: unknown, ...args: unknown[]): unknown {
        onCall();

        return method.apply(this, args);
      },
    };
  }) };

/** Counts reads of a prototype getter. */
const countReads = (target: object, key: string, onRead: () => void): (() => void) =>
  { return instrument(target, key, (original) => {
    // Read through a non-method type: the getter is re-bound with call() below.
    const accessor: GetterField = original;
    const getter = accessor.get as AnyMethod;

    return {
      ...original,
      get(this: unknown): unknown {
        onRead();

        return getter.call(this);
      },
    };
  }) };

/**
 * One write + flush with Y.Array#insert/#delete and Item#deleted
 * instrumented. Instrumentation is removed before returning; it never runs
 * during timed samples.
 */
const measureCounters = (initial: unknown[], next: (list: unknown[]) => unknown[]): FlushCounters => {
  const { doc, handle, store } = makeListFixture(initial);
  const counters = { "deleteCalls": 0, "insertCalls": 0, "itemVisits": 0, "updateBytes": 0 };

  doc.on("update", (update: Uint8Array) => {
    counters.updateBytes = counters.updateBytes + update.byteLength;
  });

  const restorers = [
    countCalls(yjs.Array.prototype, "insert", () => { counters.insertCalls = counters.insertCalls + 1; }),
    countCalls(yjs.Array.prototype, "delete", () => { counters.deleteCalls = counters.deleteCalls + 1; }),
    countReads(yjs.Item.prototype, "deleted", () => { counters.itemVisits = counters.itemVisits + 1; }),
  ];

  try {
    store.setState({ "list": next(store.getState().list) });
    handle.flush();
  } finally {
    for (const restore of restorers) {
      restore();
    }
  }

  const docList = doc.getMap("shelf").get("list");

  if (!(docList instanceof yjs.Array) || JSON.stringify(docList.toJSON()) !== JSON.stringify(store.getState().list)) {
    throw new Error("yarray-runs bench: doc and store diverged");
  }

  return { ...counters, "items": countItems(doc) };
};

interface Scenario {
  name: string;
  initial: () => unknown[];
  next: (list: unknown[]) => unknown[];
}

const runScenario = (record: Recorder, { name, initial, next }: Scenario): FlushCounters => {
  const initialList = initial();
  const counters = measureCounters(initialList, next);

  record(bench(
    `e2e/yarray-runs: ${name}`,
    (fixture) => {
      const { handle, store } = fixture as ListFixture;

      store.setState({ "list": next(store.getState().list) });
      handle.flush();
    },
    { "runs": 5, "setup": () => makeListFixture(initialList), "warmupRuns": 1 }
  ), {
    "deleteCalls": counters.deleteCalls,
    "insertCalls": counters.insertCalls,
    "itemVisits": counters.itemVisits,
    "items": counters.items,
    "updateBytes": counters.updateBytes,
  });

  return counters;
};

const seriesSizes = [1_000, 2_000, 4_000];

/**
 * Records every scenario through `record`; returns a markdown table of the
 * item-visit growth per doubling (the scaling signature of the cost).
 */
export const runYArrayRunsBench = (record: Recorder): string => {
  const rows: string[] = [];
  const series = (label: string, scenarioFor: (size: number) => Scenario): void => {
    let previous: number | undefined;

    for (const size of seriesSizes) {
      const { deleteCalls, insertCalls, itemVisits } = runScenario(record, scenarioFor(size));
      const growth = previous === undefined ? "" : `${(itemVisits / previous).toFixed(2)}x`;

      rows.push(
        `| ${label} | ${String(size)} | ${String(insertCalls)} | ${String(deleteCalls)} | ` +
        `${String(itemVisits)} | ${growth} |`
      );
      previous = itemVisits;
    }
  };

  // Headline, versicle-shaped: bulk-add book ids to a 1,000-id shelf list.
  for (const count of [500, 2_000]) {
    runScenario(record, {
      "initial": () => makeIds(1_000, 0),
      "name": `append ${String(count)} ids to a 1,000-id list`,
      "next": (list) => [...list, ...makeIds(count, 1_000)],
    });
  }

  series("append numbers (insert path)", (size) => { return {
    "initial": () => makeNumbers(10, 0),
    "name": `append ${String(size)} numbers to a 10-number list`,
    "next": (list) => [...list, ...makeNumbers(size, 10)],
  } });

  series("rewrite numbers (update path)", (size) => { return {
    "initial": () => makeNumbers(size, 0),
    "name": `rewrite all ${String(size)} numbers`,
    "next": () => makeNumbers(size, 1_000_000),
  } });

  series("rewrite ids (pending-string path)", (size) => { return {
    "initial": () => makeIds(size, 0),
    "name": `rewrite all ${String(size)} ids`,
    "next": () => makeIds(size, 5_000_000),
  } });

  // Control: Y.Map elements with fields break the clock run, so this one is
  // linear even on the per-element applier.
  series("append objects with fields (control)", (size) => { return {
    "initial": () => makeObjects(10, 0),
    "name": `append ${String(size)} objects with fields`,
    "next": (list) => [...list, ...makeObjects(size, 10)],
  } });

  return [
    "## Y.Array bulk inserts: Yjs list-walk work per flush",
    "",
    "| series | elements | Y.Array insert calls | Y.Array delete calls | item visits | growth per doubling |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
};

if (require.main === module) {
  __scopedDiffDevSampling.rate = 0;

  const results: BenchResult[] = [];
  const report = runYArrayRunsBench((result, meta) => {
    results.push({ ...result, meta });
    console.error(`  done: ${result.name} (median ${result.medianMs.toFixed(3)} ms)`);
  });

  // eslint-disable-next-line no-console
  console.log(`\n## Benchmark results (node ${process.version})\n\n${formatTable(results)}\n\n${report}`);
}
