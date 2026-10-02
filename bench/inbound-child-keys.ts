/*
 * Inbound child-key add / delete under one hot top-level key.
 *
 * §11 of docs/performance.md made a DEEP remote edit cost O(changed branch):
 * the observer keeps the whole event path and the patch reconciles only that
 * branch. Adding or removing a child key is different. Yjs reports it as an
 * event whose target is the parent Y.Map, so a new key directly under a
 * top-level key (a new book under `progress`, a new annotation under
 * `annotations`) has a store-relative path of length 1. The observer flags
 * such a batch "shallow" and the WHOLE batch takes the key-scoped route:
 * `toJSON()` of the entire top-level value, sanitize, a deep diff against
 * state, rebuild. That is O(total size of the key) per inbound batch, even
 * though `event.keysChanged` names exactly which child keys changed.
 *
 * The same narrowing is missing one level further down: an event whose
 * target is a Y.Map at depth >= 2 is reconciled by reading that whole map,
 * so a scalar-only page turn on progress[book][device] re-serializes every
 * reading session of that device, and adding one annotation to a per-book
 * map re-serializes every annotation of that book.
 *
 * Measured on the RECEIVING store (scopedDiff: true, the downstream config):
 * the store patch is microtask-batched, so each sample applies the update and
 * then drains the microtask, timing the drain. Alongside the median timings,
 * every Y.Map / Y.Array `toJSON()` call made by the receiver is counted —
 * a deterministic measure of how much of the document the patch
 * materialized (the ideal for a one-key add is the size of the added value).
 *
 * Scenarios:
 * 1. Versicle `progress` tree (book -> device -> fields + 300 sessions):
 *    ordinary page turn (control, deep route), fields-only page turn
 *    (depth-3 map target), remote new book, remote book removal.
 * 2. Cold start: a stale local doc, then one catch-up transaction holding
 *    30 page turns, with and without one new book.
 * 3. Flat `annotations` record: remote add / delete of one annotation.
 * 4. Per-book `annotations[bookId]` map: remote add of one annotation.
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from "../src";
import { makeDeviceProgress, makeProgressTree, makeSession, type ProgressTree } from "./versicle";

const SAMPLES = 7;
const SESSIONS_PER_DEVICE = 300;
const CATCH_UP_TURNS = 30;

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

const resetCounters = (): void => {
  counters.mapToJson = 0;
  counters.arrayToJson = 0;
};

const median = (samples: number[]): number => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)];
};

interface Sample {
  patchMs: number;
  toJsonCalls: number;
}

interface Measured {
  patchMedianMs: number;
  /** Median of the per-sample Y.Map + Y.Array toJSON counts. */
  toJsonCalls: number;
}

const summarize = (samples: Sample[]): Measured => {
  return {
    "patchMedianMs": median(samples.map((sample) => sample.patchMs)),
    "toJsonCalls": median(samples.map((sample) => sample.toJsonCalls)),
  };
};

type State = Record<string, unknown>;

/** A copy of `record` without `key` (built by filtering; no delete operator). */
const omitKey = <V>(record: Record<string, V>, key: string): Record<string, V> => {
  const copy: Record<string, V> = {};

  for (const [childKey, value] of Object.entries(record)) {
    if (childKey !== key) {
      copy[childKey] = value;
    }
  }

  return copy;
};

const middlewareOptions = (syncedKey: string) => {
  return {
    "disableYText": true,
    "scopedDiff": true,
    "syncedKeys": [syncedKey],
  };
};

/**
 * Applies `update` to `doc`, drains the batching microtask, and returns the
 * receiver's cost: the drained patch's duration and every toJSON call made
 * from the apply onward.
 *
 * @param doc - The receiving document.
 * @param update - The update to deliver.
 * @returns The measured sample.
 */
const deliver = async (doc: yjs.Doc, update: Uint8Array): Promise<Sample> => {
  resetCounters();
  yjs.applyUpdate(doc, update);

  const start = performance.now();

  await Promise.resolve();

  const patchMs = performance.now() - start;

  return { patchMs, "toJsonCalls": counters.mapToJson + counters.arrayToJson };
};

interface Pair {
  sender: StoreApi<State>;
  senderDoc: yjs.Doc;
  receiver: StoreApi<State>;
  /** Writes on the sender, flushes, and measures the receiver applying it. */
  send: (write: (state: State) => State) => Promise<Sample>;
}

