/*
 * ts-node runs this bench as CommonJS, where top-level await is unavailable,
 * so the standalone entry point has to be a promise chain.
 */
/* eslint-disable unicorn/prefer-top-level-await */
/*
 * No-op inbound batches.
 *
 * A foreign Yjs transaction can change nothing for a store: another device
 * concurrently wrote a value this store already holds, another store bound
 * to the same map wrote a key outside this store's syncedKeys, or an
 * identical nested value was rewritten. The inbound patch still hands
 * zustand a NEW top-level state object (patchStore clones the state, and the
 * syncedKeys branch of computeInboundState always builds a fresh object), so
 * every subscriber runs and a nested persist middleware re-serializes and
 * re-writes the whole state, although no slice changed.
 *
 * Per mode and no-op shape this reports, per foreign batch:
 * - listener calls and selector runs (deterministic counters),
 * - persist setItem calls and bytes written (deterministic counters),
 * - the store-patch microtask's median time, in two configurations:
 * "bare" (one counting listener, no persist) and "app" (persist inside yjs
 * plus 20 selector subscribers, i.e. mounted components). The app-minus-bare
 * gap is the work that produces nothing.
 *
 * A changed value is included as a control: it SHOULD notify once.
 *
 * Run alone with:
 * npx ts-node -T -P bench/tsconfig.json bench/noop-inbound.ts
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createJSONStorage, persist } from "zustand/middleware";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from "../src";

// Deterministic perf runs: disable the DEV-only sampled convergence check,
// as bench/index.ts does, so scopedDiff numbers measure the patch itself.
__scopedDiffDevSampling.rate = 0;

interface Book {
  title: string;
  author: string;
  progress: number;
  addedAt: number;
  tags: string[];
}

interface LibraryState {
  theme: string;
  fontSize: number;
  library: Record<string, Book>;
}

const syncedKeyNames = ["theme", "fontSize", "library"];
const SUBSCRIBERS = 20;
const SAMPLES = 15;
const WARMUP = 3;

const makeLibrary = (books: number): Record<string, Book> => {
  const library: Record<string, Book> = {};

  for (let index = 0; index < books; index = index + 1) {
    library[`book-${String(index)}`] = {
      "title": `A Reasonably Long Book Title Number ${String(index)}`,
      "author": `Author ${String(index % 97)}`,
      "progress": (index % 100) / 100,
      "addedAt": 1_700_000_000_000 + (index * 86_400_000),
      "tags": [`shelf-${String(index % 7)}`, `genre-${String(index % 13)}`],
    };
  }

  return library;
};

interface Counters {
  listenerCalls: number;
  selectorRuns: number;
  persistWrites: number;
  persistBytes: number;
}

interface Fixture {
  localDoc: yjs.Doc;
  remoteDoc: yjs.Doc;
  remoteMap: yjs.Map<unknown>;
  store: StoreApi<LibraryState>;
  counters: Counters;
}

type Config = "app" | "bare";

const median = (samples: number[]): number => {
  const sorted = [...samples];

  sorted.sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Seeds a "remote device" doc with the library through the real middleware,
 * then attaches the measured store to a second doc that has synced it, so the
 * store hydrates at creation exactly like an app launch.
 */
