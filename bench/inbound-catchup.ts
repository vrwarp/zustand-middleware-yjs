/*
 * Inbound catch-up of in-place edits to elements of a large object array.
 *
 * Shape: a store keeps a collection as an array of objects (annotations,
 * bookmarks, a todo list) — in the doc, a Y.Array of Y.Maps — and edits
 * elements in place. A receiver that was offline catches up on many such
 * edits in one tick: either as one update per remote transaction (a
 * websocket or IndexedDB replay) or as one merged update (y-cinder style).
 *
 * What it isolates: the SYNCHRONOUS observer phase, i.e. `Y.applyUpdate` with
 * the middleware's observeDeep handler attached, against a bare doc receiving
 * the same updates. The store patch runs later, on the batching microtask; it
 * is O(array) once per batch whatever the observer does, and is drained
 * untimed after every sample.
 *
 * Why the observer phase is expensive: Yjs' `YEvent.path` getter is not
 * cached. Every read calls getPathTo, which, for each array ancestor, walks
 * the parent's item list from its start up to the child, tombstones
 * included — O(index) per read. The scopedDiff observer reads `event.path`
 * 3 times per event (7 times with `scope`; with `scope` and no scopedDiff,
 * touchesScope still reads it twice) and then cuts the path at the first
 * array index, discarding the index it paid for. In a single merged update,
 * Yjs additionally sorts each ancestor's deep events by `path.length`, which
 * is Yjs' own cost and shows up in the "bare" rows.
 *
 * Counters (deterministic; one instrumented, untimed pass per row):
 * `pathReads` = `YEvent#path` getter calls and `itemVisits` = `Item#deleted`
 * getter calls (getPathTo checks it once per item it walks past) during the
 * observer phase.
 *
 * Run on its own (from the repo root):
 *   npx ts-node -T -P bench/tsconfig.json -e \
 *     'require("./bench/inbound-catchup").runInboundCatchUpBench().then(console.log)'
 */
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle, type YjsOptions } from "../src";
import { benchAsync, type BenchResult, formatTable } from "./harness";

interface Annotation {
  id: string;
  bookId: string;
  cfiRange: string;
  color: string;
  note: string;
  createdAt: number;
}

interface AnnotationsState {
  annotations: Annotation[];
  revision: number;
}

const MAP_NAME = "annotations";
const SCOPE_KEY = "device-0";
const colors = ["yellow", "green", "blue", "pink"];

const makeAnnotation = (index: number): Annotation => {
  return {
    "id": `annotation-${String(index)}`,
    "bookId": `book-${String(index % 120)}`,
    "cfiRange": `epubcfi(/6/${String(index % 40)}!/4/${String(index % 200)}:0)`,
    "color": colors[index % colors.length],
    "note": `note ${String(index)}`,
    "createdAt": 1_700_000_000_000 + (index * 60_000),
  };
};

interface Source {
  /** Doc state the receiver starts from (taken before the edits). */
  snapshot: Uint8Array;
  /** The edits, one update per remote transaction. */
  updates: Uint8Array[];
  /** The same edits as one merged update. */
  merged: Uint8Array;
  /** Store-relative JSON the receiver must converge to (sanity check). */
  expected: unknown;
  live: number;
  tombstones: number;
  scope?: { key: string };
}

/**
 * Builds the sender side once per array shape: the middleware writes the
 * initial array (so the doc layout is exactly the middleware's), tombstones
 * are made by deleting elements spread through the array, and each edit is
 * one transaction that rewrites two fields of one element's Y.Map — what the
 * sender's middleware emits for an immutable in-place element update.
 */
interface SourceShape {
  live: number;
  tombstones: number;
  edits: number;
  scope?: YjsOptions["scope"];
}

