/*
 * Inbound doc-JSON sanitize walk: per-leaf cost.
 *
 * Every inbound doc read that feeds store state (creation hydration, the
 * key-scoped and legacy inbound routes, deep-path reads) runs the sanitize
 * check (isSafeDocJson via sanitizeDocJson) over the whole JSON Yjs's
 * toJSON() produced. The walk recursed into EVERY node — including primitive
 * leaves, which outnumber containers ~5:1 in a versicle-shaped tree — and
 * allocated an `.every` closure per array and record. On a cold start that is
 * a second full pass over the store's data on top of toJSON() (~16% of
 * end-to-end hydration at 120 books, see bench "cold-start/versicle").
 *
 * The walk only has something to check on objects (prototype, dangerous
 * keys); a primitive leaf needs no visit beyond a `typeof` test by its
 * parent. These tests pin that with a deterministic counter instead of
 * timing: with the container shape held fixed, quadrupling the number of
 * primitive leaves must not multiply the walk's per-node type dispatch
 * (Array.isArray calls), whose count is the observable symptom of visiting a
 * node. On the walk that recurses into leaves it grows ~3x; on a walk that
 * only recurses into objects it stays flat.
 *
 * Correctness of the sanitize semantics themselves is covered by
 * proto-injection-inbound.spec, prototype-named-keys.spec and
 * plain-json-doc-values.spec.
 */
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling } from ".";
import { computeInboundState } from "./patching";

const RECORDS = 25;
const FEW_LEAVES = 4;
const MANY_LEAVES = FEW_LEAVES * 4;

/**
 * Leaf growth must not show up in the walk's dispatch count. A walk that
 * visits leaves scales ~3x here; one that does not stays at 1.0. The bound
 * leaves room for a constant per-container overhead.
 */
const MAX_DISPATCH_GROWTH = 1.25;

let savedSamplingRate = 0;

beforeAll(() => {
  savedSamplingRate = __scopedDiffDevSampling.rate;
  // The DEV tripwire re-serializes at random; keep counts deterministic.
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = savedSamplingRate;
});

/**
 * Plain doc JSON with a FIXED container shape (one root, one `items`
 * record, RECORDS records each holding one array) and `leaves` primitive
 * leaves per record plus `leaves` primitive elements per array.
 */
const makeJson = (leaves: number): Record<string, unknown> => {
  const items: Record<string, unknown> = {};

  for (let record = 0; record < RECORDS; record = record + 1) {
    const entry: Record<string, unknown> = {};

    for (let leaf = 0; leaf < leaves; leaf = leaf + 1) {
      entry[`f${String(leaf)}`] = leaf % 2 === 0 ? leaf : `v${String(leaf)}`;
    }
    entry.tags = Array.from({ "length": leaves }, (unused, index) => `t${String(index)}`);
    items[`r${String(record)}`] = entry;
  }

  return { items };
};

/** The same shape materialized as nested Y types inside a populated doc. */
const makePopulatedDoc = (leaves: number): yjs.Doc => {
  const doc = new yjs.Doc();
  const root = doc.getMap("store");
  const json = makeJson(leaves);

  doc.transact(() => {
    const items = new yjs.Map<unknown>();

    root.set("items", items);
    for (const [recordKey, recordValue] of Object.entries(json.items as Record<string, Record<string, unknown>>)) {
      const entry = new yjs.Map<unknown>();

      items.set(recordKey, entry);
      for (const [field, value] of Object.entries(recordValue)) {
        if (Array.isArray(value)) {
          const tags = new yjs.Array<unknown>();

          entry.set(field, tags);
          tags.push(value);
        } else {
          entry.set(field, value);
        }
      }
    }
  });

  return doc;
};

/** Counts Array.isArray calls made while `run` executes. */
const countTypeDispatch = (run: () => void): number => {
  const spy = jest.spyOn(Array, "isArray");

  try {
    run();

    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
};

interface ItemsState { items: Record<string, unknown> }

describe("inbound sanitize walk does not visit primitive leaves", () => {
  it("computeInboundState on an empty branch (the cold-start patch): dispatch is flat in leaf count", () => {
    const syncedKeys = new Set(["items"]);
    const hydrate = (leaves: number) => {
      const json = makeJson(leaves);
      let next: ItemsState | undefined;
      const calls = countTypeDispatch(() => {
        next = computeInboundState<ItemsState>({ "items": {} }, json, { syncedKeys });
      });

      // Sanity: the patch really materialized the whole branch.
      expect(Object.keys(next?.items ?? {})).toHaveLength(RECORDS);

      return calls;
    };

    const few = hydrate(FEW_LEAVES);
    const many = hydrate(MANY_LEAVES);

    // 4x the primitive leaves, same containers: the dispatch count must not follow.
    expect(many).toBeLessThanOrEqual(Math.floor(few * MAX_DISPATCH_GROWTH));
  });

  it.each([
    ["legacy", false],
    ["scopedDiff", true],
  ])("creation hydration from a populated doc (%s): dispatch is flat in leaf count", (unused, scopedDiff) => {
    const hydrate = (leaves: number) => {
      const doc = makePopulatedDoc(leaves);
      let store: StoreApi<ItemsState> | undefined;
      const calls = countTypeDispatch(() => {
        store = createStore<ItemsState>()(
          yjsMiddleware(doc, "store", () => ({ "items": {} }), { "disableYText": true, scopedDiff })
        );
      });

      // Sanity: hydration really materialized the doc into the store.
      expect(store?.getState().items).toEqual(makeJson(leaves).items);

      return calls;
    };

    const few = hydrate(FEW_LEAVES);
    const many = hydrate(MANY_LEAVES);

    expect(many).toBeLessThanOrEqual(Math.floor(few * MAX_DISPATCH_GROWTH));
  });
});