const makeFixture = (books: number, scopedDiff: boolean, config: Config): Fixture => {
  /*
   * Seeded in a throwaway doc: a store left attached to the remote doc would
   * react to every remote write below and its own patch would land in the
   * timed microtask.
   */
  const seedDoc = new yjs.Doc();
  const seedStore = createStore<LibraryState>()(
    yjsMiddleware(
      seedDoc,
      "app",
      () => ({ "theme": "dark", "fontSize": 16, "library": makeLibrary(books) }),
      { "disableYText": true }
    )
  );

  // An empty doc is seeded on the first write: make one and flush it.
  seedStore.setState((state) => ({ "library": { ...state.library } }));
  getYjsStoreHandle(seedStore).flush();

  const seedUpdate = yjs.encodeStateAsUpdate(seedDoc);
  const remoteDoc = new yjs.Doc();
  const localDoc = new yjs.Doc();

  yjs.applyUpdate(remoteDoc, seedUpdate);
  yjs.applyUpdate(localDoc, seedUpdate);

  const counters: Counters = { "listenerCalls": 0, "selectorRuns": 0, "persistWrites": 0, "persistBytes": 0 };
  const initial = (): LibraryState => ({ "theme": "light", "fontSize": 14, "library": {} });
  const options = { "disableYText": true, scopedDiff, "syncedKeys": syncedKeyNames };
  const store = config === "bare"
    ? createStore<LibraryState>()(yjsMiddleware(localDoc, "app", initial, options))
    : createStore<LibraryState>()(yjsMiddleware(
      localDoc,
      "app",
      persist(initial, {
        "name": "library",
        "skipHydration": true,
        "storage": createJSONStorage<LibraryState>(() => {
          return {
            "getItem": () => null,
            "setItem": (unusedKey: string, value: string) => {
              counters.persistWrites = counters.persistWrites + 1;
              counters.persistBytes = counters.persistBytes + value.length;
            },
            "removeItem": () => { /* never called */ },
          };
        }),
      }),
      options
    ));

  if (Object.keys(store.getState().library).length !== books) {
    throw new Error("store did not hydrate from the synced doc");
  }

  store.subscribe(() => {
    counters.listenerCalls = counters.listenerCalls + 1;
  });

  if (config === "app") {
    // Mounted components: each selects one book's progress and compares it
    // to its previous selection (what useStore(selector) does per notify).
    for (let index = 0; index < SUBSCRIBERS; index = index + 1) {
      const bookId = `book-${String(index)}`;
      let selected = store.getState().library[bookId].progress;

      store.subscribe((state) => {
        counters.selectorRuns = counters.selectorRuns + 1;

        const next = state.library[bookId].progress;

        if (!Object.is(next, selected)) {
          selected = next;
        }
      });
    }
  }

  return { localDoc, remoteDoc, "remoteMap": remoteDoc.getMap("app"), store, counters };
};

type Shape = "changed value (control)" | "identical deep value" | "identical synced value" | "key outside syncedKeys";

const shapes: Shape[] = [
  "identical synced value",
  "key outside syncedKeys",
  "identical deep value",
  "changed value (control)",
];

/** Performs one remote-device write of the given shape on the remote doc. */
const remoteWrite = (fixture: Fixture, shape: Shape, sample: number): void => {
  const { remoteDoc, remoteMap } = fixture;

  remoteDoc.transact(() => {
    switch (shape) {
      case "identical synced value": {
        remoteMap.set("theme", "dark");
        break;
      }
      case "key outside syncedKeys": {
        remoteMap.set("otherStoreKey", sample);
        break;
      }
      case "identical deep value": {
        const library = remoteMap.get("library") as yjs.Map<unknown>;
        const book = library.get("book-7") as yjs.Map<unknown>;

        book.set("progress", book.get("progress"));
        break;
      }
      case "changed value (control)": {
        remoteMap.set("fontSize", 100 + sample);
        break;
      }
      default: {
        break;
      }
    }
  });
};

interface ShapeRow {
  mode: string;
  shape: Shape;
  books: number;
  listenerCallsPerBatch: number;
  selectorRunsPerBatch: number;
  persistWritesPerBatch: number;
  persistBytesPerBatch: number;
  bareMedianMs: number;
  appMedianMs: number;
}

/**
 * Delivers SAMPLES remote writes of one shape and times the store-patch
 * microtask each one schedules (applyUpdate itself only queues it).
 */
const runShape = async (fixture: Fixture, shape: Shape): Promise<{ ms: number; counters: Counters }> => {
  const samples: number[] = [];
  const start: Counters = { ...fixture.counters };

  for (let sample = 0; sample < WARMUP + SAMPLES; sample = sample + 1) {
    if (sample === WARMUP) {
      Object.assign(start, fixture.counters);
    }

    const stateVector = yjs.encodeStateVector(fixture.localDoc);

    remoteWrite(fixture, shape, sample);
    yjs.applyUpdate(fixture.localDoc, yjs.encodeStateAsUpdate(fixture.remoteDoc, stateVector));

    const patchStart = performance.now();

    await Promise.resolve();
    if (sample >= WARMUP) {
      samples.push(performance.now() - patchStart);
    }
  }

  return {
    "ms": median(samples),
    "counters": {
      "listenerCalls": (fixture.counters.listenerCalls - start.listenerCalls) / SAMPLES,
      "selectorRuns": (fixture.counters.selectorRuns - start.selectorRuns) / SAMPLES,
      "persistWrites": (fixture.counters.persistWrites - start.persistWrites) / SAMPLES,
      "persistBytes": (fixture.counters.persistBytes - start.persistBytes) / SAMPLES,
    },
  };
};

