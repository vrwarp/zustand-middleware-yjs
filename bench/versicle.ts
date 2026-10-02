/*
 * Versicle-shaped aging benchmark.
 *
 * Versicle (the primary downstream consumer) binds ONE long-lived store per
 * domain; the hot one is `progress`: a single top-level key holding
 * Y.Map<bookId, Y.Map<deviceId, Y.Map<fields>>>, where every page turn /
 * TTS sentence rewrites a handful of fields in ONE device branch and appends
 * to that branch's readingSessions array (capped 500 -> keep last 300).
 *
 * What this measures, per library scale:
 *
 * 1. Outbound page-turn flush (scopedDiff: true) — the per-write cost the
 *    reader pays on every page turn. The changed top-level key is always
 *    `progress`, so the scoped diff's per-key confinement does not help;
 *    what matters is whether the flush walks the whole progress tree or
 *    only the changed branch.
 * 2. Update payload bytes per page turn — churn the doc (and every sync
 *    provider downstream) permanently absorbs.
 * 3. The readingSessions sawtooth (500 -> 300 head splice) — a 201-element
 *    block removal, far beyond the differ's deep-equality lookahead window.
 * 4. Inbound cost on a second client receiving a page turn.
 *
 * `runInboundBulkBench` (end of file) covers the other inbound shape: one
 * remote batch that changes many sibling records at once (offline catch-up,
 * a backfill migration, "mark all read").
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from "../src";
import { computeInboundStateForPaths, type InboundPath, minimizeInboundPaths } from "../src/patching";
import { bench } from "./harness";

export interface ReadingSession {
  cfiRange: string;
  startTime: number;
  endTime: number;
  type: string;
  label: string;
}

export interface DeviceProgress {
  bookId: string;
  currentCfi: string;
  percentage: number;
  lastRead: number;
  completedRanges: string[];
  readingSessions: ReadingSession[];
}

export type ProgressTree = Record<string, Record<string, DeviceProgress>>;

interface ProgressState {
  progress: ProgressTree;
  updateReadingSession: (bookId: string, deviceId: string, now: number) => void;
}

const deviceIds = ["device-0", "device-1"];

export const makeSession = (n: number): ReadingSession => {
  return {
    "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0),epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:80)`,
    "startTime": 1_700_000_000_000 + (n * 60_000),
    "endTime": 1_700_000_000_000 + (n * 60_000) + 45_000,
    "type": n % 5 === 0 ? "tts" : "page",
    "label": `Chapter ${String(n % 30)}: section ${String(n)}`,
  };
};

export const makeDeviceProgress = (bookId: string, sessions: number): DeviceProgress => {
  return {
    bookId,
    "currentCfi": `epubcfi(/6/4!/4/${String(sessions)}:0)`,
    "percentage": (sessions % 100) / 100,
    "lastRead": 1_700_000_000_000 + (sessions * 60_000),
    "completedRanges": Array.from(
      { "length": 50 },
      (unused, index) => { return `epubcfi(/6/${String(index)}!:0),epubcfi(/6/${String(index)}!:99)` }
    ),
    "readingSessions": Array.from({ "length": sessions }, (unused, index) => makeSession(index)),
  };
};

export const makeProgressTree = (books: number, sessionsPerDevice: number): ProgressTree => {
  const tree: ProgressTree = {};

  for (let book = 0; book < books; book = book + 1) {
    const bookId = `book-${String(book)}`;
    const perBook: Record<string, DeviceProgress> = {};

    for (const deviceId of deviceIds) {
      perBook[deviceId] = makeDeviceProgress(bookId, sessionsPerDevice);
    }
    tree[bookId] = perBook;
  }

  return tree;
};

const MAX_READING_SESSIONS = 500;
const PRUNED_READING_SESSIONS = 300;

interface Fixture {
  doc: yjs.Doc;
  store: StoreApi<ProgressState>;
  flush: () => void;
  updateBytes: () => number;
  resetUpdateBytes: () => void;
}

const makeFixture = (books: number, sessionsPerDevice: number): Fixture => {
  const doc = new yjs.Doc();
  let updateBytes = 0;

  doc.on("update", (update: Uint8Array) => {
    updateBytes = updateBytes + update.byteLength;
  });

  const store = createStore<ProgressState>()(
    yjsMiddleware(
      doc,
      "progress",
      (set) => {
        return {
          "progress": makeProgressTree(books, sessionsPerDevice),
          "updateReadingSession": (bookId: string, deviceId: string, now: number) => {
            set((state) => {
              const perBook = state.progress[bookId];
              const perDevice = perBook[deviceId];
              let sessions = [
                ...perDevice.readingSessions,
                makeSession(now),
              ];

              // Versicle's sawtooth cap: 500 -> keep the last 300.
              if (sessions.length > MAX_READING_SESSIONS) {
                sessions = sessions.slice(-PRUNED_READING_SESSIONS);
              }

              return {
                "progress": {
                  ...state.progress,
                  [bookId]: {
                    ...perBook,
                    [deviceId]: {
                      ...perDevice,
                      "currentCfi": `epubcfi(/6/4!/4/${String(now)}:0)`,
                      "percentage": (now % 100) / 100,
                      "lastRead": now,
                      "readingSessions": sessions,
                    },
                  },
                },
              };
            });
          },
        };
      },
      {
        "disableYText": true,
        "scopedDiff": true,
        "syncedKeys": ["progress"],
      }
    )
  );

  const handle = getYjsStoreHandle(store);

  // Populate the doc with the initial tree (first flush) and settle.
  store.getState().updateReadingSession("book-0", "device-0", 0);
  handle.flush();

  return {
    doc,
    store,
    "flush": () => { handle.flush(); },
    "updateBytes": () => updateBytes,
    "resetUpdateBytes": () => { updateBytes = 0; },
  };
};

const countItems = (doc: yjs.Doc): number => {
  let count = 0;

  (doc.store as unknown as { clients: Map<number, unknown[]> }).clients
    .forEach((structs) => { count = count + structs.length; });

  return count;
};

const median = (samples: number[]): number => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)];
};

export interface VersicleScaleRow {
  books: number;
  liveSessions: number;
  pageTurnMedianMs: number;
  pageTurnBytes: number;
  sawtoothMs: number;
  sawtoothBytes: number;
  sawtoothItemDelta: number;
  inboundApplyMedianMs: number;
  inboundPatchMedianMs: number;
  hydrationMs: number;
}

/**
 * Runs the versicle-shaped scenario at one library scale.
 *
 * @param books - Number of books in the progress tree.
 * @param pageTurns - Timed steady-state page turns.
 * @returns A promise for the measured row.
 */
