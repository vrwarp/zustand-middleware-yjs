import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from "./index";

describe("Yjs middleware with atomic keys", () => {
  it("Updates atomic keys correctly", async () => {
    type Store = {
      description: string;
      setDescription: (description: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "description": "initial",
        "setDescription": (description) =>
          set({ "description": description, }),
      }),
      { "atomicKeys": ["description"], }
    ));

    api.getState().setDescription("updated");
    await Promise.resolve();

    // update again
    api.getState().setDescription("updated2");
    await Promise.resolve();

    expect(map.get("description")).toBe("updated2");
  });
});
