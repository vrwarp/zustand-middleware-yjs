/*
 * Perf regression: Y.Array inserts/updates must be applied as runs.
 *
 * The array differ emits one change per element — an append of k elements is
 * [insert, n], [insert, n + 1], ..., a rewrite is k contiguous updates (or k
 * `pending` string diffs). The Y.Array applier used to turn every one of them
 * into its own `yarray.insert(i, [value])` (plus `delete(i)` for updates).
 *
 * In Yjs that is quadratic for any element whose integration consumes exactly
 * one clock — primitives (numbers, booleans, null, strings under
 * disableYText) and empty Y.Maps/Y.Arrays: one transaction gives them
 * consecutive clocks from the same client, and on every insert Yjs's
 * findMarker walks LEFT across the whole mergeable run inserted so far ("make
 * sure p can't be merged with left"), so k inserts walk ~k²/2 items. Elements
 * that are Y.Maps with fields break the run (their field items take clocks in
 * between), which is why object-array benches never showed it. The first
 * flush (arrayToYArray: one insert of every element) is unaffected.
 *
 * The cost is pinned two ways, neither of them wall-clock:
 *
 * 1. Yjs call counts: a bulk append/rewrite issues a constant number of
 *    Y.Array insert/delete calls, not one per element.
 * 2. Item visits: Yjs's list walks read `Item#deleted` on every item they step
 *    over (findMarker's left/right walks, the insert/get position walks,
 *    toJSON), so counting reads of that getter is a deterministic measure of
 *    list-walk work. Appending 4n primitives must cost less than 8x appending
 *    n (linear is ~4x or flat; the quadratic run walk is ~16x).
 *
 * And the batching must not change the CRDT: a property patches random write
 * sequences (with concurrent remote edits) into two docs, one through the
 * library and one through an element-wise reference applier, and requires
 * byte-identical doc state after every patch.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { getChanges } from "./diff";
import { arrayToYArray, objectToYMap } from "./mapping";
import { patchSharedType, patchSharedTypeScoped } from "./patching";
import { type Change, changeType } from "./types";

interface ListState {
  list: unknown[];
}

const makeIds = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (unused, index) => `book-${String(index + offset).padStart(7, "0")}`);

const makeNumbers = (count: number, offset = 0): number[] =>
  Array.from({ length: count }, (unused, index) => index + offset);

const makeMixedPrimitives = (count: number): unknown[] =>
  Array.from({ length: count }, (unused, index) => {
    switch (index % 4) {
      case 0: { return index; }
      case 1: { return index % 3 === 0; }
      case 2: { return null; }
      default: { return `tag-${String(index)}`; }
    }
  });

const makeObjects = (count: number, offset = 0): Record<string, unknown>[] =>
  Array.from({ length: count }, (unused, index) => ({ "id": `o${String(index + offset)}`, "n": index + offset }));

/** A store bound to `list`, flushed once so the doc holds `initial`. */
const makeListStore = (initial: unknown[], isScopedDiff: boolean) => {
  const doc = new yjs.Doc();
  const store = createStore<ListState>(
    yjsMiddleware(doc, "shelf", () => ({ "list": initial }), {
      "disableYText": true,
      "scopedDiff": isScopedDiff,
    })
  );
  const handle = getYjsStoreHandle(store);

  // First flush writes the whole list with one arrayToYArray insert.
  store.setState({ "list": [...initial] });
  handle.flush();

  const yList = (): yjs.Array<unknown> => doc.getMap("shelf").get("list") as yjs.Array<unknown>;

  expect(yList()).toBeInstanceOf(yjs.Array);

  return { doc, handle, store, yList };
};

/**
 * Counts reads of `Item#deleted` while `run` executes: one per item a Yjs list
 * walk steps over. A plain wrapper rather than jest.spyOn, which would record
 * millions of calls at baseline.
 */
const countItemVisits = (run: () => void): number => {
  const proto = yjs.Item.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "deleted");

  if (descriptor?.get === undefined) {
    throw new Error("yjs Item#deleted is no longer a prototype getter; update this probe");
  }

  const originalGet = descriptor.get;
  let visits = 0;

  Object.defineProperty(proto, "deleted", {
    ...descriptor,
    get(this: yjs.Item) {
      visits = visits + 1;

      return originalGet.call(this) as boolean;
    },
  });

  try {
    run();
  } finally {
    Object.defineProperty(proto, "deleted", descriptor);
  }

  return visits;
};

