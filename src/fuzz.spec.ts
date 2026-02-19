import * as fc from "fast-check";
import * as Y from "yjs";
import { createStore as createVanilla, } from "zustand/vanilla";
import yjs from ".";

describe("Fuzz testing", () => {
  // Custom arbitrary for safe JSON values, excluding "unsafe" keys
  const safeString = fc.string().filter((k) =>
    !["valueOf", "toString", "__proto__", "constructor"].includes(k));

  const safeJsonValue = fc.letrec((tie) =>
  ({
    "json": fc.oneof(
      fc.constantFrom(null),
      fc.boolean(),
      fc.integer(),
      fc.double(),
      fc.string(),
      tie("array"),
      tie("object")
    ),
    "array": fc.array(tie("json"), { "maxLength": 3, }),
    "object": fc.dictionary(safeString, tie("json"), { "maxKeys": 3, }),
  })).json;

  it("Should maintain consistency between Zustand store and Yjs doc with "
    + "random operations", async () => {
      await fc.assert(fc.asyncProperty(
        fc.array(
          fc.record({
            "type": fc.constantFrom("set"),
            "key": safeString,
            "value": safeJsonValue,
          }),
          { "minLength": 1, "maxLength": 20, }
        ),
        async (operations) => {
          const doc = new Y.Doc();
          const map = doc.getMap("shared");

          // Define a generic store
          type Store = Record<string, any>;

          const api = createVanilla<Store>(yjs(
            doc,
            "shared",
            (set) =>
            ({
              "set": (key: string, value: any) =>
                set((state) =>
                  ({ ...state, [key]: value, })),
            })
          ));

          // Apply operations
          operations.forEach((op) => {
            if (op.type === "set")

              api.setState({ [op.key]: op.value, });

          });

          // Flush microtask queue so all deferred patchSharedType calls fire.
          await Promise.resolve();

          // Check consistency
          const state = api.getState();
          const yMapJson = map.toJSON();

          // Filter out the 'set' function from state comparison
          const cleanState = { ...state, };
          delete cleanState.set;

          // We expect the state to match the Yjs map
          expect(cleanState).toEqual(yMapJson);
        }
      ));
    });

  it("Should maintain consistency between two peers with random concurrent "
    + "operations", async () => {
      await fc.assert(fc.asyncProperty(
        fc.array(
          fc.record({
            "peer": fc.constantFrom(0, 1),
            "key": safeString,
            "value": safeJsonValue,
          }),
          { "minLength": 1, "maxLength": 20, }
        ),
        async (operations) => {
          const doc1 = new Y.Doc();
          const doc2 = new Y.Doc();

          doc1.on("update", (update) =>
            Y.applyUpdate(doc2, update));
          doc2.on("update", (update) =>
            Y.applyUpdate(doc1, update));

          const createPeer = (doc: Y.Doc) =>
            createVanilla<Record<string, any>>(yjs(doc, "shared", (set) =>
            ({
              "set": (key: string, value: any) =>
                set((state) =>
                  ({ ...state, [key]: value, })),
            })));

          const peer1 = createPeer(doc1);
          const peer2 = createPeer(doc2);

          const peers = [peer1, peer2];

          operations.forEach((op) => {
            peers[op.peer].setState({ [op.key]: op.value, });
          });

          // Tick 1: flush outbound batches → Yjs transactions fire → peer updates arrive.
          await Promise.resolve();
          // Tick 2: flush inbound batches on receiving peers → Zustand stores updated.
          await Promise.resolve();

          const state1 = { ...peer1.getState(), };
          delete state1.set;
          const state2 = { ...peer2.getState(), };
          delete state2.set;

          expect(state1).toEqual(state2);
          expect(state1).toEqual(doc1.getMap("shared").toJSON());
          expect(state2).toEqual(doc2.getMap("shared").toJSON());
        }
      ));
    });

  it("Should handle nested object updates correctly", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(
        fc.tuple(
          safeString,
          safeJsonValue
        ),
        { "minLength": 1, "maxLength": 20, }
      ),
      async (operations) => {
        const doc = new Y.Doc();
        const api = createVanilla<Record<string, any>>(yjs(doc, "shared", () =>
          ({})));

        operations.forEach(([key, value]) => {
          if (value !== undefined)

            api.setState({ [key]: value, });

        });

        // Flush microtask queue so all deferred patchSharedType calls fire.
        await Promise.resolve();

        const state = { ...api.getState(), };
        const yState = doc.getMap("shared").toJSON();

        expect(state).toEqual(yState);
      }
    ));
  });
});
