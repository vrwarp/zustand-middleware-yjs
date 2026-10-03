/*
 * Perf regression: a full-tree record diff walks each node once, wherever
 * the change sits in key order.
 *
 * getRecordChanges prefilters every same-type child with isDeepEqualForDiff
 * and, when that reports a difference, recurses with getChanges. The
 * prefilter stops at the child's FIRST difference, so it fully traverses
 * every earlier sibling subtree on the way there; the recursion then walks
 * those same siblings again (prefiltering each one). That repeats at every
 * ancestor level of the changed path, so a node preceding the change at
 * depth d is walked d times:
 *
 * - library-shaped tree (`progress -> bookId -> deviceId -> fields`): a field
 *   update in the LAST book walks every other book twice (~2x the tree),
 *   while the same update in the FIRST book walks it once;
 * - a wide record under d single-key wrappers: the last entry's update costs
 *   (d + 2)x an unchanged diff.
 *
 * This is the legacy (default) full-tree path: every legacy outbound flush
 * and every legacy / key-scoped inbound patchState runs it over the whole
 * state.
 *
 * Cost is measured deterministically as string-keyed property reads on the
 * NEW-state tree (a copy whose keys are counting getters) — never wall-clock time. A single-pass
 * diff reads the same nodes for an unchanged tree and for any one-leaf
 * change, so every scenario is pinned against the unchanged diff of the
 * same tree on the same code.
 */
import { __scopedDiffDevSampling } from ".";
import { getChanges } from "./diff";
import { patchState } from "./patching";
import { type Change, changeType } from "./types";

type Tree = Record<string, unknown>;

/**
 * A structurally identical, read-counting copy of `root`: every record key
 * and array index is an enumerable getter that counts its reads, so
 * Object.keys/entries, Object.hasOwn and Array.isArray behave exactly as on
 * the original.
 */
const makeCountingCopy = <T extends object>(root: T): { copy: T; reads: () => number } => {
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

  return { "copy": instrument(root) as T, "reads": () => counter.reads };
};

/** Property reads `run` makes on (a counting copy of) `state`. */
const countReads = (state: Tree, run: (instrumented: Tree) => void): number => {
  const { copy, reads } = makeCountingCopy(state);

  run(copy);

  return reads();
};

const makeSession = (n: number): Tree => ({
  "cfiRange": `epubcfi(/6/${String(n % 40)}!/4/${String(n % 200)}:0)`,
  "startTime": 1_700_000_000_000 + (n * 60_000),
  "endTime": 1_700_000_000_000 + (n * 60_000) + 45_000,
  "type": n % 5 === 0 ? "tts" : "page",
  "label": `Chapter ${String(n % 30)}: section ${String(n)}`,
});

const makeDeviceProgress = (bookId: string, sessions: number): Tree => ({
  bookId,
  "currentCfi": `epubcfi(/6/4!/4/${String(sessions)}:0)`,
  "percentage": 0.25,
  "lastRead": 1_700_000_000_000,
  "completedRanges": Array.from({ "length": 10 }, (unused, index) => `range-${String(index)}`),
  "readingSessions": Array.from({ "length": sessions }, (unused, index) => makeSession(index)),
});

const BOOKS = 12;
const SESSIONS_PER_DEVICE = 30;

/** The versicle `progress` shape: progress -> bookId -> deviceId -> fields. */
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

/** Immutable update of one primitive field in `bookId`'s device-0 branch. */
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

/** Follows a pending chain down `path` and returns the leaf change list. */
const pendingAt = (changes: Change[], path: string[]): Change[] => {
  let current = changes;

  for (const segment of path) {
    expect(current).toHaveLength(1);
    expect(current[0][0]).toBe(changeType.pending);
    expect(current[0][1]).toBe(segment);
    current = current[0][2] as Change[];
  }

  return current;
};

