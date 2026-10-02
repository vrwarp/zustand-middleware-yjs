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
 * 5. (runColdStartRepresentationBench) Cold-start cost — decode, toJSON,
 *    hydration, structs, snapshot bytes — of storing each reading session
 *    as a Y.Map vs as a plain JSON element of the same Y.Array.
 *
 * `runInboundBulkBench` (later in this file) covers the other inbound shape: one
 * remote batch that changes many sibling records at once (offline catch-up,
 * a backfill migration, "mark all read").
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from "../src";
import { computeInboundStateForPaths, type InboundPath, minimizeInboundPaths, patchSharedType } from "../src/patching";
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

/*
 * Shared-map scenario: a tiny store next to the progress tree.
 *
 * `syncedKeys` lets several stores share ONE Y.Map with disjoint key sets
 * (and lets a store ignore a deprecated key that old documents still carry).
 * Here a small `settings` store (syncedKeys ['settings']) is bound to the
 * same map that holds the whole `progress` tree. Its own data is a handful of
 * scalars, so every operation on it should cost O(settings) — yet whole-map
 * reads (creation hydration, the legacy flush's root `toJSON()`, the legacy
 * inbound re-read) serialize the foreign `progress` tree first and only then
 * discard it with pickKeys.
 *
 * Measured per library scale (0 books = a map holding only `settings`, the
 * O(own data) reference) and per diff mode:
 * - Y types serialized (`Y.Map`/`Y.Array` `toJSON` calls, deterministic) and
 *   median wall time of: cold hydration, an outbound settings flush, an
 *   inbound settings change, and an inbound FOREIGN change (another device's
 *   page turn, which touches no key this store syncs).
 */

interface Settings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

interface SettingsState {
  settings: Settings;
  setFontSize: (fontSize: number) => void;
}

const SHARED_MAP = "versicle";

const initialSettings: Settings = {
  "theme": "sepia",
  "fontFamily": "serif",
  "fontSize": 18,
  "lineHeight": 1.5,
};

const makeSettingsStore = (doc: yjs.Doc, isScopedDiff: boolean): StoreApi<SettingsState> => {
  return createStore<SettingsState>()(
    yjsMiddleware(
      doc,
      SHARED_MAP,
      (set) => {
        return {
          "settings": initialSettings,
          "setFontSize": (fontSize: number) => {
            set((state) => ({ "settings": { ...state.settings, fontSize } }));
          },
        };
      },
      {
        "disableYText": true,
        "scopedDiff": isScopedDiff,
        "syncedKeys": ["settings"],
      }
    )
  );
};

/**
 * Runs `fn` with Y.Map/Y.Array `toJSON` wrapped by a counter (nested calls
 * included: a parent's toJSON recurses through the children's prototypes).
 *
 * @param fn - The work to count; may be async.
 * @returns A promise for the number of Y types serialized during `fn`.
 */
const countSerializedTypes = async (fn: () => unknown): Promise<number> => {
  const mapPrototype = yjs.Map.prototype as { toJSON: () => unknown };
  const arrayPrototype = yjs.Array.prototype as { toJSON: () => unknown };
  const originalMapToJson = mapPrototype.toJSON;
  const originalArrayToJson = arrayPrototype.toJSON;
  let calls = 0;

  mapPrototype.toJSON = function countedMapToJson(this: unknown) {
    calls = calls + 1;

    return originalMapToJson.call(this);
  };
  arrayPrototype.toJSON = function countedArrayToJson(this: unknown) {
    calls = calls + 1;

    return originalArrayToJson.call(this);
  };

  try {
    await fn();
  } finally {
    mapPrototype.toJSON = originalMapToJson;
    arrayPrototype.toJSON = originalArrayToJson;
  }

  return calls;
};

export interface SharedMapRow {
  books: number;
  mode: string;
  hydrationTypes: number;
  hydrationMs: number;
  flushTypes: number;
  flushMs: number;
  inboundOwnTypes: number;
  inboundOwnMs: number;
  inboundForeignTypes: number;
  inboundForeignMs: number;
}

/**
 * Measures the settings store at one library scale and diff mode.
 *
 * @param books - Books in the foreign progress tree (0 = settings only).
 * @param isScopedDiff - Diff mode of the measured settings store.
 * @param samples - Timed samples per operation (median reported).
 * @returns A promise for the measured row.
 */