export const runVersicleScale = async (books: number, pageTurns: number): Promise<VersicleScaleRow> => {
  const sessionsPerDevice = 300;
  const fixture = makeFixture(books, sessionsPerDevice);

  // --- Steady-state page turns (sessions stay under the cap) ---
  const flushSamples: number[] = [];
  const byteSamples: number[] = [];
  let turn = 1;

  for (let index = 0; index < pageTurns; index = index + 1) {
    const bookId = `book-${String(index % books)}`;

    fixture.resetUpdateBytes();
    fixture.store.getState().updateReadingSession(bookId, "device-0", turn);
    turn = turn + 1;

    const start = performance.now();

    fixture.flush();
    flushSamples.push(performance.now() - start);
    byteSamples.push(fixture.updateBytes());
  }

  // --- Sawtooth: fill book-0/device-0 to the cap, then trip the splice.
  // Median of several cycles: a single-shot sample at large fixture sizes
  // mostly measures V8 GC pauses, not the flush. ---
  const sawtoothMsSamples: number[] = [];
  const sawtoothByteSamples: number[] = [];
  const sawtoothItemDeltas: number[] = [];

  for (let cycle = 0; cycle < 5; cycle = cycle + 1) {
    const state = fixture.store.getState();
    const perDevice = state.progress["book-0"]["device-0"];
    const fill = MAX_READING_SESSIONS - perDevice.readingSessions.length;

    // Fill silently (single set + flush, not timed).
    const filledSessions = [
      ...perDevice.readingSessions,
      ...Array.from({ "length": fill }, (unused, index) => makeSession((10_000 * (cycle + 1)) + index)),
    ];

    fixture.store.setState((current) => {
      return {
        "progress": {
          ...current.progress,
          "book-0": {
            ...current.progress["book-0"],
            "device-0": { ...current.progress["book-0"]["device-0"], "readingSessions": filledSessions },
          },
        },
      };
    });
    fixture.flush();

    const itemsBefore = countItems(fixture.doc);

    fixture.resetUpdateBytes();
    fixture.store.getState().updateReadingSession("book-0", "device-0", 99_999 + cycle);

    const sawtoothStart = performance.now();

    fixture.flush();
    sawtoothMsSamples.push(performance.now() - sawtoothStart);
    sawtoothByteSamples.push(fixture.updateBytes());
    sawtoothItemDeltas.push(countItems(fixture.doc) - itemsBefore);
  }

  const sawtoothMs = median(sawtoothMsSamples);
  const sawtoothBytes = median(sawtoothByteSamples);
  const sawtoothItemDelta = median(sawtoothItemDeltas);

  /*
   * --- Inbound: a second client receives one steady-state page turn ---
   *
   * The store patch is microtask-batched, so `applyUpdate` alone measures
   * almost nothing: the observer just collects the affected top-level keys
   * and schedules. The real work — re-reading the doc and diffing it into
   * the store — happens on the microtask, so each sample must drain it.
   */
  const remoteDoc = new yjs.Doc();

  yjs.applyUpdate(remoteDoc, yjs.encodeStateAsUpdate(fixture.doc));

  /*
   * Cold-start hydration: attaching a store to an already-populated document
   * (every app launch). Timed separately because it is unavoidable O(state)
   * work — the store must materialize the whole tree — and so acts as the
   * floor the steady-state numbers should be compared against.
   */
  const hydrateStart = performance.now();

  const remoteStore = createStore<ProgressState>()(
    yjsMiddleware(
      remoteDoc,
      "progress",
      () => {
        return {
          "progress": {},
          "updateReadingSession": () => { /* remote reader is passive */ },
        };
      },
      {
        "disableYText": true,
        "scopedDiff": true,
        "syncedKeys": ["progress"],
      }
    )
  );

  const hydrationMs = performance.now() - hydrateStart;

  if (Object.keys(remoteStore.getState().progress).length !== books) {
    throw new Error("hydration did not populate the store");
  }

  const inboundApplySamples: number[] = [];
  const inboundPatchSamples: number[] = [];

  for (let index = 0; index < pageTurns; index = index + 1) {
    const stateVector = yjs.encodeStateVector(remoteDoc);
    const bookId = `book-${String(index % books)}`;

    fixture.store.getState().updateReadingSession(bookId, "device-0", 20_000 + turn);
    turn = turn + 1;
    fixture.flush();

    const update = yjs.encodeStateAsUpdate(fixture.doc, stateVector);
    const before = remoteStore.getState().progress;
    const applyStart = performance.now();

    yjs.applyUpdate(remoteDoc, update);
    inboundApplySamples.push(performance.now() - applyStart);

    // Drain the batching microtask and time the store patch it performs.
    const patchStart = performance.now();

    await Promise.resolve();
    inboundPatchSamples.push(performance.now() - patchStart);

    if (remoteStore.getState().progress === before) {
      throw new Error(`inbound patch did not run for ${bookId}`);
    }
  }

  /*
   * Sanity (not timed): the remote STORE (not just the doc) must mirror the
   * source. Checking the store proves the inbound patch path actually ran.
   */
  const remoteBooks = Object.keys(remoteStore.getState().progress).length;

  if (remoteBooks !== books) {
    throw new Error(`remote store failed to converge: ${String(remoteBooks)}/${String(books)} books`);
  }

  return {
    books,
    "liveSessions": books * deviceIds.length * sessionsPerDevice,
    "pageTurnMedianMs": median(flushSamples),
    "pageTurnBytes": median(byteSamples),
    sawtoothMs,
    sawtoothBytes,
    sawtoothItemDelta,
    "inboundApplyMedianMs": median(inboundApplySamples),
    "inboundPatchMedianMs": median(inboundPatchSamples),
    hydrationMs,
  };
};

