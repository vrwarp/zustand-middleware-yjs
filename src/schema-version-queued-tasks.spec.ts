import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { getYjsStoreHandle, } from ".";

/*
 * Regression: the schema-version poison pill must halt sync for work that was
 * ALREADY QUEUED when it fired, not only for work scheduled afterwards.
 *
 * The README promises that once a newer `__schemaVersion` is seen the
 * middleware "permanently halts all outbound and inbound synchronization".
 * Outbound flushes and inbound batches are deferred to a microtask, so a
 * local set() (or a remote data update) followed in the same task by the
 * remote schema bump leaves a queued task behind. That queued task must not
 * write legacy state over the migrated document (downgrading
 * `__schemaVersion`) nor patch newer-schema data into the legacy store.
 */

type Store = {
    count: number;
    label: string;
    setCount: (count: number) => void;
};

const STORE_NAME = "store";

// The v1 document both peers start from (as written by a v1 client).
const seedV1Doc = (): Y.Doc => {
    const doc = new Y.Doc();
    const map = doc.getMap(STORE_NAME);

    doc.transact(() => {
        map.set("__schemaVersion", 1);
        map.set("count", 0);
        map.set("label", "a");
    });

    return doc;
};

const clone = (source: Y.Doc): Y.Doc => {
    const doc = new Y.Doc();

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), "remote");

    return doc;
};

// Apply a remote transaction made on `peer` to `target`, like a provider would.
const deliver = (peer: Y.Doc, target: Y.Doc, change: (map: Y.Map<unknown>) => void): void => {
    const before = Y.encodeStateVector(target);

    peer.transact(() => change(peer.getMap(STORE_NAME)));
    Y.applyUpdate(target, Y.encodeStateAsUpdate(peer, before), "remote");
};

// The v2 migration: bump the marker and restructure `count`.
const migrateToV2 = (map: Y.Map<unknown>): void => {
    map.set("__schemaVersion", 2);
    map.set("count", { "migrated": true, "value": 5, });
};

// Every queued microtask (outbound flush / inbound batch) has run once a
// macrotask boundary is crossed; no real timing is involved.
const drainMicrotasks = (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, 0);
});

const makeLegacyStore = (doc: Y.Doc, scopedDiff: boolean, onObsolete: (version: number) => void) =>
    createVanilla<Store>(yjs(
        doc,
        STORE_NAME,
        (set) => ({
            "count": 0,
            "label": "a",
            "setCount": (count) => set({ count, }),
        }),
        { schemaVersion: 1, onObsolete, scopedDiff, }
    ));

describe.each([
    ["legacy full diff", false],
    ["scopedDiff", true],
])("Poison pill halts work queued before it fired (%s)", (_label, scopedDiff) => {
    it("does not flush a local set() queued before the schema bump over the migrated doc", async () => {
        const v2Peer = seedV1Doc();
        const legacyDoc = clone(v2Peer);
        const onObsolete = jest.fn();
        const store = makeLegacyStore(legacyDoc, scopedDiff, onObsolete);

        // Local edit: queues the outbound flush for the end of this task.
        store.getState().setCount(1);

        // Same task: a v2 peer's migration arrives before the flush runs.
        deliver(v2Peer, legacyDoc, migrateToV2);

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(2);
        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        await drainMicrotasks();

        // Nothing may be written once obsolete: the doc stays exactly as the
        // v2 peer left it (no legacy count, no downgraded __schemaVersion).
        const map = legacyDoc.getMap(STORE_NAME);

        expect(map.get("__schemaVersion")).toBe(2);
        expect(map.toJSON()).toEqual(v2Peer.getMap(STORE_NAME).toJSON());
    });

    it("does not let api.yjs.flush() write a set() queued before the schema bump", async () => {
        const v2Peer = seedV1Doc();
        const legacyDoc = clone(v2Peer);
        const onObsolete = jest.fn();
        const store = makeLegacyStore(legacyDoc, scopedDiff, onObsolete);

        store.setState({ "count": 1, });
        deliver(v2Peer, legacyDoc, migrateToV2);

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        // A synchronous drain after obsolescence must be a no-op as well.
        getYjsStoreHandle(store).flush();
        await drainMicrotasks();

        expect(legacyDoc.getMap(STORE_NAME).toJSON()).toEqual(v2Peer.getMap(STORE_NAME).toJSON());
    });

    it("does not apply newer-schema data from an inbound batch queued before the schema bump", async () => {
        const remotePeer = seedV1Doc();
        const legacyDoc = clone(remotePeer);
        const onObsolete = jest.fn();
        const store = makeLegacyStore(legacyDoc, scopedDiff, onObsolete);

        // Two remote transactions delivered back to back in one task (e.g. a
        // provider applying updates from separate callbacks or an async
        // continuation): an ordinary v1 edit to `count`, then the v2
        // migration that restructures `count`.
        deliver(remotePeer, legacyDoc, (map) => map.set("count", 1));
        deliver(remotePeer, legacyDoc, migrateToV2);

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(2);
        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        await drainMicrotasks();

        // The legacy store must never receive v2-shaped data.
        const state = store.getState() as Store & { __schemaVersion?: unknown };

        expect(typeof state.count).toBe("number");
        expect(state.count).not.toEqual({ "migrated": true, "value": 5, });
        expect(state.__schemaVersion).not.toBe(2);
    });
});

