import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Yjs middleware with atomic keys", () => {
  it("Does not convert atomic keys to Y.Text", async () => {
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

    // Not synced initially as per design
    expect(map.get("description")).toBeUndefined();

    api.getState().setDescription("updated");

    // Yjs writes are deferred; flush before asserting.
    await Promise.resolve();

    // It should be a string, not Y.Text
    expect(typeof map.get("description")).toBe("string");
    expect(map.get("description")).toBe("updated");
  });

  it("Converts non-atomic keys to Y.Text", async () => {
    type Store = {
      title: string;
      setTitle: (title: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "title": "initial",
        "setTitle": (title) =>
          set({ "title": title, }),
      }),
      { "atomicKeys": ["description"], } // title is not atomic
    ));

    api.getState().setTitle("updated");

    // Yjs writes are deferred; flush before asserting.
    await Promise.resolve();

    // It should be Y.Text
    expect(map.get("title")).toBeInstanceOf(Y.Text);
    expect((map.get("title") as Y.Text).toString()).toBe("updated");
  });

  it("Handles nested atomic keys", async () => {
    type Store = {
      meta: {
        id: string;
        tag: string;
      };
      setMeta: (id: string, tag: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "meta": { "id": "1", "tag": "a", },
        "setMeta": (id, tag) =>
          set({ "meta": { "id": id, "tag": tag, }, }),
      }),
      { "atomicKeys": ["id"], }
    ));

    api.getState().setMeta("2", "b");

    // Yjs writes are deferred; flush before asserting.
    await Promise.resolve();

    const metaMap = map.get("meta") as Y.Map<any>;

    // id should be string
    expect(typeof metaMap.get("id")).toBe("string");
    expect(metaMap.get("id")).toBe("2");

    // tag should be Y.Text
    expect(metaMap.get("tag")).toBeInstanceOf(Y.Text);
    expect((metaMap.get("tag") as Y.Text).toString()).toBe("b");
  });
});