/**
 * Runs the scenario across library scales and formats a markdown report.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runVersicleBench = async (): Promise<string> => {
  const rows: VersicleScaleRow[] = [];

  for (const books of [10, 40, 120]) {
    console.error(`  running versicle-shaped scale: ${String(books)} books...`);
     
    rows.push(await runVersicleScale(books, 15));
  }

  const header =
    "| books | live sessions | page-turn flush (ms) | page-turn bytes | " +
    "sawtooth splice (ms) | sawtooth bytes | sawtooth item delta | inbound apply (ms) | inbound patch (ms) | cold hydration (ms) |";
  const divider = "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((row) => {
    return `| ${String(row.books)} | ${String(row.liveSessions)} | ` +
      `${row.pageTurnMedianMs.toFixed(3)} | ${String(row.pageTurnBytes)} | ` +
      `${row.sawtoothMs.toFixed(3)} | ${String(row.sawtoothBytes)} | ` +
      `${String(row.sawtoothItemDelta)} | ${row.inboundApplyMedianMs.toFixed(3)} | ` +
      `${row.inboundPatchMedianMs.toFixed(3)} | ${row.hydrationMs.toFixed(1)} |`;
  });

  return [
    "## Versicle-shaped aging scenario (scopedDiff, one hot top-level key)",
    "",
    header,
    divider,
    ...lines,
  ].join("\n");
};

/*
 * Bulk inbound batch on the path-scoped route.
 *
 * Versicle's `library` and `annotations` stores keep one record per item
 * under ONE top-level key. When a device comes back online, y-cinder applies
 * its backlog inside one `ydoc.transact`, so the receiving store gets ONE
 * observeDeep batch with one deep event per changed record. A migration that
 * backfills a field, a bulk re-tag, or "mark all read" looks the same. Every
 * event names `['library', bookId]`, so a scopedDiff receiver takes the
 * deep-path route (`computeInboundStateForPaths`) for the whole batch.
 *
 * Measured per batch size N (every record of an N-record library changed):
 * 1. The e2e inbound store patch, scopedDiff (deep-path route) against the
 *    legacy full-tree route on the same batch, interleaved, median of five.
 * 2. `minimizeInboundPaths` alone: median time, plus a deterministic count
 *    of path-segment reads taken through Proxy-wrapped paths.
 * At a fixed parent width (5,000 records) it also measures P changed
 * records, which isolates the per-path copy of the shared parent record.
 */

