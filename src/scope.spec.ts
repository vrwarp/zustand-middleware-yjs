import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle } from ".";

/**
 * Fork contract suite — the `scope: { key }` nested-map binding: creation
 * timing, inbound path filtering, the obsolete check unaffected. Designed for
 * a store rebinding its unchanged flat state to a nested map (e.g.
 * `preferences.<deviceId>`) so zero consumer call sites change.
 */

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

const countUpdates = (doc: Y.Doc): { count: () => number } => {
  let n = 0;
  doc.on("update", () => {
    n += 1;
  });
  return { count: () => n };
};

interface PrefState {
  currentTheme: string;
  fontSize: number;
  setTheme: (theme: string) => void;
  setFontSize: (size: number) => void;
}

const creator = (set: (fn: (s: PrefState) => Partial<PrefState>) => void): PrefState => ({
  currentTheme: "light",
  fontSize: 16,
  setTheme: (currentTheme) => set(() => ({ currentTheme })),
  setFontSize: (fontSize) => set(() => ({ fontSize })),
});

const OPTS = { disableYText: true } as const;

describe("scope contract — creation timing", () => {
  it("creating the store does NOT create the scoped child map; the first outbound flush does (lazily)", async () => {
    const doc = new Y.Doc();
    const updates = countUpdates(doc);
    const store = createStore<PrefState>(
      yjs(doc, "preferences", creator, { ...OPTS, scope: { key: "device-a" } }),
    );

    // Late-join safety preserved under scope: creation writes nothing.
    expect(updates.count()).toBe(0);
    expect(doc.getMap("preferences").has("device-a")).toBe(false);

    store.getState().setTheme("dark");
    await drain();

    const child = doc.getMap("preferences").get("device-a") as Y.Map<unknown>;
    expect(child).toBeInstanceOf(Y.Map);
    expect(child.toJSON()).toEqual({ currentTheme: "dark", fontSize: 16 });
    // The data lives under the scope key, NOT at the top level.
    expect(doc.getMap("preferences").has("currentTheme")).toBe(false);
  });

  it("a new device id starts from declared defaults even when siblings exist", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const sibling = new Y.Map();
      sibling.set("currentTheme", "sepia");
      sibling.set("fontSize", 22);
      doc.getMap("preferences").set("device-b", sibling);
    });

    const store = createStore<PrefState>(
      yjs(doc, "preferences", creator, { ...OPTS, scope: { key: "device-a" } }),
    );

    expect(store.getState().currentTheme).toBe("light"); // defaults, not device-b's
    expect(getYjsStoreHandle(store).hasHydrated()).toBe(false); // own map empty
  });
});

describe("scope contract — initial hydration from a pre-populated child", () => {
  it("hydrates synchronously at creation from map.get(scope.key)", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const child = new Y.Map();
      child.set("currentTheme", "dark");
      child.set("fontSize", 18);
      doc.getMap("preferences").set("device-a", child);
    });

    const onLoaded = jest.fn();
    const store = createStore<PrefState>(
      yjs(doc, "preferences", creator, {
        ...OPTS,
        scope: { key: "device-a" },
        onLoaded,
      }),
    );

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(store.getState().currentTheme).toBe("dark");
    expect(store.getState().fontSize).toBe(18);
    expect(getYjsStoreHandle(store).hasHydrated()).toBe(true);
  });
});

describe("scope contract — inbound path filtering", () => {
  it("sibling devices' changes never patch the store or notify subscribers; own-key changes do", async () => {
    const docA = new Y.Doc();
    const store = createStore<PrefState>(
      yjs(docA, "preferences", creator, { ...OPTS, scope: { key: "device-a" } }),
    );
    store.getState().setTheme("dark");
    await drain();

    const subscriber = jest.fn();
    store.subscribe(subscriber);

    // A remote peer writes a SIBLING device's prefs.
    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.transact(() => {
      const sibling = new Y.Map();
      sibling.set("currentTheme", "sepia");
      docB.getMap("preferences").set("device-b", sibling);
    });
    replicate(docB, docA);
    await drain();

    expect(subscriber).not.toHaveBeenCalled();
    expect(store.getState().currentTheme).toBe("dark");

    // A remote change UNDER our key patches normally.
    docB.transact(() => {
      (docB.getMap("preferences").get("device-a") as Y.Map<unknown>)
        .set("fontSize", 24);
    });
    replicate(docB, docA);
    await drain();

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(store.getState().fontSize).toBe(24);
    expect(store.getState().currentTheme).toBe("dark");
  });

  it("outbound writes are confined to the scoped subtree (siblings untouched)", async () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const sibling = new Y.Map();
      sibling.set("currentTheme", "sepia");
      doc.getMap("preferences").set("device-b", sibling);
    });

    const store = createStore<PrefState>(
      yjs(doc, "preferences", creator, { ...OPTS, scope: { key: "device-a" } }),
    );
    store.getState().setFontSize(20);
    await drain();

    expect((doc.getMap("preferences").get("device-b") as Y.Map<unknown>).toJSON())
      .toEqual({ currentTheme: "sepia" }); // untouched
    expect((doc.getMap("preferences").get("device-a") as Y.Map<unknown>).toJSON())
      .toEqual({ currentTheme: "light", fontSize: 20 });
  });
});

describe("scope contract — obsolete check unaffected", () => {
  it("the poison pill still reads __schemaVersion from the TOP-LEVEL named map", async () => {
    const docA = new Y.Doc();
    const onObsolete = jest.fn();
    const store = createStore<PrefState>(
      yjs(docA, "preferences", creator, {
        ...OPTS,
        scope: { key: "device-a" },
        schemaVersion: 5,
        onObsolete,
      }),
    );
    store.getState().setTheme("dark");
    await drain();

    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.getMap("preferences").set("__schemaVersion", 6);
    replicate(docB, docA);
    await drain();

    expect(onObsolete).toHaveBeenCalledWith(6);
    expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

    // Outbound halted: local sets stay local.
    const updates = countUpdates(docA);
    store.getState().setTheme("void");
    await drain();
    expect(updates.count()).toBe(0);
  });
});

describe("scope contract — combined with scopedDiff and merge-defaults", () => {
  it("scoped store with scopedDiff + merge-defaults syncs its subtree and retains new defaults", async () => {
    // An old-format child: has currentTheme, lacks fontSize.
    const doc = new Y.Doc();
    doc.transact(() => {
      const child = new Y.Map();
      child.set("currentTheme", "dark");
      doc.getMap("preferences").set("device-a", child);
    });

    const store = createStore<PrefState>(
      yjs(doc, "preferences", creator, {
        ...OPTS,
        scope: { key: "device-a" },
        scopedDiff: true,
        hydration: "merge-defaults",
        syncedKeys: ["currentTheme", "fontSize"],
      }),
    );

    expect(store.getState().currentTheme).toBe("dark"); // hydrated
    expect(store.getState().fontSize).toBe(16); // retained default

    // Remote nested change under our key applies through the scoped path.
    const remote = new Y.Doc();
    replicate(doc, remote);
    remote.transact(() => {
      (remote.getMap("preferences").get("device-a") as Y.Map<unknown>)
        .set("currentTheme", "sepia");
    });
    replicate(remote, doc);
    await drain();
    expect(store.getState().currentTheme).toBe("sepia");

    // Local write lands under the scope key only.
    store.getState().setFontSize(21);
    await drain();
    expect((doc.getMap("preferences").get("device-a") as Y.Map<unknown>).get("fontSize"))
      .toBe(21);
    expect(doc.getMap("preferences").has("fontSize")).toBe(false);
  });
});
