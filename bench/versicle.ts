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
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { getYjsStoreHandle } from "../src";

interface ReadingSession {
  cfiRange: string;
  startTime: number;
  endTime: number;
  type: string;
  label: string;
}

interface DeviceProgress {
  bookId: string;
  currentCfi: string;
  percentage: number;
  lastRead: number;
  completedRanges: string[];
  readingSessions: ReadingSession[];
}

type ProgressTree = Record<string, Record<string, DeviceProgress>>;

interface ProgressState {
  progress: ProgressTree;
  updateReadingSession: (bookId: string, deviceId: string, now: number) => void;
}

const deviceIds = ["device-0", "device-1"];

const makeSession = (n: number): ReadingSession => {
  return {
    "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0),epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:80)`,
    "startTime": 1_700_000_000_000 + (n * 60_000),
    "endTime": 1_700_000_000_000 + (n * 60_000) + 45_000,
    "type": n % 5 === 0 ? "tts" : "page",
    "label": `Chapter ${String(n % 30)}: section ${String(n)}`,
  };
};

const makeDeviceProgress = (bookId: string, sessions: number): DeviceProgress => {
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

const makeProgressTree = (books: number, sessionsPerDevice: number): ProgressTree => {
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
