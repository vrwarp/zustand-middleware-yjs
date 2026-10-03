/*
 * Inbound bulk record deletes.
 *
 * A remote peer removes many entries from ONE record in a single batch:
 * bulk-deleting books from a library, clearing or pruning an id-keyed
 * annotations/progress map. Every receiving device turns that into a change
 * list of k `[delete, key]` entries for an n-key record and applies it with
 * the inbound state applier (`applyChangesToObject` in src/patching.ts), on
 * the main thread. Every inbound route ends there: the deep-path route, the
 * key-scoped route, the legacy full-tree route and creation hydration.
 *
 * Two layers are measured:
 *
 * 1. `patchState` alone — the applier in isolation, at several record widths
 *    (n) and delete counts (k), including a delete-half series at n and 2n
 *    so the scaling is visible.
 * 2. End to end on a receiving store: a peer deletes k of n books from
 *    `books` and the receiver applies the update and drains the batching
 *    microtask (where the store patch actually runs; timing only
 *    `applyUpdate` would miss it). Covers the scopedDiff deep-path route
 *    (`library.books`), the scopedDiff key-scoped route (top-level `books`)
 *    and the legacy full-tree route.
 *
 * Besides timings, each row reports a deterministic cost counter:
 * `enumerated` is the number of record entries materialized by
 * Object.entries / Object.keys / Object.values / Object.fromEntries during
 * one untimed run. An O(n + k) applier keeps it a small multiple of n; a
 * per-delete rebuild makes it grow with n * k.
 *
 * Run alone with:
 *   npx ts-node -T -P bench/tsconfig.json bench/record-delete.ts
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling } from "../src";
import { getChanges } from "../src/diff";
import { patchState } from "../src/patching";
import { bench, type BenchResult, formatTable } from "./harness";

interface Book {
  title: string;
  author: string;
  addedAt: number;
  progress: number;
}

const makeBook = (index: number): Book => {
  return {
    "title": `Book title number ${String(index)}`,
    "author": `Author ${String(index % 97)}`,
    "addedAt": 1_700_000_000_000 + (index * 1_000),
    "progress": (index % 100) / 100,
  };
};

const makeBooks = (count: number): Record<string, Book> => {
  const books: Record<string, Book> = {};

  for (let index = 0; index < count; index = index + 1) {
    books[`book-${String(index)}`] = makeBook(index);
  }

  return books;
};

/**
 * Ids of the books a bulk delete removes: every (n / k)-th book, so the
 * deletes are spread across the record rather than one contiguous block.
 *
 * @param count - Record width n.
 * @param deleteCount - Number of keys to delete, k.
 * @returns The deleted ids.
 */
const pickDeletedIds = (count: number, deleteCount: number): string[] => {
  const ids: string[] = [];
  const stride = count / deleteCount;

  for (let index = 0; index < deleteCount; index = index + 1) {
    ids.push(`book-${String(Math.floor(index * stride))}`);
  }

  return ids;
};

const withoutKeys = (books: Record<string, Book>, ids: readonly string[]): Record<string, Book> => {
  const removed = new Set(ids);

  return Object.fromEntries(Object.entries(books).filter(([id]) => !removed.has(id)));
};

/**
 * Counts record entries materialized by the Object enumeration built-ins
 * while `fn` runs. Deterministic: depends only on the code path, not on
 * timing or GC.
 *
 * @param fn - The work to measure (sync or async).
 * @returns The number of entries enumerated.
 */
const countEnumerated = async (fn: () => unknown): Promise<number> => {
  const originalEntries = Object.entries;
  const originalKeys = Object.keys;
  const originalValues = Object.values;
  const originalFromEntries = Object.fromEntries;
  let count = 0;

  Object.entries = ((value: object) => {
    const result = originalEntries(value);

    count = count + result.length;

    return result;
  }) as typeof Object.entries;
  Object.keys = ((value: object) => {
    const result = originalKeys(value);

    count = count + result.length;

    return result;
  }) as typeof Object.keys;
  Object.values = ((value: object) => {
    const result: unknown[] = originalValues(value);

    count = count + result.length;

    return result;
  }) as typeof Object.values;
  Object.fromEntries = ((entries: Iterable<readonly [PropertyKey, unknown]>) => {
    const list: (readonly [PropertyKey, unknown])[] = [...entries];

    count = count + list.length;

    return originalFromEntries(list);
  }) as typeof Object.fromEntries;

  const restore = (): void => {
    Object.entries = originalEntries;
    Object.keys = originalKeys;
    Object.values = originalValues;
    Object.fromEntries = originalFromEntries;
  };

  try {
    await fn();
  } finally {
    restore();
  }

  return count;
};

