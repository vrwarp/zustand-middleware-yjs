import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";
import { getChanges, } from "./diff";
import { ChangeType, } from "./types";
import { patchSharedType, } from "./patching";
import { arrayToYArray, } from "./mapping";

describe("Edge cases from fuzz testing", () => {
  it("Should handle nested arrays correctly (Case 1)", async () => {
    /*
     * Counterexample:
     * [[{"type":"set","key":"","value":
     * [[false,"<=rH","<=rH",true,"b;i63MU5#"]]}]]
     * Simplified: setting a key to an array with mixed types.
     */

    const doc = new Y.Doc();
    const map = doc.getMap("shared");
    const api = createVanilla<Record<string, any>>(yjs(doc, "shared", () =>
      ({})));

    const value = [[false, "<=rH", "<=rH", true, "b;i63MU5#"]];
    api.setState({ "": value, });

    const state = api.getState();

    expect(state[""]).toEqual(value);

    // Yjs writes are deferred; flush before asserting.
    await Promise.resolve();
    const yState = map.toJSON();

    expect(yState[""]).toEqual(value);
  });

  it("Should handle complex nested structures (Case 3)", async () => {
    /*
     * Counterexample:
     * [[["",{"x,":{"P9O":"o","2A47 m":[true,[true,"4 "],
     * [680436100448947,null,"","",-7185039365749484,false,1242072609498249],
     * ["","",1242072609498249]]},"":{}}]]]
     * Simplified key-value pair
     */
    const key = "";
    const value = {
      "x,": {
        "P9O": "o",
        "2A47 m": [
          true,
          [true, "4 "],
          [
            680436100448947,
            null,
            "",
            "",
            -7185039365749484,
            false,
            1242072609498249
          ],
          ["", "", 1242072609498249]
        ],
      },
      "": {},
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");
    const api = createVanilla<Record<string, any>>(yjs(doc, "shared", () =>
      ({})));

    api.setState({ [key]: value, });

    const state = api.getState();

    expect(state[key]).toEqual(value);

    // Yjs writes are deferred; flush before asserting.
    await Promise.resolve();
    const yState = map.toJSON();

    expect(yState[key]).toEqual(value);
  });

  it(
    "Reproduction: Array update [\"b>Jz0\", 0] -> [\"b>Jz0\", \"b>Jz0\"]",
    () => {
      const a = ["b>Jz0", 0];
      const b = ["b>Jz0", "b>Jz0"];

      const changes = getChanges(a, b);
      console.log("Changes:", changes);

      expect(changes).toEqual([
        [ChangeType.UPDATE, 1, "b>Jz0"]
      ]);
    }
  );

  it("Reproduction: patchSharedType failure", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("shared");
    const key = "eR6";

    // Initial state in Yjs: ["b>Jz0", 0]
    const initialArray = arrayToYArray(["b>Jz0", 0]);
    map.set(key, initialArray);

    const newState = { [key]: ["b>Jz0", "b>Jz0"], };

    // Patch Yjs
    doc.transact(() => {
      patchSharedType(map, newState);
    });

    expect(map.toJSON()).toEqual(newState);
  });
});
