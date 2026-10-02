/*
 * Inbound batches that mix one root-level event with a deep change.
 *
 * §11 of docs/performance.md made a deep remote edit cost O(changed branch):
 * the observer keeps every event's full path and the patch reconciles only
 * those branches (computeInboundStateForPaths). The fast route is gated by a
 * single batch-wide boolean, though: ANY event that is only visible at the
 * top level — a top-level primitive written, a top-level key added, replaced
 * or deleted, an edit inside a top-level Y.Array (path cut to one segment) —
 * sets it, and then the WHOLE batch takes the key-scoped route. That route
 * `toJSON()`s, sanitizes and deep-diffs every affected top-level key in
 * full, including a hot key (`progress`) that only had a deep change. One
 * small top-level field written alongside a page turn brings back the
 * O(total library) inbound cost §11 removed.
 *
 * Store shape: the versicle `progress` tree (book -> device -> fields + 300
 * reading sessions) plus two small top-level fields in the SAME store —
 * `currentBookId` (a primitive string, disableYText) and `recentBookIds` (a
 * five-element array, i.e. a top-level Y.Array). scopedDiff: true, the
 * downstream configuration.
 *
 * Measured on the RECEIVING store. The patch is microtask-batched, so each
 * sample applies the update(s) and then drains the microtask, timing the
 * drain. Alongside the median timings, every Y.Map / Y.Array `toJSON()` call
 * made by the receiver is counted — a deterministic measure of how much of
 * the document the patch materialized — together with the number of store
 * notifications per batch (must stay 1).
 *
 * Scenarios (interleaved per sample, so drift and GC pressure hit them all):
 * 1. deep only — an ordinary page turn (control: deep-path route).
 * 2. deep + top-level string, one transaction — the same page turn with
 *    `currentBookId` written in the same set().
 * 3. deep + top-level string, two transactions in one tick — the page turn
 *    and the `currentBookId` write arrive as separate updates before the
 *    batching microtask runs (a catch-up, or two writes flushed separately).
 * 4. deep + top-level array edit, one transaction — `recentBookIds` reordered
 *    alongside the page turn.
 * 5. top-level string only — control: the small key on its own is cheap.
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from "../src";
import { makeProgressTree, makeSession, type ProgressTree } from "./versicle";

const SAMPLES = 9;
const WARMUP_SAMPLES = 2;
const SESSIONS_PER_DEVICE = 300;
const RECENT_LENGTH = 5;

interface MixedState {
  progress: ProgressTree;
  currentBookId: string;
  recentBookIds: string[];
}

interface Counters {
  mapToJson: number;
  arrayToJson: number;
}

const counters: Counters = { "mapToJson": 0, "arrayToJson": 0 };

/**
 * Counts every Y.Map / Y.Array `toJSON()` call (nested calls included: a
 * container serializes its child containers through the same prototype
 * method). Returns a function that restores the originals.
 *
 * @returns The restore function.
 */
const installToJsonCounters = (): (() => void) => {
  const mapPrototype = yjs.Map.prototype as { toJSON: () => unknown };
  const arrayPrototype = yjs.Array.prototype as { toJSON: () => unknown };
  const originalMapToJson = mapPrototype.toJSON;
  const originalArrayToJson = arrayPrototype.toJSON;

  mapPrototype.toJSON = function countedMapToJson(this: yjs.Map<unknown>): unknown {
    counters.mapToJson = counters.mapToJson + 1;

    return originalMapToJson.call(this);
  };
  arrayPrototype.toJSON = function countedArrayToJson(this: yjs.Array<unknown>): unknown {
    counters.arrayToJson = counters.arrayToJson + 1;

    return originalArrayToJson.call(this);
  };

  return () => {
    mapPrototype.toJSON = originalMapToJson;
    arrayPrototype.toJSON = originalArrayToJson;
  };
};

const median = (samples: number[]): number => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)];
};

const middlewareOptions = {
  "disableYText": true,
  "scopedDiff": true,
  "syncedKeys": ["progress", "currentBookId", "recentBookIds"],
};

/** The page turn versicle's updateReadingSession makes: one device branch. */
const turnPage = (tree: ProgressTree, bookId: string, now: number): ProgressTree => {
  const perBook = tree[bookId];
  const perDevice = perBook["device-0"];

  return {
    ...tree,
    [bookId]: {
      ...perBook,
      "device-0": {
        ...perDevice,
        "currentCfi": `epubcfi(/6/4!/4/${String(now)}:0)`,
        "percentage": (now % 100) / 100,
        "lastRead": now,
        "readingSessions": [...perDevice.readingSessions, makeSession(now)],
      },
    },
  };
};

