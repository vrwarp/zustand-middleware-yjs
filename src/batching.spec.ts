import { createStore as createVanilla, } from "zustand/vanilla";
import * as Y from "yjs";
import yjs from ".";

describe("Inbound Microtask Batching", () => {
    it("Coalesces multiple remote transactions into one store update per tick", async () => {
        type Store =
            {
                values: number[],
            };

        const doc = new Y.Doc();
        const storeName = "store";

        const storeApi = createVanilla<Store>(yjs(
            doc,
            storeName,
            (): Store => ({ "values": [], })
        ));

        // Track how many times the store state actually changes (i.e., patchStore fires).
        let storeNotifications = 0;
        storeApi.subscribe(() => {
            storeNotifications++;
        });

        // Reset after initial subscription setup.
        storeNotifications = 0;

        // Apply 5 separate synchronous Yjs transactions.
        // Each fires the observeDeep callback, but batching should coalesce them
        // into a single patchStore call via queueMicrotask.
        const map = doc.getMap(storeName);

        doc.transact(() => { map.set("_arr", new Y.Array()); });
        doc.transact(() => { (map.get("_arr") as Y.Array<any>).push([1]); });
        doc.transact(() => { (map.get("_arr") as Y.Array<any>).push([2]); });
        doc.transact(() => { (map.get("_arr") as Y.Array<any>).push([3]); });
        doc.transact(() => { (map.get("_arr") as Y.Array<any>).push([4]); });

        // The microtask has NOT run yet – the store must not have been notified.
        expect(storeNotifications).toBe(0);

        // Flush the microtask queue.
        await Promise.resolve();

        // Despite 5 separate Yjs transactions, exactly 1 store notification should fire.
        expect(storeNotifications).toBe(1);
    });

    it("Suppresses local echo (does not schedule a microtask for own transactions)", async () => {
        type Store =
            {
                count: number,
                increment: () => void,
            };

        const doc = new Y.Doc();

        const api = createVanilla<Store>(yjs(
            doc,
            "store",
            (set) =>
            ({
                "count": 0,
                "increment": () =>
                    set((state) =>
                        ({ "count": state.count + 1, })),
            })
        ));

        // Intercept queueMicrotask to detect if processBatch (inbound) is ever scheduled.
        // Note: outbound batching WILL schedule a microtask via scheduleOutbound, so we
        // only start tracking AFTER the outbound microtask has been queued.
        api.getState().increment();

        // Capture any queueMicrotask calls that happen AFTER the initial set.
        let inboundBatchScheduled = false;
        const originalQueueMicrotask = globalThis.queueMicrotask;
        globalThis.queueMicrotask = (cb: () => void) => {
            inboundBatchScheduled = true;
            originalQueueMicrotask(cb);
        };

        try {
            // Flush the pending outbound microtask — this fires flushOutbound, which
            // writes to Yjs with origin=api, which triggers observeDeep, which should
            // detect origin === api and NOT schedule the inbound processBatch.
            await Promise.resolve();

            // The inbound processBatch must NOT have been queued by the observer.
            expect(inboundBatchScheduled).toBe(false);

            // State is correct (local set worked).
            expect(api.getState().count).toBe(1);
        }
        finally {
            globalThis.queueMicrotask = originalQueueMicrotask;
        }
    });
});

describe("Outbound Microtask Batching", () => {
    it("Coalesces multiple set() calls into one Yjs transaction per tick", async () => {
        type Store = {
            count: number;
            increment: () => void;
        };

        const doc = new Y.Doc();
        const map = doc.getMap("store");

        const api = createVanilla<Store>(yjs(
            doc,
            "store",
            (set) => ({
                "count": 0,
                "increment": () => set((state) => ({ "count": state.count + 1, })),
            })
        ));

        // Call increment 5× synchronously — each calls set() internally.
        api.getState().increment();
        api.getState().increment();
        api.getState().increment();
        api.getState().increment();
        api.getState().increment();

        // Zustand is up-to-date immediately (optimistic local state).
        expect(api.getState().count).toBe(5);

        // Yjs has NOT been written yet — microtask hasn't fired.
        expect(map.get("count")).toBeUndefined();

        // Flush the microtask queue — one Yjs transaction should fire.
        await Promise.resolve();

        // Yjs now reflects the FINAL state (5), not intermediate values.
        expect(map.get("count")).toBe(5);
    });

    it("Coalesces multiple api.setState() calls into one Yjs transaction per tick", async () => {
        type Store = {
            a: number;
            b: number;
            c: number;
        };

        const doc = new Y.Doc();
        const map = doc.getMap("store");

        const api = createVanilla<Store>(yjs(
            doc,
            "store",
            () => ({ "a": 0, "b": 0, "c": 0, })
        ));

        // Three separate setState calls synchronously.
        api.setState({ "a": 1, });
        api.setState({ "b": 2, });
        api.setState({ "c": 3, });

        // Zustand is up to date immediately.
        expect(api.getState()).toMatchObject({ "a": 1, "b": 2, "c": 3, });

        // Yjs has NOT been written yet.
        expect(map.get("a")).toBeUndefined();
        expect(map.get("b")).toBeUndefined();
        expect(map.get("c")).toBeUndefined();

        // Flush — one batch should write all three fields.
        await Promise.resolve();

        expect(map.get("a")).toBe(1);
        expect(map.get("b")).toBe(2);
        expect(map.get("c")).toBe(3);
    });

    it("Uses the state from the FIRST update in the batch as previousState for the merge", async () => {
        // This test confirms that previousState is locked in at the first set call of a batch.
        // This is critical for correctly detecting deletions that occur within the batch.
        // If previousState was captured later (e.g., after a deletion), the diffing
        // logic would fail to see the deletion, leading to "ghost" data in Yjs.

        type Store = {
            items: Record<string, number>;
            init: () => void;
            deleteItem: (key: string) => void;
            updateItem: (key: string, val: number) => void;
        };

        const doc = new Y.Doc();
        const map = doc.getMap("store");
        const api = createVanilla<Store>(yjs(
            doc,
            "store",
            (set) => ({
                items: {},
                init: () => set({ items: { "A": 1, "B": 1 } }),
                deleteItem: (key) => set(s => {
                    const next = { ...s.items };
                    delete next[key];
                    return { items: next };
                }),
                updateItem: (key, val) => set(s => ({ items: { ...s.items, [key]: val } })),
            })
        ));

        // Initial sync
        api.getState().init();
        await Promise.resolve();
        expect((map.get("items") as any).toJSON()).toEqual({ "A": 1, "B": 1 });

        // Batch:
        // 1. Delete B
        api.getState().deleteItem("B");
        // 2. Update A (same tick)
        api.getState().updateItem("A", 2);

        expect(api.getState().items).toEqual({ "A": 2 }); // Local state correct

        // Flush
        await Promise.resolve();

        const finalMap = (map.get("items") as any).toJSON();
        // If previousState was correctly captured at the start of the batch,
        // the diff will correctly identify that 'B' was deleted.

        expect(finalMap).not.toHaveProperty("B");
        expect(finalMap).toEqual({ "A": 2 });
    });
});