export const runSharedMapScale = async (
  books: number,
  isScopedDiff: boolean,
  samples: number
): Promise<SharedMapRow> => {
  __scopedDiffDevSampling.rate = 0;

  // The populated document every client starts from: the progress tree
  // (written in the middleware's own layout) next to the settings.
  const sourceDoc = new yjs.Doc();

  sourceDoc.transact(() => {
    patchSharedType(
      sourceDoc.getMap(SHARED_MAP),
      books === 0
        ? { "settings": initialSettings }
        : { "progress": makeProgressTree(books, 300), "settings": initialSettings },
      { "disableYText": true }
    );
  });

  const snapshot = yjs.encodeStateAsUpdate(sourceDoc);
  const loadDoc = (): yjs.Doc => {
    const loaded = new yjs.Doc();

    yjs.applyUpdate(loaded, snapshot);

    return loaded;
  };

  // --- Cold hydration: attach the settings store to the populated doc ---
  const hydrationTypes = await countSerializedTypes(() => makeSettingsStore(loadDoc(), isScopedDiff));
  const hydrationSamples: number[] = [];

  for (let index = 0; index < samples; index = index + 1) {
    const coldDoc = loadDoc();
    const start = performance.now();
    const coldStore = makeSettingsStore(coldDoc, isScopedDiff);

    hydrationSamples.push(performance.now() - start);

    if (coldStore.getState().settings.theme !== "sepia" || Object.hasOwn(coldStore.getState(), "progress")) {
      throw new Error("hydration produced the wrong state");
    }
  }

  // --- Steady state: one measured client and one peer ---
  const doc = loadDoc();
  const peerDoc = loadDoc();
  const store = makeSettingsStore(doc, isScopedDiff);
  const handle = getYjsStoreHandle(store);
  let fontSize = 20;

  const flushOnce = (): void => {
    store.getState().setFontSize(fontSize);
    fontSize = fontSize + 1;
    handle.flush();
  };

  // Outbound: one settings write, flushed synchronously.
  const flushTypes = await countSerializedTypes(flushOnce);
  const flushSamples: number[] = [];

  for (let index = 0; index < samples; index = index + 1) {
    store.getState().setFontSize(fontSize);
    fontSize = fontSize + 1;

    const start = performance.now();

    handle.flush();
    flushSamples.push(performance.now() - start);
  }

  flushOnce();
  yjs.applyUpdate(peerDoc, yjs.encodeStateAsUpdate(doc, yjs.encodeStateVector(peerDoc)));

  const peerMap = peerDoc.getMap(SHARED_MAP);
  let peerValue = 0;

  /**
   * One remote transaction from the peer, applied to the measured doc; the
   * store patch is microtask-batched, so the work happens on the drain.
   */
  const receive = async (write: () => void): Promise<void> => {
    const stateVector = yjs.encodeStateVector(doc);

    peerDoc.transact(write);
    yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(peerDoc, stateVector));
    await Promise.resolve();
  };
  const writeOwn = (): void => {
    peerValue = peerValue + 1;
    (peerMap.get("settings") as yjs.Map<unknown>).set("lineHeight", 1 + (peerValue / 1000));
  };
  const writeForeign = (): void => {
    peerValue = peerValue + 1;

    if (books === 0) {
      peerMap.set("progress", peerValue);

      return;
    }

    const bookId = `book-${String(peerValue % books)}`;
    const progress = peerMap.get("progress") as yjs.Map<yjs.Map<yjs.Map<unknown>>>;

    progress.get(bookId)?.get("device-1")?.set("percentage", peerValue / 1_000_000);
  };

  const timeReceive = async (write: () => void): Promise<{ types: number; ms: number }> => {
    const types = await countSerializedTypes(() => receive(write));
    const timings: number[] = [];

    for (let index = 0; index < samples; index = index + 1) {
      const stateVector = yjs.encodeStateVector(doc);

      peerDoc.transact(write);
      yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(peerDoc, stateVector));

      const start = performance.now();

      await Promise.resolve();
      timings.push(performance.now() - start);
    }

    return { types, "ms": median(timings) };
  };

  const inboundOwn = await timeReceive(writeOwn);

  if (store.getState().settings.lineHeight !== 1 + (peerValue / 1000)) {
    throw new Error("inbound settings change did not reach the store");
  }

  const inboundForeign = await timeReceive(writeForeign);

  if (Object.hasOwn(store.getState(), "progress")) {
    throw new Error("a foreign key leaked into the settings store");
  }

  return {
    books,
    "mode": isScopedDiff ? "scopedDiff" : "legacy",
    hydrationTypes,
    "hydrationMs": median(hydrationSamples),
    flushTypes,
    "flushMs": median(flushSamples),
    "inboundOwnTypes": inboundOwn.types,
    "inboundOwnMs": inboundOwn.ms,
    "inboundForeignTypes": inboundForeign.types,
    "inboundForeignMs": inboundForeign.ms,
  };
};