interface LibraryBook {
  title: string;
  author: string;
  lastRead: number;
  tags: string[];
}

interface LibraryState {
  library: Record<string, LibraryBook>;
}

const LIBRARY_MAP = "library-store";

const makeLibraryBook = (index: number): LibraryBook => {
  return {
    "title": `Title ${String(index)}`,
    "author": `Author ${String(index % 97)}`,
    "lastRead": 0,
    "tags": [`shelf-${String(index % 7)}`, "unread"],
  };
};

const makeLibrary = (books: number): LibraryState["library"] => {
  const library: LibraryState["library"] = {};

  for (let index = 0; index < books; index = index + 1) {
    library[`book-${String(index)}`] = makeLibraryBook(index);
  }

  return library;
};

/** The doc shape the middleware writes for `makeLibrary` with disableYText. */
const buildLibraryDoc = (books: number): yjs.Doc => {
  const doc = new yjs.Doc();

  doc.transact(() => {
    const library = new yjs.Map<yjs.Map<unknown>>();

    doc.getMap(LIBRARY_MAP).set("library", library);

    for (const [bookId, book] of Object.entries(makeLibrary(books))) {
      const bookMap = new yjs.Map<unknown>();

      library.set(bookId, bookMap);
      bookMap.set("title", book.title);
      bookMap.set("author", book.author);
      bookMap.set("lastRead", book.lastRead);
      bookMap.set("tags", yjs.Array.from(book.tags));
    }
  });

  return doc;
};

