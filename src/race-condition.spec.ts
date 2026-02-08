import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Vulnerability Reproduction: Safe-Update Race Condition", () => {
  it("Clobbers concurrent updates when setState is derived from stale state", () => {
    // 1. Setup: A store managing a record of items.
    type Store = {
      items: Record<string, number>;
      addItem: (key: string, value: number) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("store");

    const api = createVanilla<Store>(
      yjs(
        doc,
        "store",
        (set) => ({
          items: {},
          addItem: (key, value) =>
            set((state) => ({
              items: { ...state.items, [key]: value },
            })),
        })
      )
    );

    // 2. Initial State: Both Map and Store have { A: 1 }
    api.getState().addItem("A", 1);
    expect((map.get("items") as any).toJSON()).toEqual({ "A": 1 });

    // 3. Simulate the "Race":
    // The user (or a React component) reads the *current* state to prepare an update.
    // This state captures { A: 1 }.
    const staleStateSnapshot = api.getState();

    // 4. Concurrent Update:
    // While the user is preparing their update, a remote change arrives via Yjs.
    // (We simulate this by writing directly to the Y.Map, mimicking an incoming sync).
    doc.transact(() => {
        const itemsMap = map.get("items") as Y.Map<any>;
        itemsMap.set("B", 2);
    });

    // Verify the store updated (Middleware observer works correctly)
    // The store is now { A: 1, B: 2 }
    expect(api.getState().items).toEqual({ "A": 1, "B": 2 });

    // 5. Commit Stale Update:
    // The user/component finally commits their update, adding "C".
    // CRITICALLY: They use the 'staleStateSnapshot' they read in Step 3.
    // They set the state to: { ...{A:1}, C:3 } -> { A:1, C:3 }
    api.setState({
      items: {
        ...staleStateSnapshot.items,
        "C": 3,
      },
    });

    // 6. Verification of Data Loss:
    // The middleware diffs the Current Map { A, B } against the New State { A, C }.
    // It sees 'B' is missing in the New State and generates a DELETE operation.
    const finalMap = (map.get("items") as any).toJSON();

    // EXPECTATION: B should be preserved (atomic merge).
    // REALITY: B is deleted (clobbered).

    expect(finalMap).toHaveProperty("A");
    expect(finalMap).toHaveProperty("C");

    // This assertion passes if the vulnerability exists (B is lost):
    expect(finalMap).not.toHaveProperty("B");

    console.log("Final Map State:", finalMap);
    // Output: { A: 1, C: 3 } -> B was lost.
  });
});