interface Pair {
  sender: StoreApi<MixedState>;
  senderDoc: yjs.Doc;
  flushSender: () => void;
  receiver: StoreApi<MixedState>;
  receiverDoc: yjs.Doc;
  notifications: () => number;
}

const makePair = (books: number): Pair => {
  const senderDoc = new yjs.Doc();
  const tree = makeProgressTree(books, SESSIONS_PER_DEVICE);
  const sender = createStore<MixedState>()(
    yjsMiddleware(
      senderDoc,
      "progress",
      (): MixedState => {
        return {
          "progress": tree,
          "currentBookId": "book-0",
          "recentBookIds": Array.from({ "length": RECENT_LENGTH }, (unused, index) => `book-${String(index)}`),
        };
      },
      middlewareOptions
    )
  );
  const senderHandle = getYjsStoreHandle(sender);

  // Seed the doc (an empty doc is only written on the first flush, and only
  // in full once the store is hydrated: a new doc, so mark it).
  senderHandle.markHydrated();
  sender.setState((state) => ({ "progress": { ...state.progress } }));
  senderHandle.flush();

  const receiverDoc = new yjs.Doc();

  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(senderDoc));

  const receiver = createStore<MixedState>()(
    yjsMiddleware(
      receiverDoc,
      "progress",
      (): MixedState => ({ "progress": {}, "currentBookId": "", "recentBookIds": [] }),
      middlewareOptions
    )
  );

  if (Object.keys(receiver.getState().progress).length !== books) {
    throw new Error("receiver did not hydrate");
  }

  let notificationCount = 0;

  receiver.subscribe(() => { notificationCount = notificationCount + 1; });

  return {
    sender,
    senderDoc,
    "flushSender": () => { senderHandle.flush(); },
    receiver,
    receiverDoc,
    "notifications": () => notificationCount,
  };
};

type ScenarioName =
  | "deep only (control)"
  | "deep + top-level string, one txn"
  | "deep + top-level string, two txns one tick"
  | "deep + top-level array edit, one txn"
  | "top-level string only (control)";

const scenarioNames: readonly ScenarioName[] = [
  "deep only (control)",
  "deep + top-level string, one txn",
  "deep + top-level string, two txns one tick",
  "deep + top-level array edit, one txn",
  "top-level string only (control)",
];

interface Sample {
  patchMs: number;
  toJsonCalls: number;
  notifications: number;
}

/**
 * Makes the sender write one scenario, captures the update(s) it produced,
 * delivers them to the receiver in one tick and drains the batch.
 *
 * @param pair - The sender/receiver pair.
 * @param scenario - Which write to make.
 * @param turn - A monotonically increasing turn number (picks the book).
 * @param books - Library size.
 * @returns The receiver-side cost of the batch.
 */
const runSample = async (pair: Pair, scenario: ScenarioName, turn: number, books: number): Promise<Sample> => {
  const { sender, senderDoc, flushSender, receiver, receiverDoc } = pair;
  let bookId = `book-${String(turn % books)}`;

  // The top-level write must actually change the doc.
  if (sender.getState().currentBookId === bookId) {
    bookId = `book-${String((turn + 1) % books)}`;
  }

  /*
   * Each write is flushed and captured as its own update (relative to the
   * sender's state before that write), so separately flushed writes reach
   * the receiver as separate transactions.
   */
  const updates: Uint8Array[] = [];
  const write = (makeWrite: () => void): void => {
    const vector = yjs.encodeStateVector(senderDoc);

    makeWrite();
    flushSender();
    updates.push(yjs.encodeStateAsUpdate(senderDoc, vector));
  };

  switch (scenario) {
    case "deep only (control)": {
      write(() => {
        sender.setState((state) => ({ "progress": turnPage(state.progress, bookId, turn) }));
      });
      break;
    }
    case "deep + top-level string, one txn": {
      write(() => {
        const progress = turnPage(sender.getState().progress, bookId, turn);

        sender.setState({ progress, "currentBookId": bookId });
      });
      break;
    }
    case "deep + top-level string, two txns one tick": {
      // Two updates, both applied before the receiver's batching microtask
      // runs, so they land in one inbound batch.
      write(() => {
        sender.setState((state) => ({ "progress": turnPage(state.progress, bookId, turn) }));
      });
      write(() => { sender.setState({ "currentBookId": bookId }); });
      break;
    }
    case "deep + top-level array edit, one txn": {
      write(() => {
        sender.setState((state) => {
          return {
            "progress": turnPage(state.progress, bookId, turn),
            "recentBookIds": [bookId, ...state.recentBookIds.filter((id) => id !== bookId)].slice(0, RECENT_LENGTH),
          };
        });
      });
      break;
    }
    case "top-level string only (control)": {
      write(() => { sender.setState({ "currentBookId": bookId }); });
      break;
    }
  }

  const notificationsBefore = pair.notifications();

  counters.mapToJson = 0;
  counters.arrayToJson = 0;

  for (const update of updates) {
    yjs.applyUpdate(receiverDoc, update);
  }

  const start = performance.now();

  await Promise.resolve();

  const patchMs = performance.now() - start;
  const sample: Sample = {
    patchMs,
    "toJsonCalls": counters.mapToJson + counters.arrayToJson,
    "notifications": pair.notifications() - notificationsBefore,
  };

  // Sanity (not timed): the receiver STORE converged on what was sent.
  const sent = sender.getState();
  const received = receiver.getState();

  if (
    received.currentBookId !== sent.currentBookId ||
    received.recentBookIds.join(",") !== sent.recentBookIds.join(",") ||
    received.progress[bookId]["device-0"].lastRead !== sent.progress[bookId]["device-0"].lastRead ||
    received.progress[bookId]["device-0"].readingSessions.length !==
      sent.progress[bookId]["device-0"].readingSessions.length
  ) {
    throw new Error(`receiver diverged after "${scenario}" on ${bookId}`);
  }

  return sample;
};