const buildSource = ({ live, tombstones, edits, scope }: SourceShape): Source => {
  const doc = new yjs.Doc();
  const total = live + tombstones;
  const store = createStore<AnnotationsState>()(
    yjsMiddleware(
      doc,
      MAP_NAME,
      () => {
        return {
          "annotations": Array.from({ "length": total }, (unused, index) => makeAnnotation(index)),
          "revision": 0,
        };
      },
      { "disableYText": true, "scopedDiff": true, scope }
    )
  );

  // First flush writes the whole state.
  store.setState({ "revision": 1 });
  getYjsStoreHandle(store).flush();

  const rootMap = doc.getMap(MAP_NAME);
  const dataMap = scope === undefined ? rootMap : rootMap.get(scope.key) as yjs.Map<unknown>;
  const array = dataMap.get("annotations") as yjs.Array<yjs.Map<unknown>>;

  if (tombstones > 0) {
    // Delete `tombstones` elements spread evenly through the array (an aged
    // list: annotations removed over the years), from the back so indices
    // stay valid. Each deleted element stays in the item list as a tombstone.
    const stride = total / tombstones;

    doc.transact(() => {
      for (let index = tombstones - 1; index >= 0; index = index - 1) {
        array.delete(Math.floor(index * stride), 1);
      }
    });
  }

  if (array.length !== live) {
    throw new Error(`expected ${String(live)} live elements, got ${String(array.length)}`);
  }

  const snapshot = yjs.encodeStateAsUpdate(doc);
  const updates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array): void => {
    updates.push(update);
  };

  doc.on("update", onUpdate);

  for (let edit = 0; edit < edits; edit = edit + 1) {
    // 7919 is prime, so for edits <= live every edit hits a distinct element,
    // spread uniformly over the array (mean index ~ live / 2).
    const element = array.get((edit * 7_919) % live);

    doc.transact(() => {
      element.set("color", colors[edit % colors.length]);
      element.set("note", `edited ${String(edit)}`);
    });
  }

  doc.off("update", onUpdate);

  return {
    snapshot,
    updates,
    "merged": yjs.mergeUpdates(updates),
    "expected": dataMap.toJSON().annotations,
    live,
    tombstones,
    scope,
  };
};

interface Fixture {
  doc: yjs.Doc;
  store?: StoreApi<AnnotationsState>;
}

type ReceiverKind = "bare" | "legacy" | "scopedDiff";

const makeReceiver = (source: Source, kind: ReceiverKind): Fixture => {
  const doc = new yjs.Doc();

  yjs.applyUpdate(doc, source.snapshot);

  if (kind === "bare") {
    return { doc };
  }

  const options: YjsOptions = {
    "disableYText": true,
    "scopedDiff": kind === "scopedDiff",
    "scope": source.scope,
  };
  // Hydrates synchronously from the populated doc.
  const store = createStore<AnnotationsState>()(
    yjsMiddleware(doc, MAP_NAME, (): AnnotationsState => ({ "annotations": [], "revision": 0 }), options)
  );

  if (store.getState().annotations.length !== source.live) {
    throw new Error("receiver did not hydrate");
  }

  return { doc, store };
};

const drain = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Counts `YEvent#path` reads and `Item#deleted` reads (one per item a path
 * computation walks past) while `run` executes, then restores both getters.
 */
const countPathCost = (run: () => void): { pathReads: number; itemVisits: number } => {
  const eventPrototype = yjs.YEvent.prototype as object;
  const itemPrototype = yjs.Item.prototype as object;
  const pathDescriptor = Object.getOwnPropertyDescriptor(eventPrototype, "path");
  const deletedDescriptor = Object.getOwnPropertyDescriptor(itemPrototype, "deleted");

  if (pathDescriptor?.get === undefined || deletedDescriptor?.get === undefined) {
    throw new Error("unexpected yjs internals: YEvent#path / Item#deleted getters not found");
  }

  let pathReads = 0;
  let itemVisits = 0;

  Object.defineProperty(eventPrototype, "path", {
    ...pathDescriptor,
    get(this: unknown) {
      pathReads = pathReads + 1;

      return pathDescriptor.get?.call(this) as unknown;
    },
  });
  Object.defineProperty(itemPrototype, "deleted", {
    ...deletedDescriptor,
    get(this: unknown) {
      itemVisits = itemVisits + 1;

      return deletedDescriptor.get?.call(this) as unknown;
    },
  });

  try {
    run();
  } finally {
    Object.defineProperty(eventPrototype, "path", pathDescriptor);
    Object.defineProperty(itemPrototype, "deleted", deletedDescriptor);
  }

  return { pathReads, itemVisits };
};

