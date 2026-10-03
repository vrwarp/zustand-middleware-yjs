/*
 * Full-tree record diff: cost by the changed key's POSITION.
 *
 * getRecordChanges prefilters every same-type child with isDeepEqualForDiff
 * and then recurses with getChanges. The prefilter stops at the child's
 * first difference, so it fully walks every earlier sibling subtree; the
 * recursion then walks those siblings again, at every ancestor level of the
 * changed path. On the legacy (default) full-tree path — every outbound
 * flush and every legacy / key-scoped inbound patchState — the cost of one
 * field update therefore depends on where it sits in key order:
 *
 * - library-shaped `progress -> bookId -> deviceId -> fields` tree: an update
 *   in the LAST book costs ~2x one in the FIRST book (or an unchanged diff);
 * - a wide record under d single-key levels: the last entry costs (d + 2)x.
 *
 * A single-pass diff reads each node once, so every row should cost about
 * its "unchanged" floor. `reads` is the deterministic cost measure: property
 * reads the operation makes on the new-state tree (one untimed run through a
 * read-counting copy); `xUnchanged` is reads relative to the unchanged diff of
 * the same tree.
 *
 * Run alone with:
 *   npx ts-node -T -P bench/tsconfig.json bench/record-diff.ts
 */
import * as yjs from "yjs";
import { getChanges } from "../src/diff";
import { patchSharedType, patchState } from "../src/patching";
import { bench, type BenchResult, formatTable } from "./harness";

type Tree = Record<string, unknown>;

export interface RecordDiffRow {
  result: BenchResult;
  meta: Record<string, string | number>;
}

/**
 * Runs `run` once (untimed) against a read-counting copy of `state` and
 * returns the number of property reads it made on the tree. The copy is
 * structurally identical, but every record key and array index is an
 * enumerable getter that counts its reads, so Object.keys/entries,
 * Object.hasOwn and Array.isArray behave exactly as on the original.
 *
 * @param state - The new-state tree to observe.
 * @param run - The operation, given the instrumented tree.
 * @returns Property reads made on the tree.
 */
const countStateReads = (state: Tree, run: (instrumented: Tree) => void): number => {
  const counter = { "reads": 0 };
  const instrument = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) {
      return value;
    }

    const source = value as Tree;
    const copy: Tree | unknown[] = Array.isArray(value)
      ? Array.from({ "length": value.length })
      : {};

    for (const key of Object.keys(source)) {
      const child = instrument(source[key]);

      Object.defineProperty(copy, key, {
        "configurable": true,
        "enumerable": true,
        get() {
          counter.reads = counter.reads + 1;

          return child;
        },
      });
    }

    return copy;
  };
  const instrumented = instrument(state) as Tree;

  counter.reads = 0;
  run(instrumented);

  return counter.reads;
};

const makeSession = (n: number): Tree => {
  return {
    "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0),epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:80)`,
    "startTime": 1_700_000_000_000 + (n * 60_000),
    "endTime": 1_700_000_000_000 + (n * 60_000) + 45_000,
    "type": n % 5 === 0 ? "tts" : "page",
    "label": `Chapter ${String(n % 30)}: section ${String(n)}`,
  };
};

const makeDeviceProgress = (bookId: string, sessions: number): Tree => {
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

const BOOKS = 40;
const SESSIONS_PER_DEVICE = 300;

/** Same shape and scale as bench/versicle.ts at 40 books. */
const makeProgressState = (): Tree => {
  const progress: Tree = {};

  for (let book = 0; book < BOOKS; book = book + 1) {
    const bookId = `book-${String(book)}`;

    progress[bookId] = {
      "device-0": makeDeviceProgress(bookId, SESSIONS_PER_DEVICE),
      "device-1": makeDeviceProgress(bookId, SESSIONS_PER_DEVICE),
    };
  }

  return { progress };
};

/** Immutable page-turn-style update of one field in `bookId`'s device-0. */
const withLastRead = (state: Tree, bookId: string, lastRead: number): Tree => {
  const progress = state.progress as Record<string, Record<string, Tree>>;
  const perBook = progress[bookId];

  return {
    ...state,
    "progress": {
      ...progress,
      [bookId]: { ...perBook, "device-0": { ...perBook["device-0"], lastRead } },
    },
  };
};

const makeDocFixture = (state: Tree): { doc: yjs.Doc; map: yjs.Map<unknown> } => {
  const doc = new yjs.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    patchSharedType(map, state, { "disableYText": true });
  });

  return { doc, map };
};

/**
 * Runs the record-diff key-position scenarios.
 *
 * @returns One row per scenario (timing + deterministic read counts).
 */
