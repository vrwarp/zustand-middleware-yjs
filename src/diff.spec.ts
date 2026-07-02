import { changeType, } from "./types";
import { getChanges, } from "./diff";

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
              [changeType.delete, 0, undefined],
              [changeType.insert, 1, 2]
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
       * This is an edge case in how we perform change detection.
       *
       * In this case, A contains a repeated sequence of digits that is not in
       * B. This confuses the look ahead, which, in order to detect an update,
       * looks to the next value in B to see if the value found in A has just
       * moved.
       *
       * When it sees that A's position 1, with a value of 3, is not the same as
       * B's position 1 (with a value of 2), the look ahead checks to see if
       * B's position 2 is the same as A's position 1. It is, so the algorithm
       * assumes that an insertion took place in B.
       *
       * This insertion causes an increase in the indexing offset for B. When
       * that happens, the next iteration is looking at B position 3 (does not
       * exist) instead of position 3. Because B position 3 does not exist, it
       * is assumed that the duplicate value was deleted in B.
       *
       * As far as I know, there's no way around this. One option is that we
       * could increase the look ahead. But by doing that, we change the minimum
       * length of the sequence this happens with. If we added, say, a look
       * ahead of two positions, we'd eliminate the issue with values repeated
       * twice, but not for values repeated three times.
       *
       * Another option is to retroactively recognize a repeated sequence and
       * then correct the previous insertion to an update when we try to delete
       * the end of the sequence. However, this has other issues, such as the
       * ambiguity about what to do when an update happens at the beginning of
       * a repeated sequence and a delete happens at the end. That could be
       * construed as an insert at the beginning and two deletes at the end.
       *
       * At the end of the day, a correct transformation is better than a
       * 'correct' change list.
       */
      [
        [1, 3, 3],
        [1, 2, 3],
        [
          [changeType.insert, 1, 2],
          [changeType.delete, 3, undefined]
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
          [changeType.insert, 0, "\uD83D"],
          [changeType.insert, 1, "\uDE00"]
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
        // The shared high surrogate \uD83D is common-prefix-trimmed, so only
        // the differing low surrogate is deleted and reinserted.
        [
          [changeType.delete, 1, undefined],
          [changeType.insert, 1, "\uDE01"]
        ]
      ],
      [
        "I love 😀",
        "I love 😁",
        [
          [changeType.delete, 8, undefined],
          [changeType.insert, 8, "\uDE01"]
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