const getLibraryMap = (doc: yjs.Doc): yjs.Map<yjs.Map<unknown>> =>
  { return doc.getMap(LIBRARY_MAP).get("library") as yjs.Map<yjs.Map<unknown>> };

/** One remote transaction that stamps `lastRead` on every record. */
const markAllRead = (doc: yjs.Doc, stamp: number): void => {
  doc.transact(() => {
    getLibraryMap(doc).forEach((bookMap) => { bookMap.set("lastRead", stamp); });
  });
};

interface CatchUpResult {
  deepMedianMs: number;
  legacyMedianMs: number;
}

/**
 * Times the store patch of one all-records batch on a scopedDiff receiver
 * and on a legacy full-tree receiver. A/B samples are interleaved and the
 * first pair is a discarded warmup.
 *
 * @param books - Library size; every record changes in each batch.
 * @param runs - Timed batches per receiver.
 * @returns Median patch time per route.
 */
const runCatchUp = async (books: number, runs: number): Promise<CatchUpResult> => {
  const sender = buildLibraryDoc(books);
  const initial = yjs.encodeStateAsUpdate(sender);
  const updates: Uint8Array[] = [];

  for (let stamp = 1; stamp <= runs + 1; stamp = stamp + 1) {
    const stateVector = yjs.encodeStateVector(sender);

    markAllRead(sender, stamp);
    updates.push(yjs.encodeStateAsUpdate(sender, stateVector));
  }

  const receivers = [true, false].map((scopedDiff) => {
    const doc = new yjs.Doc();

    yjs.applyUpdate(doc, initial);

    const store = createStore<LibraryState>()(
      yjsMiddleware(doc, LIBRARY_MAP, () => ({ "library": {} }), {
        "disableYText": true,
        scopedDiff,
      })
    );

    if (Object.keys(store.getState().library).length !== books) {
      throw new Error("bulk-inbound receiver did not hydrate");
    }

    return { doc, "samples": [] as number[], store };
  });

  for (const [index, update] of updates.entries()) {
    for (const receiver of receivers) {
      yjs.applyUpdate(receiver.doc, update);

      // The store patch is microtask-batched: drain it and time the patch.
      const start = performance.now();

      await Promise.resolve();

      const elapsed = performance.now() - start;
      const { library } = receiver.store.getState();

      if (library["book-0"].lastRead !== index + 1 || library[`book-${String(books - 1)}`].lastRead !== index + 1) {
        throw new Error("bulk-inbound batch was not applied to the store");
      }
      if (index > 0) {
        receiver.samples.push(elapsed);
      }
    }
  }

  return {
    "deepMedianMs": median(receivers[0].samples),
    "legacyMedianMs": median(receivers[1].samples),
  };
};

const makeSiblingPaths = (count: number, stride: number): InboundPath[] =>
  { return Array.from({ "length": count }, (unused, index) => ["library", `book-${String(index * stride)}`]) };

/**
 * Index reads `minimizeInboundPaths` makes on the segments of `paths`,
 * counted through accessor-backed copies of each path. Deterministic: no
 * timing involved.
 *
 * @param paths - The batch's paths.
 * @returns Total segment reads across all paths.
 */
