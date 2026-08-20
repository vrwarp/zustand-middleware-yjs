/*
 * Performance benchmark suite for zustand-middleware-yjs.
 *
 * Focus areas (see docs/performance.md):
 * 1. Text diffing + Y.Text patching cost on large strings.
 * 2. Aged-document behavior: latency and update-payload growth after a long
 *    editing session (many aggregated Yjs items).
 * 3. Array diffing cost on large arrays (lookahead equality checks).
 * 4. Full-tree vs scoped outbound flush; inbound patch cost.
 *
 * Run with: npm run bench
 */
import { performance } from "node:perf_hooks";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling,getYjsStoreHandle } from "../src";
import { getChanges } from "../src/diff";
import { patchSharedType, patchState, patchStore } from "../src/patching";
import {
  bench,
  type BenchResult,
  formatTable,
  makeRandom,
  randomText,
} from "./harness";
import { runVersicleBench } from "./versicle";

// Deterministic perf runs: disable the DEV-only sampled convergence check so
// scopedDiff numbers measure the flush itself, not the diagnostic.
__scopedDiffDevSampling.rate = 0;

const results: BenchResult[] = [];

const record = (result: BenchResult, meta: Record<string, string | number>): void => {
  results.push({ ...result, meta });

  console.error(`  done: ${result.name} (median ${result.medianMs.toFixed(3)} ms)`);
};

/* -------------------------------------------------------------------------
 * 1. Text diff (getChanges on strings)
 * ---------------------------------------------------------------------- */

const TEXT_SIZE = 50_000;
const random = makeRandom(42);
const bigText = randomText(TEXT_SIZE, random);

{
  const insertPosition = Math.floor(TEXT_SIZE / 2);
  const edited = `${bigText.slice(0, insertPosition)}hello world${bigText.slice(insertPosition)}`;

  record(bench(
    "diff/text: insert 11 chars mid 50k string",
    () => { getChanges(bigText, edited); }
  ), { chars: TEXT_SIZE });
}

{
  const appended = `${bigText}${randomText(100, makeRandom(7))}`;

  record(bench(
    "diff/text: append 100 chars to 50k string",
    () => { getChanges(bigText, appended); }
  ), { chars: TEXT_SIZE });
}

{
  const before = randomText(20_000, makeRandom(1));
  /**
   * No common alphabet, so this exercises the no-common-subsequence fallback.
   */
  const after = "0123456789".repeat(2_000);

  record(bench(
    "diff/text: replace 20k string (disjoint alphabets)",
    () => { getChanges(before, after); }
  ), { chars: 20_000 });
}

/* -------------------------------------------------------------------------
 * 2. Y.Text patching (outbound flush of a text edit)
 * ---------------------------------------------------------------------- */

const makeTextDocFixture = (text: string): { doc: yjs.Doc; map: yjs.Map<unknown> } => {
  const doc = new yjs.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    map.set("text", new yjs.Text(text));
  });

  return { doc, map };
};

{
  const appended = `${bigText}${randomText(100, makeRandom(7))}`;

  record(bench(
    "patch/ytext: append 100 chars to 50k Y.Text",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeTextDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { text: appended });
      });
    },
    { setup: () => makeTextDocFixture(bigText), runs: 10 }
  ), { chars: TEXT_SIZE });
}

{
  const insertPosition = Math.floor(TEXT_SIZE / 3);
  const edited = `${bigText.slice(0, insertPosition)}${randomText(500, makeRandom(9))}${bigText.slice(insertPosition)}`;

  record(bench(
    "patch/ytext: insert 500 chars mid 50k Y.Text",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeTextDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { text: edited });
      });
    },
    { setup: () => makeTextDocFixture(bigText), runs: 10 }
  ), { chars: TEXT_SIZE });
}

{
  /*
   * Kept small on purpose: per-character delete application is quadratic in
   * accumulated tombstones (each delete(idx, 1) walks past every tombstone
   * created by the previous deletes), so 20k chars takes minutes per run at
   * baseline. 5k chars keeps the baseline measurable while still exposing it.
   */
  const REPLACE_SIZE = 5_000;
  const before = randomText(REPLACE_SIZE, makeRandom(1));
  const after = "0123456789".repeat(REPLACE_SIZE / 10);

  record(bench(
    "patch/ytext: replace 5k Y.Text (disjoint alphabets)",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeTextDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { text: after });
      });
    },
    { setup: () => makeTextDocFixture(before), runs: 3, warmupRuns: 1 }
  ), { chars: REPLACE_SIZE });
}

