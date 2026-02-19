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

        // Intercept queueMicrotask to detect if processBatch is ever scheduled.
        let processBatchScheduled = false;
        const originalQueueMicrotask = globalThis.queueMicrotask;
        globalThis.queueMicrotask = (cb: () => void) => {
            processBatchScheduled = true;
            originalQueueMicrotask(cb);
        };

        try {
            // A local setState triggers patchSharedType → Yjs transact with origin=api.
            // The observeDeep callback should detect origin === api and return early,
            // never calling queueMicrotask.
            api.getState().increment();

            // processBatch must NOT have been queued by the observer.
            expect(processBatchScheduled).toBe(false);

            // Flush the microtask queue for thoroughness.
            await Promise.resolve();

            // State is correct (local set worked) and no echo was scheduled.
            expect(api.getState().count).toBe(1);
            expect(processBatchScheduled).toBe(false);
        }
        finally {
            globalThis.queueMicrotask = originalQueueMicrotask;
        }
    });
});