const countMinimizeReads = (paths: readonly InboundPath[]): number => {
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

    return copy;
  });

  minimizeInboundPaths(counted);

  return counter.reads;
};

interface BulkRow {
  books: number;
  deepMedianMs: number;
  legacyMedianMs: number;
  minimizeMedianMs: number;
  minimizeReads: number;
}

interface WidthRow {
  changed: number;
  medianMs: number;
}

const PARENT_WIDTH = 5_000;

/*
 * To run this scenario without the rest of the suite:
 *   npx ts-node -T -P bench/tsconfig.json \
 *     -e 'require("./bench/versicle").runInboundBulkBench().then(console.log)'
 */
/**
 * Runs the bulk inbound scenario and formats a markdown report.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runInboundBulkBench = async (): Promise<string> => {
  // Also pinned by bench/index.ts; repeated so the scenario runs alone too.
  __scopedDiffDevSampling.rate = 0;

  const rows: BulkRow[] = [];

  for (const books of [1_000, 2_000, 4_000]) {
    console.error(`  running bulk inbound batch: ${String(books)} records...`);

    const catchUp = await runCatchUp(books, 5);
    const paths = makeSiblingPaths(books, 1);
    const minimize = bench(
      `minimizeInboundPaths: ${String(books)} sibling paths`,
      () => { minimizeInboundPaths(paths); },
      { "runs": 5, "warmupRuns": 1 }
    );

    rows.push({
      books,
      ...catchUp,
      "minimizeMedianMs": minimize.medianMs,
      "minimizeReads": countMinimizeReads(paths),
    });
  }

  /*
   * Fixed parent width, growing batch: with one copy of the shared parent
   * per batch the cost would stay near the P = 1 row; with one copy per
   * path it grows with P times the parent's width.
   */
  console.error(`  running bulk inbound batch: fixed ${String(PARENT_WIDTH)}-record parent...`);

  const widthDoc = buildLibraryDoc(PARENT_WIDTH);
  const widthState: LibraryState = { "library": makeLibrary(PARENT_WIDTH) };

  markAllRead(widthDoc, 1);

  const widthRows: WidthRow[] = [1, 8, 32, 128].map((changed) => {
    const paths = makeSiblingPaths(changed, Math.floor(PARENT_WIDTH / changed));
    const result = bench(
      `computeInboundStateForPaths: ${String(changed)} of ${String(PARENT_WIDTH)} records`,
      () => { computeInboundStateForPaths(widthState, widthDoc.getMap(LIBRARY_MAP), paths); },
      { "runs": 7, "warmupRuns": 1 }
    );

    return { changed, "medianMs": result.medianMs };
  });

  const baseMs = widthRows[0].medianMs;

  return [
    "## Bulk inbound batch (one remote transaction changes every record of a library)",
    "",
    "| records changed | inbound patch, scopedDiff deep-path (ms) | inbound patch, legacy full-tree (ms) | " +
      "deep / legacy | minimizeInboundPaths (ms) | minimize path-segment reads |",
    "|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => {
      return `| ${String(row.books)} | ${row.deepMedianMs.toFixed(1)} | ${row.legacyMedianMs.toFixed(1)} | ` +
        `${(row.deepMedianMs / row.legacyMedianMs).toFixed(1)}x | ${row.minimizeMedianMs.toFixed(2)} | ` +
        `${String(row.minimizeReads)} |`;
    }),
    "",
    `computeInboundStateForPaths, P changed records under one ${String(PARENT_WIDTH)}-record parent:`,
    "",
    "| P | median (ms) | vs P = 1 |",
    "|---:|---:|---:|",
    ...widthRows.map((row) => {
      return `| ${String(row.changed)} | ${row.medianMs.toFixed(2)} | ${(row.medianMs / baseMs).toFixed(1)}x |`;
    }),
  ].join("\n");
};