/* -------------------------------------------------------------------------
 * 3. Inbound string patching (applyChangesToString path via patchState)
 * ---------------------------------------------------------------------- */

{
  const insertPosition = Math.floor(TEXT_SIZE / 2);
  const edited = `${bigText.slice(0, insertPosition)}${randomText(500, makeRandom(11))}${bigText.slice(insertPosition)}`;

  record(bench(
    "patch/state: inbound 500-char insert into 50k string",
    () => {
      patchState({ text: bigText }, { text: edited });
    }
  ), { chars: TEXT_SIZE });
}

/* -------------------------------------------------------------------------
 * 4. Array diffing
 * ---------------------------------------------------------------------- */

const ARRAY_SIZE = 2_000;
const makeItems = (count: number): Record<string, unknown>[] =>
  { return Array.from({ length: count }, (unused, index) => { return {
    id: `item-${String(index)}`,
    label: `Label number ${String(index)}`,
    done: index % 3 === 0,
    nested: { score: index * 7, tags: [`tag${String(index % 5)}`, `tag${String(index % 11)}`] },
  } }) };

{
  const items = makeItems(ARRAY_SIZE);
  const changed = items.map((item, index) =>
    (index === ARRAY_SIZE - 1 ? { ...item, "label": "CHANGED" } : item));

  record(bench(
    "diff/array: 2000 objects, last one changed",
    () => { getChanges(items, changed); }
  ), { items: ARRAY_SIZE });
}

{
  const items = makeItems(ARRAY_SIZE);
  const withInsert = [
    { id: "new", label: "inserted at front", done: false, nested: { score: -1, tags: [] } },
    ...items,
  ];

  record(bench(
    "diff/array: 2000 objects, insert at front (lookahead)",
    () => { getChanges(items, withInsert); }
  ), { items: ARRAY_SIZE });
}

{
  const items = makeItems(ARRAY_SIZE);
  const withDelete = items.slice(1);

  record(bench(
    "diff/array: 2000 objects, delete at front (lookahead)",
    () => { getChanges(items, withDelete); }
  ), { items: ARRAY_SIZE });
}

/* -------------------------------------------------------------------------
 * 4b. Object patching: deep nesting, wide subtrees, Y.Array churn
 * ---------------------------------------------------------------------- */

const makeObjectDocFixture = (state: Record<string, unknown>): {
  doc: yjs.Doc;
  map: yjs.Map<unknown>;
} => {
  const doc = new yjs.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    patchSharedType(map, state, { disableYText: true });
  });

  return { doc, map };
};

/** Nested state: `depth` levels, each with `siblings` scalar keys + one child. */
const makeDeepState = (
  depth: number,
  siblings: number,
  leafValue: number
): Record<string, unknown> => {
  let node: Record<string, unknown> = { "leaf": leafValue };

  for (let level = depth - 1; level >= 0; level = level - 1) {
    const wrapped: Record<string, unknown> = { "child": node };

    for (let sibling = 0; sibling < siblings; sibling = sibling + 1) {
      wrapped[`field${String(sibling)}`] = level * 100 + sibling;
    }
    node = wrapped;
  }

  return node;
};

{
  const DEPTH = 12;
  const before = makeDeepState(DEPTH, 6, 1);
  const after = makeDeepState(DEPTH, 6, 2);

  record(bench(
    "patch/deep-map: update leaf at depth 12 (6 siblings per level)",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

      doc.transact(() => {
        patchSharedType(map, after, { disableYText: true });
      });
    },
    { setup: () => makeObjectDocFixture(before), runs: 10 }
  ), { depth: DEPTH });
}

