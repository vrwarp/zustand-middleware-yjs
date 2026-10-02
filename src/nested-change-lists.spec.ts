/*
 * Nested change lists must not be recomputed at every pending level.
 *
 * getChanges recurses all the way down, so the root diff of a flush already
 * holds the complete nested change tree: one diff per changed node. The
 * applier must apply that tree, not re-run patchSharedType -> getChanges for
 * every `pending` entry. Re-diffing makes a change at depth d cost
 * (d + 1)(d + 2) / 2 node diffs instead of d + 1, deep-compares every
 * unchanged sibling under a changed ancestor once per ancestor level (the
 * multiplier on the legacy full-tree flush, which is O(state)), and
 * re-serializes changed Y.Array elements.
 *
 * Costs are pinned with counters and a scaling ratio, never wall-clock time:
 * - getChanges calls (jest.spyOn on the module export; TypeScript's CommonJS
 *   emit routes diff.ts's own recursion through the export too, so the spy
 *   sees one call per node diffed — a sanity test below fails if it ever
 *   stops doing so, rather than letting the depth tests pass vacuously);
 * - new-state nodes passed to getChanges more than once in a flush;
 * - enumerations of new-state records, counted through a Proxy;
 * - toJSON calls on one specific Y.Array element.
 *
 * Applying the parent's list is pure memoization only while that list was
 * diffed from the doc's current content. Two guards pin that: a property
 * asserting byte-identical Yjs updates against a forced re-diff of every
 * pending child, and same-tick races where the list was diffed from
 * previousState (an inbound batch still unapplied) and must NOT be applied.
 *
 * Benchmark: bench/nested-lists.ts (part of `npm run bench`).
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import * as diff from "./diff";
import { patchSharedType, patchSharedTypeScoped } from "./patching";
import { type Change, changeType } from "./types";

const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  // The DEV convergence tripwire runs a second (full) diff at random.
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

/** `depth` nested records, each with six scalar siblings and one child. */
const makeDeepState = (depth: number, leaf: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { leaf };

  for (let level = depth - 1; level >= 0; level = level - 1) {
    const wrapped: Record<string, unknown> = { "child": node };

    for (let sibling = 0; sibling < 6; sibling = sibling + 1) {
      wrapped[`field${String(sibling)}`] = (level * 100) + sibling;
    }
    node = wrapped;
  }

  return node;
};

const makeDoc = (state: Record<string, unknown>): { doc: yjs.Doc; map: yjs.Map<unknown> } => {
  const doc = new yjs.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    patchSharedType(map, state, { "disableYText": true });
  });

  return { doc, map };
};

