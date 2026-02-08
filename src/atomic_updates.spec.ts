import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from "./index";

describe("Atomic Updates to Avoid Race Condition", () => {
  it("Should not lose data when using set.yjs for atomic updates", () => {
    type Store = {
      items: Record<string, number>;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("store");

    const store = createVanilla<Store>(
      yjs(doc, "store", (set) => ({
        items: {},
        addItem: (key: string, value: number) => (set as any).yjs("items").set(key, value)
      }))
    );

    // 1. Initial state { X: 1 }
    store.setState({ items: { X: 1 } });
    expect((map.get("items") as Y.Map<any>).toJSON()).toEqual({ X: 1 });

    // 2. Simulate Remote update adding Y
    doc.transact(() => {
      const itemsMap = map.get("items") as Y.Map<any>;
      itemsMap.set("Y", 2);
    });

    // Verify store updated
    expect(store.getState().items).toEqual({ X: 1, Y: 2 });

    // 3. User applies update using ATOMIC action (adding Z)
    // This action does NOT depend on the current state (stale or fresh).
    // Using the action defined in the store which uses set.yjs
    (store.getState() as any).addItem("Z", 3);

    // 4. Check if Y is preserved
    const itemsMap = map.get("items") as Y.Map<any>;

    expect(itemsMap.has("Y")).toBe(true);
    expect(itemsMap.has("Z")).toBe(true);
    expect(itemsMap.has("X")).toBe(true);

    // Verify local state is updated
    expect(store.getState().items).toEqual({ X: 1, Y: 2, Z: 3 });
  });

  it("Should handle nested paths correctly", () => {
    type Store = {
        config: {
            settings: {
                theme: string;
            }
        },
        updateTheme: (theme: string) => void;
    };

    const doc = new Y.Doc();
    const store = createVanilla<Store>(
        yjs(doc, "store", (set) => ({
            config: {
                settings: {
                    theme: "light"
                }
            },
            updateTheme: (theme) => set.yjs("config.settings").set("theme", theme)
        }))
    );

    // Populate Yjs map
    store.setState(store.getState());

    // Update deep property
    store.getState().updateTheme("dark");

    expect(store.getState().config.settings.theme).toBe("dark");

    const map = doc.getMap("store");
    const config = map.get("config") as Y.Map<any>;
    const settings = config.get("settings") as Y.Map<any>;
    expect(settings.get("theme").toString()).toBe("dark");
  });

  it("Should handle array operations", () => {
    type Store = {
        list: number[];
        push: (items: number[]) => void;
        insert: (index: number, items: number[]) => void;
        delete: (index: number) => void;
        set: (index: number, value: number) => void;
    };

    const doc = new Y.Doc();
    const store = createVanilla<Store>(
        yjs(doc, "store", (set) => ({
            list: [1, 2, 3],
            push: (items) => set.yjs("list").push(items),
            insert: (index, items) => set.yjs("list").insert(index, items),
            delete: (index) => set.yjs("list").delete(index),
            set: (index, value) => set.yjs("list").set(index, value)
        }))
    );

    // Populate Yjs map
    store.setState(store.getState());

    // Push
    store.getState().push([4, 5]);
    expect(store.getState().list).toEqual([1, 2, 3, 4, 5]);

    // Insert
    store.getState().insert(1, [1.5]);
    expect(store.getState().list).toEqual([1, 1.5, 2, 3, 4, 5]);

    // Delete
    store.getState().delete(0); // Delete index 0 (value 1)
    expect(store.getState().list).toEqual([1.5, 2, 3, 4, 5]);

    // Set (replace)
    store.getState().set(0, 99);
    expect(store.getState().list).toEqual([99, 2, 3, 4, 5]);
  });
});