/** Runs one write + flush and reports the Y.Array calls it made. */
const measureFlush = (
  initial: unknown[],
  next: (list: unknown[]) => unknown[],
  isScopedDiff: boolean
) => {
  const { handle, store, yList } = makeListStore(initial, isScopedDiff);
  const insertSpy = jest.spyOn(yjs.Array.prototype, "insert");
  const deleteSpy = jest.spyOn(yjs.Array.prototype, "delete");

  try {
    const visits = countItemVisits(() => {
      store.setState({ "list": next(store.getState().list) });
      handle.flush();
    });

    // The run must still converge: doc and store hold the same list.
    expect(yList().toJSON()).toEqual(store.getState().list);

    return {
      "deleteCalls": deleteSpy.mock.calls.length,
      "insertCalls": insertSpy.mock.calls.length,
      visits,
    };
  } finally {
    insertSpy.mockRestore();
    deleteSpy.mockRestore();
  }
};

describe("Y.Array bulk inserts and updates are applied as runs", () => {
  beforeEach(() => {
    __scopedDiffDevSampling.rate = 0;
  });

  describe.each([
    ["legacy full-tree diff", false],
    ["scopedDiff", true],
  ])("%s", (unusedLabel, isScopedDiff) => {
    it.each([
      ["ids (strings under disableYText)", makeIds(1_000), makeIds(2_000, 1_000)],
      ["numbers", makeNumbers(10), makeNumbers(2_000, 10)],
      ["mixed primitives", makeNumbers(10), makeMixedPrimitives(2_000)],
    ])("appending 2,000 %s is a constant number of Y.Array inserts", (unusedKind, initial, appended) => {
      const { insertCalls } = measureFlush(initial, (list) => [...list, ...appended], isScopedDiff);

      // One contiguous run -> one insert; was one insert per element (2,000).
      expect(insertCalls).toBeLessThanOrEqual(2);
    });

    it("rewriting all 1,000 numbers (update path) is a ranged delete + one insert", () => {
      const { deleteCalls, insertCalls } = measureFlush(
        makeNumbers(1_000),
        () => makeNumbers(1_000, 100_000),
        isScopedDiff
      );

      // Was delete(i) + insert(i, [v]) per element: 1,000 + 1,000.
      expect(insertCalls).toBeLessThanOrEqual(2);
      expect(deleteCalls).toBeLessThanOrEqual(2);
    });

    it("rewriting all 1,000 ids (pending string path) is a ranged delete + one insert", () => {
      // Two strings diff as `pending` (a text diff), and the applier replaces
      // a primitive-string element by delete(i) + insert(i, [v]) per element.
      const { deleteCalls, insertCalls } = measureFlush(
        makeIds(1_000),
        () => makeIds(1_000, 500_000),
        isScopedDiff
      );

      expect(insertCalls).toBeLessThanOrEqual(2);
      expect(deleteCalls).toBeLessThanOrEqual(2);
    });
  });

  it("Yjs list-walk work for a primitive append grows linearly, not quadratically", () => {
    const visitsFor = (count: number): number =>
      measureFlush(makeNumbers(10), (list) => [...list, ...makeNumbers(count, 10)], true).visits;

    const small = visitsFor(500);
    const large = visitsFor(2_000);

    // 4x the elements: quadratic is ~16x (measured 378,758 -> 6,015,008 item
    // visits, 15.9x, on the per-element applier); linear is <= ~4x (a
    // run-batched applier measured a flat 17 -> 17).
    expect(large / small).toBeLessThan(8);
  });

  it("control: object elements with fields were already linear (the probe measures the run walk)", () => {
    // Y.Map elements with fields consume extra clocks per element, which
    // breaks the mergeable run findMarker walks; this stays linear on the
    // per-element applier too, so it guards the probe, not the fix.
    const visitsFor = (count: number): number =>
      measureFlush(makeObjects(10), (list) => [...list, ...makeObjects(count, 10)], true).visits;

    const small = visitsFor(500);
    const large = visitsFor(2_000);

    expect(large / small).toBeLessThan(8);
  });
});