/** Number of getChanges calls (recursion included) made while `run` executes. */
const countGetChangesCalls = (run: () => void): number => {
  const spy = jest.spyOn(diff, "getChanges");

  try {
    run();

    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
};

/**
 * getChanges calls made while `run` executes, and how many of them diffed an
 * object-valued new-state node (`b`) that an earlier call already diffed.
 * A repeat is a recomputation whatever a design chooses to diff; plain call
 * counts also move when unchanged nodes are diffed (or strings deferred).
 */
const countRepeatedNodeDiffs = (run: () => void): { calls: number; repeats: number } => {
  const original = diff.getChanges;
  const diffed = new Set<unknown>();
  let calls = 0;
  let repeats = 0;
  const spy = jest.spyOn(diff, "getChanges").mockImplementation((a, b, options) => {
    calls = calls + 1;
    if (typeof b === "object") {
      if (diffed.has(b)) {
        repeats = repeats + 1;
      }
      diffed.add(b);
    }

    return original(a, b, options);
  });

  try {
    run();

    return { calls, repeats };
  } finally {
    spy.mockRestore();
  }
};

/** Stands in for every nested change list while they are withheld. */
const WITHHELD = Symbol("withheld nested change list");

/**
 * Runs `run` with the nested list of every pending entry replaced by a
 * non-list marker, so every pending child is serialized and diffed from
 * scratch: the behavior before nested lists were threaded down, and the
 * fallback any non-list value must take.
 */
const withNestedListsWithheld = (run: () => void): void => {
  const original = diff.getChanges;
  const spy = jest.spyOn(diff, "getChanges").mockImplementation((a, b, options) =>
    original(a, b, options).map(([type, property, value]): Change =>
      [type, property, type === changeType.pending ? WITHHELD : value]));

  try {
    run();
  } finally {
    spy.mockRestore();
  }
};

/**
 * Deep Proxy over `root` counting enumerations (Object.keys / entries) of
 * every record or array reached through it: one count per walk of a node.
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

    const proxy = new Proxy(value, {
      get: (target, key) => wrap((target as Record<PropertyKey, unknown>)[key]),
      ownKeys: (target) => {
        visits = visits + 1;

        return Reflect.ownKeys(target);
      },
    });

    proxies.set(value, proxy);

    return proxy;
  };

  return { "proxy": wrap(root) as T, "visits": () => visits };
};

/** Counts calls of `target.toJSON` (an instance spy: parents call it too). */
const countToJson = (target: yjs.Map<unknown>): (() => number) => {
  const spy = jest.spyOn(target, "toJSON");

  return () => spy.mock.calls.length;
};

describe("legacy full-tree flush: one diff per changed node", () => {
  it("counts the differ's own recursion (sanity check for the counters below)", () => {
    /*
     * The external calls alone are d + 1 for a leaf at depth d, so if the
     * differ's internal recursion ever bypassed the spied export (an ESM
     * build, an internal helper), the depth tests would pass even on code
     * that re-diffs every level.
     */
    const calls = countGetChangesCalls(() => {
      diff.getChanges({ "a": { "b": { "c": 1 } } }, { "a": { "b": { "c": 2 } } });
    });

    expect(calls).toBe(3);
  });

  it.each([6, 12, 24])("diffs a leaf change at depth %i once per node on its path", (depth) => {
    const { doc, map } = makeDoc(makeDeepState(depth, 1));
    const next = makeDeepState(depth, 2);

    const calls = countGetChangesCalls(() => {
      doc.transact(() => {
        patchSharedType(map, next, { "disableYText": true });
      });
    });

    expect(map.toJSON()).toEqual(next);
    /*
     * The root diff already recurses through all depth + 1 records on the
     * path. Re-diffing at every pending level adds the rest:
     * (depth + 1)(depth + 2) / 2 calls — 28 / 91 / 325 for depth 6 / 12 / 24.
     */
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(depth + 1);
  });

  it("walks a deep changed path O(d^2), not O(d^3), in state-record visits", () => {
    const visitsAt = (depth: number): number => {
      const { doc, map } = makeDoc(makeDeepState(depth, 1));
      const counter = makeVisitCounter(makeDeepState(depth, 2));

      doc.transact(() => {
        patchSharedType(map, counter.proxy, { "disableYText": true });
      });
      expect(map.toJSON()).toEqual(makeDeepState(depth, 2));

      return counter.visits();
    };

    const shallow = visitsAt(12);
    const deep = visitsAt(24);

    /*
     * One diff pass enumerates each path record once for getRecordChanges
     * plus once per ancestor for the equality prefilter's descent: O(d^2),
     * ratio ~3.6 for 2x depth (91 -> 325). Re-diffing at every level makes it
     * O(d^3): 455 -> 2925, ratio ~6.4.
     */
    expect(deep / shallow).toBeLessThan(5);
  });

  it("does not re-compare unchanged sibling subtrees at every ancestor level", () => {
    const makeBook = (book: number): Record<string, unknown> => {
      return {
        "device-0": {
          "lastRead": book,
          "sessions": Array.from({ "length": 20 }, (unused, index) => ({ "label": `s${String(index)}`, "t": index })),
        },
        "device-1": { "lastRead": book, "sessions": [] },
      };
    };
    const books: Record<string, Record<string, unknown>> = {};

    for (let book = 0; book < 8; book = book + 1) {
      books[`book-${String(book)}`] = makeBook(book);
    }

    const { doc, map } = makeDoc({ "progress": books });
    let firstSiblingWalks = 0;
    let lastSiblingWalks = 0;
    const changed = books["book-4"];
    const next = {
      "progress": {
        ...books,
        "book-0": new Proxy(books["book-0"], {
          ownKeys: (target) => {
            firstSiblingWalks = firstSiblingWalks + 1;

            return Reflect.ownKeys(target);
          },
        }),
        "book-4": { ...changed, "device-0": { ...(changed["device-0"] as Record<string, unknown>), "lastRead": 99 } },
        "book-7": new Proxy(books["book-7"], {
          ownKeys: (target) => {
            lastSiblingWalks = lastSiblingWalks + 1;

            return Reflect.ownKeys(target);
          },
        }),
      },
    };

    doc.transact(() => {
      patchSharedType(map, next, { "disableYText": true });
    });

    expect((map.toJSON() as { progress: Record<string, { "device-0": { lastRead: number } }> })
      .progress["book-4"]["device-0"].lastRead).toBe(99);
    /*
     * The progress diff compares each unchanged book once. book-0 precedes
     * the change, so the root's equality prefilter also walks it on the way
     * down (2); book-7 follows it and is reached only by the diff (1).
     * Re-diffing progress from its pending entry adds one more walk of every
     * unchanged book — a full extra O(state) comparison per changed ancestor
     * in a legacy flush (3 and 2).
     */
    expect(lastSiblingWalks).toBe(1);
    expect(firstSiblingWalks).toBeLessThanOrEqual(2);
  });

  it("diffs no node of a versicle-shaped page turn twice through the middleware", () => {
    interface Progress {
      progress: Record<string, Record<string, Record<string, unknown>>>;
    }

    const makeDevice = (book: number): Record<string, unknown> => {
      return {
        "currentCfi": `epubcfi(/6/4!/4/${String(book)}:0)`,
        "lastRead": book,
        "percentage": 0.1,
        "readingSessions": Array.from({ "length": 5 }, (unused, index) => ({ "label": `s${String(index)}`, "t": index })),
      };
    };
    const progress: Progress["progress"] = {};

    for (let book = 0; book < 3; book = book + 1) {
      progress[`book-${String(book)}`] = { "device-0": makeDevice(book), "device-1": makeDevice(book) };
    }

    const doc = new yjs.Doc();
    // Default options: the legacy full-tree flush.
    const store = createStore<Progress>()(yjsMiddleware(doc, "progress", () => ({ progress }), { "disableYText": true }));
    const handle = getYjsStoreHandle(store);

    store.setState({ "progress": { ...store.getState().progress } });
    handle.flush();

    const { calls, repeats } = countRepeatedNodeDiffs(() => {
      store.setState((state) => {
        const perBook = state.progress["book-1"];
        const perDevice = perBook["device-0"];

        return {
          "progress": {
            ...state.progress,
            "book-1": {
              ...perBook,
              "device-0": {
                ...perDevice,
                "currentCfi": "epubcfi(/6/4!/4/77:0)",
                "lastRead": 77,
                "percentage": 0.5,
                "readingSessions": [...(perDevice.readingSessions as unknown[]), { "label": "new", "t": 77 }],
              },
            },
          },
        };
      });
      handle.flush();
    });

    expect((doc.getMap("progress").toJSON() as Progress).progress).toEqual(store.getState().progress);
    /*
     * The root diff already reaches every changed node (root, progress,
     * book-1, device-0, readingSessions, plus the currentCfi string): 6
     * calls. Re-diffing every pending level makes it 19, of which 10 diff
     * an object node a second (or third) time.
     */
    expect(calls).toBeGreaterThan(0);
    expect(repeats).toBe(0);
  });
});

describe("changed Y.Array elements are serialized once per flush", () => {
  const makeItems = (): Record<string, unknown>[] =>
    Array.from({ "length": 20 }, (unused, index) => ({
      "id": `item-${String(index)}`,
      "nested": { "score": index, "tags": [`t${String(index)}`] },
    }));

  it("legacy full-tree flush", () => {
    const items = makeItems();
    const { doc, map } = makeDoc({ "list": items });
    const element = (map.get("list") as yjs.Array<unknown>).get(7) as yjs.Map<unknown>;
    const nested = element.get("nested") as yjs.Map<unknown>;
    const elementToJson = countToJson(element);
    const nestedToJson = countToJson(nested);
    const next = items.map((item, index) => (index === 7 ? { ...item, "id": "changed" } : item));

    doc.transact(() => {
      patchSharedType(map, { "list": next }, { "disableYText": true });
    });

    // Read the counts before verifying: toJSON() below serializes again.
    const counts = [elementToJson(), nestedToJson()];

    expect(map.toJSON()).toEqual({ "list": next });
    // Once inside the root snapshot; a pending recursion that re-diffs the
    // element re-serializes it (and with it its nested map): 2 each.
    expect(counts[0]).toBeLessThanOrEqual(1);
    expect(counts[1]).toBeLessThanOrEqual(1);
  });

  it("scopedDiff flush through the middleware (array-leaf path)", () => {
    const doc = new yjs.Doc();
    const store = createStore<{ list: Record<string, unknown>[] }>()(
      yjsMiddleware(doc, "store", () => ({ "list": makeItems() }), { "disableYText": true, "scopedDiff": true })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "list": [...store.getState().list] });
    handle.flush();

    const map = doc.getMap("store");
    const element = (map.get("list") as yjs.Array<unknown>).get(7) as yjs.Map<unknown>;
    const nested = element.get("nested") as yjs.Map<unknown>;
    const elementToJson = countToJson(element);
    const nestedToJson = countToJson(nested);

    store.setState(({ list }) => ({
      "list": list.map((item, index) => (index === 7 ? { ...item, "id": "changed" } : item)),
    }));
    handle.flush();

    const counts = [elementToJson(), nestedToJson()];

    expect(map.toJSON()).toEqual({ "list": store.getState().list });
    // Once inside the array leaf's snapshot; a pending recursion that
    // re-diffs the element re-serializes it and its nested map: 2 each.
    expect(counts[0]).toBeLessThanOrEqual(1);
    expect(counts[1]).toBeLessThanOrEqual(1);
  });
});

