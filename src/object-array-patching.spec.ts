/*
 * Regression tests for object/array patching:
 *
 * 1. Inbound array delete application. getArrayChanges emits delete indices
 *    in sequential post-application coordinates (the interpretation the
 *    Y.Array applier uses). applyChangesToArray used to apply all deletes
 *    first in DESCENDING index order — an original-coordinate assumption that
 *    corrupted any change list mixing lookahead deletes with trailing deletes
 *    (patching [1, 2, 3] toward [2] produced [3]), silently diverging the
 *    Zustand store from the Yjs doc on inbound sync.
 * 2. Y.Array delete-run coalescing: clearing/shrinking a large array must be
 *    range deletes, not N single deletes that walk an ever-growing tombstone
 *    chain (quadratic; a 5k-element clear took ~2.3s).
 * 3. Precomputed-JSON threading: patching a deep nested map must serialize
 *    each subtree once, not once per ancestor level.
 */
import * as fc from "fast-check";
import * as Y from "yjs";
import { patchSharedType, patchState } from "./patching";

const makeDoc = (state: Record<string, unknown>): { doc: Y.Doc; map: Y.Map<unknown> } => {
  const doc = new Y.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    patchSharedType(map, state, { "disableYText": true, });
  });

  return { doc, map };
};

describe("inbound array patching (evolving-index application)", () => {
  it.each([
    [[1, 2, 3], [2]],
    [[1, 2, 3, 4], [2]],
    [[1, 2, 3, 4, 5], [3, 5]],
    [["a", "b", "c"], ["b"]],
    [[1, 2, 3, 4, 5], []],
    [[1, 1, 2, 1, 1], [2]]
  ])(
    "patches %j toward %j",
    (before, after) => {
      expect(patchState({ "list": before, }, { "list": after, }))
        .toEqual({ "list": after, });
    }
  );

  it("agrees with the Y.Array applier for random overlapping arrays", () => {
    // Small value range on purpose: collisions exercise the lookahead paths
    // (mixed matches, block deletes, trailing deletes) that plain random
    // values almost never hit.
    const smallArray = fc.array(fc.integer({ "min": 0, "max": 5, }), { "maxLength": 10, });

    fc.assert(
      fc.property(smallArray, smallArray, (before, after) => {
        // Inbound path: plain state array.
        expect(patchState({ "list": before, }, { "list": after, }))
          .toEqual({ "list": after, });

        // Outbound path: Y.Array in a doc.
        const { doc, map } = makeDoc({ "list": before, });

        doc.transact(() => {
          patchSharedType(map, { "list": after, }, { "disableYText": true, });
        });

        expect(map.toJSON()).toEqual({ "list": after, });
      }),
      { "numRuns": 500, }
    );
  });

  it("agrees with the Y.Array applier for random nested structures", () => {
    const element = fc.oneof(
      fc.integer({ "min": 0, "max": 3, }),
      fc.record({ "id": fc.integer({ "min": 0, "max": 3, }), }),
      fc.array(fc.integer({ "min": 0, "max": 3, }), { "maxLength": 3, })
    );
    const nestedArray = fc.array(element, { "maxLength": 8, });

    fc.assert(
      fc.property(nestedArray, nestedArray, (before, after) => {
        expect(patchState({ "list": before, }, { "list": after, }))
          .toEqual({ "list": after, });

        const { doc, map } = makeDoc({ "list": before, });

        doc.transact(() => {
          patchSharedType(map, { "list": after, }, { "disableYText": true, });
        });

        expect(map.toJSON()).toEqual({ "list": after, });
      }),
      { "numRuns": 300, }
    );
  });
});

describe("Y.Array delete-run coalescing", () => {
  it("clears a large array without quadratic tombstone walking", () => {
    const SIZE = 5_000;
    const numbers = Array.from({ "length": SIZE, }, (unused, index) => index);
    const { doc, map } = makeDoc({ "list": numbers, });

    const start = Date.now();

    doc.transact(() => {
      patchSharedType(map, { "list": [], }, { "disableYText": true, });
    });

    expect(map.toJSON()).toEqual({ "list": [], });
    /*
     * Generous ceiling: the uncoalesced per-element path took ~2.3 SECONDS
     * (quadratic in accumulated tombstones); the coalesced path is
     * single-digit milliseconds. Catches order-of-magnitude regressions only.
     */
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("removes a middle block as a range", () => {
    const numbers = Array.from({ "length": 1_000, }, (unused, index) => index);
    const shrunk = [...numbers.slice(0, 400), ...numbers.slice(600)];
    const { doc, map } = makeDoc({ "list": numbers, });

    doc.transact(() => {
      patchSharedType(map, { "list": shrunk, }, { "disableYText": true, });
    });

    expect(map.toJSON()).toEqual({ "list": shrunk, });
  });
});

describe("precomputed-JSON threading through nested maps", () => {
  it("serializes each subtree once when patching a deep leaf", () => {
    const DEPTH = 10;
    const makeDeep = (leaf: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf, };

      for (let level = 0; level < DEPTH; level = level + 1) {
        node = { "child": node, "sibling": level, };
      }

      return node;
    };

    const { doc, map } = makeDoc(makeDeep(1));

    const toJsonSpy = jest.spyOn(Y.Map.prototype, "toJSON");

    try {
      doc.transact(() => {
        patchSharedType(map, makeDeep(2), { "disableYText": true, });
      });

      expect(map.toJSON()).toEqual(makeDeep(2));

      /*
       * One full serialization of the tree is DEPTH + 1 nested toJSON calls
       * (the root's toJSON recurses into each level), plus the verification
       * call above (another DEPTH + 1). Without threading, every pending
       * level re-serializes its subtree: O(DEPTH^2 / 2) extra calls (~65 for
       * DEPTH 10). Anything near that means the threading regressed.
       */
      expect(toJsonSpy.mock.calls.length).toBeLessThanOrEqual(2 * (DEPTH + 1) + 2);
    } finally {
      toJsonSpy.mockRestore();
    }
  });
});
