import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Concurrency: Three-Way Merge Strategy", () => {
  it("preserves remote keys when local update is ignorant of them (Three-Way Merge)", () => {
    // 1. Setup
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

    // 2. Initial State: { A: 1 }
    api.getState().addItem("A", 1);
    expect((map.get("items") as any).toJSON()).toEqual({ "A": 1 });

    // 3. Capture Stale Snapshot
    const staleStateSnapshot = api.getState();

    // 4. Remote Update: Insert { B: 2 }
    doc.transact(() => {
        const itemsMap = map.get("items") as Y.Map<any>;
        itemsMap.set("B", 2);
    });

    // Verify remote update landed in store
    expect(api.getState().items).toEqual({ "A": 1, "B": 2 });

    // 5. Local Update using Stale Snapshot (Ignorant of B)
    // We mock api.getState() to return the stale snapshot for the first call (previousState capture)
    // and the real state for subsequent calls (newState capture).
    // This simulates the scenario where the store update lagged behind Yjs,
    // or allows us to provide the "User's View" as previousState.

    const realGetState = api.getState;
    const getStateSpy = jest.spyOn(api, 'getState')
      .mockReturnValueOnce(staleStateSnapshot) // Call 1: previousState capture
      .mockImplementation(() => realGetState()); // Call 2: newState capture

    // User sets state to { A: 1, C: 3 } (derived from snapshot that missed B)
    api.setState({
      items: {
        ...staleStateSnapshot.items,
        "C": 3,
      },
    });

    getStateSpy.mockRestore();

    // 6. Verification
    const finalMap = (map.get("items") as any).toJSON();

    expect(finalMap).toHaveProperty("A");
    expect(finalMap).toHaveProperty("C");
    // EXPECTATION: B should be preserved (atomic merge).
    expect(finalMap).toHaveProperty("B");
  });
});