const runShapeRow = async (books: number, scopedDiff: boolean, shape: Shape): Promise<ShapeRow> => {
  const bare = await runShape(makeFixture(books, scopedDiff, "bare"), shape);
  const app = await runShape(makeFixture(books, scopedDiff, "app"), shape);

  return {
    "mode": scopedDiff ? "scopedDiff" : "legacy",
    shape,
    books,
    "listenerCallsPerBatch": bare.counters.listenerCalls,
    "selectorRunsPerBatch": app.counters.selectorRuns,
    "persistWritesPerBatch": app.counters.persistWrites,
    "persistBytesPerBatch": Math.round(app.counters.persistBytes),
    "bareMedianMs": bare.ms,
    "appMedianMs": app.ms,
  };
};

/*
 * Several legacy-mode stores bound to ONE map with disjoint syncedKeys: every
 * local write of one store is a foreign batch for each of the others, which
 * changes nothing for them but notifies all of their subscribers and
 * re-writes their persisted state.
 */
interface SharedMapRow {
  stores: number;
  books: number;
  spuriousListenerCallsPerWrite: number;
  spuriousPersistWritesPerWrite: number;
  spuriousPersistBytesPerWrite: number;
  bareMedianMs: number;
  appMedianMs: number;
}

const runSharedMap = async (
  stores: number,
  books: number,
  config: Config
): Promise<{ ms: number; counters: Counters }> => {
  const keys = Array.from({ "length": stores }, (unused, index) => `domain${String(index)}`);

  /*
   * Seed every domain first (in a throwaway doc whose store is never touched
   * again): a store that attached before its key existed in the map would
   * have it deleted by replace-hydration as soon as another store flushed.
   */
  const seedDoc = new yjs.Doc();
  const seedState: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, makeLibrary(books)]));
  const seedStore = createStore<Record<string, unknown>>()(yjsMiddleware(
    seedDoc,
    "shared",
    () => seedState,
    { "disableYText": true }
  ));

  seedStore.setState((state) => ({ ...state }));
  getYjsStoreHandle(seedStore).flush();

  const doc = new yjs.Doc();

  yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(seedDoc));

  const counters: Counters = { "listenerCalls": 0, "selectorRuns": 0, "persistWrites": 0, "persistBytes": 0 };
  const handles: StoreApi<Record<string, unknown>>[] = [];

  for (const [index, key] of keys.entries()) {
    const isWriter = index === 0;
    const initial = (): Record<string, unknown> => ({ [key]: {} });
    const options = { "disableYText": true, "syncedKeys": [key] };
    const store = config === "bare"
      ? createStore<Record<string, unknown>>()(yjsMiddleware(doc, "shared", initial, options))
      : createStore<Record<string, unknown>>()(yjsMiddleware(
        doc,
        "shared",
        persist(initial, {
        "name": key,
        "skipHydration": true,
        "storage": createJSONStorage<Record<string, unknown>>(() => {
          return {
            "getItem": () => null,
            "setItem": (unusedKey: string, value: string) => {
              if (isWriter) {
                return;
              }
              counters.persistWrites = counters.persistWrites + 1;
              counters.persistBytes = counters.persistBytes + value.length;
            },
            "removeItem": () => { /* never called */ },
          };
        }),
      }),
        options
      ));

    if (Object.keys(store.getState()[key] as Record<string, unknown>).length !== books) {
      throw new Error(`store ${key} did not hydrate from the shared map`);
    }

    if (!isWriter) {
      store.subscribe(() => {
        counters.listenerCalls = counters.listenerCalls + 1;
      });
    }

    handles.push(store);
  }

  Object.assign(counters, { "listenerCalls": 0, "persistWrites": 0, "persistBytes": 0 });

  const writer = handles[0];
  const writerHandle = getYjsStoreHandle(writer);
  const samples: number[] = [];
  const start: Counters = { ...counters };

  for (let sample = 0; sample < WARMUP + SAMPLES; sample = sample + 1) {
    if (sample === WARMUP) {
      Object.assign(start, counters);
    }

    writer.setState((state) => {
      const library = state.domain0 as Record<string, Book>;

      return { "domain0": { ...library, "book-0": { ...library["book-0"], "progress": sample / 100 } } };
    });
    writerHandle.flush();

    const patchStart = performance.now();

    await Promise.resolve();
    if (sample >= WARMUP) {
      samples.push(performance.now() - patchStart);
    }
  }

  return {
    "ms": median(samples),
    "counters": {
      "listenerCalls": (counters.listenerCalls - start.listenerCalls) / SAMPLES,
      "selectorRuns": 0,
      "persistWrites": (counters.persistWrites - start.persistWrites) / SAMPLES,
      "persistBytes": (counters.persistBytes - start.persistBytes) / SAMPLES,
    },
  };
};