/**
 * A sender store and a receiver store bound to two docs, both scopedDiff with
 * one synced top-level key. The receiver hydrates from a populated doc, like
 * an app launch.
 *
 * @param syncedKey - The single replicated top-level key.
 * @param initial - The sender's initial value for that key.
 * @returns The wired pair.
 */
const makePair = (syncedKey: string, initial: unknown): Pair => {
  const senderDoc = new yjs.Doc();
  const receiverDoc = new yjs.Doc();
  const sender = createStore<State>()(
    yjsMiddleware(senderDoc, "store", (): State =>  ({ [syncedKey]: initial }) , middlewareOptions(syncedKey))
  );
  const senderHandle = getYjsStoreHandle(sender);

  // An empty doc is seeded on the first write; make it, then hydrate the
  // receiver from the populated doc.
  sender.setState((state) =>  ({ [syncedKey]: { ...(state[syncedKey] as State) } }) );
  senderHandle.flush();
  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(senderDoc));

  const receiver = createStore<State>()(
    yjsMiddleware(receiverDoc, "store", (): State =>  ({ [syncedKey]: {} }) , middlewareOptions(syncedKey))
  );

  return {
    sender,
    senderDoc,
    receiver,
    "send": async (write) => {
      const stateVector = yjs.encodeStateVector(receiverDoc);

      sender.setState(write, true);
      senderHandle.flush();

      return deliver(receiverDoc, yjs.encodeStateAsUpdate(senderDoc, stateVector));
    },
  };
};

const assertMirrored = (pair: Pair, key: string, label: string): void => {
  const sent = JSON.stringify(pair.sender.getState()[key]);
  const received = JSON.stringify(pair.receiver.getState()[key]);

  if (sent !== received) {
    throw new Error(`${label}: receiver did not converge with the sender`);
  }
};

/* -------------------------------------------------------------------------
 * 1. Versicle progress tree
 * ---------------------------------------------------------------------- */

const pageTurn = (bookId: string, now: number, isAppendingSession: boolean) => {
  return (state: State): State => {
    const tree = state.progress as ProgressTree;
    const perBook = tree[bookId];
    const perDevice = perBook["device-0"];

    return {
      ...state,
      "progress": {
        ...tree,
        [bookId]: {
          ...perBook,
          "device-0": {
            ...perDevice,
            "currentCfi": `epubcfi(/6/4!/4/${String(now)}:0)`,
            "percentage": (now % 100) / 100,
            "lastRead": now,
            "readingSessions": isAppendingSession
              ? [...perDevice.readingSessions, makeSession(now)]
              : perDevice.readingSessions,
          },
        },
      },
    };
  };
};

const addBook = (bookId: string) => {
  return (state: State): State => {
    return {
      ...state,
      "progress": { ...(state.progress as ProgressTree), [bookId]: { "device-1": makeDeviceProgress(bookId, 1) } },
    };
  };
};

const dropBook = (bookId: string) => {
  return (state: State): State => {
    return { ...state, "progress": omitKey(state.progress as ProgressTree, bookId) };
  };
};

export interface ProgressRow {
  books: number;
  pageTurn: Measured;
  fieldsOnlyTurn: Measured;
  newBook: Measured;
  dropBook: Measured;
}

const runProgressScale = async (books: number): Promise<ProgressRow> => {
  const pair = makePair("progress", makeProgressTree(books, SESSIONS_PER_DEVICE));
  const turns: Sample[] = [];
  const fieldsOnly: Sample[] = [];
  const adds: Sample[] = [];
  const drops: Sample[] = [];
  let now = 1;

  // Interleaved so drift and GC pressure spread evenly over the variants.
  for (let index = 0; index < SAMPLES; index = index + 1) {
    const bookId = `book-${String(index % books)}`;
    const newBookId = `new-book-${String(index)}`;

    turns.push(await pair.send(pageTurn(bookId, now, true)));
    now = now + 1;
    fieldsOnly.push(await pair.send(pageTurn(bookId, now, false)));
    now = now + 1;
    adds.push(await pair.send(addBook(newBookId)));
    drops.push(await pair.send(dropBook(newBookId)));
  }

  assertMirrored(pair, "progress", `progress@${String(books)}`);

  return {
    books,
    "pageTurn": summarize(turns),
    "fieldsOnlyTurn": summarize(fieldsOnly),
    "newBook": summarize(adds),
    "dropBook": summarize(drops),
  };
};

