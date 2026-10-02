/*
 * Observer cost of reading `event.path` on edits inside arrays.
 *
 * Yjs' `YEvent.path` getter is not cached: every read runs getPathTo, which,
 * for each array ancestor of the changed type, walks the parent's item list
 * from its start up to the child — tombstones included. The inbound observer
 * reads `event.path` several times per event (scopedDiff: 3; scopedDiff +
 * scope: 7; scope alone: 2 in touchesScope) and then cuts the path at its
 * first array index anyway (truncateAtArrayIndex), so it pays O(index) per
 * read for a number it throws away. A catch-up of many in-place edits to the
 * elements of a large object array (a list of annotations or bookmarks)
 * therefore costs O(events x reads x array length) in the synchronous
 * observer phase, and keeps growing as the array ages.
 *
 * Cost measure (deterministic): `Item#deleted` getter calls during the
 * synchronous `applyUpdate` phase. getPathTo checks it once for every item it
 * walks past, so it counts list items visited. Yjs' own work (integration,
 * and in a merged update the deep-event sort by `path.length`) is factored out
 * by subtracting the count of a bare doc receiving the same updates; what is
 * left is what the middleware's observer adds. `YEvent#path` reads are
 * counted the same way, across the batching microtask as well, so moving
 * the reads out of the observer would not escape the count.
 *
 * The observer computes paths with getEventPathWithoutIndices instead, which
 * relies on Yjs internals (`_item`, `parent`, `parentSub`); a property below
 * pins it to `event.path` so a Yjs upgrade that changes them fails here.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, {
  __scopedDiffDevSampling,
  getYjsStoreHandle,
  type YjsOptions,
} from ".";
import { getEventPathWithoutIndices, truncateAtArrayIndex, UNCOUNTED_ARRAY_INDEX } from "./patching";

interface Annotation { id: string; color: string; note: string }
interface AnnotationsState { annotations: Annotation[]; revision: number }

const MAP_NAME = "annotations";
const EDITS = 20;
const SMALL = 200;
const LARGE = 800;
/**
 * O(depth) per event is the expected cost; this leaves room for a few O(1)
 * reads per event (e.g. the schema-version `map.get`) without admitting
 * anything that grows with the array.
 */
const MAX_VISITS_PER_EVENT = 8;

interface Source {
  snapshot: Uint8Array;
  updates: Uint8Array[];
  merged: Uint8Array;
  expected: unknown;
}

/**
 * Sender: the middleware writes the initial array (so the layout is exactly
 * the middleware's); tombstones are elements deleted evenly through the
 * array; each edit is one transaction rewriting two fields of one element.
 */
const buildSource = (live: number, tombstones: number, scope?: { key: string }): Source => {
  const doc = new yjs.Doc();
  const total = live + tombstones;
  const store = createStore<AnnotationsState>()(
    yjsMiddleware(
      doc,
      MAP_NAME,
      (): AnnotationsState => ({
        "annotations": Array.from({ "length": total }, (unused, index) => ({
          "id": `a${String(index)}`, "color": "yellow", "note": `note ${String(index)}`,
        })),
        "revision": 0,
      }),
      { "disableYText": true, "scopedDiff": true, scope }
    )
  );

  store.setState({ "revision": 1 });
  getYjsStoreHandle(store).flush();

  const rootMap = doc.getMap(MAP_NAME);
  const dataMap = scope === undefined ? rootMap : rootMap.get(scope.key) as yjs.Map<unknown>;
  const array = dataMap.get("annotations") as yjs.Array<yjs.Map<unknown>>;

  if (tombstones > 0) {
    const stride = total / tombstones;

    doc.transact(() => {
      for (let index = tombstones - 1; index >= 0; index = index - 1) {
        array.delete(Math.floor(index * stride), 1);
      }
    });
  }

  expect(array.length).toBe(live);

  const snapshot = yjs.encodeStateAsUpdate(doc);
  const updates: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array): void => { updates.push(update); };

  doc.on("update", onUpdate);

  for (let edit = 0; edit < EDITS; edit = edit + 1) {
    // 7919 is prime: distinct elements spread over the whole array.
    const element = array.get((edit * 7_919) % live);

    doc.transact(() => {
      element.set("color", `color-${String(edit)}`);
      element.set("note", `edited ${String(edit)}`);
    });
  }

  doc.off("update", onUpdate);

  return {
    snapshot,
    updates,
    "merged": yjs.mergeUpdates(updates),
    "expected": dataMap.toJSON().annotations,
  };
};