{
  const WIDE_COUNT = 1_000;
  const makeWideData = (changedIndex: number): Record<string, unknown> => {
    const data: Record<string, unknown> = {};

    for (let index = 0; index < WIDE_COUNT; index = index + 1) {
      data[`entry${String(index)}`] = {
        "name": `Entry ${String(index)}`,
        "count": index === changedIndex ? -1 : index,
        "meta": { "created": index * 1_000, "flags": [index % 2, index % 3] },
      };
    }

    return { data };
  };
  const before = makeWideData(-10);
  const after = makeWideData(500);

  record(bench(
    "patch/wide-map: 1000 nested objects under one key, update one",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

      doc.transact(() => {
        patchSharedType(map, after, { disableYText: true });
      });
    },
    { setup: () => makeObjectDocFixture(before), runs: 10 }
  ), { entries: WIDE_COUNT });
}

{
  const LIST_SIZE = 5_000;
  const numbers = Array.from({ length: LIST_SIZE }, (unused, index) => index);

  record(bench(
    "patch/yarray: clear 5000-element array",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { "list": [] }, { disableYText: true });
      });
    },
    { setup: () => makeObjectDocFixture({ "list": numbers }), runs: 3, warmupRuns: 1 }
  ), { items: LIST_SIZE });

  const shrunk = [...numbers.slice(0, 2_000), ...numbers.slice(2_500)];

  record(bench(
    "patch/yarray: remove 500 elements mid 5000-element array",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { "list": shrunk }, { disableYText: true });
      });
    },
    { setup: () => makeObjectDocFixture({ "list": numbers }), runs: 3, warmupRuns: 1 }
  ), { items: LIST_SIZE });
}

{
  const items = makeItems(ARRAY_SIZE);
  const changed = items.map((item, index) =>
    (index === 1_000 ? { ...item, "label": "CHANGED", } : item));

  record(bench(
    "patch/yarray: update one object field in 2000-element array",
    (fixture) => {
      const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

      doc.transact(() => {
        patchSharedType(map, { "list": changed }, { disableYText: true });
      });
    },
    { setup: () => makeObjectDocFixture({ "list": items }), runs: 10 }
  ), { items: ARRAY_SIZE });
}

/* -------------------------------------------------------------------------
 * 5. End-to-end outbound flush: legacy full-tree diff vs scopedDiff
 * ---------------------------------------------------------------------- */

interface WideState {
  [key: string]: unknown;
}

const KEY_COUNT = 100;

const makeWideInitialState = (): WideState => {
  const state: WideState = {};

  for (let index = 0; index < KEY_COUNT; index = index + 1) {
    state[`section${String(index)}`] = {
      title: `Section ${String(index)}`,
      items: makeItems(20),
      counters: { views: index, clicks: index * 2 },
    };
  }

  return state;
};

const makeStoreFixture = (isScopedDiff: boolean) => {
  const doc = new yjs.Doc();
  const store = createStore<WideState>(
    yjsMiddleware(doc, "store", () => makeWideInitialState(), {
      scopedDiff: isScopedDiff,
      disableYText: true,
    })
  );

  // Populate the doc (first flush = full tree) so timed runs measure steady state.
  store.setState({ "warm": true });
  getYjsStoreHandle(store).flush();

  return { doc, store };
};

for (const isScopedDiff of [false, true]) {
  const label = isScopedDiff ? "scopedDiff" : "full-tree";

  record(bench(
    `e2e/outbound: single-key update, 100-key store (${label})`,
    (fixture) => {
      const { store } = fixture as ReturnType<typeof makeStoreFixture>;

      store.setState({
        "section50": {
          title: "Section 50 EDITED",
          items: makeItems(20),
          counters: { views: 1, clicks: 2 },
        },
      });
      getYjsStoreHandle(store).flush();
    },
    { setup: () => makeStoreFixture(isScopedDiff), runs: 10 }
  ), { keys: KEY_COUNT });
}

/* -------------------------------------------------------------------------
 * 6. Inbound full-tree patch (patchStore with a large map JSON)
 * ---------------------------------------------------------------------- */

{
  const initial = makeWideInitialState();
  const remote = {
    ...initial,
    "section10": {
      title: "Section 10 (remote edit)",
      items: makeItems(20),
      counters: { views: 999, clicks: 1 },
    },
  };

  record(bench(
    "e2e/inbound: full-tree patchStore, 100-key state, 1 key changed",
    () => {
      const store = createStore<WideState>(() => initial);

      patchStore(store, remote);
    }
  ), { keys: KEY_COUNT });
}

