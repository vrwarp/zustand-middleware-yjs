/**
 * This test reproduces the "Safe-Update Race Condition" where concurrent remote updates
 * could be lost if a local update is based on a stale state snapshot.
 *
 * It verifies that the "Ignorance Check" (Three-Way Merge) strategy correctly prevents
 * the deletion of remote keys that were not present in the local stale snapshot.
 */
import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Vulnerability Reproduction: Safe-Update Race Condition", () => {
  it("Preserves concurrent updates when setState is derived from stale state", () => {
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
    doc.transact(() => {
        const itemsMap = map.get("items") as Y.Map<any>;
        itemsMap.set("B", 2);
    });

    // Verify the store updated
    expect(api.getState().items).toEqual({ "A": 1, "B": 2 });

    // 5. Commit Stale Update:
    // The user/component finally commits their update, adding "C", based on stale snapshot.

    // We mock api.getState() to simulate the lag/race where the update logic receives
    // the stale state as "previousState", or to represent the user's view.
    const realGetState = api.getState;
    const getStateSpy = jest.spyOn(api, 'getState')
      .mockReturnValueOnce(staleStateSnapshot) // Call 1: previousState capture
      .mockImplementation(() => realGetState()); // Call 2: newState capture

    api.setState({
      items: {
        ...staleStateSnapshot.items,
        "C": 3,
      },
    });

    getStateSpy.mockRestore();

    // 6. Verification:
    const finalMap = (map.get("items") as any).toJSON();

    expect(finalMap).toHaveProperty("A");
    expect(finalMap).toHaveProperty("C");

    // EXPECTATION: B should be preserved because it wasn't in the stale snapshot
    expect(finalMap).toHaveProperty("B");
  });
});
