/*
 * Nested change lists recomputed at every pending level.
 *
 * getChanges recurses all the way down, so the root diff of a flush already
 * holds the complete nested change tree. The applier nevertheless re-runs
 * patchSharedType -> getChanges for every `pending` entry it meets, so a
 * change at depth d is diffed d + 1 times from scratch (the changed path is
 * walked O(d^2) times instead of O(d)), every unchanged sibling under a
 * changed ancestor is deep-compared again at each ancestor level, and a
 * changed Y.Array element is serialized again by the recursion.
 *
 * Counters (deterministic, in the notes column):
 * - getChangesCalls: getChanges invocations during the flush, the differ's
 *   own recursion included (TypeScript's CommonJS emit routes diff.ts's
 *   internal calls of the exported const through the module object, so the
 *   wrapper sees every level). The floor is one call per changed node
 *   (reported as changedNodes): d + 1 for a leaf at depth d, while
 *   recomputation at every level makes it (d + 1)(d + 2) / 2.
 * - stateRecordsVisited: enumerations (Object.keys/entries) of records and
 *   arrays of the new state during the flush, counted through a Proxy.
 * - elementToJSON: serializations of the one changed Y.Array element.
 *
 * Part of `npm run bench`; run on its own with:
 *   npx ts-node -T -P bench/tsconfig.json bench/nested-lists.ts
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { getYjsStoreHandle } from "../src";
import * as diffModule from "../src/diff";
import { patchSharedType } from "../src/patching";
import { bench, type BenchResult, formatTable } from "./harness";
import { makeProgressTree, makeSession, type ProgressTree } from "./versicle";

export interface NestedListsRow {
  result: BenchResult;
  meta: Record<string, string | number>;
}

/**
 * Number of getChanges invocations during `run`, recursion included. Swaps
 * the module export for a counting wrapper (patching.ts, and diff.ts's own
 * recursion, read it through the module object on every call).
 *
 * @param run - The flush to observe.
 * @returns The number of getChanges calls.
 */
const countGetChangesCalls = (run: () => void): number => {
  const original = diffModule.getChanges;
  let calls = 0;

  Object.defineProperty(diffModule, "getChanges", {
    "configurable": true,
    "value": (...args: Parameters<typeof original>) => {
      calls = calls + 1;

      return original(...args);
    },
    "writable": true,
  });

  try {
    run();
  } finally {
    Object.defineProperty(diffModule, "getChanges", { "configurable": true, "value": original, "writable": true });
  }

  return calls;
};

/**
 * Wraps `root` in a deep Proxy that counts how often any record or array
 * reached through it is enumerated: one count per walk of a node, however
 * many times the same node is walked.
 *
 * @param root - The new state to observe.
 * @returns The proxied state and a reader for the visit count.
 */
const makeVisitCounter = <T extends object>(root: T): { proxy: T; visits: () => number } => {
  let visits = 0;
  const proxies = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) {
      return value;
    }

    const cached = proxies.get(value);

    if (cached !== undefined) {
      return cached;
    }

    // eslint-disable-next-line no-restricted-syntax/noProxy -- Object.keys/entries can only be observed through a Proxy
    const proxy = new Proxy(value, {
      get: (target, key) => wrap((target as Record<PropertyKey, unknown>)[key]),
      ownKeys: (target) => {
        visits = visits + 1;

        return [...Object.getOwnPropertyNames(target), ...Object.getOwnPropertySymbols(target)];
      },
    });

    proxies.set(value, proxy);

    return proxy;
  };

  return { "proxy": wrap(root) as T, "visits": () => visits };
};

const makeObjectDocFixture = (state: Record<string, unknown>): {
  doc: yjs.Doc;
  map: yjs.Map<unknown>;
} => {
  const doc = new yjs.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    patchSharedType(map, state, { "disableYText": true });
  });

  return { doc, map };
};

/** Same shape as bench/index.ts §4b: `depth` levels, `siblings` scalars + one child each. */
const makeDeepState = (depth: number, siblings: number, leafValue: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { "leaf": leafValue };

  for (let level = depth - 1; level >= 0; level = level - 1) {
    const wrapped: Record<string, unknown> = { "child": node };

    for (let sibling = 0; sibling < siblings; sibling = sibling + 1) {
      wrapped[`field${String(sibling)}`] = (level * 100) + sibling;
    }
    node = wrapped;
  }

  return node;
};

/** Same shape as bench/index.ts §4: objects with a nested record and a tag array. */
const makeItems = (count: number): Record<string, unknown>[] => {
  return Array.from({ "length": count }, (unused, index) => {
    return {
      "done": index % 3 === 0,
      "id": `item-${String(index)}`,
      "label": `Label number ${String(index)}`,
      "nested": { "score": index * 7, "tags": [`tag${String(index % 5)}`, `tag${String(index % 11)}`] },
    };
  });
};