describe("full-tree record diff cost does not depend on the change's key position", () => {
  const originalSamplingRate = __scopedDiffDevSampling.rate;

  beforeAll(() => {
    // Deterministic: the DEV convergence tripwire is random (not exercised
    // by these direct calls, pinned off anyway).
    __scopedDiffDevSampling.rate = 0;
  });

  afterAll(() => {
    __scopedDiffDevSampling.rate = originalSamplingRate;
  });

  // `a` is the doc-side JSON: structurally equal, shares no references.
  const base = makeProgressState();
  const docJson = JSON.parse(JSON.stringify(base)) as Tree;
  const firstBook = "book-0";
  const lastBook = `book-${String(BOOKS - 1)}`;

  const diffReads = (state: Tree): number =>
    countReads(state, (instrumented) => { getChanges(docJson, instrumented); });

  it("the counting copy does not change what the diff finds", () => {
    const { copy } = makeCountingCopy(withLastRead(base, lastBook, 42));
    const leaf = pendingAt(getChanges(docJson, copy), ["progress", lastBook, "device-0"]);

    expect(leaf).toStrictEqual([[changeType.update, "lastRead", 42]]);
    expect(getChanges(docJson, makeCountingCopy(base).copy)).toStrictEqual([]);
  });

  it("an update in the LAST book reads no more of the tree than an unchanged diff", () => {
    const unchanged = diffReads(base);
    const lastBookUpdate = diffReads(withLastRead(base, lastBook, 42));

    /*
     * Single pass: lastBookUpdate ≈ unchanged (every node read once either
     * way). With the prefilter double walk, books 0..n-2 are read twice:
     * ratio ≈ 2.0.
     */
    expect(lastBookUpdate / unchanged).toBeLessThanOrEqual(1.1);
  });

  it("an update in the last book costs the same as one in the first book", () => {
    const firstBookUpdate = diffReads(withLastRead(base, firstBook, 42));
    const lastBookUpdate = diffReads(withLastRead(base, lastBook, 42));

    expect(lastBookUpdate / firstBookUpdate).toBeLessThanOrEqual(1.1);
  });

  it("an inbound full-tree patchState is single-pass too", () => {
    /*
     * Inbound: patchState(currentState, docJson) — the doc JSON is the
     * new-state side. The remote change sits in the last book.
     */
    const current = JSON.parse(JSON.stringify(base)) as Tree;
    const unchanged = countReads(base, (instrumented) => { patchState(current, instrumented); });
    const remote = withLastRead(base, lastBook, 42);
    const lastBookPatch = countReads(remote, (instrumented) => { patchState(current, instrumented); });

    expect(patchState(current, remote)).toStrictEqual(remote);
    expect(lastBookPatch / unchanged).toBeLessThanOrEqual(1.1);
  });

  describe("wide record nested under single-key levels", () => {
    const ENTRIES = 100;
    const makeEntries = (changed: number): Tree => {
      const entries: Tree = {};

      for (let index = 0; index < ENTRIES; index = index + 1) {
        entries[`entry-${String(index)}`] = {
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

    /*
     * Each wrapper level adds one more full re-walk of the earlier entries:
     * on the unfixed code the ratio is depth + 2 (2.0, 3.0, 4.0, 5.0, 6.0).
     */
    it.each([0, 1, 2, 3, 4])(
      "updating the last entry at wrapper depth %i costs about an unchanged diff",
      (depth) => {
        const docSide = JSON.parse(JSON.stringify(nest({ "entries": makeEntries(-1) }, depth))) as Tree;
        const unchanged = countReads(nest({ "entries": makeEntries(-1) }, depth), (instrumented) => {
          getChanges(docSide, instrumented);
        });
        const lastEntryUpdate = countReads(nest({ "entries": makeEntries(ENTRIES - 1) }, depth), (instrumented) => {
          getChanges(docSide, instrumented);
        });

        expect(lastEntryUpdate / unchanged).toBeLessThanOrEqual(1.1);
      }
    );
  });
});
