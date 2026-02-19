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
        // This test confirms that batchPreviousState is locked in at the first set call.
        // We'll mock the internal patchSharedType or infer it from behavior.
        // Since we can't easily mock internal modules here without complex setup,
        // we'll rely on the fact that if previousState was incorrect (e.g. from the last update),
        // the diffing logic might behave differently in a three-way merge scenario.
        // But actually, we can verify this by checking that the 'pending' logic works
        // for a concurrent deletion if we simulate one.

        // Actually, simplest way: reuse the logic from concurrency tests but with MULTIPLE local updates.
        // 1. Initial: { A: 1 }
        // 2. Remote: { B: 2 } (arrives but not yet synced to Zustand store triggers)
        // 3. Local: updates A->2, then A->3 (two updates)
        // If previousState is {A:1} (from start), B is preserved.
        // If previousState is {A:2} (from middle), B might be lost if logic was flawed?
        // Actually, Three-Way merge relies on: keys NOT in previousState are preserved.
        // If previousState was {A:2} (middle), B is NOT in it, so B is preserved regardless.
        // Wait, if B is in the remote map (items: {A:1, B:2}), and previousState is {A:1}, B is not in previous -> preserved.
        // If previousState is {A:2}, B is not in previous -> preserved.

        // We need a case where something IS in previousState but NOT in local state (deleted locally).
        // Suppose we have { A: 1, B: 1 }.
        // Remote changes A -> 2.
        // Local deletes B (batch update 1).
        // Local updates A -> 3 (batch update 2).
        // If previousState is captured at update 1 ({ A: 1, B: 1 }), then B is in previous, not in current -> Deletion committed.
        // If previousState was captured at update 2 ({ A: 1, B: undefined }), B is NOT in previous... wait.
        // If B was deleted in update 1, state at update 2 start is { A: 1 }.
        // If we used that as previousState ({ A: 1 }), then comparing to final ({ A: 3 }),
        // we see B is missing in BOTH previous and current. So no delete op generated?
        // If no delete op generated, B remains in Yjs (ghost/resurrection issue).

        // Correct behavior: B should be deleted from Yjs.
        // So ensuring previousState is { A: 1, B: 1 } is CRITICAL.

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
        // If previousState was captured at step 2 ({A:1}), B was already gone from it.
        // patchSharedType(map={A:1,B:1}, newState={A:2}, prev={A:1})
        // diff(prev, new) -> A changed. B is missing in both, so no delete change detected?
        // Result: B stays in Yjs! (Bug)

        // If previousState was captured at step 1 ({A:1,B:1}):
        // patchSharedType(map={A:1,B:1}, newState={A:2}, prev={A:1,B:1})
        // diff(prev, new) -> A changed, B deleted.
        // Result: B deleted from Yjs. (Correct)

        expect(finalMap).not.toHaveProperty("B");
        expect(finalMap).toEqual({ "A": 2 });
    });
});
