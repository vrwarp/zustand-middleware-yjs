import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling } from ".";

/**
 * Regression: a set() issued from a store subscriber WHILE another set() is
 * running (zustand notifies listeners synchronously inside set) must not
 * become the outbound batch's baseline. The batch baseline has to be the
 * state from BEFORE the outermost write of the tick; otherwise
 *   - scopedDiff skips every key the outer write changed (they are
 *     Object.is-equal between the shifted baseline and the final state), and
 *   - in both modes the previousState delete guard mistakes keys removed by
 *     the outer write for concurrent remote inserts and never deletes them.
 *
 * Contract: after the batch settles, the doc mirrors the store.
 */

/** Outbound batching runs on a microtask; a macrotask boundary drains it. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const MODES = [
  { mode: "legacy full diff", scopedDiff: false },
  { mode: "scopedDiff", scopedDiff: true },
] as const;

let savedSamplingRate = __scopedDiffDevSampling.rate;

beforeEach(() => {
  // Keep the random DEV tripwire out of the picture so the outcome is
  // deterministic and the failure is the doc assertion below.
  savedSamplingRate = __scopedDiffDevSampling.rate;
  __scopedDiffDevSampling.rate = 0;
});

afterEach(() => {
  __scopedDiffDevSampling.rate = savedSamplingRate;
});

describe("re-entrant set() from a subscriber during another set()", () => {
  interface CounterState {
    a: number;
    b: number;
    setA: (a: number) => void;
  }

  // The legacy variant passed even before the fix (the full diff still
  // writes updates); it is kept as a regression check for that mode.
  it.each(MODES)(
    "[$mode] the outer write still reaches the doc when a subscriber derives a key from it",
    async ({ scopedDiff }) => {
      const doc = new Y.Doc();
      const store = createStore<CounterState>()(
        yjs(
          doc,
          "m",
          (set) => ({
            a: 0,
            b: 0,
            setA: (a) => set({ a }),
          }),
          { disableYText: true, scopedDiff }
        )
      );

      // Settle an initial write of every key (scopedDiff lazily defers
      // never-set defaults) so the next write starts a fresh batch.
      store.setState({ a: 1, b: 10 });
      await drain();
      expect(doc.getMap("m").toJSON()).toEqual({ a: 1, b: 10 });

      // Common zustand pattern: derive one key from another in a subscriber.
      store.subscribe((state, prev) => {
        if (state.a !== prev.a) {
          store.setState({ b: state.a * 10 });
        }
      });

      store.getState().setA(5);
      await drain();

      expect(store.getState().a).toBe(5);
      expect(store.getState().b).toBe(50);
      expect(doc.getMap("m").toJSON()).toEqual({ a: 5, b: 50 });
    }
  );

  interface ItemsState {
    items: Record<string, number>;
    updatedAt: number;
  }

  it.each(MODES)(
    "[$mode] a record removed by the outer write is deleted from the doc when a subscriber stamps updatedAt",
    async ({ scopedDiff }) => {
      const doc = new Y.Doc();
      const store = createStore<ItemsState>()(
        yjs(
          doc,
          "m",
          () => ({
            items: {} as Record<string, number>,
            updatedAt: 0,
          }),
          { disableYText: true, scopedDiff }
        )
      );

      store.setState({ items: { x: 1, y: 2 }, updatedAt: 1 });
      await drain();
      expect(doc.getMap("m").toJSON()).toEqual({
        items: { x: 1, y: 2 },
        updatedAt: 1,
      });

      // Stamp updatedAt whenever items changes.
      store.subscribe((state, prev) => {
        if (state.items !== prev.items) {
          store.setState({ updatedAt: state.updatedAt + 1 });
        }
      });

      // Remove item "y".
      const { y: _removed, ...withoutY } = store.getState().items;

      store.setState({ items: withoutY });
      await drain();

      expect(store.getState()).toEqual({ items: { x: 1 }, updatedAt: 2 });
      expect(doc.getMap("m").toJSON()).toEqual({
        items: { x: 1 },
        updatedAt: 2,
      });
    }
  );

  interface ReplaceState {
    a: number;
    derived: number;
    extra?: number;
  }

  it.each(MODES)(
    "[$mode] a top-level key dropped by an outer replace is deleted from the doc",
    async ({ scopedDiff }) => {
      const doc = new Y.Doc();
      const store = createStore<ReplaceState>()(
        yjs(
          doc,
          "m",
          () => ({ a: 0, derived: 0 } as ReplaceState),
          { disableYText: true, scopedDiff }
        )
      );

      store.setState({ a: 1, derived: 10, extra: 7 });
      await drain();
      expect(doc.getMap("m").toJSON()).toEqual({ a: 1, derived: 10, extra: 7 });

      store.subscribe((state, prev) => {
        if (state.a !== prev.a) {
          store.setState({ derived: state.a * 10 });
        }
      });

      // replace=true drops "extra" at the top level.
      store.setState({ a: 2, derived: 10 }, true);
      await drain();

      expect(store.getState()).toEqual({ a: 2, derived: 20 });
      expect(doc.getMap("m").toJSON()).toEqual({ a: 2, derived: 20 });
    }
  );
});