interface Row {
  label: string;
  source: Source;
  kind: ReceiverKind;
  merged: boolean;
}

const runRow = async ({ label, source, kind, merged }: Row): Promise<BenchResult> => {
  const updates = merged ? [source.merged] : source.updates;
  const apply = (fixture: Fixture): void => {
    for (const update of updates) {
      yjs.applyUpdate(fixture.doc, update);
    }
  };

  // Counter pass (untimed) plus a convergence check of the receiving STORE.
  const probe = makeReceiver(source, kind);
  const { pathReads, itemVisits } = countPathCost(() => { apply(probe); });

  await drain();

  if (probe.store !== undefined &&
    JSON.stringify(probe.store.getState().annotations) !== JSON.stringify(source.expected)) {
    throw new Error(`${label}: receiving store did not converge`);
  }

  const result = await benchAsync(
    label,
    (fixture) => { apply(fixture as Fixture); },
    {
      "runs": 5,
      "warmupRuns": 2,
      "setup": () => makeReceiver(source, kind),
      "afterRun": drain,
    }
  );

  return {
    ...result,
    "meta": {
      "live": source.live,
      "tombstones": source.tombstones,
      "updates": updates.length,
      "events": source.updates.length,
      pathReads,
      itemVisits,
    },
  };
};

/**
 * Runs the catch-up rows and formats them as a markdown table.
 *
 * @returns A promise for the report as a markdown string.
 */
export const runInboundCatchUpBench = async (): Promise<string> => {
  // Deterministic runs when invoked on its own (bench/index.ts pins it too).
  __scopedDiffDevSampling.rate = 0;

  const EDITS = 1_000;
  const small = buildSource({ "live": 2_000, "tombstones": 0, "edits": EDITS });
  const large = buildSource({ "live": 8_000, "tombstones": 0, "edits": EDITS });
  const aged = buildSource({ "live": 2_000, "tombstones": 6_000, "edits": EDITS });
  const scoped = buildSource({
    "live": 8_000, "tombstones": 0, "edits": EDITS, "scope": { "key": SCOPE_KEY },
  });
  const rows: Row[] = [
    { "label": "multi-tx: 2000 live, bare doc (no store)", "source": small, "kind": "bare", "merged": false },
    { "label": "multi-tx: 2000 live, scopedDiff receiver", "source": small, "kind": "scopedDiff", "merged": false },
    { "label": "multi-tx: 8000 live, bare doc (no store)", "source": large, "kind": "bare", "merged": false },
    { "label": "multi-tx: 8000 live, legacy receiver", "source": large, "kind": "legacy", "merged": false },
    { "label": "multi-tx: 8000 live, scopedDiff receiver", "source": large, "kind": "scopedDiff", "merged": false },
    { "label": "multi-tx: 2000 live + 6000 tombstones, scopedDiff receiver", "source": aged, "kind": "scopedDiff", "merged": false },
    { "label": "multi-tx: 8000 live, scope + legacy receiver", "source": scoped, "kind": "legacy", "merged": false },
    { "label": "multi-tx: 8000 live, scope + scopedDiff receiver", "source": scoped, "kind": "scopedDiff", "merged": false },
    { "label": "merged: 8000 live, bare doc (no store)", "source": large, "kind": "bare", "merged": true },
    { "label": "merged: 8000 live, scopedDiff receiver", "source": large, "kind": "scopedDiff", "merged": true },
  ];
  const results: BenchResult[] = [];

  for (const row of rows) {
    console.error(`  running inbound catch-up: ${row.label}...`);
    results.push(await runRow(row));
  }

  return [
    `## Inbound catch-up: ${String(EDITS)} in-place element edits to a Y.Array of Y.Maps`,
    "",
    "Timed: the synchronous observer phase (every `Y.applyUpdate` of the catch-up),",
    "store patch drained untimed. `itemVisits` = Yjs list items walked by",
    "`event.path` computations in that phase.",
    "",
    formatTable(results),
  ].join("\n");
};