export interface SharedMapBenchOptions {
  /** Library sizes to measure (0 = settings-only reference). */
  scales?: readonly number[];
  /** Timed samples per operation (median reported). */
  samples?: number;
}

/**
 * Runs the shared-map scenario across library scales and both diff modes.
 *
 * @param options - Optional overrides (see SharedMapBenchOptions).
 * @returns A promise for the report as a markdown string.
 */
export const runSharedMapBench = async (
  { scales = [0, 10, 40, 120], samples = 7 }: SharedMapBenchOptions = {}
): Promise<string> => {
  const rows: SharedMapRow[] = [];

  for (const isScopedDiff of [false, true]) {
    for (const books of scales) {
      console.error(`  running shared-map scale: ${String(books)} books, ${isScopedDiff ? "scopedDiff" : "legacy"}...`);

      rows.push(await runSharedMapScale(books, isScopedDiff, samples));
    }
  }

  const header =
    "| mode | books | hydration: types | hydration (ms) | settings flush: types | settings flush (ms) | " +
    "inbound settings: types | inbound settings (ms) | inbound foreign: types | inbound foreign (ms) |";
  const divider = "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((row) => {
    return `| ${row.mode} | ${String(row.books)} | ${String(row.hydrationTypes)} | ${row.hydrationMs.toFixed(3)} | ` +
      `${String(row.flushTypes)} | ${row.flushMs.toFixed(3)} | ` +
      `${String(row.inboundOwnTypes)} | ${row.inboundOwnMs.toFixed(3)} | ` +
      `${String(row.inboundForeignTypes)} | ${row.inboundForeignMs.toFixed(3)} |`;
  });

  return [
    "## Shared map: tiny `settings` store (syncedKeys) next to the progress tree",
    "",
    "types = Y.Map/Y.Array toJSON calls (deterministic); times are medians.",
    "0 books = a map holding only `settings` (the O(own data) reference).",
    "",
    header,
    divider,
    ...lines,
  ].join("\n");
};

/* -------------------------------------------------------------------------
 * Cold-start cost of the readingSessions representation
 * (json-leaf-records-for-cold-start).
 *
 * By default the middleware maps every object to a Y.Map, so each
 * immutable, append-only reading session costs 1 ContentType item + 1 keyed
 * item per field (6 structs), and each session a trim removes leaves 2
 * permanent structs (the deleted wrapper + the merged GC run of its fields).
 * With the opt-in `jsonElementKeys: ["readingSessions"]` the session
 * ELEMENTS are plain JSON values (ContentAny) inside the same Y.Array.
 *
 * Fresh docs are written by the real middleware in both representations.
 * Aged docs (hundreds of page turns per device) are built by replaying the
 * identical operations directly with Yjs, because building Y.Map aged docs
 * through the middleware is slow in Yjs itself. Fidelity: before anything is
 * measured, each replay is checked against the real middleware (2 books,
 * same page-turn history) — identical JSON, struct count within 0.1%.
 *
 * Measured per doc: struct count, tombstones, encoded snapshot bytes
 * (pinned client ID, so deterministic), Y.applyUpdate into a fresh doc (what
 * y-idb does at every launch), map.toJSON(), and cold-start hydration of a
 * real middleware store attached to the decoded doc, plus the number of
 * Y.Map#toJSON calls that hydration makes.
 * ---------------------------------------------------------------------- */

type SessionRepresentation = "ymap" | "json";

const representationLabel = (representation: SessionRepresentation): string => {
  return representation === "ymap" ? "Y.Map elements (default)" : "JSON elements (jsonElementKeys)";
};