export interface MixedBatchRow {
  books: number;
  scenario: ScenarioName;
  patchMedianMs: number;
  toJsonCalls: number;
  notifications: number;
}

/**
 * Runs every scenario at one library scale, interleaved per sample.
 *
 * @param books - Number of books in the progress tree.
 * @returns A promise for one row per scenario.
 */
export const runInboundMixedBatchScale = async (books: number): Promise<MixedBatchRow[]> => {
  const pair = makePair(books);
  const samples = new Map<ScenarioName, Sample[]>(scenarioNames.map((scenario) => [scenario, []]));
  let turn = 1;

  for (let index = 0; index < WARMUP_SAMPLES + SAMPLES; index = index + 1) {
    for (const scenario of scenarioNames) {
      const sample = await runSample(pair, scenario, turn, books);

      turn = turn + 1;

      if (index >= WARMUP_SAMPLES) {
        samples.get(scenario)?.push(sample);
      }
    }
  }

  return scenarioNames.map((scenario) => {
    const list = samples.get(scenario) ?? [];

    return {
      books,
      scenario,
      "patchMedianMs": median(list.map((sample) => sample.patchMs)),
      "toJsonCalls": median(list.map((sample) => sample.toJsonCalls)),
      "notifications": median(list.map((sample) => sample.notifications)),
    };
  });
};

/**
 * Runs the scenario across library scales and formats a markdown report.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runInboundMixedBatchBench = async (): Promise<string> => {
  const previousRate = __scopedDiffDevSampling.rate;

  __scopedDiffDevSampling.rate = 0;

  const restore = installToJsonCounters();
  const scales = [10, 40, 120];
  const rows: MixedBatchRow[] = [];

  try {
    for (const books of scales) {
      console.error(`  running inbound mixed-batch scale: ${String(books)} books...`);
      rows.push(...await runInboundMixedBatchScale(books));
    }
  } finally {
    restore();
    __scopedDiffDevSampling.rate = previousRate;
  }

  const cell = (scenario: ScenarioName, books: number, pick: (row: MixedBatchRow) => string): string => {
    const row = rows.find((candidate) => candidate.scenario === scenario && candidate.books === books);

    return row === undefined ? "-" : pick(row);
  };
  const timeHeaders = scales.map((books) => `${String(books)} books patch (ms)`);
  const callHeaders = scales.map((books) => `${String(books)} books toJSON calls`);
  const header = `| scenario | ${[...timeHeaders, ...callHeaders].join(" | ")} | notifications |`;
  const divider = `|---|${scales.map(() => "---:").join("|")}|${scales.map(() => "---:").join("|")}|---:|`;
  const lines = scenarioNames.map((scenario) => {
    const times = scales.map((books) => cell(scenario, books, (row) => row.patchMedianMs.toFixed(3)));
    const calls = scales.map((books) => cell(scenario, books, (row) => String(row.toJsonCalls)));
    const notifications = cell(scenario, scales[scales.length - 1], (row) => String(row.notifications));

    return `| ${scenario} | ${times.join(" | ")} | ${calls.join(" | ")} | ${notifications} |`;
  });

  return [
    "## Inbound mixed batches: one root-level event next to a deep change (scopedDiff)",
    "",
    `Receiver store patch per batch, median of ${String(SAMPLES)} interleaved samples; ` +
      "toJSON calls = Y.Map + Y.Array toJSON() invocations during the patch (deterministic).",
    "",
    header,
    divider,
    ...lines,
  ].join("\n");
};
