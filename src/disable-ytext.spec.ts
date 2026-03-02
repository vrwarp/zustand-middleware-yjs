import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Yjs middleware disableYText and yTextKeys", () => {
  it("Disables Y.Text mapping globally with disableYText: true", async () => {
    type Store = {
      title: string;
      tags: string[];
      nested: { value: string };
      setTitle: (title: string) => void;
      setTags: (tags: string[]) => void;
      setNestedValue: (value: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "title": "initial",
        "tags": ["a", "b"],
        "nested": { "value": "x" },
        "setTitle": (title) => set({ "title": title, }),
        "setTags": (tags) => set({ "tags": tags, }),
        "setNestedValue": (value) => set({ "nested": { "value": value } }),
      }),
      { "disableYText": true, }
    ));

    api.getState().setTitle("updated");
    api.getState().setTags(["a", "b", "c"]);
    api.getState().setNestedValue("y");
    await Promise.resolve();

    expect(typeof map.get("title")).toBe("string");
    expect(map.get("title")).toBe("updated");

    const tagsYArray = map.get("tags") as Y.Array<any>;
    expect(typeof tagsYArray.get(2)).toBe("string");
    expect(tagsYArray.get(2)).toBe("c");

    const nestedYMap = map.get("nested") as Y.Map<any>;
    expect(typeof nestedYMap.get("value")).toBe("string");
    expect(nestedYMap.get("value")).toBe("y");
  });

  it("Respects yTextKeys when disableYText: true", async () => {
    type Store = {
      title: string;
      body: string;
      setTitle: (title: string) => void;
      setBody: (body: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "title": "initial",
        "body": "initial text",
        "setTitle": (title) => set({ "title": title, }),
        "setBody": (body) => set({ "body": body, }),
      }),
      { "disableYText": true, "yTextKeys": ["body"] }
    ));

    api.getState().setTitle("updated title");
    api.getState().setBody("updated body");
    await Promise.resolve();

    expect(typeof map.get("title")).toBe("string");
    expect(map.get("title")).toBe("updated title");

    expect(map.get("body")).toBeInstanceOf(Y.Text);
    expect((map.get("body") as Y.Text).toString()).toBe("updated body");
  });

  it("Handles migration from Y.Text to string when disableYText is added", async () => {
    type Store = {
      description: string;
      setDescription: (description: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    // Initially populated by old client using Y.Text
    map.set("description", new Y.Text("old value"));

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "description": "",
        "setDescription": (description) =>
          set({ "description": description, }),
      }),
      { "disableYText": true }
    ));

    // Wait for initial load
    await Promise.resolve();

    // Store should load correctly from Y.Text
    expect(api.getState().description).toBe("old value");

    // Update value, triggering migration
    api.getState().setDescription("new string value");
    await Promise.resolve();

    // The shared map should now have a plain string instead of Y.Text
    expect(typeof map.get("description")).toBe("string");
    expect(map.get("description")).toBe("new string value");
  });

  it("Handles migration from string to Y.Text when disableYText is removed", async () => {
    type Store = {
      description: string;
      setDescription: (description: string) => void;
    };

    const doc = new Y.Doc();
    const map = doc.getMap("shared");

    // Initially populated by old client using plain string
    map.set("description", "old string value");

    const api = createVanilla<Store>(yjs(
      doc,
      "shared",
      (set) =>
      ({
        "description": "",
        "setDescription": (description) =>
          set({ "description": description, }),
      }),
      // Default behavior without disableYText is to use Y.Text
    ));

    // Wait for initial load
    await Promise.resolve();

    // Store should load correctly from string
    expect(api.getState().description).toBe("old string value");

    // Update value, triggering migration
    api.getState().setDescription("new text value");
    await Promise.resolve();

    // The shared map should now have a Y.Text instead of string
    expect(map.get("description")).toBeInstanceOf(Y.Text);
    expect((map.get("description") as Y.Text).toString()).toBe("new text value");
  });

  it("Updates atomic keys correctly during consecutive updates", async () => {
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
      { "disableYText": true }
    ));

    api.getState().setDescription("updated");
    await Promise.resolve();

    // update again
    api.getState().setDescription("updated2");
    await Promise.resolve();

    expect(map.get("description")).toBe("updated2");
  });
});