const runDeepLeaf = (depth: number): NestedListsRow => {
  const before = makeDeepState(depth, 6, 1);
  const after = makeDeepState(depth, 6, 2);
  const counted = makeObjectDocFixture(before);
  const counter = makeVisitCounter(after);
  const getChangesCalls = countGetChangesCalls(() => {
    counted.doc.transact(() => {
      patchSharedType(counted.map, counter.proxy, { "disableYText": true });
    });
  });

  return {
    "meta": { "changedNodes": depth + 1, depth, getChangesCalls, "stateRecordsVisited": counter.visits() },
    "result": bench(
      `patch/nested-lists: legacy leaf update at depth ${String(depth)}`,
      (fixture) => {
        const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

        doc.transact(() => {
          patchSharedType(map, after, { "disableYText": true });
        });
      },
      { "runs": 21, "setup": () => makeObjectDocFixture(before) }
    ),
  };
};

const runArrayElement = (): NestedListsRow => {
  const size = 2_000;
  const items = makeItems(size);
  const changed = items.map((item, index) => (index === 1_000 ? { ...item, "label": "CHANGED" } : item));
  const counted = makeObjectDocFixture({ "list": items });
  const element = (counted.map.get("list") as yjs.Array<unknown>).get(1_000) as yjs.Map<unknown>;
  const serializeElement = element.toJSON.bind(element);
  let elementToJSON = 0;

  element.toJSON = () => {
    elementToJSON = elementToJSON + 1;

    return serializeElement();
  };

  const getChangesCalls = countGetChangesCalls(() => {
    counted.doc.transact(() => {
      patchSharedType(counted.map, { "list": changed }, { "disableYText": true });
    });
  });

  return {
    // Changed nodes: root, list, the element, its label string.
    "meta": { "changedNodes": 4, elementToJSON, getChangesCalls, "items": size },
    "result": bench(
      `patch/nested-lists: legacy update of one field in a ${String(size)}-element array`,
      (fixture) => {
        const { doc, map } = fixture as ReturnType<typeof makeObjectDocFixture>;

        doc.transact(() => {
          patchSharedType(map, { "list": changed }, { "disableYText": true });
        });
      },
      { "runs": 21, "setup": () => makeObjectDocFixture({ "list": items }) }
    ),
  };
};

interface LegacyProgressState {
  progress: ProgressTree;
}

/**
 * Versicle-shaped page turn through the real middleware in the DEFAULT
 * (legacy full-tree) mode: one hot `progress` key holding per-book,
 * per-device records of fields plus a readingSessions array, each turn rewriting a
 * few fields of one device branch and appending one session. The change sits
 * at progress/book/device/readingSessions, so on top of the root diff the
 * patcher re-diffs the progress tree, the book, the device and the array.
 *
 * @param books - Library size.
 * @returns The measured row.
 */
const runLegacyPageTurn = (books: number): NestedListsRow => {
  const doc = new yjs.Doc();
  const store = createStore<LegacyProgressState>(
    yjsMiddleware(doc, "progress", () => ({ "progress": makeProgressTree(books, 300) }), { "disableYText": true })
  );
  const handle = getYjsStoreHandle(store);
  let turn = 1;
  const pageTurn = (): void => {
    const bookId = `book-${String(turn % books)}`;

    store.setState((state) => {
      const perBook = state.progress[bookId];
      const perDevice = perBook["device-0"];

      return {
        "progress": {
          ...state.progress,
          [bookId]: {
            ...perBook,
            "device-0": {
              ...perDevice,
              "currentCfi": `epubcfi(/6/4!/4/${String(turn)}:0)`,
              "lastRead": turn,
              "percentage": (turn % 100) / 100,
              "readingSessions": [...perDevice.readingSessions, makeSession(turn)],
            },
          },
        },
      };
    });
    turn = turn + 1;
    handle.flush();
  };

  // The first flush writes the whole tree; measure the steady state after it.
  store.setState({ "progress": { ...store.getState().progress } });
  handle.flush();

  const getChangesCalls = countGetChangesCalls(pageTurn);

  return {
    // Changed nodes: root, progress, book, device, currentCfi, readingSessions.
    "meta": { books, "changedNodes": 6, getChangesCalls },
    "result": bench(
      `e2e/nested-lists: legacy versicle-shaped page turn, ${String(books)} books`,
      pageTurn,
      { "runs": 15 }
    ),
  };
};

/**
 * Runs every nested-change-list scenario.
 *
 * @returns One row per scenario: the timing plus its deterministic counters.
 */
export const runNestedListsBench = (): NestedListsRow[] => {
  return [
    runDeepLeaf(6),
    runDeepLeaf(12),
    runDeepLeaf(24),
    runArrayElement(),
    runLegacyPageTurn(10),
    runLegacyPageTurn(40),
  ];
};

if (require.main === module) {
  const rows = runNestedListsBench();

  // eslint-disable-next-line no-console
  console.log(formatTable(rows.map(({ meta, result }) => ({ ...result, meta }))));
}