/* -------------------------------------------------------------------------
 * 2. Cold start: stale local doc, then one catch-up transaction
 * ---------------------------------------------------------------------- */

export interface CatchUpRow {
  books: number;
  turnsOnly: Measured;
  turnsAndNewBook: Measured;
}

const runCatchUpScale = async (books: number): Promise<CatchUpRow> => {
  const pair = makePair("progress", makeProgressTree(books, SESSIONS_PER_DEVICE));
  const senderHandle = getYjsStoreHandle(pair.sender);
  const staleState = yjs.encodeStateAsUpdate(pair.senderDoc);
  const staleVector = yjs.encodeStateVector(pair.senderDoc);

  for (let index = 0; index < CATCH_UP_TURNS; index = index + 1) {
    pair.sender.setState(pageTurn(`book-${String(index % books)}`, 50_000 + index, true), true);
    senderHandle.flush();
  }

  const turnsOnlyUpdate = yjs.encodeStateAsUpdate(pair.senderDoc, staleVector);

  pair.sender.setState(addBook("catch-up-book"), true);
  senderHandle.flush();

  const turnsAndBookUpdate = yjs.encodeStateAsUpdate(pair.senderDoc, staleVector);

  const coldStart = async (catchUp: Uint8Array, expectedBooks: number): Promise<Sample> => {
    const doc = new yjs.Doc();

    yjs.applyUpdate(doc, staleState);

    const store = createStore<State>()(
      yjsMiddleware(doc, "store", (): State =>  ({ "progress": {} }) , middlewareOptions("progress"))
    );
    const sample = await deliver(doc, catchUp);
    const received = Object.keys(store.getState().progress as ProgressTree).length;

    if (received !== expectedBooks) {
      throw new Error(`catch-up@${String(books)}: ${String(received)}/${String(expectedBooks)} books`);
    }

    return sample;
  };

  const turnsOnly: Sample[] = [];
  const turnsAndBook: Sample[] = [];

  for (let index = 0; index < SAMPLES; index = index + 1) {
    turnsOnly.push(await coldStart(turnsOnlyUpdate, books));
    turnsAndBook.push(await coldStart(turnsAndBookUpdate, books + 1));
  }

  return { books, "turnsOnly": summarize(turnsOnly), "turnsAndNewBook": summarize(turnsAndBook) };
};

/* -------------------------------------------------------------------------
 * 3. Flat annotations record, 4. per-book annotations map
 * ---------------------------------------------------------------------- */

const makeAnnotation = (id: string, bookId: string, n: number): Record<string, unknown> => {
  return {
    id,
    bookId,
    "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0,:${String(40 + (n % 60))})`,
    "text": `highlighted passage number ${String(n)} with some surrounding words`,
    "color": ["yellow", "green", "blue", "pink"][n % 4],
    "note": n % 3 === 0 ? `note ${String(n)}` : "",
    "created": 1_700_000_000_000 + (n * 1000),
  };
};

const makeAnnotations = (count: number, bookCount: number): Record<string, unknown> => {
  const record: Record<string, unknown> = {};

  for (let index = 0; index < count; index = index + 1) {
    const id = `ann-${String(index)}`;

    record[id] = makeAnnotation(id, `book-${String(index % bookCount)}`, index);
  }

  return record;
};

export interface AnnotationRow {
  annotations: number;
  add: Measured;
  remove: Measured;
}

const runFlatAnnotationScale = async (count: number): Promise<AnnotationRow> => {
  const pair = makePair("annotations", makeAnnotations(count, 50));
  const adds: Sample[] = [];
  const removes: Sample[] = [];

  for (let index = 0; index < SAMPLES; index = index + 1) {
    const id = `new-ann-${String(index)}`;

    adds.push(await pair.send((state) => {
      return {
        ...state,
        "annotations": { ...(state.annotations as State), [id]: makeAnnotation(id, "book-1", count + index) },
      };
    }));
    removes.push(await pair.send((state) => 
      ({ ...state, "annotations": omitKey(state.annotations as State, id) })
    ));
  }

  assertMirrored(pair, "annotations", `annotations@${String(count)}`);

  return { "annotations": count, "add": summarize(adds), "remove": summarize(removes) };
};

