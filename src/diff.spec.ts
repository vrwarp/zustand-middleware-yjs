import * as fc from "fast-check";
import { type Change, changeType, } from "./types";
import { getChanges, isDeepEqualForDiff, } from "./diff";

describe("getChanges", () => {
  describe("When given objects", () => {
    it.each([
      [{}],
      [{ "foo": 1, }],
      [{ "foo": null, }], // See GitHub Issue #32
      [{ "foo": undefined, }], // See GitHub Issue #32
      [{ "foo": { "bar": 1, }, }]
    ])(
      "Returns an empty list for two identical objects.",
      (a) => {
        expect(getChanges(a, a)).toStrictEqual([]);
      }
    );

    it.each([
      [
        {},
        { "foo": 1, },
        [
          [changeType.insert, "foo", 1]
        ]
      ],
      [
        { "foo": 1, },
        {},
        [
          [changeType.delete, "foo", undefined]
        ]
      ],
      [
        { "foo": 1, },
        { "foo": 2, },
        [
          [changeType.update, "foo", 2]
        ]
      ],
      [
        { "foo": 1, },
        { "bar": 1, },
        [
          [changeType.delete, "foo", undefined],
          [changeType.insert, "bar", 1]
        ]
      ],
      [
        { "foo": 1, "bar": 3, },
        { "foo": 1, "bar": 2, },
        [
          [changeType.update, "bar", 2]
        ]
      ],
      [
        { "foo": 1, },
        { "foo": "a", },
        [
          [changeType.update, "foo", "a"]
        ]
      ],
      [
        { "foo": "a", },
        { "foo": "", },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.delete, 0, undefined]
            ]
          ]
        ]
      ],
      [
        { "foo": "a", },
        { "foo": "b", },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.delete, 0, undefined],
              [changeType.insert, 0, "b"]
            ]
          ]
        ]
      ],
      [
        { "foo": "ab", },
        { "foo": "bc", },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.delete, 0, undefined],
              [changeType.insert, 1, "c"]
            ]
          ]
        ]
      ],
      [
        { "foo": [1], },
        { "foo": [2], },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.update, 0, 2]
            ]
          ]
        ]
      ],
      [
        { "foo": [1, 2], },
        { "foo": [2, 2], },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.update, 0, 2]
            ]
          ]
        ]
      ],
      [
        { "foo": [1, 2, 2], },
        { "foo": [1, 2, 3], },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.update, 2, 3]
            ]
          ]
        ]
      ],
      [
        { "foo": [1, 2, 2], },
        { "foo": [1, 2], },
        [
          [
            changeType.pending,
            "foo",
            [
              [changeType.delete, 2, undefined]
            ]
          ]
        ]
      ]
    ])(
      "Returns a change list for objects",
      (a, b, changes) => {
        expect(getChanges(a, b)).toStrictEqual(changes);
      }
    );

    it("Ignores properties whose values are functions", () => {
      const a = {
        "foo": () =>
          1,
      };

      const b = {};

      expect(getChanges(a, b)).toStrictEqual([]);
    });
  });

  describe("When given arrays", () => {
    it.each([
      [[1, 2, 3]],
      [[null, null, null]], // See GitHub Issue #32
      [[{ "foo": 1, }]]
    ])("Returns an empty list for identical arrays", (a) => {
      expect(getChanges(a, a)).toStrictEqual([]);
    });

    it.each([
      [
        [1, 2, 3],
        [1, 2],
        [
          [changeType.delete, 2, undefined]
        ]
      ],
      [
        [1, 2],
        [1, 2, 3],
        [
          [changeType.insert, 2, 3]
        ]
      ],
      [
        [1, 3],
        [1, 2, 3],
        [
          [changeType.insert, 1, 2]
        ]
      ],
      [
        [0, 2, 3],
        [1, 2, 3],
        [
          [changeType.update, 0, 1]
        ]
      ],
      /*
       * A repeated value in A used to confuse the look ahead: B's position 2
       * (3) matches A's position 1 (3), which reads as "2 was inserted in
       * front of the 3", after which A's second 3 has nothing left to match
       * and is deleted — an insert plus a delete that recreates an element
       * nobody changed (losing any concurrent remote edit to it).
       *
       * The next elements (A's and B's position 2) already line up, though,
       * and the shift does not line up a longer run than they do, so the
       * change is read as a single in-place update of position 1.
       */
      [
        [1, 3, 3],
        [1, 2, 3],
        [
          [changeType.update, 1, 2]
        ]
      ],
      // A shift still wins when it lines up a longer run than an in-place
      // replacement: this is a head removal, not an update plus a delete.
      [
        [9, 1, 1, 2],
        [1, 1, 2],
        [
          [changeType.delete, 0, undefined]
        ]
      ],
      // ...and when the runs tie (here both reach the look-ahead cap), the
      // shift wins if it brings the remaining lengths closer together.
      [
        [9, ...Array.from({ "length": 12 }, () => 0)],
        Array.from({ "length": 12 }, () => 0),
        [
          [changeType.delete, 0, undefined]
        ]
      ],
      // A block prepended to an array with alternating duplicates is still
      // inserted, rather than read as in-place replacements.
      [
        [{ "id": 1, }, null, { "id": 2, }, null],
        [{ "id": 0, }, null, { "id": 1, }, null, { "id": 2, }, null],
        [
          [changeType.insert, 0, { "id": 0, }],
          [changeType.insert, 1, null]
        ]
      ],
      // A strict-identity match past the window is not taken either when the
      // next elements already line up: replace slot 0, keep the zeros.
      [
        [1, ...Array.from({ "length": 11 }, () => 0), 2],
        [2, ...Array.from({ "length": 11 }, () => 0), 2],
        [
          [changeType.update, 0, 2]
        ]
      ],
      [
        [1, ...Array.from({ "length": 11 }, () => 0)],
        [2, ...Array.from({ "length": 10 }, () => 0), 1],
        [
          [changeType.update, 0, 2],
          [changeType.update, 11, 1]
        ]
      ],
      [
        [{ "foo": 1, }],
        [{ "foo": 1, }, { "bar": 2, }],
        [[changeType.insert, 1, { "bar": 2, }]]
      ],
      [
        [{ "foo": 1, }],
        [{ "foo": 2, }, { "foo": 1, }],
        [
          [changeType.insert, 0, { "foo": 2, }]
        ]
      ],
      [
        [{ "foo": 1, }, { "foo": 2, }],
        [{ "foo": 0, }, { "foo": 1, }, { "foo": 2, }],
        [
          [changeType.insert, 0, { "foo": 0, }]
        ]
      ],
      [
        [{ "foo": 1, }, { "foo": 2, }],
        [{ "foo": 1, }, { "foo": 1, }, { "foo": 2, }],
        [
          [changeType.insert, 1, { "foo": 1, }]
        ]
      ],
      [
        [{ "foo": 1, }, { "foo": 2, }, { "foo": 3, }],
        [{ "foo": 1, }, { "foo": 2, }, { "foo": 2, }, { "foo": 3, }],
        [
          [changeType.insert, 2, { "foo": 2, }]
        ]
      ],
      [
        [{ "foo": 1, }],
        [{ "foo": 0, }],
        [
          [
            changeType.pending,
            0,
            [
              [changeType.update, "foo", 0]
            ]
          ]
        ]
      ],
      [
        [{ "foo": 1, }],
        [],
        [
          [
            changeType.delete,
            0,
            undefined
          ]
        ]
      ],
      [
        [{ "foo": 1, }],
        [{}],
        [
          [
            changeType.pending,
            0,
            [
              [
                changeType.delete,
                "foo",
                undefined
              ]
            ]
          ]
        ]
      ],
      [
        ["a"],
        [""],
        [
          [
            changeType.pending,
            0,
            [
              [changeType.delete, 0, undefined]
            ]
          ]
        ]
      ],
      [
        ["ab"],
        ["bc"],
        [
          [
            changeType.pending,
            0,
            [
              [changeType.delete, 0, undefined],
              [changeType.insert, 1, "c"]
            ]
          ]
        ]
      ]
    ])(
      "Returns a change list for arrays",
      (a, b, changes) => {
        expect(getChanges(a, b)).toStrictEqual(changes);
      }
    );

    describe("Deletion Lookahead (FIFO Queue Operations)", () => {
      it("Detects primitive shift+push as DELETE+INSERT instead of N updates", () => {
        // [1, 2, 3, 4, 5] → [2, 3, 4, 5, 6]
        const a = [1, 2, 3, 4, 5];
        const b = [2, 3, 4, 5, 6];
        const changes = getChanges(a, b);

        expect(changes).toEqual([
          [changeType.delete, 0, undefined],
          [changeType.insert, 4, 6]
        ]);
      });

      it("Detects pure deletion at head", () => {
        const a = [1, 2, 3];
        const b = [2, 3];
        const changes = getChanges(a, b);

        expect(changes).toEqual([
          [changeType.delete, 0, undefined]
        ]);
      });

      it("Detects object FIFO shift as DELETE+INSERT", () => {
        const a = [{ "id": 0, }, { "id": 1, }, { "id": 2, }];
        const b = [{ "id": 1, }, { "id": 2, }, { "id": 3, }];
        const changes = getChanges(a, b);

        expect(changes).toEqual([
          [changeType.delete, 0, undefined],
          [changeType.insert, 2, { "id": 3, }]
        ]);
      });

      it("Produces O(1) changes for large FIFO shift", () => {
        const size = 1000;
        const a = Array.from({ "length": size, }, (_, i) => ({ "id": i, }));
        const b = [...a.slice(1), { "id": size, }];
        const changes = getChanges(a, b);

        // Should be exactly 2 operations: 1 DELETE + 1 INSERT
        expect(changes).toHaveLength(2);
        expect(changes[0][0]).toBe(changeType.delete);
        expect(changes[1][0]).toBe(changeType.insert);
      });
    });
  });

  describe("When given strings", () => {
    it.each([
      ["", ""],
      ["a", "a"],
      ["hello, world!", "hello, world!"]
    ])("Returns undefined for identical sequences", (a, b) => {
      expect(getChanges(a, b)).toStrictEqual([]);
    });

    it.each([
      ["a", "", [[changeType.delete, 0, undefined]]],
      ["", "a", [[changeType.insert, 0, "a"]]],
      ["a", "ab", [[changeType.insert, 1, "b"]]],
      ["ab", "a", [[changeType.delete, 1, undefined]]],
      [
        "ab",
        "ac",
        [
          [changeType.delete, 1, undefined],
          [changeType.insert, 1, "c"]
        ]
      ],
      [
        "ac",
        "bc",
        [
          [changeType.delete, 0, undefined],
          [changeType.insert, 0, "b"]
        ]
      ],
      [
        "ab",
        "",
        [
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined]
        ]
      ],
      [
        "",
        "ab",
        [
          [changeType.insert, 0, "a"],
          [changeType.insert, 1, "b"]
        ]
      ],
      // No common subsequence test cases.
      [
        "a",
        "b",
        [
          [changeType.delete, 0, undefined],
          [changeType.insert, 0, "b"]
        ]
      ],
      [
        "ab",
        "cd",
        [
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined],
          [changeType.insert, 0, "c"],
          [changeType.insert, 1, "d"]
        ]
      ],
      ["😀", "😀", []],
      [
        "",
        "😀",
        [
          [changeType.insert, 0, "😀"]
        ]
      ],
      [
        "😀",
        "",
        [
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined]
        ]
      ],
      [
        "😀",
        "😁",
        // The shared high surrogate \uD83D is NOT common-prefix-trimmed:
        // splitting the pair would make Y.Text replace both halves with
        // U+FFFD, so the whole code point is deleted and reinserted.
        [
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined],
          [changeType.insert, 0, "😁"]
        ]
      ],
      [
        "I love 😀",
        "I love 😁",
        [
          [changeType.delete, 7, undefined],
          [changeType.delete, 7, undefined],
          [changeType.insert, 7, "😁"]
        ]
      ],
      [
        "😀",
        "😂😀",
        // Shared surrogates on both sides of the edit are kept whole too.
        [[changeType.insert, 0, "😂"]]
      ],
      [
        "x😀-y",
        "z😁-w",
        // No common prefix or suffix: the inner diff compares code points.
        [
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined],
          [changeType.delete, 0, undefined],
          [changeType.insert, 0, "z"],
          [changeType.insert, 1, "😁"],
          [changeType.delete, 4, undefined],
          [changeType.insert, 4, "w"]
        ]
      ]
    ])(
      "Returns a change tuple for sequences that are different",
      (a, b, diff) => {
        expect(getChanges(a, b)).toStrictEqual(diff);
      }
    );

    it.each([
      [
        "hello",
        "goodbye",
        [
          [changeType.insert, 0, "g"],
          [changeType.insert, 1, "o"],
          [changeType.insert, 2, "o"],
          [changeType.insert, 3, "d"],
          [changeType.insert, 4, "b"],
          [changeType.insert, 5, "y"],
          [changeType.delete, 6, undefined],
          [changeType.delete, 7, undefined],
          [changeType.delete, 7, undefined],
          [changeType.delete, 7, undefined]
        ]
      ],
      [
        "hello, world!",
        "goodbye, world.",
        [
          [changeType.insert, 0, "g"],
          [changeType.insert, 1, "o"],
          [changeType.insert, 2, "o"],
          [changeType.insert, 3, "d"],
          [changeType.insert, 4, "b"],
          [changeType.insert, 5, "y"],
          [changeType.delete, 6, undefined],
          [changeType.delete, 7, undefined],
          [changeType.delete, 7, undefined],
          [changeType.delete, 7, undefined],
          [changeType.insert, 14, "."],
          [changeType.delete, 15, undefined]
        ]
      ]
    ])(
      "Adjusts indices to account for previous changes.",
      (a, b, diff) => {
        expect(getChanges(a, b)).toStrictEqual(diff);
      }
    );
  });
});
describe("isDeepEqualForDiff and getChanges agree", () => {
  /*
   * getRecordChanges recurses into every changed same-type child and emits a
   * pending change only when the child's list is non-empty, which reproduces
   * the old isDeepEqualForDiff-prefiltered output exactly as long as
   * isDeepEqualForDiff(a, b) === (getChanges(a, b).length === 0). The array
   * lookahead also uses isDeepEqualForDiff as its equality test.
   *
   * Pairs are generated as twins (equal by default, diverging at random
   * nodes) so that deep near-equal trees, the full-tree diff's common case,
   * are frequent. Leaves cover the differ's quirks: NaN, -0, undefined,
   * functions (shared and distinct), surrogate pairs and keys named like
   * Object.prototype members.
   */
  type Pair = [left: unknown, right: unknown];

  const sharedFunction = (): number => 1;
  const otherFunction = (): number => 2;
  const key = fc.constantFrom("a", "b", "c", "toString", "valueOf", "hasOwnProperty");
  const leaf = fc.oneof(
    fc.constantFrom(null, undefined, true, false, 0, -0, 1, Number.NaN, sharedFunction, otherFunction),
    fc.constantFrom("", "x", "xy", "😀", "😁", "a😀b")
  );
  const toRecord = (entries: [string, unknown][]): Record<string, unknown> => {
    const record: Record<string, unknown> = {};

    for (const [property, value] of entries) {
      record[property] = value;
    }

    return record;
  };

  const { arrayPair, recordPair, stringPair } = fc.letrec<{
    pair: Pair;
    arrayPair: Pair;
    recordPair: Pair;
    stringPair: Pair;
  }>((tie) => ({
    "pair": fc.oneof(
      { "depthSize": "small" },
      { "arbitrary": leaf.map((value): Pair => [value, value]), "weight": 4 },
      { "arbitrary": fc.tuple(leaf, leaf), "weight": 1 },
      { "arbitrary": tie("stringPair"), "weight": 1 },
      { "arbitrary": tie("arrayPair"), "weight": 2 },
      { "arbitrary": tie("recordPair"), "weight": 2 },
      // A container shared by reference on both sides (state-vs-state).
      { "arbitrary": tie("recordPair").map(([left]): Pair => [left, left]), "weight": 1 }
    ),
    "arrayPair": fc.tuple(
      fc.array(tie("pair"), { "maxLength": 4 }),
      fc.array(leaf, { "maxLength": 1 }),
      fc.boolean()
    ).map(([pairs, extra, isExtraOnLeft]): Pair => {
      const left = pairs.map(([element]) => element);
      const right = pairs.map(([, element]) => element);

      (isExtraOnLeft ? left : right).push(...extra);

      return [left, right];
    }),
    "recordPair": fc.tuple(
      fc.uniqueArray(fc.tuple(key, tie("pair")), { "maxLength": 4, "selector": ([property]) => property }),
      fc.array(fc.tuple(key, leaf), { "maxLength": 1 }),
      fc.array(fc.tuple(key, leaf), { "maxLength": 1 })
    ).map(([pairs, onlyLeft, onlyRight]): Pair => {
      const left = toRecord(pairs.map(([property, [value]]) => [property, value]));
      const right = toRecord(pairs.map(([property, [, value]]) => [property, value]));

      for (const [property, value] of onlyLeft) {
        if (!Object.hasOwn(left, property)) {
          left[property] = value;
        }
      }
      for (const [property, value] of onlyRight) {
        if (!Object.hasOwn(right, property)) {
          right[property] = value;
        }
      }

      return [left, right];
    }),
    "stringPair": fc.oneof(
      fc.string({ "maxLength": 4 }).map((text): Pair => [text, text]),
      fc.tuple(fc.string({ "maxLength": 4 }), fc.string({ "maxLength": 4 }))
    ),
  }));
  // getChanges only diffs same-type diffable pairs (anything else is []).
  const diffablePair = fc.oneof(recordPair, arrayPair, stringPair);

  it("isDeepEqualForDiff(a, b) is exactly getChanges(a, b).length === 0", () => {
    fc.assert(fc.property(diffablePair, ([left, right]) => {
      expect(isDeepEqualForDiff(left, right)).toBe(
        getChanges(left as Record<string, unknown>, right as Record<string, unknown>).length === 0
      );
    }), { "numRuns": 2_000 });
  });

  it("a record diff matches the isDeepEqualForDiff-prefiltered reference", () => {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const isSameValueZero = (left: unknown, right: unknown): boolean =>
      left === right || (Number.isNaN(left) && Number.isNaN(right));
    const isDiffableSameType = (left: unknown, right: unknown): boolean =>
      (typeof left === "string" && typeof right === "string") ||
      (Array.isArray(left) && Array.isArray(right)) ||
      (isRecord(left) && isRecord(right));

    // The pre-single-pass getRecordChanges, recursing through itself.
    const referenceChanges = (a: unknown, b: unknown): Change[] => {
      if (!isRecord(a) || !isRecord(b)) {
        return getChanges(a as unknown[], b as unknown[]);
      }

      const changeList: Change[] = [];

      for (const [property, value] of Object.entries(a)) {
        if (!Object.hasOwn(b, property) && !(value instanceof Function)) {
          changeList.push([changeType.delete, property, undefined]);
        }
      }
      for (const [property, value] of Object.entries(b)) {
        if (!Object.hasOwn(a, property)) {
          changeList.push([changeType.insert, property, value]);
        } else if (isDiffableSameType(a[property], value)) {
          if (!isDeepEqualForDiff(a[property], value)) {
            changeList.push([changeType.pending, property, referenceChanges(a[property], value)]);
          }
        } else if (!isSameValueZero(a[property], value)) {
          changeList.push([changeType.update, property, value]);
        }
      }

      return changeList;
    };

    fc.assert(fc.property(recordPair, ([left, right]) => {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;

      expect(getChanges(a, b)).toStrictEqual(referenceChanges(a, b));
    }), { "numRuns": 2_000 });
  });
});