/*
 * Run application must leave the CRDT exactly as element-wise application
 * did: k inserts at i..i+k-1 equal one insert of k values at i, and k
 * contiguous updates (or pending strings under disableYText) equal
 * delete(i, k) + one insert, down to every item's clock, origins and merges.
 *
 * Two docs with the same clientID start equal and receive the same
 * concurrent remote edits. One is patched by the library, the other by the
 * element-wise reference below (one Yjs call per change, as the applier
 * worked before runs) applying the change list the library computes (same
 * differ, same inputs). Their encoded states must be byte-identical after
 * every patch.
 */
describe("run application is byte-identical to element-wise application", () => {
  /**
   * The per-element Y.Array applier: one Yjs call per change, in list order.
   * Pending elements recurse through the library (its Y.Map and Y.Text paths
   * are not run-batched) with the same previousState alignment.
   */
  const applyElementWise = (
    yarray: yjs.Array<unknown>,
    changes: Change[],
    next: unknown[],
    previous: unknown[] | undefined,
    disableYText: boolean
  ): void => {
    const toStored = (value: unknown): unknown => {
      if (typeof value === "string") {
        return disableYText ? value : new yjs.Text(value);
      }
      if (Array.isArray(value)) {
        return arrayToYArray(value, { disableYText });
      }
      if (typeof value === "object" && value !== null) {
        return objectToYMap(value as Record<string, unknown>, { disableYText });
      }

      return value;
    };
    const initialLength = yarray.length;

    for (const [type, property, value] of changes) {
      const index = property as number;

      switch (type) {
        case changeType.insert: {
          yarray.insert(index, [toStored(value)]);
          break;
        }
        case changeType.update: {
          yarray.delete(index);
          yarray.insert(index, [toStored(value)]);
          break;
        }
        case changeType.delete: {
          // In range: delete at index; past the end: the last element.
          if (yarray.length > 0) {
            yarray.delete(Math.min(index, yarray.length - 1));
          }
          break;
        }
        case changeType.pending: {
          const existing = yarray.get(index);
          const element = next[index];

          if (existing instanceof yjs.AbstractType && !(disableYText && typeof element === "string")) {
            patchSharedType(existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text, element, {
              disableYText,
              "previousState": previous?.[index - (yarray.length - initialLength)],
            });
          } else {
            // A primitive string, or the Y.Text <-> string mapping repair.
            yarray.delete(index);
            yarray.insert(index, [toStored(element)]);
          }
          break;
        }
        default: {
          break;
        }
      }
    }
  };

  // Single-clock elements (primitives, {} and []) form the runs the fix
  // batches; records and non-empty arrays break them and recurse as pending.
  const element = fc.oneof(
    fc.integer({ "min": 0, "max": 5 }),
    fc.constantFrom("a", "b", "c"),
    fc.boolean(),
    fc.constant(null),
    fc.constant(0).map(() => ({})),
    fc.constant(0).map((): unknown[] => []),
    fc.record({ "id": fc.integer({ "min": 0, "max": 3 }) }),
    fc.array(fc.integer({ "min": 0, "max": 3 }), { "minLength": 1, "maxLength": 3 })
  );
  const values = fc.array(element, { "minLength": 1, "maxLength": 30 });
  // Position as a percentage of the list length; 100 (an append) is common.
  const at = fc.oneof(fc.constant(100), fc.integer({ "min": 0, "max": 100 }));
  const edit = fc.oneof(
    fc.record({ at, "kind": fc.constant("insert" as const), values }),
    fc.record({ at, "count": fc.integer({ "min": 1, "max": 20 }), "kind": fc.constant("remove" as const) }),
    fc.record({ at, "kind": fc.constant("overwrite" as const), values }),
    fc.record({ "kind": fc.constant("rebuild" as const), values }),
    fc.record({ "kind": fc.constant("rewriteStrings" as const) })
  );
  // A remote insert/delete lands before the patch; `isSeen` says whether the
  // patching side's previous state already reflects it (a settled inbound
  // patch) or is stale (it lands in the same tick as the local write).
  const remoteEdit = fc.record({ at, "isInsert": fc.boolean(), "isSeen": fc.boolean() });
  const step = fc.record({ edit, "remote": fc.option(remoteEdit, { "nil": undefined }) });
  const initialList = fc.array(element, { "maxLength": 12 });
  const steps = fc.array(step, { "minLength": 1, "maxLength": 12 });

  type Edit = typeof edit extends fc.Arbitrary<infer T> ? T : never;

  // Immutable edits, so the scoped differ's identity hint sees shared elements.
  const applyEdit = (list: unknown[], change: Edit): unknown[] => {
    const position = "at" in change ? Math.floor((list.length * change.at) / 100) : 0;

    switch (change.kind) {
      case "insert": { return [...list.slice(0, position), ...change.values, ...list.slice(position)]; }
      case "remove": { return [...list.slice(0, position), ...list.slice(position + change.count)]; }
      case "overwrite": {
        return [...list.slice(0, position), ...change.values, ...list.slice(position + change.values.length)];
      }
      case "rebuild": { return [...change.values]; }
      default: { return list.map((value) => (typeof value === "string" ? `${value}!` : value)); }
    }
  };

  const makeDoc = (initial: unknown[], disableYText: boolean) => {
    const doc = new yjs.Doc();

    doc.clientID = 1;

    const map = doc.getMap("shelf");

    map.set("list", arrayToYArray(initial, { disableYText }));

    return { doc, "list": () => map.get("list") as yjs.Array<unknown>, map };
  };

  describe.each([
    ["disableYText, legacy", true, false],
    ["disableYText, scopedDiff", true, true],
    ["Y.Text strings, legacy", false, false],
    ["Y.Text strings, scopedDiff", false, true],
  ])("%s", (unusedLabel, disableYText, isScopedDiff) => {
    it("matches byte for byte after every patch (property)", () => {
      fc.assert(
        fc.property(initialList, steps, (initial, sequence) => {
          const runs = makeDoc(initial, disableYText);
          const elementWise = makeDoc(initial, disableYText);
          const remote = new yjs.Doc();
          let state: unknown[] = initial;

          remote.clientID = 2;
          yjs.applyUpdate(remote, yjs.encodeStateAsUpdate(runs.doc));

          for (const { edit: change, remote: remoteChange } of sequence) {
            if (remoteChange !== undefined) {
              const remoteList = remote.getMap("shelf").get("list") as yjs.Array<unknown>;
              const vector = yjs.encodeStateVector(remote);
              const position = Math.floor((remoteList.length * remoteChange.at) / 100);

              if (remoteChange.isInsert || remoteList.length === 0) {
                remoteList.insert(position, [7, 8]);
              } else {
                remoteList.delete(Math.min(position, remoteList.length - 1));
              }

              const update = yjs.encodeStateAsUpdate(remote, vector);

              yjs.applyUpdate(runs.doc, update);
              yjs.applyUpdate(elementWise.doc, update);

              if (remoteChange.isSeen) {
                state = runs.list().toJSON() as unknown[];
              }
            }

            const next = applyEdit(state, change);
            const previous = state;

            runs.doc.transact(() => {
              if (isScopedDiff) {
                patchSharedTypeScoped(runs.map, { "list": next }, { "list": previous }, { disableYText });
              } else {
                patchSharedType(runs.map, { "list": next }, { disableYText });
              }
            });
            elementWise.doc.transact(() => {
              const list = elementWise.list();
              const changes = getChanges(
                list.toJSON() as unknown[],
                next,
                isScopedDiff ? { "previousA": previous } : {}
              );

              applyElementWise(list, changes, next, isScopedDiff ? previous : undefined, disableYText);
            });
            yjs.applyUpdate(remote, yjs.encodeStateAsUpdate(runs.doc, yjs.encodeStateVector(remote)));

            expect(yjs.encodeStateAsUpdate(elementWise.doc)).toEqual(yjs.encodeStateAsUpdate(runs.doc));

            // Behind an unseen remote edit, the Y.Map delete guard may keep a
            // key (by design), so only a fresh previous state must reach `next`.
            if (remoteChange?.isSeen !== false) {
              expect(runs.list().toJSON()).toEqual(next);
            }

            // The inbound patch settles: state mirrors the doc again.
            state = runs.list().toJSON() as unknown[];
          }
        }),
        { "numRuns": 100 }
      );
    });
  });
});