const representationOptions = (representation: SessionRepresentation): { jsonElementKeys?: string[] } => {
  return representation === "json" ? { "jsonElementKeys": ["readingSessions"] } : {};
};

/** Number of readingSessions elements stored as shared types (Y.Map) in a progress doc. */
const countSharedTypeSessions = (doc: yjs.Doc): number => {
  const progress = doc.getMap("progress").get("progress") as yjs.Map<yjs.Map<yjs.Map<unknown>>>;
  let count = 0;

  progress.forEach((perBook) => {
    perBook.forEach((perDevice) => {
      for (const element of (perDevice.get("readingSessions") as yjs.Array<unknown>).toArray()) {
        if (element instanceof yjs.AbstractType) {
          count = count + 1;
        }
      }
    });
  });

  return count;
};

/**
 * Mirrors objectToYMap/arrayToYArray with `disableYText` (one Y.Array insert
 * per array, prelim types built bottom-up), except that under
 * `readingSessions` the JSON representation keeps object elements as plain
 * values.
 *
 * @param value - The plain value to map.
 * @param isJsonElements - Store object elements of this array as JSON.
 * @param representation - Which session representation to build.
 * @returns The prelim shared type (or the primitive itself).
 */
const toPrelim = (value: unknown, isJsonElements: boolean, representation: SessionRepresentation): unknown => {
  if (Array.isArray(value)) {
    const yarray = new yjs.Array<unknown>();

    yarray.insert(0, value.map((element: unknown) => {
      if (typeof element === "object" && element !== null && !isJsonElements) {
        return toPrelim(element, false, representation);
      }

      return element;
    }));

    return yarray;
  }

  if (typeof value === "object" && value !== null) {
    const ymap = new yjs.Map<unknown>();

    for (const [key, child] of Object.entries(value)) {
      ymap.set(key, toPrelim(child, key === "readingSessions" && representation === "json", representation));
    }

    return ymap;
  }

  return value;
};

interface ReplayedDoc {
  doc: yjs.Doc;
  removedSessions: number;
}

/**
 * Builds a progress doc by replaying page turns directly with Yjs: the
 * initial tree (300 sessions per device, written in one transaction like the
 * middleware's first flush), then `turnsPerDevice` page turns per device
 * branch, each one transaction that rewrites currentCfi/percentage/lastRead
 * and appends one session (trimming the 500 cap to the last 300 first), in the
 * order the scoped flush applies them.
 *
 * @param books - Library size.
 * @param turnsPerDevice - Page turns per (book, device) branch.
 * @param representation - Session element representation.
 * @returns The doc and how many sessions trims removed.
 */
const replayProgressDoc = (books: number, turnsPerDevice: number, representation: SessionRepresentation): ReplayedDoc => {
  const doc = new yjs.Doc();

  doc.clientID = 1;

  const tree = makeProgressTree(books, 300);
  const prelim = toPrelim(tree, false, representation) as yjs.Map<unknown>;

  doc.transact(() => {
    doc.getMap("progress").set("progress", prelim);
  });

  const progress = doc.getMap("progress").get("progress") as yjs.Map<unknown>;
  let removedSessions = 0;

  for (let turn = 0; turn < turnsPerDevice; turn = turn + 1) {
    for (let book = 0; book < books; book = book + 1) {
      const perBook = progress.get(`book-${String(book)}`) as yjs.Map<unknown>;

      for (const [deviceIndex, deviceId] of deviceIds.entries()) {
        const perDevice = perBook.get(deviceId) as yjs.Map<unknown>;
        const sessions = perDevice.get("readingSessions") as yjs.Array<unknown>;
        const n = 1_000_000 + (book * 10_000) + (deviceIndex * 5_000) + turn;
        const remove = sessions.length + 1 > MAX_READING_SESSIONS
          ? sessions.length + 1 - PRUNED_READING_SESSIONS
          : 0;

        removedSessions = removedSessions + remove;
        doc.transact(() => {
          perDevice.set("currentCfi", `epubcfi(/6/4!/4/${String(n)}:0)`);
          perDevice.set("percentage", (n % 100) / 100);
          perDevice.set("lastRead", n);

          if (remove > 0) {
            sessions.delete(0, remove);
          }

          sessions.push([representation === "json" ? makeSession(n) : toPrelim(makeSession(n), false, representation)]);
        });
      }
    }
  }

  return { doc, removedSessions };
};