/* -------------------------------------------------------------------------
 * 7. Aged document: long editing session through the real middleware
 * ---------------------------------------------------------------------- */

interface AgedDocReport {
  edits: number;
  firstWindowMeanMs: number;
  lastWindowMeanMs: number;
  totalMs: number;
  docUpdateBytes: number;
  encodedStateBytes: number;
  itemCount: number;
  finalToJsonMs: number;
}

const mean = (samples: number[]): number =>
  { return samples.reduce((sum, sample) => sum + sample, 0) / samples.length };

const runAgedDocSession = (edits: number, window: number): AgedDocReport => {
  const doc = new yjs.Doc();
  const editRandom = makeRandom(1234);

  interface NoteState {
    body: string;
    revision: number;
  }

  const store = createStore<NoteState>(
    yjsMiddleware(doc, "note", () => { return {
      body: randomText(2_000, makeRandom(5)),
      revision: 0,
    } })
  );
  const handle = getYjsStoreHandle(store);

  let docUpdateBytes = 0;

  doc.on("update", (update: Uint8Array) => {
    docUpdateBytes = docUpdateBytes + update.byteLength;
  });

  const latencies: number[] = [];
  const sessionStart = performance.now();

  for (let edit = 0; edit < edits; edit = edit + 1) {
    const { body, revision } = store.getState();
    const position = Math.floor(editRandom() * body.length);
    // Mixed workload: mostly small typed insertions, occasional deletion.
    const isDeletion = editRandom() < 0.2 && body.length > 200;
    const nextBody = isDeletion
      ? body.slice(0, position) + body.slice(Math.min(position + 40, body.length))
      : body.slice(0, position) +
        randomText(8, editRandom) +
        body.slice(position);

    const start = performance.now();

    store.setState({ body: nextBody, revision: revision + 1 });
    handle.flush();
    latencies.push(performance.now() - start);
  }

  const totalMs = performance.now() - sessionStart;

  let itemCount = 0;

  doc.store.clients.forEach((clientItems) => {
    itemCount = itemCount + clientItems.length;
  });

  const toJsonStart = performance.now();

  doc.getMap("note").toJSON();
  const finalToJsonMs = performance.now() - toJsonStart;

  return {
    edits,
    firstWindowMeanMs: mean(latencies.slice(0, window)),
    lastWindowMeanMs: mean(latencies.slice(-window)),
    totalMs,
    docUpdateBytes,
    encodedStateBytes: yjs.encodeStateAsUpdate(doc).byteLength,
    itemCount,
    finalToJsonMs,
  };
};

/**
 * Aged OBJECT document: a long editing session mutating nested objects and
 * arrays (no collaborative text at all) through the real middleware.
 */
