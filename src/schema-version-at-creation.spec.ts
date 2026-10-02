import { createStore } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { getYjsStoreHandle, type YjsOptions } from ".";

/*
 * Regression: the `__schemaVersion` poison pill must also apply when the doc
 * ALREADY holds a newer schema at store creation (the cold-start case where
 * y-idb / y-cinder loaded the doc before the store was constructed). The
 * creation-time hydration used to run unconditionally, so a legacy client
 * hydrated newer-schema data, never became obsolete, and its first set()
 * wrote legacy data into the upgraded doc.
 */

type CounterState = {
    count: number;
    inc: () => void;
};

const makeCounterStore = (doc: Y.Doc, options: YjsOptions) =>
    createStore<CounterState>()(yjs(
        doc,
        "store",
        (set) => ({
            "count": 0,
            "inc": () => { set((state) => ({ "count": state.count + 1 })); },
        }),
        options
    ));

/** Drain queued microtasks (inbound/outbound batching) deterministically. */
const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
};

describe("Schema version guard (Poison Pill) at store creation", () => {
    it("is obsolete, keeps defaults, and never writes when the pre-loaded doc has a newer __schemaVersion", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");

        // Doc was loaded (e.g. from IndexedDB) and already holds v5 data.
        doc.transact(() => {
            map.set("__schemaVersion", 5);
            map.set("count", 100);
            map.set("v5OnlyField", "new-shape");
        });

        const onObsolete = jest.fn();
        const onLoaded = jest.fn();
        const store = makeCounterStore(doc, { schemaVersion: 1, onObsolete, onLoaded });

        // No hydration from the newer schema: the store keeps its declared defaults.
        expect(store.getState().count).toBe(0);
        expect(store.getState()).not.toHaveProperty("v5OnlyField");
        expect(store.getState()).not.toHaveProperty("__schemaVersion");
        expect(getYjsStoreHandle(store).hasHydrated()).toBe(false);

        await flushMicrotasks();

        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);
        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(5);
        expect(onLoaded).not.toHaveBeenCalled();

        // A local action must not write legacy data into the upgraded doc.
        const updates: Uint8Array[] = [];

        doc.on("update", (update: Uint8Array) => { updates.push(update); });

        store.getState().inc();
        getYjsStoreHandle(store).flush();
        await flushMicrotasks();

        expect(updates).toHaveLength(0);
        expect(map.toJSON()).toEqual({
            "__schemaVersion": 5,
            "count": 100,
            "v5OnlyField": "new-shape",
        });
        expect(onObsolete).toHaveBeenCalledTimes(1);
    });

    it("applies the creation-time check to the top-level map when the store is scoped", async () => {
        const doc = new Y.Doc();
        const root = doc.getMap("store");

        doc.transact(() => {
            root.set("__schemaVersion", 5);
            const child = new Y.Map<unknown>();

            root.set("device-1", child);
            child.set("count", 100);
        });

        const onObsolete = jest.fn();
        const store = makeCounterStore(doc, {
            schemaVersion: 1,
            onObsolete,
            scope: { key: "device-1" },
        });

        expect(store.getState().count).toBe(0);
        expect(getYjsStoreHandle(store).hasHydrated()).toBe(false);

        await flushMicrotasks();

        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);
        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(5);

        const updates: Uint8Array[] = [];

        doc.on("update", (update: Uint8Array) => { updates.push(update); });

        store.getState().inc();
        getYjsStoreHandle(store).flush();
        await flushMicrotasks();

        expect(updates).toHaveLength(0);
        expect((root.get("device-1") as Y.Map<unknown>).toJSON()).toEqual({ "count": 100 });
    });

    it("does not create the scoped child map in a newer-schema doc that lacks it", async () => {
        const doc = new Y.Doc();
        const root = doc.getMap("store");

        // Upgraded doc with no entry for this device yet.
        root.set("__schemaVersion", 5);

        const onObsolete = jest.fn();
        const store = makeCounterStore(doc, {
            schemaVersion: 1,
            onObsolete,
            scope: { key: "device-1" },
        });

        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        const updates: Uint8Array[] = [];

        doc.on("update", (update: Uint8Array) => { updates.push(update); });

        store.getState().inc();
        getYjsStoreHandle(store).flush();
        await flushMicrotasks();

        expect(updates).toHaveLength(0);
        expect(root.has("device-1")).toBe(false);
        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(5);
    });

    it("still hydrates normally at creation when the pre-loaded doc's __schemaVersion is not newer", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");

        doc.transact(() => {
            map.set("__schemaVersion", 1);
            map.set("count", 100);
        });

        const onObsolete = jest.fn();
        const store = makeCounterStore(doc, { schemaVersion: 1, onObsolete });

        expect(store.getState().count).toBe(100);

        store.getState().inc();
        getYjsStoreHandle(store).flush();
        await flushMicrotasks();

        expect(getYjsStoreHandle(store).isObsolete()).toBe(false);
        expect(onObsolete).not.toHaveBeenCalled();
        expect(map.get("count")).toBe(101);
    });
});