export interface PerBookAnnotationRow {
  annotationsInBook: number;
  add: Measured;
}

const runPerBookAnnotationScale = async (count: number): Promise<PerBookAnnotationRow> => {
  const pair = makePair("annotations", {
    "book-0": makeAnnotations(count, 1),
    "book-1": makeAnnotations(10, 1),
  });
  const adds: Sample[] = [];

  for (let index = 0; index < SAMPLES; index = index + 1) {
    const id = `new-ann-${String(index)}`;

    adds.push(await pair.send((state) => {
      const byBook = state.annotations as Record<string, State>;

      return {
        ...state,
        "annotations": { ...byBook, "book-0": { ...byBook["book-0"], [id]: makeAnnotation(id, "book-0", count + index) } },
      };
    }));
  }

  assertMirrored(pair, "annotations", `per-book annotations@${String(count)}`);

  return { "annotationsInBook": count, "add": summarize(adds) };
};

/* -------------------------------------------------------------------------
 * Report
 * ---------------------------------------------------------------------- */

const cell = (measured: Measured): string =>
  { return `${measured.patchMedianMs.toFixed(3)} | ${String(measured.toJsonCalls)}` };

/**
 * Runs every scenario and formats a markdown report.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runInboundChildKeyBench = async (): Promise<string> => {
  __scopedDiffDevSampling.rate = 0;

  const restore = installToJsonCounters();

  try {
    const progressRows: ProgressRow[] = [];
    const catchUpRows: CatchUpRow[] = [];
    const flatRows: AnnotationRow[] = [];
    const perBookRows: PerBookAnnotationRow[] = [];

    for (const books of [10, 40, 120]) {
      console.error(`  running inbound child-key scenario: progress, ${String(books)} books...`);
      progressRows.push(await runProgressScale(books));
      catchUpRows.push(await runCatchUpScale(books));
    }

    for (const count of [1000, 4000, 16_000]) {
      console.error(`  running inbound child-key scenario: ${String(count)} annotations...`);
      flatRows.push(await runFlatAnnotationScale(count));
    }

    for (const count of [100, 1000, 5000]) {
      console.error(`  running inbound child-key scenario: ${String(count)} annotations in one book...`);
      perBookRows.push(await runPerBookAnnotationScale(count));
    }

    return [
      "## Inbound child-key add / delete (receiver, scopedDiff)",
      "",
      "Receiver-side store patch per remote change: median ms over " +
        `${String(SAMPLES)} samples | Y.Map + Y.Array toJSON() calls.`,
      "",
      "### Versicle progress tree (2 devices x 300 sessions per book)",
      "",
      "| books | page turn (ms) | page turn toJSON | fields-only turn (ms) | fields-only toJSON | " +
        "new book (ms) | new book toJSON | drop book (ms) | drop book toJSON |",
      "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...progressRows.map((row) => {
        return `| ${String(row.books)} | ${cell(row.pageTurn)} | ${cell(row.fieldsOnlyTurn)} | ` +
          `${cell(row.newBook)} | ${cell(row.dropBook)} |`;
      }),
      "",
      `### Cold-start catch-up (stale doc, then one transaction of ${String(CATCH_UP_TURNS)} page turns)`,
      "",
      "| books | turns only (ms) | turns only toJSON | turns + 1 new book (ms) | turns + 1 new book toJSON |",
      "|---:|---:|---:|---:|---:|",
      ...catchUpRows.map((row) => {
        return `| ${String(row.books)} | ${cell(row.turnsOnly)} | ${cell(row.turnsAndNewBook)} |`;
      }),
      "",
      "### Flat annotations record (one remote annotation)",
      "",
      "| annotations | add (ms) | add toJSON | delete (ms) | delete toJSON |",
      "|---:|---:|---:|---:|---:|",
      ...flatRows.map((row) =>  `| ${String(row.annotations)} | ${cell(row.add)} | ${cell(row.remove)} |` ),
      "",
      "### Per-book annotations map annotations[bookId] (one remote annotation)",
      "",
      "| annotations in book | add (ms) | add toJSON |",
      "|---:|---:|---:|",
      ...perBookRows.map((row) =>  `| ${String(row.annotationsInBook)} | ${cell(row.add)} |` ),
    ].join("\n");
  } finally {
    restore();
  }
};