const runSharedMapRow = async (stores: number, books: number): Promise<SharedMapRow> => {
  const bare = await runSharedMap(stores, books, "bare");
  const app = await runSharedMap(stores, books, "app");

  return {
    stores,
    books,
    "spuriousListenerCallsPerWrite": bare.counters.listenerCalls,
    "spuriousPersistWritesPerWrite": app.counters.persistWrites,
    "spuriousPersistBytesPerWrite": Math.round(app.counters.persistBytes),
    "bareMedianMs": bare.ms,
    "appMedianMs": app.ms,
  };
};

/**
 * Runs the no-op inbound scenarios and formats a markdown report.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runNoopInboundBench = async (): Promise<string> => {
  const BOOKS = 500;
  const rows: ShapeRow[] = [];

  for (const isScopedDiff of [false, true]) {
    for (const shape of shapes) {
      console.error(`  running no-op inbound: ${isScopedDiff ? "scopedDiff" : "legacy"} / ${shape}...`);
      rows.push(await runShapeRow(BOOKS, isScopedDiff, shape));
    }
  }

  // Scaling: the persist re-write is O(state) even where the patch is O(1).
  const scaling: ShapeRow[] = [];

  for (const books of [125, 500]) {
    for (const isScopedDiff of [false, true]) {
      scaling.push(await runShapeRow(books, isScopedDiff, "identical synced value"));
    }
  }

  console.error("  running no-op inbound: shared map...");

  const shared = await runSharedMapRow(4, 250);

  const shapeHeader =
    "| mode | shape | books | listener calls / batch | selector runs / batch (20 subs) | " +
    "persist writes / batch | persist bytes / batch | patch, bare (ms) | patch, app (ms) |";
  const shapeDivider = "|---|---|---:|---:|---:|---:|---:|---:|---:|";
  const formatRow = (row: ShapeRow): string => {
    return `| ${row.mode} | ${row.shape} | ${String(row.books)} | ${String(row.listenerCallsPerBatch)} | ` +
      `${String(row.selectorRunsPerBatch)} | ${String(row.persistWritesPerBatch)} | ` +
      `${String(row.persistBytesPerBatch)} | ${row.bareMedianMs.toFixed(3)} | ${row.appMedianMs.toFixed(3)} |`;
  };

  return [
    "## No-op inbound batches (foreign transactions that change nothing for the store)",
    "",
    shapeHeader,
    shapeDivider,
    ...rows.map((row) => formatRow(row)),
    "",
    "Scaling (identical synced value, 4x books):",
    "",
    shapeHeader,
    shapeDivider,
    ...scaling.map((row) => formatRow(row)),
    "",
    "Several legacy stores on one map (persist inside yjs), per local write of one store:",
    "",
    "| stores | books / store | spurious listener calls | spurious persist writes | spurious persist bytes | " +
      "inbound, bare (ms) | inbound, app (ms) |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${String(shared.stores)} | ${String(shared.books)} | ${String(shared.spuriousListenerCallsPerWrite)} | ` +
      `${String(shared.spuriousPersistWritesPerWrite)} | ${String(shared.spuriousPersistBytesPerWrite)} | ` +
      `${shared.bareMedianMs.toFixed(3)} | ${shared.appMedianMs.toFixed(3)} |`,
  ].join("\n");
};

const isEntryPoint = process.argv[1]?.endsWith("noop-inbound.ts") ?? false;

if (isEntryPoint) {
  runNoopInboundBench()
    .then((report) => {
      // eslint-disable-next-line no-console
      console.log(`\n${report}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