describe("applying the parent's nested list is pure memoization", () => {
  // High-collision values, so lookahead shifts, duplicates and nested
  // pending elements are common.
  const leaf = fc.oneof(fc.constantFrom(0, 1, 2, null, true, "a", "b", "ab", "abc"), fc.string({ "maxLength": 4 }));
  const { tree } = fc.letrec((tie) => ({
    "arr": fc.array(tie("tree"), { "maxLength": 6 }),
    "rec": fc.dictionary(fc.constantFrom("k0", "k1", "k2", "k3", "k4"), tie("tree"), { "maxKeys": 5 }),
    "tree": fc.oneof({ "depthSize": "small", "withCrossShrink": true }, leaf, tie("arr"), tie("rec")),
  }));
  const rootState = fc.dictionary(fc.constantFrom("w", "x", "y", "z"), tree, { "maxKeys": 4, "minKeys": 1 });

  /** Seeded LCG in [0, 1): reproducible from the fast-check seed. */
  const makeRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;

    return () => {
      state = ((state * 1_664_525) + 1_013_904_223) >>> 0;

      return state / (2 ** 32);
    };
  };

  /** One immutable edit somewhere in `value`: unchanged branches keep their identity. */
  const mutate = (value: unknown, random: () => number): unknown => {
    const roll = random();

    if (Array.isArray(value)) {
      const next: unknown[] = [...value];
      const operation = Math.floor(roll * 5);
      const at = Math.min(Math.floor(random() * (next.length + 1)), Math.max(next.length - 1, 0));

      if (operation === 0) {
        next.splice(Math.floor(random() * (next.length + 1)), 0, random() < 0.5 ? { "k0": Math.floor(random() * 3) } : 1);
      } else if (operation === 1 && next.length > 0) {
        next.splice(at, 1);
      } else if (operation === 2 && next.length > 1) {
        next.splice(0, at);
      } else if (next.length > 0) {
        next[at] = mutate(next[at], random);
        if (operation === 4) {
          next.push("ab");
        }
      }

      return next;
    }
    if (typeof value === "object" && value !== null) {
      const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      const keys = Object.keys(next);
      const operation = Math.floor(roll * 4);

      if (operation === 0 || keys.length === 0) {
        next[`k${String(Math.floor(random() * 5))}`] = random() < 0.5 ? [1, { "k1": "a" }] : "abc";
      } else if (operation === 1) {
        delete next[keys[Math.floor(random() * keys.length)]];
      } else {
        const key = keys[Math.floor(random() * keys.length)];

        next[key] = mutate(next[key], random);
      }

      return next;
    }
    if (typeof value === "string") {
      return roll < 0.5 ? `${value}x` : `Z${value.slice(1)}`;
    }
    if (roll < 0.3) {
      return { "k2": value };
    }

    return typeof value === "number" ? value + 1 : 7;
  };

  /** The update one flush from `before` to `after` emits (fixed clientID). */
  const flush = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    mode: "legacy" | "scoped",
    disableYText: boolean,
    wrap: (run: () => void) => void
  ): { json: unknown; update: string } => {
    const doc = new yjs.Doc();

    doc.clientID = 4242;

    const map = doc.getMap("store");

    doc.transact(() => {
      patchSharedType(map, before, { disableYText });
    });

    const stateVector = yjs.encodeStateVector(doc);

    wrap(() => {
      doc.transact(() => {
        if (mode === "legacy") {
          patchSharedType(map, after, { disableYText });
        } else {
          patchSharedTypeScoped(map, after, before, { "backfillAbsentKeys": true, disableYText });
        }
      });
    });

    return { "json": map.toJSON(), "update": Buffer.from(yjs.encodeStateAsUpdate(doc, stateVector)).toString("hex") };
  };

  it("emits byte-identical updates to re-diffing every pending child (property)", () => {
    fc.assert(
      fc.property(
        rootState,
        fc.integer(),
        fc.integer({ "max": 4, "min": 1 }),
        fc.boolean(),
        fc.constantFrom("legacy" as const, "scoped" as const),
        (before, seed, edits, disableYText, mode) => {
          const random = makeRandom(seed);
          let after: Record<string, unknown> = before;

          for (let edit = 0; edit < edits; edit = edit + 1) {
            after = mutate(after, random) as Record<string, unknown>;
          }

          const threaded = flush(before, after, mode, disableYText, (run) => {
            run();
          });
          const recomputed = flush(before, after, mode, disableYText, withNestedListsWithheld);

          expect(threaded.json).toEqual(recomputed.json);
          expect(threaded.update).toBe(recomputed.update);
        }
      ),
      { "numRuns": 400 }
    );
  });
});

