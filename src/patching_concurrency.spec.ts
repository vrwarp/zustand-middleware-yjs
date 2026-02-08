import * as Y from "yjs";
import { patchSharedType } from "./patching";

describe("patchSharedType with Three-Way Merge (Ignorance Check)", () => {
  let ydoc: Y.Doc;
  let ymap: Y.Map<any>;

  beforeEach(() => {
    ydoc = new Y.Doc();
    ymap = ydoc.getMap("test");
  });

  afterEach(() => {
    ydoc.destroy();
  });

  it("Preserves remote key when previousState was ignorant of it", () => {
    // 1. Setup Yjs State: { A: 1, B: 2 }
    ymap.set("A", 1);
    ymap.set("B", 2);

    // 2. User Update
    // User started with { A: 1 } (Ignorant of B)
    const previousState = { "A": 1 };

    // User wants to add C: { A: 1, C: 3 }
    const newState = { "A": 1, "C": 3 };

    // 3. Apply Patch
    patchSharedType(ymap, newState, { previousState });

    // 4. Assertions
    const finalState = ymap.toJSON();

    // B should be preserved because it wasn't in previousState
    expect(finalState).toHaveProperty("B", 2);
    // C should be added
    expect(finalState).toHaveProperty("C", 3);
    // A should remain
    expect(finalState).toHaveProperty("A", 1);
  });

  it("Deletes remote key when previousState knew about it", () => {
    // 1. Setup Yjs State: { A: 1, B: 2 }
    ymap.set("A", 1);
    ymap.set("B", 2);

    // 2. User Update
    // User started with { A: 1, B: 2 } (Knew about B)
    const previousState = { "A": 1, "B": 2 };

    // User wants to delete B and add C: { A: 1, C: 3 }
    const newState = { "A": 1, "C": 3 };

    // 3. Apply Patch
    patchSharedType(ymap, newState, { previousState });

    // 4. Assertions
    const finalState = ymap.toJSON();

    // B should be deleted because it WAS in previousState
    expect(finalState).not.toHaveProperty("B");
    // C should be added
    expect(finalState).toHaveProperty("C", 3);
    // A should remain
    expect(finalState).toHaveProperty("A", 1);
  });

  it("Handles nested objects ignorance", () => {
    // Yjs: { nested: { A: 1, B: 2 } }
    const nestedMap = new Y.Map();
    nestedMap.set("A", 1);
    nestedMap.set("B", 2);
    ymap.set("nested", nestedMap);

    // Previous: { nested: { A: 1 } } (Ignorant of B)
    const previousState = { nested: { "A": 1 } };

    // New: { nested: { A: 1, C: 3 } }
    const newState = { nested: { "A": 1, "C": 3 } };

    patchSharedType(ymap, newState, { previousState });

    const finalState = ymap.toJSON();
    expect(finalState.nested).toHaveProperty("B", 2);
    expect(finalState.nested).toHaveProperty("C", 3);
  });

   it("Deletes nested objects when known", () => {
    // Yjs: { nested: { A: 1, B: 2 } }
    const nestedMap = new Y.Map();
    nestedMap.set("A", 1);
    nestedMap.set("B", 2);
    ymap.set("nested", nestedMap);

    // Previous: { nested: { A: 1, B: 2 } } (Known B)
    const previousState = { nested: { "A": 1, "B": 2 } };

    // New: { nested: { A: 1, C: 3 } } (Delete B)
    const newState = { nested: { "A": 1, "C": 3 } };

    patchSharedType(ymap, newState, { previousState });

    const finalState = ymap.toJSON();
    expect(finalState.nested).not.toHaveProperty("B");
    expect(finalState.nested).toHaveProperty("C", 3);
  });
});