/** Applies the same page-turn history through the real middleware. */
const middlewareProgressDoc = (books: number, turnsPerDevice: number, representation: SessionRepresentation): yjs.Doc => {
  const doc = new yjs.Doc();

  doc.clientID = 1;

  const store = createStore<{ progress: ProgressTree }>()(
    yjsMiddleware(
      doc,
      "progress",
      () => ({ "progress": makeProgressTree(books, 300) }),
      { "disableYText": true, "scopedDiff": true, "syncedKeys": ["progress"], ...representationOptions(representation) }
    )
  );
  const handle = getYjsStoreHandle(store);

  store.setState((state) => ({ "progress": { ...state.progress } }));
  handle.flush();

  for (let turn = 0; turn < turnsPerDevice; turn = turn + 1) {
    for (let book = 0; book < books; book = book + 1) {
      const bookId = `book-${String(book)}`;

      deviceIds.forEach((deviceId, deviceIndex) => {
        const n = 1_000_000 + (book * 10_000) + (deviceIndex * 5_000) + turn;

        store.setState((state) => {
          const perBook = state.progress[bookId];
          const perDevice = perBook[deviceId];
          let sessions = [...perDevice.readingSessions, makeSession(n)];

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
                  "currentCfi": `epubcfi(/6/4!/4/${String(n)}:0)`,
                  "percentage": (n % 100) / 100,
                  "lastRead": n,
                  "readingSessions": sessions,
                },
              },
            },
          };
        });
        handle.flush();
      });
    }
  }

  return doc;
};

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

/** Runs `fn` while counting Y.Map#toJSON calls (nested calls included). */
const countMapToJsonCalls = (fn: () => void): number => {
  const prototype = yjs.Map.prototype as unknown as { toJSON: (this: yjs.Map<unknown>) => unknown };
  const original = prototype.toJSON;
  let calls = 0;

  prototype.toJSON = function countingToJson(this: yjs.Map<unknown>) {
    calls = calls + 1;

    return original.call(this);
  };

  try {
    fn();
  } finally {
    prototype.toJSON = original;
  }

  return calls;
};

const hydrateProgressStore = (doc: yjs.Doc, representation: SessionRepresentation): StoreApi<{ progress: ProgressTree }> => {
  return createStore<{ progress: ProgressTree }>()(
    yjsMiddleware(
      doc,
      "progress",
      () => ({ "progress": {} }),
      { "disableYText": true, "scopedDiff": true, "syncedKeys": ["progress"], ...representationOptions(representation) }
    )
  );
};

export interface ColdStartRow {
  doc: string;
  representation: string;
  books: number;
  liveSessions: number;
  structs: number;
  tombstones: number;
  bytes: number;
  decodeMs: number;
  toJsonMs: number;
  hydrationMs: number;
  hydrationMapToJsonCalls: number;
}

const measureColdStart = (docLabel: string, books: number, representation: SessionRepresentation, doc: yjs.Doc): ColdStartRow => {
  const update = yjs.encodeStateAsUpdate(doc);

  const decode = bench(
    `cold-start decode ${docLabel} ${representation}`,
    (fixture) => { yjs.applyUpdate(fixture as yjs.Doc, update); },
    { "runs": 5, "warmupRuns": 1, "setup": () => new yjs.Doc() }
  );

  const decoded = new yjs.Doc();

  yjs.applyUpdate(decoded, update);

  const toJson = bench(
    `cold-start toJSON ${docLabel} ${representation}`,
    () => { decoded.getMap("progress").toJSON(); },
    { "runs": 7, "warmupRuns": 2 }
  );

  /*
   * Each run attaches a store to a freshly decoded doc (decoded in untimed
   * setup), as an app launch does. Stores attached to one shared doc stay
   * reachable through its observers, so their hydrated state would pile up
   * across runs and bill later runs for collecting it.
   */
  const hydration = bench(
    `cold-start hydration ${docLabel} ${representation}`,
    (fixture) => {
      const store = hydrateProgressStore(fixture as yjs.Doc, representation);

      if (Object.keys(store.getState().progress).length !== books) {
        throw new Error("hydration did not populate the store");
      }
    },
    {
      "runs": 7,
      "warmupRuns": 2,
      "setup": () => {
        const fresh = new yjs.Doc();

        yjs.applyUpdate(fresh, update);

        return fresh;
      },
    }
  );

  const hydrationMapToJsonCalls = countMapToJsonCalls(() => {
    hydrateProgressStore(decoded, representation);
  });
  const hydratedProgress = (decoded.getMap("progress").toJSON() as { progress: ProgressTree }).progress;
  let liveSessions = 0;

  for (const perBook of Object.values(hydratedProgress)) {
    for (const perDevice of Object.values(perBook)) {
      liveSessions = liveSessions + perDevice.readingSessions.length;
    }
  }

  return {
    "doc": docLabel,
    "representation": representationLabel(representation),
    books,
    liveSessions,
    "structs": countItems(doc),
    "tombstones": countTombstones(doc),
    "bytes": update.byteLength,
    "decodeMs": decode.medianMs,
    "toJsonMs": toJson.medianMs,
    "hydrationMs": hydration.medianMs,
    hydrationMapToJsonCalls,
  };
};