describe("a list diffed from previousState is never applied to the doc's children", () => {
  /*
   * While an inbound batch is unapplied, the scoped array leaf diffs
   * previousState (not the doc) against the new state, so an element's
   * nested list holds offsets into state's text, not into the doc's, which
   * already carries the remote edit. Applied to the doc it interleaves the
   * two edits ("hello" -> "hellO" at state's offsets into "XXhello" gives
   * "XXheOlo"). The element must be re-diffed against the doc instead.
   */
  interface Item { id: string; title: string }

  const initialItems = (): Item[] => [{ "id": "a", "title": "hello" }, { "id": "b", "title": "world" }];
  const editTitle = (items: Item[]): Item[] => [{ ...items[0], "title": "hellO" }, items[1]];

  /** An update prepending "XX" to element 0's title, made on a copy of `doc`. */
  const makeRemotePrepend = (doc: yjs.Doc, key: string): Uint8Array => {
    const remote = new yjs.Doc();

    yjs.applyUpdate(remote, yjs.encodeStateAsUpdate(doc));

    const stateVector = yjs.encodeStateVector(remote);
    const items = remote.getMap(key).get("list") as yjs.Array<yjs.Map<unknown>>;

    (items.get(0).get("title") as yjs.Text).insert(0, "XX");

    return yjs.encodeStateAsUpdate(remote, stateVector);
  };

  it("same-tick race through the default middleware: a local title edit and a remote prepend", async () => {
    const doc = new yjs.Doc();
    // Default options: Y.Text titles, legacy full-tree mode.
    const store = createStore<{ list: Item[] }>()(yjsMiddleware(doc, "s", () => ({ "list": initialItems() })));

    store.setState({ "list": [...store.getState().list] });
    getYjsStoreHandle(store).flush();

    const remotePrepend = makeRemotePrepend(doc, "s");

    // Same tick: the local write queues its flush, then the remote update
    // lands in the doc before the inbound batch that would apply it runs.
    store.setState(({ list }) => ({ "list": editTitle(list) }));
    yjs.applyUpdate(doc, remotePrepend, "remote");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const docTitle = (doc.getMap("s").toJSON() as { list: Item[] }).list[0].title;

    // The local edit lands on the doc's text: it wins outright today (the
    // element is re-diffed against the doc), and keeping both edits would
    // be fine, but never an interleaving of the two.
    expect(["hellO", "XXhellO"]).toContain(docTitle);
    expect(store.getState().list[0].title).toBe(docTitle);
  });

  it.each([false, true])("patchSharedTypeScoped with unappliedInboundTargets (lists withheld: %s)", (isWithheld) => {
    const doc = new yjs.Doc();
    const map = doc.getMap("s");
    const before = { "list": initialItems() };
    const after = { "list": editTitle(before.list) };

    doc.transact(() => {
      patchSharedType(map, before);
    });

    const unappliedInboundTargets = new Set<unknown>();

    map.observeDeep((events) => {
      for (const event of events) {
        unappliedInboundTargets.add(event.target);
      }
    });
    yjs.applyUpdate(doc, makeRemotePrepend(doc, "s"), "remote");

    // Only the Y.Text changed: the array keeps its structure, so the leaf
    // is diffed from previousState.
    expect(unappliedInboundTargets.has(map.get("list"))).toBe(false);

    const run = (): void => {
      doc.transact(() => {
        patchSharedTypeScoped(map, after, before, { unappliedInboundTargets });
      });
    };

    if (isWithheld) {
      withNestedListsWithheld(run);
    } else {
      run();
    }

    expect((map.toJSON() as { list: Item[] }).list).toEqual([{ "id": "a", "title": "hellO" }, { "id": "b", "title": "world" }]);
  });
});
