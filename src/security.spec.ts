import * as Y from "yjs";
import { objectToYMap } from "./mapping";
import { patchSharedType } from "./patching";

describe("Security: Prototype Pollution", () => {
  it("objectToYMap should filter out dangerous keys", () => {
    const dangerousObject: Record<string, any> = { normal: "value" };
    Object.defineProperty(dangerousObject, "__proto__", { value: { polluted: "yes" }, enumerable: true, configurable: true });
    Object.defineProperty(dangerousObject, "constructor", { value: { polluted: "yes" }, enumerable: true, configurable: true });
    Object.defineProperty(dangerousObject, "prototype", { value: { polluted: "yes" }, enumerable: true, configurable: true });

    const ydoc = new Y.Doc();
    const parentMap = ydoc.getMap("parent");
    parentMap.set("map", objectToYMap(dangerousObject));
    const ymap = parentMap.get("map") as Y.Map<any>;

    expect(ymap.has("__proto__")).toBe(false);
    expect(ymap.has("constructor")).toBe(false);
    expect(ymap.has("prototype")).toBe(false);
    expect(ymap.has("normal")).toBe(true);
    expect(ymap.get("normal")).toBeInstanceOf(Y.Text);
    expect(ymap.get("normal")?.toString()).toBe("value");
  });

  it("patchSharedType should filter out dangerous keys during insert/update", () => {
    const dangerousObject: Record<string, any> = { normal: "value" };
    Object.defineProperty(dangerousObject, "__proto__", { value: { polluted: "yes" }, enumerable: true, configurable: true });
    Object.defineProperty(dangerousObject, "constructor", { value: { polluted: "yes" }, enumerable: true, configurable: true });
    Object.defineProperty(dangerousObject, "prototype", { value: { polluted: "yes" }, enumerable: true, configurable: true });

    const ydoc = new Y.Doc();
    const ymap = ydoc.getMap("test");

    patchSharedType(ymap, dangerousObject);

    expect(ymap.has("__proto__")).toBe(false);
    expect(ymap.has("constructor")).toBe(false);
    expect(ymap.has("prototype")).toBe(false);
    expect(ymap.has("normal")).toBe(true);
    expect(ymap.get("normal")).toBeInstanceOf(Y.Text);
    expect(ymap.get("normal")?.toString()).toBe("value");
  });
});
