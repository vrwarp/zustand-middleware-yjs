import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

type Store = {
    count: number;
    increment: () => void;
};

const makeStore = (doc: Y.Doc, name: string, options?: Parameters<typeof yjs>[3]) =>
    createVanilla<Store>(yjs(
        doc,
        name,
        (set) => ({
            "count": 0,
            "increment": () =>
                set((state) => ({ "count": state.count + 1, })),
        }),
        options
    ));

describe("Schema version guard (Poison Pill)", () => {
    it("ignores __schemaVersion when schemaVersion option is not set", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");
        const api = makeStore(doc, "store"); // no schemaVersion option

        // Simulate a remote peer writing a higher schema version.
        doc.transact(() => {
            map.set("__schemaVersion", 99);
            map.set("count", 42);
        });

        // Flush inbound microtask.
        await Promise.resolve();

        // Sync should proceed normally — the middleware ignores the key.
        expect(api.getState().count).toBe(42);
    });

    it("fires onObsolete and halts inbound sync when remote version exceeds local", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");
        const onObsolete = jest.fn();

        const api = makeStore(doc, "store", {
            schemaVersion: 1,
            onObsolete,
        });

        // Remote peer upgrades schema.
        doc.transact(() => {
            map.set("__schemaVersion", 2);
            map.set("count", 100);
        });

        // Flush inbound microtask (if any were scheduled).
        await Promise.resolve();

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(2);
        // Zustand should NOT have patched to the remote state.
        expect(api.getState().count).toBe(0);
    });

    it("prevents outbound writes after obsolescence", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");

        const api = makeStore(doc, "store", {
            schemaVersion: 1,
            onObsolete: () => { },
        });

        // Trigger obsolescence.
        doc.transact(() => {
            map.set("__schemaVersion", 5);
        });
        await Promise.resolve();

        // Local mutation — should NOT propagate to Yjs.
        api.getState().increment();
        await Promise.resolve(); // flush outbound microtask

        // The map should NOT have a "count" key written by this client.
        expect(map.get("count")).toBeUndefined();
    });

    it("continues syncing when incoming version is <= local version", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");
        const onObsolete = jest.fn();

        const api = makeStore(doc, "store", {
            schemaVersion: 3,
            onObsolete,
        });

        // Remote peer has same or lower version.
        doc.transact(() => {
            map.set("__schemaVersion", 3);
            map.set("count", 7);
        });

        await Promise.resolve();

        expect(onObsolete).not.toHaveBeenCalled();
        expect(api.getState().count).toBe(7);
    });

    it("permanently ignores all subsequent inbound events after obsolescence", async () => {
        const doc = new Y.Doc();
        const map = doc.getMap("store");
        const onObsolete = jest.fn();

        const api = makeStore(doc, "store", {
            schemaVersion: 1,
            onObsolete,
        });

        // First remote event — triggers obsolescence.
        doc.transact(() => {
            map.set("__schemaVersion", 2);
            map.set("count", 10);
        });
        await Promise.resolve();

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(api.getState().count).toBe(0);

        // Second remote event — should be completely ignored.
        doc.transact(() => {
            map.set("count", 20);
        });
        await Promise.resolve();

        // onObsolete should NOT fire again; store remains unchanged.
        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(api.getState().count).toBe(0);
    });
});
