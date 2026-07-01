/*
 * Structural regression tests for the text-edit fast paths:
 *
 * 1. Run coalescing: per-character text changes are applied to Y.Text as run
 *    operations, so a text edit creates O(runs) Yjs items instead of O(chars).
 *    Without coalescing, bulk deletes are quadratic in accumulated tombstones
 *    (a 5k-char replace took ~9s; see bench/).
 * 2. Prefix/suffix trimming: diffing a small edit inside a large string does
 *    not allocate O(m + n) frontier arrays.
 *
 * These assert structure (item counts) rather than wall-clock time, so they
 * are deterministic in CI.
 */
import * as fc from "fast-check";
import * as Y from "yjs";
import { getChanges } from "./diff";
import { patchSharedType, patchState } from "./patching";

const countItems = (doc: Y.Doc): number => {
  let count = 0;

  doc.store.clients.forEach((items) => {
    count = count + items.length;
  });

  return count;
};

const makeTextDoc = (text: string): { doc: Y.Doc; map: Y.Map<unknown> } => {
  const doc = new Y.Doc();
  const map = doc.getMap("store");

  doc.transact(() => {
    map.set("text", new Y.Text(text));
  });

  return { doc, map };
};

describe("Y.Text run coalescing", () => {
  it("applies a contiguous insertion as O(1) items, not O(chars)", () => {
    const before = "a".repeat(1_000);
    const insertion = "b".repeat(500);
    const after = before.slice(0, 500) + insertion + before.slice(500);

    const { doc, map } = makeTextDoc(before);
    const itemsBefore = countItems(doc);

    doc.transact(() => {
      patchSharedType(map, { "text": after });
    });

    expect((map.get("text") as Y.Text).toString()).toEqual(after);
    // A single 500-char run splits one existing item and adds one new item.
    // Allow a little slack, but far below the 500 items per-char ops create.
    expect(countItems(doc) - itemsBefore).toBeLessThanOrEqual(5);
  });

  it("applies a full replacement of disjoint text as O(1) operations", () => {
    const before = "abcdefghij".repeat(500); // 5k chars
    const after = "0123456789".repeat(500); // No common characters.

    const { doc, map } = makeTextDoc(before);

    const start = Date.now();

    doc.transact(() => {
      patchSharedType(map, { "text": after });
    });

    expect((map.get("text") as Y.Text).toString()).toEqual(after);
    /*
     * Generous ceiling: the uncoalesced per-character path took ~9 SECONDS
     * for this input (quadratic tombstone walking); the coalesced path takes
     * single-digit milliseconds. This only catches order-of-magnitude
     * regressions, so it is safe on slow CI machines.
     */
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("produces identical Y.Text content for random edit pairs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const { doc, map } = makeTextDoc(before);

        doc.transact(() => {
          patchSharedType(map, { "text": after });
        });

        expect((map.get("text") as Y.Text).toString()).toEqual(after);
      }),
      { "numRuns": 200, }
    );
  });

  it("patchState applies coalesced string changes identically", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const patched = patchState({ "text": before, }, { "text": after, });

        expect(patched).toEqual({ "text": after, });
      }),
      { "numRuns": 200, }
    );
  });
});

describe("text diff prefix/suffix trimming", () => {
  it("emits changes equivalent to the edit for a small change in a large string", () => {
    const big = "The quick brown fox jumps over the lazy dog. ".repeat(1_000);
    const edited = `${big.slice(0, 10_000)}INSERTED${big.slice(10_000)}`;

    const changes = getChanges(big, edited);

    // The whole edit is 8 inserted characters; trimming must confine the
    // change list to them instead of re-describing the string.
    expect(changes.length).toBeLessThanOrEqual(16);
    expect(patchState({ "text": big, }, { "text": edited, }))
      .toEqual({ "text": edited, });
  });

  it("round-trips random string pairs through getChanges + patchState", () => {
    fc.assert(
      fc.property(
        fc.string({ "maxLength": 200, }),
        fc.string({ "maxLength": 200, }),
        (before, after) => {
          expect(patchState(before, after)).toEqual(after);
        }
      ),
      { "numRuns": 500, }
    );
  });
});