/*
 * Same race for a `scope`-bound store, with the remote transactions made
 * directly on the shared doc. The poison pill reads the TOP-LEVEL map while
 * the store's data lives in the nested scoped map.
 */
describe.each([
    ["legacy full diff", false],
    ["scopedDiff", true],
])("Poison pill halts work queued before it fired under scope (%s)", (_label, scopedDiff) => {
    const SCOPE_KEY = "device-a";

    const seedScopedV1Doc = (): Y.Doc => {
        const doc = new Y.Doc();
        const map = doc.getMap(STORE_NAME);

        doc.transact(() => {
            const data = new Y.Map<unknown>();

            map.set("__schemaVersion", 1);
            map.set(SCOPE_KEY, data);
            data.set("count", 0);
            data.set("label", "a");
        });

        return doc;
    };

    const scopedData = (doc: Y.Doc): Y.Map<unknown> =>
        doc.getMap(STORE_NAME).get(SCOPE_KEY) as Y.Map<unknown>;

    const migrateScopedToV2 = (doc: Y.Doc): void => {
        doc.transact(() => {
            doc.getMap(STORE_NAME).set("__schemaVersion", 2);
            scopedData(doc).set("count", { "migrated": true, "value": 5, });
        }, "remote");
    };

    const makeScopedLegacyStore = (doc: Y.Doc, onObsolete: (version: number) => void) =>
        createVanilla<Store>(yjs(
            doc,
            STORE_NAME,
            (set) => ({
                "count": 0,
                "label": "a",
                "setCount": (count) => set({ count, }),
            }),
            { schemaVersion: 1, onObsolete, scopedDiff, scope: { key: SCOPE_KEY, }, }
        ));

    it("does not flush a local set() queued before the schema bump into the scoped map", async () => {
        const doc = seedScopedV1Doc();
        const onObsolete = jest.fn();
        const store = makeScopedLegacyStore(doc, onObsolete);

        store.getState().setCount(1);
        migrateScopedToV2(doc);

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(2);
        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        await drainMicrotasks();

        expect(doc.getMap(STORE_NAME).toJSON()).toEqual({
            "__schemaVersion": 2,
            [SCOPE_KEY]: { "count": { "migrated": true, "value": 5, }, "label": "a", },
        });
    });

    it("does not apply newer-schema data from a scoped inbound batch queued before the schema bump", async () => {
        const doc = seedScopedV1Doc();
        const onObsolete = jest.fn();
        const store = makeScopedLegacyStore(doc, onObsolete);

        doc.transact(() => scopedData(doc).set("count", 1), "remote");
        migrateScopedToV2(doc);

        expect(onObsolete).toHaveBeenCalledTimes(1);
        expect(onObsolete).toHaveBeenCalledWith(2);
        expect(getYjsStoreHandle(store).isObsolete()).toBe(true);

        await drainMicrotasks();

        const { count, } = store.getState();

        expect(typeof count).toBe("number");
        expect(count).not.toEqual({ "migrated": true, "value": 5, });
    });
});