const runAgedObjectSession = (edits: number, window: number): AgedDocReport => {
  const doc = new yjs.Doc();
  const editRandom = makeRandom(4321);
  const SECTION_COUNT = 20;

  interface SectionsState {
    sections: Record<string, {
      title: string;
      counters: Record<string, number>;
      tags: string[];
    }>;
  }

  const makeSections = (): SectionsState => {
    const sections: SectionsState["sections"] = {};

    for (let index = 0; index < SECTION_COUNT; index = index + 1) {
      sections[`s${String(index)}`] = {
        "title": `Section ${String(index)}`,
        "counters": { "views": 0, "clicks": 0, "shares": 0 },
        "tags": [`tag${String(index % 5)}`],
      };
    }

    return { sections };
  };

  const store = createStore<SectionsState>(
    yjsMiddleware(doc, "sections", () => makeSections(), { "disableYText": true })
  );
  const handle = getYjsStoreHandle(store);

  let docUpdateBytes = 0;

  doc.on("update", (update: Uint8Array) => {
    docUpdateBytes = docUpdateBytes + update.byteLength;
  });

  const counterNames = ["views", "clicks", "shares"];
  const latencies: number[] = [];
  const sessionStart = performance.now();

  for (let edit = 0; edit < edits; edit = edit + 1) {
    const { sections } = store.getState();
    const sectionKey = `s${String(Math.floor(editRandom() * SECTION_COUNT))}`;
    const section = sections[sectionKey];
    const kind = editRandom();

    let nextSection: SectionsState["sections"][string];

    if (kind < 0.7) {
      // Bump a nested counter (immutable update).
      const counter = counterNames[Math.floor(editRandom() * counterNames.length)];

      nextSection = {
        ...section,
        "counters": { ...section.counters, [counter]: section.counters[counter] + 1 },
      };
    } else if (kind < 0.85 || section.tags.length === 0) {
      // Append a tag.
      nextSection = {
        ...section,
        "tags": [...section.tags, `tag${String(Math.floor(editRandom() * 50))}`],
      };
    } else {
      // Remove a tag.
      const removeAt = Math.floor(editRandom() * section.tags.length);

      nextSection = {
        ...section,
        "tags": section.tags.filter((unused, index) => index !== removeAt),
      };
    }

    const start = performance.now();

    store.setState({ "sections": { ...sections, [sectionKey]: nextSection } });
    handle.flush();
    latencies.push(performance.now() - start);
  }

  const totalMs = performance.now() - sessionStart;

  let itemCount = 0;

  doc.store.clients.forEach((clientItems) => {
    itemCount = itemCount + clientItems.length;
  });

  const toJsonStart = performance.now();

  doc.getMap("sections").toJSON();
  const finalToJsonMs = performance.now() - toJsonStart;

  return {
    edits,
    "firstWindowMeanMs": mean(latencies.slice(0, window)),
    "lastWindowMeanMs": mean(latencies.slice(-window)),
    totalMs,
    docUpdateBytes,
    "encodedStateBytes": yjs.encodeStateAsUpdate(doc).byteLength,
    itemCount,
    finalToJsonMs,
  };
};

console.error("  running aged-doc session (this is the slow one)...");

const agedReport = runAgedDocSession(500, 25);

console.error("  running aged-object session...");

const agedObjectReport = runAgedObjectSession(500, 25);

/* -------------------------------------------------------------------------
 * Report
 * ---------------------------------------------------------------------- */

// eslint-disable-next-line no-console
console.log(`\n## Benchmark results (node ${process.version})\n`);
// eslint-disable-next-line no-console
console.log(formatTable(results));
// eslint-disable-next-line no-console
console.log(`
## Aged-document session (500 edits on a ~2k-char Y.Text note)

| metric | value |
|---|---:|
| mean flush latency, first 25 edits (ms) | ${agedReport.firstWindowMeanMs.toFixed(3)} |
| mean flush latency, last 25 edits (ms) | ${agedReport.lastWindowMeanMs.toFixed(3)} |
| total session time (ms) | ${agedReport.totalMs.toFixed(1)} |
| cumulative update payload (bytes) | ${String(agedReport.docUpdateBytes)} |
| encoded doc state (bytes) | ${String(agedReport.encodedStateBytes)} |
| Yjs item count | ${String(agedReport.itemCount)} |
| final map.toJSON() (ms) | ${agedReport.finalToJsonMs.toFixed(3)} |

## Aged-object session (500 nested-object/array edits, 20 sections, no Y.Text)

| metric | value |
|---|---:|
| mean flush latency, first 25 edits (ms) | ${agedObjectReport.firstWindowMeanMs.toFixed(3)} |
| mean flush latency, last 25 edits (ms) | ${agedObjectReport.lastWindowMeanMs.toFixed(3)} |
| total session time (ms) | ${agedObjectReport.totalMs.toFixed(1)} |
| cumulative update payload (bytes) | ${String(agedObjectReport.docUpdateBytes)} |
| encoded doc state (bytes) | ${String(agedObjectReport.encodedStateBytes)} |
| Yjs item count | ${String(agedObjectReport.itemCount)} |
| final map.toJSON() (ms) | ${agedObjectReport.finalToJsonMs.toFixed(3)} |
`);

console.error("  running versicle-shaped aging scenario...");
// eslint-disable-next-line no-console
console.log(`\n${runVersicleBench()}`);