const median = (samples: number[]): number => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)];
};

const summarize = (name: string, samples: number[]): BenchResult => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return {
    name,
    "runs": sorted.length,
    "medianMs": median(sorted),
    "meanMs": sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length,
    "p95Ms": sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    "minMs": sorted[0],
  };
};

/* -------------------------------------------------------------------------
 * 1. patchState alone (the applier in isolation)
 * ---------------------------------------------------------------------- */

const runPatchStateCase = async (
  label: string,
  count: number,
  deleteCount: number,
  runs: number
): Promise<BenchResult> => {
  const before = { "books": makeBooks(count) };
  const after = { "books": withoutKeys(before.books, pickDeletedIds(count, deleteCount)) };
  const [pending] = getChanges(before, after);
  const changes = Array.isArray(pending[2]) ? pending[2].length : 0;
  const enumerated = await countEnumerated(() => patchState(before, after));
  const check = patchState(before, after);

  if (Object.keys(check.books).length !== count - deleteCount) {
    throw new Error(`${label}: patchState produced the wrong record`);
  }

  const result = bench(
    `patch/state: ${label}`,
    () => { patchState(before, after); },
    { runs, "warmupRuns": 1 }
  );

  return {
    ...result,
    "meta": { "n": count, "k": deleteCount, changes, enumerated },
  };
};

/* -------------------------------------------------------------------------
 * 2. End to end: a receiving store applies a peer's bulk delete
 * ---------------------------------------------------------------------- */

type Route = "deep" | "key-scoped" | "legacy";

interface InboundFixture {
  receiverDoc: yjs.Doc;
  update: Uint8Array;
  readBooks: () => Record<string, unknown>;
}

const ROOT = "library-store";

/**
 * Builds a populated receiver (store already hydrated from the doc) and the
 * peer update that deletes `deleteCount` books in ONE transaction.
 *
 * @param route - Which inbound route the receiver takes.
 * @param count - Number of books, n.
 * @param deleteCount - Number of books the peer deletes, k.
 * @returns The receiver doc, the pending update and a reader for the store's books.
 */
const makeInboundFixture = (route: Route, count: number, deleteCount: number): InboundFixture => {
  const peerDoc = new yjs.Doc();
  const peerRoot = peerDoc.getMap(ROOT);
  const books = new yjs.Map<unknown>();

  peerDoc.transact(() => {
    if (route === "deep") {
      // Deep path: the event target is library.books, two segments below
      // the store root.
      const library = new yjs.Map<unknown>();

      peerRoot.set("library", library);
      library.set("books", books);
    } else {
      peerRoot.set("books", books);
    }

    for (const [id, book] of Object.entries(makeBooks(count))) {
      const bookMap = new yjs.Map<unknown>();

      books.set(id, bookMap);
      for (const [field, value] of Object.entries(book)) {
        bookMap.set(field, value);
      }
    }
  });

  const receiverDoc = new yjs.Doc();

  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(peerDoc));

  interface DeepState { library: { books: Record<string, unknown> } }
  interface FlatState { books: Record<string, unknown> }

  let readBooks: () => Record<string, unknown>;

  if (route === "deep") {
    const store = createStore<DeepState>()(
      yjsMiddleware(receiverDoc, ROOT, () => ({ "library": { "books": {} } }), {
        "disableYText": true,
        "scopedDiff": true,
      })
    );

    readBooks = () => store.getState().library.books;
  } else {
    const store = createStore<FlatState>()(
      yjsMiddleware(receiverDoc, ROOT, () => ({ "books": {} }), {
        "disableYText": true,
        "scopedDiff": route === "key-scoped",
      })
    );

    readBooks = () => store.getState().books;
  }

  if (Object.keys(readBooks()).length !== count) {
    throw new Error("receiver did not hydrate");
  }

  const stateVector = yjs.encodeStateVector(peerDoc);

  peerDoc.transact(() => {
    for (const id of pickDeletedIds(count, deleteCount)) {
      books.delete(id);
    }
  });

  return { receiverDoc, "update": yjs.encodeStateAsUpdate(peerDoc, stateVector), readBooks };
};