interface SessionsState {
  sessions: ReadingSession[];
  lastRead: number;
}

/**
 * Per-record counters: structs one page turn's appended session adds, and
 * tombstones per session a 500-to-300 trim removes, through the real
 * middleware.
 *
 * @param representation - Session element representation.
 * @returns Structs per appended session and tombstones per trimmed session.
 */
const perRecordCounters = (representation: SessionRepresentation): { appendStructs: number; trimTombstonesPerRecord: number } => {
  const doc = new yjs.Doc();

  doc.clientID = 1;

  const store = createStore<SessionsState>()(
    yjsMiddleware(
      doc,
      "progress",
      (): SessionsState => ({ "sessions": [], "lastRead": 0 }),
      {
        "disableYText": true,
        "scopedDiff": true,
        ...(representation === "json" ? { "jsonElementKeys": ["sessions"] } : {}),
      }
    )
  );
  const handle = getYjsStoreHandle(store);
  const pageTurn = (n: number): void => {
    store.setState((state) => ({ "lastRead": n, "sessions": [...state.sessions, makeSession(n)] }));
    handle.flush();
  };
  const trim = (): void => {
    store.setState((state) => ({ "sessions": state.sessions.slice(-PRUNED_READING_SESSIONS) }));
    handle.flush();
  };

  // Each page turn also rewrites a scalar, so consecutive sessions never share a struct.
  for (let n = 1; n < MAX_READING_SESSIONS; n = n + 1) {
    pageTurn(n);
  }

  const structsBefore = countItems(doc);

  pageTurn(MAX_READING_SESSIONS);

  // Minus the one new item of the scalar rewrite.
  const appendStructs = countItems(doc) - structsBefore - 1;
  const tombstonesBefore = countTombstones(doc);

  trim();

  return {
    appendStructs,
    "trimTombstonesPerRecord": (countTombstones(doc) - tombstonesBefore) / (MAX_READING_SESSIONS - PRUNED_READING_SESSIONS),
  };
};

export interface ColdStartBenchOptions {
  freshBooks?: number[];
  agedBooks?: number;
  agedTurnsPerDevice?: number;
}

/**
 * Runs the cold-start representation comparison and formats a report.
 *
 * @param options - Scales: fresh-snapshot library sizes, and the aged doc's
 * library size and page turns per device (700 = three 500-to-300 trims per
 * branch).
 * @returns The report as a markdown string.
 */