export const runRecordDiffBench = (): RecordDiffRow[] => {
  const rows: RecordDiffRow[] = [];
  const add = (result: BenchResult, meta: Record<string, string | number>): void => {
    rows.push({ meta, result });
    console.error(`  done: ${result.name} (median ${result.medianMs.toFixed(3)} ms)`);
  };

  const base = makeProgressState();
  // Doc-side JSON: structurally equal to `base`, shares no references.
  const docJson = JSON.parse(JSON.stringify(base)) as Tree;
  const lastBook = `book-${String(BOOKS - 1)}`;
  const variants: [label: string, state: Tree][] = [
    ["unchanged", base],
    ["field update in first book", withLastRead(base, "book-0", 1)],
    ["field update in last book", withLastRead(base, lastBook, 1)],
  ];
  const unchangedDiffReads = countStateReads(base, (instrumented) => { getChanges(docJson, instrumented); });

  // 1. The differ alone (what every full-tree flush / inbound patch runs).
  for (const [label, state] of variants) {
    const reads = countStateReads(state, (instrumented) => { getChanges(docJson, instrumented); });

    add(bench(
      `diff/record: ${String(BOOKS)}-book progress tree, ${label}`,
      () => { getChanges(docJson, state); }
    ), {
      reads,
      "xUnchanged": (reads / unchangedDiffReads).toFixed(2),
    });
  }

  // 2. Legacy / key-scoped inbound: patchState(currentState, docJson).
  for (const [label, state] of variants.slice(1)) {
    const current = JSON.parse(JSON.stringify(base)) as Tree;
    const reads = countStateReads(state, (instrumented) => { patchState(current, instrumented); });

    add(bench(
      `patch/state: inbound full-tree patch, ${label}`,
      () => { patchState(current, state); }
    ), {
      reads,
      "xUnchanged": (reads / unchangedDiffReads).toFixed(2),
    });
  }

  /*
   * 3. Legacy outbound flush (patchSharedType at the root: toJSON + diff +
   * apply). Each run toggles the field between two values so one doc serves
   * every run; reads come from a separate untimed fixture. Note: this path
   * also re-diffs each pending level (a separate cost), so its read count is
   * a compound of both.
   */
  for (const [label, state] of variants.slice(1)) {
    const counted = makeDocFixture(base);
    const reads = countStateReads(state, (instrumented) => {
      counted.doc.transact(() => { patchSharedType(counted.map, instrumented, { "disableYText": true }); });
    });
    const { doc, map } = makeDocFixture(base);
    let isChanged = false;

    add(bench(
      `patch/legacy-flush: ${String(BOOKS)}-book progress tree, ${label}`,
      () => {
        isChanged = !isChanged;
        doc.transact(() => { patchSharedType(map, isChanged ? state : base, { "disableYText": true }); });
      },
      { "runs": 10 }
    ), {
      reads,
      "xUnchanged": (reads / unchangedDiffReads).toFixed(2),
    });
  }

  // 4. Depth multiplier: a wide record under `depth` single-key levels.
  const ENTRIES = 1_000;
  const makeEntries = (changed: number): Tree => {
    const entries: Tree = {};

    for (let index = 0; index < ENTRIES; index = index + 1) {
      entries[`entry${String(index)}`] = {
        "name": `Entry ${String(index)}`,
        "count": index === changed ? -1 : index,
        "meta": { "created": index * 1_000, "flags": [index % 2, index % 3] },
      };
    }

    return entries;
  };
  const nest = (inner: Tree, depth: number): Tree => {
    let node = inner;

    for (let level = depth - 1; level >= 0; level = level - 1) {
      node = { [`level${String(level)}`]: node };
    }

    return node;
  };

  for (const depth of [0, 4]) {
    const docSide = JSON.parse(JSON.stringify(nest({ "entries": makeEntries(-1) }, depth))) as Tree;
    const unchanged = nest({ "entries": makeEntries(-1) }, depth);
    const unchangedReads = countStateReads(unchanged, (instrumented) => { getChanges(docSide, instrumented); });

    for (const [label, state] of [
      ["unchanged", unchanged],
      ["last entry updated", nest({ "entries": makeEntries(ENTRIES - 1) }, depth)],
    ] as const) {
      const reads = countStateReads(state, (instrumented) => { getChanges(docSide, instrumented); });

      add(bench(
        `diff/record: ${String(ENTRIES)} entries under ${String(depth)} wrapper levels, ${label}`,
        () => { getChanges(docSide, state); }
      ), {
        reads,
        "xUnchanged": (reads / unchangedReads).toFixed(2),
      });
    }
  }

  return rows;
};

if (require.main === module) {
  const rows = runRecordDiffBench();

  // eslint-disable-next-line no-console
  console.log(`\n## Record diff by key position (node ${process.version})\n`);
  // eslint-disable-next-line no-console
  console.log(formatTable(rows.map(({ meta, result }) => ({ ...result, meta }))));
}