interface CatchUpCost {
  /** `Item#deleted` reads during the synchronous applyUpdate phase. */
  itemVisits: number;
  /** `YEvent#path` reads during applyUpdate AND the batching microtask. */
  pathReads: number;
}

/**
 * Cost of applying `source`'s catch-up to a fresh receiver (a bare doc when
 * `options` is undefined), one update per remote transaction or as one
 * merged update. Item visits stop at the end of the synchronous phase (the
 * store patch serializes the array, which reads every item); path reads
 * cover the drained microtask too. A receiving store must also converge, so
 * the count is never taken over a run that skipped work.
 */
const countCatchUpCost = async (
  source: Source,
  options: YjsOptions | undefined,
  merged: boolean
): Promise<CatchUpCost> => {
  const doc = new yjs.Doc();

  yjs.applyUpdate(doc, source.snapshot);

  let store: StoreApi<AnnotationsState> | undefined;

  if (options !== undefined) {
    store = createStore<AnnotationsState>()(
      yjsMiddleware(doc, MAP_NAME, (): AnnotationsState => ({ "annotations": [], "revision": 0 }), options)
    );
  }

  const pathSpy = jest.spyOn(yjs.YEvent.prototype, "path", "get");
  const deletedSpy = jest.spyOn(yjs.Item.prototype, "deleted", "get");
  let itemVisits: number;

  try {
    for (const update of merged ? [source.merged] : source.updates) {
      yjs.applyUpdate(doc, update);
    }

    itemVisits = deletedSpy.mock.calls.length;
  } finally {
    deletedSpy.mockRestore();
  }

  try {
    await Promise.resolve();
    await Promise.resolve();

    return { itemVisits, "pathReads": pathSpy.mock.calls.length };
  } finally {
    pathSpy.mockRestore();

    if (store !== undefined) {
      expect(store.getState().annotations).toStrictEqual(source.expected);
    }
  }
};

/** What the middleware's observer adds over a bare doc for the same catch-up. */
const observerCost = async (
  source: Source,
  options: YjsOptions,
  merged = false
): Promise<CatchUpCost> => {
  const receiver = await countCatchUpCost(source, options, merged);
  const bare = await countCatchUpCost(source, undefined, merged);

  return {
    "itemVisits": receiver.itemVisits - bare.itemVisits,
    "pathReads": receiver.pathReads - bare.pathReads,
  };
};

