import { createStore as createVanilla } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Yjs middleware with Subdocs", () => {
  it("Handles subdocuments correctly", () => {
    type Store = {
      sub: { foo: string } | null;
      setSub: (val: { foo: string }) => void;
    };

    const doc = new Y.Doc();
    const storeName = "store";

    // Initialize store with subdocKeys
    const api = createVanilla<Store>(
      yjs(
        doc,
        storeName,
        (set) => ({
          sub: null,
          setSub: (val) => set({ sub: val }),
        }),
        {
          subdocKeys: ["sub"],
        }
      )
    );

    // Initial state
    expect(api.getState().sub).toBeNull();

    // Set value that should become a subdoc
    api.getState().setSub({ foo: "bar" });

    // Verify Yjs structure
    const map = doc.getMap(storeName);
    const subdoc = map.get("sub");

    // Check if it is a Y.Doc
    expect(subdoc).toBeInstanceOf(Y.Doc);

    // Check content of subdoc
    if (subdoc instanceof Y.Doc) {
      const rootMap = subdoc.getMap("root");
      expect(rootMap.toJSON().foo).toBe("bar");
    }

    // Verify state reflects the value
    expect(api.getState().sub).toEqual({ foo: "bar" });
  });

  it("Reads existing subdocuments", () => {
    type Store = {
      sub: { foo: string } | null;
    };

    const doc = new Y.Doc();
    const storeName = "store";

    const api = createVanilla<Store>(
      yjs(
        doc,
        storeName,
        (_set) => ({
          sub: null,
        }),
        {
          subdocKeys: ["sub"],
        }
      )
    );

    expect(api.getState().sub).toBeNull();

    const subdoc = new Y.Doc();
    subdoc.getMap("root").set("foo", "bar");

    // This should trigger observeDeep -> patchStore
    doc.getMap(storeName).set("sub", subdoc);

    expect(api.getState().sub).toEqual({ foo: "bar" });
  });
});