const applyInbound = async (fixture: InboundFixture): Promise<void> => {
  yjs.applyUpdate(fixture.receiverDoc, fixture.update);
  // Drain the batching microtask: the store patch runs there.
  await Promise.resolve();
};

const runInboundCase = async (
  route: Route,
  count: number,
  deleteCount: number,
  runs: number
): Promise<BenchResult> => {
  const name = `e2e/inbound (${route}): peer deletes ${String(deleteCount)} of ${String(count)} books`;
  const verify = (fixture: InboundFixture): void => {
    if (Object.keys(fixture.readBooks()).length !== count - deleteCount) {
      throw new Error(`${name}: receiver store did not converge`);
    }
  };

  // Deterministic counter (one untimed run).
  const counted = makeInboundFixture(route, count, deleteCount);
  const enumerated = await countEnumerated(() => applyInbound(counted));

  verify(counted);

  // Warmup, then timed runs on fresh fixtures (setup excluded).
  const warm = makeInboundFixture(route, count, deleteCount);

  await applyInbound(warm);
  verify(warm);

  const samples: number[] = [];

  for (let run = 0; run < runs; run = run + 1) {
    const fixture = makeInboundFixture(route, count, deleteCount);
    const start = performance.now();

    await applyInbound(fixture);
    samples.push(performance.now() - start);
    verify(fixture);
  }

  return {
    ...summarize(name, samples),
    "meta": { "n": count, "k": deleteCount, enumerated },
  };
};

/**
 * Runs the bulk record delete scenarios.
 *
 * @returns A promise for the results, in report order.
 */
export const runRecordDeleteBench = async (): Promise<BenchResult[]> => {
  // Deterministic perf runs: no sampled convergence check on scoped flushes.
  __scopedDiffDevSampling.rate = 0;

  const results: BenchResult[] = [];
  const cases: [string, number, number][] = [
    ["prune 50 of 1000 record keys", 1_000, 50],
    ["delete 500 of 1000 record keys", 1_000, 500],
    ["delete 1000 of 2000 record keys", 2_000, 1_000],
    ["clear a 1000-key record", 1_000, 1_000],
  ];

  for (const [label, count, deleteCount] of cases) {
    console.error(`  running record-delete: ${label}...`);

    results.push(await runPatchStateCase(label, count, deleteCount, 5));
  }

  const inbound: [Route, number, number][] = [
    ["deep", 1_000, 500],
    ["deep", 2_000, 1_000],
    ["key-scoped", 1_000, 500],
    ["legacy", 1_000, 500],
  ];

  for (const [route, count, deleteCount] of inbound) {
    console.error(`  running record-delete: e2e ${route} ${String(deleteCount)}/${String(count)}...`);

    results.push(await runInboundCase(route, count, deleteCount, 5));
  }

  return results;
};

/**
 * Formats the scenario as a markdown section.
 *
 * @param results - Output of {@link runRecordDeleteBench}.
 * @returns The report.
 */
export const formatRecordDeleteReport = (results: BenchResult[]): string => {
  return [
    "## Inbound bulk record deletes (k deletes from one n-key record)",
    "",
    formatTable(results),
  ].join("\n");
};

/*
 * Standalone entry. ts-node runs the bench as CommonJS, where top-level
 * await is unavailable, so this has to be a promise chain.
 */
/* eslint-disable unicorn/prefer-top-level-await */
if (require.main === module) {
  runRecordDeleteBench()
    .then((results) => {
      // eslint-disable-next-line no-console
      console.log(`\n${formatRecordDeleteReport(results)}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
/* eslint-enable unicorn/prefer-top-level-await */
