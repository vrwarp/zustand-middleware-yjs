import * as Y from "yjs";
import { objectToYMap } from "./mapping";
import { patchSharedType } from "./patching";

describe("Security: Prototype Pollution", () => {
  it("objectToYMap should filter out dangerous keys", () => {
    const dangerousObject = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"polluted": "yes"}, "prototype": {"polluted": "yes"}, "normal": "value"}');
    const ymap = objectToYMap(dangerousObject);

    expect(ymap.has("__proto__")).toBe(false);
    expect(ymap.has("constructor")).toBe(false);
    expect(ymap.has("prototype")).toBe(false);
    expect(ymap.get("normal")).toBeInstanceOf(Y.Text);
    expect(ymap.get("normal")?.toString()).toBe("value");
  });

  it("patchSharedType should filter out dangerous keys during insert/update", () => {
    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap("test");
    const newState = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"polluted": "yes"}, "prototype": {"polluted": "yes"}, "normal": "value"}');

    patchSharedType(ymap, newState);

    expect(ymap.has("__proto__")).toBe(false);
    expect(ymap.has("constructor")).toBe(false);
    expect(ymap.has("prototype")).toBe(false);
    expect(ymap.get("normal")).toBeInstanceOf(Y.Text);
    expect(ymap.get("normal")?.toString()).toBe("value");
  });
});