export const runColdStartRepresentationBench = ({
  freshBooks = [10, 40, 120],
  agedBooks = 10,
  agedTurnsPerDevice = 700,
}: ColdStartBenchOptions = {}): string => {
  // --- Fidelity: each replay must reproduce the middleware's doc. ---
  console.error("  cold-start: checking replay fidelity against the middleware (2 books)...");

  const fidelityTurns = Math.min(agedTurnsPerDevice, 700);
  const viaMiddleware = middlewareProgressDoc(2, fidelityTurns, "ymap");
  const viaMiddlewareJson = middlewareProgressDoc(2, fidelityTurns, "json");
  const viaReplay = replayProgressDoc(2, fidelityTurns, "ymap").doc;
  const viaReplayJson = replayProgressDoc(2, fidelityTurns, "json").doc;
  const middlewareJson = JSON.stringify(viaMiddleware.getMap("progress").toJSON());
  const structDrift = (replayed: yjs.Doc, built: yjs.Doc): number => {
    return Math.abs(countItems(replayed) - countItems(built)) / countItems(built);
  };

  if (JSON.stringify(viaReplay.getMap("progress").toJSON()) !== middlewareJson ||
    JSON.stringify(viaMiddlewareJson.getMap("progress").toJSON()) !== middlewareJson ||
    JSON.stringify(viaReplayJson.getMap("progress").toJSON()) !== middlewareJson ||
    structDrift(viaReplay, viaMiddleware) > 0.001 ||
    structDrift(viaReplayJson, viaMiddlewareJson) > 0.001) {
    throw new Error("replay does not reproduce the middleware doc");
  }

  // The two representations must differ only in how sessions are stored.
  if (countSharedTypeSessions(viaMiddlewareJson) !== 0 ||
    countSharedTypeSessions(viaReplayJson) !== 0 ||
    countSharedTypeSessions(viaReplay) !== countSharedTypeSessions(viaMiddleware)) {
    throw new Error("session representation is not the intended one");
  }

  const fidelityLine = `Replay fidelity (2 books, ${String(fidelityTurns)} turns/device): Y.Map elements ` +
    `${String(countItems(viaMiddleware))} structs via the middleware vs ${String(countItems(viaReplay))} replayed; ` +
    `JSON elements ${String(countItems(viaMiddlewareJson))} via the middleware vs ` +
    `${String(countItems(viaReplayJson))} replayed; identical JSON throughout.`;

  const rows: ColdStartRow[] = [];

  for (const books of freshBooks) {
    console.error(`  cold-start: fresh snapshot, ${String(books)} books...`);

    // The doc the real middleware writes on its first flush.
    rows.push(measureColdStart("fresh", books, "ymap", middlewareProgressDoc(books, 0, "ymap")));
    rows.push(measureColdStart("fresh", books, "json", middlewareProgressDoc(books, 0, "json")));
  }

  const agedLabel = `aged (${String(agedTurnsPerDevice)} turns/device)`;
  const removed: Partial<Record<SessionRepresentation, number>> = {};

  for (const representation of ["ymap", "json"] as const) {
    console.error(`  cold-start: aged doc, ${String(agedBooks)} books, ${representation}...`);

    const replayed = replayProgressDoc(agedBooks, agedTurnsPerDevice, representation);

    removed[representation] = replayed.removedSessions;
    rows.push(measureColdStart(agedLabel, agedBooks, representation, replayed.doc));
  }

  const ymapCounters = perRecordCounters("ymap");
  const jsonCounters = perRecordCounters("json");

  const header =
    "| doc | representation | books | live sessions | structs | tombstones | snapshot bytes | " +
    "Y.applyUpdate (ms) | map.toJSON (ms) | hydration (ms) | Y.Map#toJSON calls in hydration |";
  const divider = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const lines = rows.map((row) => {
    return `| ${row.doc} | ${row.representation} | ${String(row.books)} | ${String(row.liveSessions)} | ` +
      `${String(row.structs)} | ${String(row.tombstones)} | ${String(row.bytes)} | ` +
      `${row.decodeMs.toFixed(1)} | ${row.toJsonMs.toFixed(1)} | ${row.hydrationMs.toFixed(1)} | ` +
      `${String(row.hydrationMapToJsonCalls)} |`;
  });

  return [
    "## Cold-start cost of the readingSessions representation (json-leaf-records-for-cold-start)",
    "",
    header,
    divider,
    ...lines,
    "",
    `Per record: structs added by one appended session = ${String(ymapCounters.appendStructs)} (Y.Map) vs ` +
      `${String(jsonCounters.appendStructs)} (JSON); tombstones left per session a 500 -> 300 trim removes = ` +
      `${ymapCounters.trimTombstonesPerRecord.toFixed(2)} (Y.Map) vs ${jsonCounters.trimTombstonesPerRecord.toFixed(2)} (JSON). ` +
      `Aged doc: ${String(removed.ymap ?? 0)} sessions trimmed.`,
    "",
    fidelityLine,
  ].join("\n");
};