describe("inbound observer: event-path cost on edits inside arrays", () => {
  let previousRate: number;

  beforeAll(() => {
    previousRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterAll(() => {
    __scopedDiffDevSampling.rate = previousRate;
  });

  const scope = { "key": "device-0" };

  it.each<[string, YjsOptions, { key: string } | undefined]>([
    ["scopedDiff", { "disableYText": true, "scopedDiff": true }, undefined],
    ["scopedDiff + scope", { "disableYText": true, "scopedDiff": true, scope }, scope],
    ["scope (legacy diff)", { "disableYText": true, scope }, scope],
  ])(
    "%s: a catch-up of separate remote transactions visits O(1) list items per event, " +
    "independent of array length",
    async (label, options, sourceScope) => {
      const small = await observerCost(buildSource(SMALL, 0, sourceScope), options);
      const large = await observerCost(buildSource(LARGE, 0, sourceScope), options);

      // 4x the elements must not mean 4x the observer work...
      expect(large.itemVisits).toBeLessThanOrEqual(small.itemVisits * 1.5);
      // ...and the per-event work is bounded by the path depth, not the index.
      expect(large.itemVisits).toBeLessThanOrEqual(EDITS * MAX_VISITS_PER_EVENT);
      // No `event.path` reads beyond Yjs' own, in the observer or later.
      expect(small.pathReads).toBeLessThanOrEqual(0);
      expect(large.pathReads).toBeLessThanOrEqual(0);
    }
  );

  it("tombstones in an aged array do not add observer work", async () => {
    const options: YjsOptions = { "disableYText": true, "scopedDiff": true };
    const fresh = await observerCost(buildSource(SMALL, 0), options);
    const aged = await observerCost(buildSource(SMALL, 3 * SMALL), options);

    expect(aged.itemVisits).toBeLessThanOrEqual(fresh.itemVisits * 1.5);
    expect(aged.itemVisits).toBeLessThanOrEqual(EDITS * MAX_VISITS_PER_EVENT);
    expect(aged.pathReads).toBeLessThanOrEqual(0);
  });

  it("a single merged update (many events in one transaction) adds O(1) work per event", async () => {
    const options: YjsOptions = { "disableYText": true, "scopedDiff": true };
    const small = await observerCost(buildSource(SMALL, 0), options, true);
    const large = await observerCost(buildSource(LARGE, 0), options, true);

    expect(large.itemVisits).toBeLessThanOrEqual(small.itemVisits * 1.5);
    expect(large.itemVisits).toBeLessThanOrEqual(EDITS * MAX_VISITS_PER_EVENT);
    expect(large.pathReads).toBeLessThanOrEqual(0);
  });
});

/**
 * One remote-style edit to a live container of the tree, picked by index
 * (modulo the containers alive at that point) so every generated value
 * applies to whatever the earlier steps built.
 */
type PathEdit =
  | { op: "set"; target: number; key: string; kind: "map" | "array" | "value" }
  | { op: "deleteKey"; target: number; key: string }
  | { op: "insert"; target: number; at: number; kind: "map" | "array" | "values" }
  | { op: "remove"; target: number; at: number; count: number };

const editKeys = fc.constantFrom("a", "b", "c");
const pathEdit: fc.Arbitrary<PathEdit> = fc.oneof(
  fc.record({
    "op": fc.constant("set" as const),
    "target": fc.nat(),
    "key": editKeys,
    "kind": fc.constantFrom("map" as const, "array" as const, "value" as const),
  }),
  fc.record({ "op": fc.constant("deleteKey" as const), "target": fc.nat(), "key": editKeys }),
  fc.record({
    "op": fc.constant("insert" as const),
    "target": fc.nat(),
    "at": fc.nat(),
    "kind": fc.constantFrom("map" as const, "array" as const, "values" as const),
  }),
  fc.record({
    "op": fc.constant("remove" as const),
    "target": fc.nat(),
    "at": fc.nat(),
    "count": fc.integer({ "min": 1, "max": 3 }),
  })
);

type Container = yjs.Map<unknown> | yjs.Array<unknown>;

/** Every live Y.Map / Y.Array at or below `type`, depth first. */
const liveContainers = (type: Container): Container[] => {
  const children: unknown[] = type instanceof yjs.Map ? [...type.values()] : type.toArray();
  const nested = children.flatMap((child) =>
    child instanceof yjs.Map || child instanceof yjs.Array ? liveContainers(child as Container) : []);

  return [type, ...nested];
};

const yMap = (entries: Record<string, unknown>): yjs.Map<unknown> => {
  const map = new yjs.Map<unknown>();

  for (const [key, value] of Object.entries(entries)) {
    map.set(key, value);
  }

  return map;
};

const yArray = (items: unknown[]): yjs.Array<unknown> => {
  const array = new yjs.Array<unknown>();

  array.push(items);

  return array;
};

/**
 * The starting tree: arrays at depth 1 and deeper, arrays inside arrays,
 * primitives sharing an Item before containers, and a nested map that gets
 * its own deep observer (a scoped store's data map).
 */
const seedTree = (root: yjs.Map<unknown>): void => {
  root.set("list", yArray([
    yMap({ "a": 1, "tags": yArray([1, 2]) }),
    yArray([yMap({ "a": 1 }), yArray([yMap({ "a": 1 })])]),
    5,
    6,
    yMap({ "inner": yMap({ "deepList": yArray([yMap({ "a": 1 })]) }) }),
  ]));
  root.set("scoped", yMap({
    "items": yArray([yMap({ "a": 1, "sub": yArray([yMap({ "a": 1 })]) }), yMap({ "a": 1 })]),
    "meta": yMap({ "x": 1 }),
  }));
};

const newChild = (kind: "map" | "array"): Container =>
  (kind === "map" ? yMap({ "a": 1 }) : yArray([1, 2]));

const applyPathEdit = (root: yjs.Map<unknown>, edit: PathEdit): void => {
  const containers = liveContainers(root);
  const target = containers[edit.target % containers.length];

  if (target instanceof yjs.Map) {
    // Edit keys never name the seeded branches ("list", "scoped").
    if (edit.op === "set") {
      target.set(edit.key, edit.kind === "value" ? edit.target : newChild(edit.kind));
    } else if (edit.op === "deleteKey") {
      target.delete(edit.key);
    } else {
      target.set("touched", edit.target);
    }
  } else {
    if (edit.op === "insert") {
      // Several primitives in one insert share an Item, which getPathTo counts
      // as one position: placeholders must not care.
      target.insert(
        edit.at % (target.length + 1),
        edit.kind === "values" ? [edit.at, edit.at + 1, edit.at + 2] : [newChild(edit.kind)]
      );
    } else if (edit.op === "remove" && target.length > 0) {
      const at = edit.at % target.length;

      target.delete(at, Math.min(edit.count, target.length - at));
    } else {
      target.push([edit.target]);
    }
  }
};

interface PathSample {
  path: (string | number)[];
  withoutIndices: readonly (string | number)[];
}

describe("getEventPathWithoutIndices", () => {
  it("matches event.path with array indices replaced, on random nested map/array edits", () => {
    let samples = 0;
    let withArray = 0;
    let arrayInArray = 0;
    let deep = 0;

    fc.assert(
      fc.property(
        fc.array(fc.array(pathEdit, { "minLength": 1, "maxLength": 3 }), { "minLength": 1, "maxLength": 25 }),
        (transactions) => {
          const sender = new yjs.Doc();
          const receiver = new yjs.Doc();
          const seen: PathSample[] = [];
          const record = (events: yjs.YEvent<yjs.AbstractType<unknown>>[]): void => {
            for (const event of events) {
              seen.push({ "path": event.path, "withoutIndices": getEventPathWithoutIndices(event) });
            }
          };

          sender.on("update", (update: Uint8Array) => { yjs.applyUpdate(receiver, update); });
          seedTree(sender.getMap("root"));

          // Root observers on both docs, plus a nested (scoped) root, so the
          // walk is checked against currentTarget below the doc root too.
          for (const doc of [sender, receiver]) {
            const root = doc.getMap("root");

            root.observeDeep(record);
            (root.get("scoped") as yjs.Map<unknown>).observeDeep(record);
          }

          for (const edits of transactions) {
            sender.transact(() => {
              for (const edit of edits) {
                applyPathEdit(sender.getMap("root"), edit);
              }
            });
          }

          expect(receiver.getMap("root").toJSON()).toStrictEqual(sender.getMap("root").toJSON());

          for (const { path, withoutIndices } of seen) {
            expect(withoutIndices).toStrictEqual(
              path.map((step) => (typeof step === "number" ? UNCOUNTED_ARRAY_INDEX : step))
            );
            expect(truncateAtArrayIndex(withoutIndices)).toStrictEqual(truncateAtArrayIndex(path));
            expect(truncateAtArrayIndex(withoutIndices.slice(1)))
              .toStrictEqual(truncateAtArrayIndex(path.slice(1)));
          }

          const indexCounts = seen.map(({ path }) => path.filter((step) => typeof step === "number").length);

          samples = samples + seen.length;
          withArray = withArray + indexCounts.filter((count) => count >= 1).length;
          arrayInArray = arrayInArray + indexCounts.filter((count) => count >= 2).length;
          deep = deep + seen.filter(({ path }) => path.length >= 3).length;
        }
      ),
      { "numRuns": 300 }
    );

    // The generator must actually reach paths through arrays (nested ones
    // too) and deep paths, not just root-map events.
    expect(samples).toBeGreaterThan(2_000);
    expect(withArray).toBeGreaterThan(1_000);
    expect(arrayInArray).toBeGreaterThan(500);
    expect(deep).toBeGreaterThan(1_000);
  });
});

describe("inbound observer: a scope key holding an array (degenerate doc)", () => {
  it("edits inside its elements leave the store untouched and do not throw", async () => {
    interface Degenerate { label: string }
    const doc = new yjs.Doc();
    const remote = new yjs.Doc();

    remote.on("update", (update: Uint8Array) => { yjs.applyUpdate(doc, update); });

    const elements = new yjs.Array<yjs.Map<unknown>>();

    remote.getMap(MAP_NAME).set("device-0", elements);
    elements.push([new yjs.Map<unknown>(), new yjs.Map<unknown>()]);

    const store = createStore<Degenerate>()(
      yjsMiddleware(doc, MAP_NAME, (): Degenerate => ({ "label": "local" }), {
        "scope": { "key": "device-0" },
        "scopedDiff": true,
      })
    );

    elements.get(1).set("label", "remote");
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState()).toStrictEqual({ "label": "local" });
  });
});
