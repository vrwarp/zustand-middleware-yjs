import * as fc from "fast-check";
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling } from ".";
import { assertScopedDiffConvergence } from "./patching";

/**
 * Fork contract suite — per-key scoped diffing (cases D.1–D.6). Default OFF =
 * legacy full-tree diff, pinned by the existing specs.
 *
 * The two divergence tripwires live here:
 *   - D.1: fast-check equivalence property (scoped ≡ full diff, incl. two-doc
 *     concurrent merges);
 *   - D.3: the DEV full-diff sampling assert fails LOUDLY on mutate-in-place
 *     writes the Object.is fast path cannot see.
 */

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const replicate = (from: Y.Doc, to: Y.Doc): void => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
};

interface State {
  count: number;
  label: string;
  items: Record<string, { n: number; tags: string[] }>;
  inc: () => void;
  setLabel: (label: string) => void;
  setItem: (id: string, n: number, tags: string[]) => void;
  delItem: (id: string) => void;
}

const creator = (set: (fn: (s: State) => Partial<State>) => void): State => ({
  count: 0,
  label: "start",
  items: {},
  inc: () => set((s) => ({ count: s.count + 1 })),
  setLabel: (label) => set(() => ({ label })),
  setItem: (id, n, tags) =>
    set((s) => ({ items: { ...s.items, [id]: { n, tags } } })),
  delItem: (id) =>
    set((s) => {
      const items = { ...s.items };
      delete items[id];
      return { items };
    }),
});

const OPTS = { disableYText: true } as const;

type Op =
  | { kind: "inc" }
  | { kind: "setLabel"; label: string }
  | { kind: "setItem"; id: string; n: number; tags: string[] }
  | { kind: "delItem"; id: string };

const applyOp = (store: { getState: () => State }, op: Op): void => {
  switch (op.kind) {
    case "inc": store.getState().inc(); break;
    case "setLabel": store.getState().setLabel(op.label); break;
    case "setItem": store.getState().setItem(op.id, op.n, op.tags); break;
    case "delItem": store.getState().delItem(op.id); break;
  }
};

const opArb = (ids: readonly string[]): fc.Arbitrary<Op> =>
  fc.oneof(
    fc.constant<Op>({ kind: "inc" }),
    fc.record({
      kind: fc.constant("setLabel" as const),
      label: fc.string({ maxLength: 8 }),
    }),
    fc.record({
      kind: fc.constant("setItem" as const),
      id: fc.constantFrom(...ids),
      n: fc.integer({ min: -100, max: 100 }),
      tags: fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
    }),
    fc.record({
      kind: fc.constant("delItem" as const),
      id: fc.constantFrom(...ids),
    }),
  );

/** Ticks of ops: ops within a tick share one outbound batch. */
const ticksArb = (ids: readonly string[]) =>
  fc.array(fc.array(opArb(ids), { minLength: 1, maxLength: 4 }), {
    minLength: 1,
    maxLength: 5,
  });

const dataOf = (state: State): Record<string, unknown> => ({
  count: state.count,
  label: state.label,
  items: state.items,
});

afterEach(() => {
  __scopedDiffDevSampling.rate = 0.02; // restore the default
});

/**
 * Touch every top-level key once. After this seed both diff modes have written
 * every key to the doc, so from here on scoped and full diff must produce
 * IDENTICAL docs. (Before a key's first write the modes legitimately differ:
 * scoped diff defers never-set defaults — the lazy-backfill contract pinned in
 * D.6/C.7 — while the legacy full diff writes all keys eagerly.)
 */
const seed = (store: { getState: () => State }): void => {
  store.getState().inc();
  store.getState().setLabel("seeded");
  store.getState().setItem("a", 0, []);
};

describe("contract D.1 — fast-check equivalence: scoped diff ≡ full diff", () => {
  it("random update sequences converge scoped and full stores to identical doc JSON and state", async () => {
    // The convergence tripwire runs IN-BAND below (after every settle) rather
    // than via the production async sampling, so a divergence is a normal,
    // shrinkable property failure instead of an unhandled microtask error.
    __scopedDiffDevSampling.rate = 0;

    await fc.assert(
      fc.asyncProperty(ticksArb(["a", "b", "c"]), async (ticks) => {
        const scopedDoc = new Y.Doc();
        const scopedStore = createStore<State>(
          yjs(scopedDoc, "s", creator, { ...OPTS, scopedDiff: true }),
        );
        const fullDoc = new Y.Doc();
        const fullStore = createStore<State>(yjs(fullDoc, "s", creator, OPTS));

        seed(scopedStore);
        seed(fullStore);
        await drain();
        expect(scopedDoc.getMap("s").toJSON()).toEqual(fullDoc.getMap("s").toJSON());
        assertScopedDiffConvergence(scopedDoc.getMap("s"), scopedStore.getState());

        for (const tick of ticks) {
          for (const op of tick) {
            applyOp(scopedStore, op);
            applyOp(fullStore, op);
          }
          await drain();
          // In-band divergence tripwire: a scoped flush that left the doc
          // diverged from state (e.g. a missed array-shrink delete) throws
          // HERE, inside the property, so fast-check shrinks it and reports
          // the offending tick sequence.
          assertScopedDiffConvergence(scopedDoc.getMap("s"), scopedStore.getState());
        }

        expect(scopedDoc.getMap("s").toJSON()).toEqual(fullDoc.getMap("s").toJSON());
        expect(dataOf(scopedStore.getState())).toEqual(dataOf(fullStore.getState()));
      }),
      // Fixed seed => deterministic generation: the same sequences run every
      // time, so a regression fails reproducibly.
      { numRuns: 200, seed: 7 },
    );
  });

  it("two-doc concurrent merges (disjoint writes) converge identically under scoped and full diff", async () => {
    __scopedDiffDevSampling.rate = 0;

    await fc.assert(
      fc.asyncProperty(
        ticksArb(["a", "b"]),
        ticksArb(["c", "d"]).map((ticks) =>
          // Peer 2 writes only nested item keys — top-level count/label stay
          // peer-1-owned so convergence is deterministic (no LWW coin flips).
          ticks.map((tick) => tick.filter((op) => op.kind === "setItem" || op.kind === "delItem"))),
        async (ticksA, ticksB) => {
          const run = async (scoped: boolean): Promise<Record<string, unknown>> => {
            const options = scoped ? { ...OPTS, scopedDiff: true } : OPTS;
            const docA = new Y.Doc();
            const storeA = createStore<State>(yjs(docA, "s", creator, options));

            seed(storeA);
            await drain();

            // Peer B forks from A's seeded history, then both write
            // concurrently in disjoint keyspaces.
            const docB = new Y.Doc();
            replicate(docA, docB);
            const storeB = createStore<State>(yjs(docB, "s", creator, options));

            for (const tick of ticksA) {
              for (const op of tick) applyOp(storeA, op);
              await drain();
              if (scoped)
                assertScopedDiffConvergence(docA.getMap("s"), storeA.getState());
            }
            for (const tick of ticksB) {
              const nestedOnly = tick.filter(
                (op) => op.kind === "setItem" || op.kind === "delItem");
              if (nestedOnly.length === 0) continue;
              for (const op of nestedOnly) applyOp(storeB, op);
              await drain();
              if (scoped)
                assertScopedDiffConvergence(docB.getMap("s"), storeB.getState());
            }

            replicate(docA, docB);
            replicate(docB, docA);
            await drain();

            const a = docA.getMap("s").toJSON();
            expect(docB.getMap("s").toJSON()).toEqual(a);
            return a as Record<string, unknown>;
          };

          expect(await run(true)).toEqual(await run(false));
        },
      ),
      { numRuns: 50, seed: 7 },
    );
  });
});

describe("contract D.2 — write scoping: a set() touching one key produces changes confined to its subtree", () => {
  it("only the touched top-level key appears in the replicated events", async () => {
    const docA = new Y.Doc();
    const store = createStore<State>(
      yjs(docA, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    store.getState().inc();
    store.getState().setLabel("seeded");
    store.getState().setItem("a", 1, ["x"]);
    await drain();

    const docB = new Y.Doc();
    replicate(docA, docB); // transfer the seed writes first

    const touched = new Set<string>();
    docB.getMap("s").observeDeep((events) => {
      events.forEach((event) => {
        if (event.path.length > 0) touched.add(String(event.path[0]));
        else event.changes.keys.forEach((_c, key) => touched.add(key));
      });
    });

    store.getState().setItem("a", 2, ["y"]); // touches ONLY items
    await drain();
    replicate(docA, docB);

    expect([...touched]).toEqual(["items"]);
  });
});

describe("contract D.3 — divergence tripwires for mutate-in-place writes", () => {
  it("demonstrates the gap: an in-place mutation is invisible to the Object.is fast path", async () => {
    __scopedDiffDevSampling.rate = 0; // isolate the gap from the tripwire
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    store.getState().setItem("a", 1, []);
    await drain();

    // Non-idiomatic mutate-in-place set(): same object reference.
    store.setState((s) => {
      s.items["a"].n = 999;
      return { items: s.items };
    });
    await drain();

    // The doc did NOT receive the write (where legacy full diff would have).
    expect((doc.getMap("s").get("items") as Y.Map<unknown>).toJSON())
      .toEqual({ a: { n: 1, tags: [] } });
    expect(store.getState().items["a"].n).toBe(999); // state drifted

    // …and the DEV sampling assert catches exactly this, loudly:
    expect(() =>
      assertScopedDiffConvergence(doc.getMap("s"), store.getState()),
    ).toThrow(/scopedDiff divergence tripwire/);
  });

  it("does not false-positive on converged stores, pending remote inserts (DELETE), or lazily-backfilled defaults (INSERT)", async () => {
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    store.getState().setItem("a", 1, ["x"]);
    await drain();

    // Converged: no throw.
    expect(() =>
      assertScopedDiffConvergence(doc.getMap("s"), store.getState()),
    ).not.toThrow();

    // Map richer than state (remote insert not yet patched inbound): exempt.
    const remote = new Y.Doc();
    replicate(doc, remote);
    remote.getMap("s").set("remoteKey", 7);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote)); // no drain — inbound pending
    expect(() =>
      assertScopedDiffConvergence(doc.getMap("s"), store.getState()),
    ).not.toThrow();

    // State richer than map (retained default, lazy backfill): exempt.
    const doc2 = new Y.Doc();
    doc2.getMap("s2").set("count", 3);
    const store2 = createStore<State>(
      yjs(doc2, "s2", creator, {
        ...OPTS,
        scopedDiff: true,
        hydration: "merge-defaults",
      }),
    );
    // 'items'/'label' retained from defaults, absent from the doc.
    expect(() =>
      assertScopedDiffConvergence(doc2.getMap("s2"), store2.getState()),
    ).not.toThrow();
  });
});

describe("contract D.4 — inbound referential stability", () => {
  it("a remote change to one key leaves the other top-level keys reference-identical", async () => {
    const docA = new Y.Doc();
    const storeA = createStore<State>(
      yjs(docA, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    storeA.getState().setItem("a", 1, []);
    storeA.getState().setLabel("stable");
    await drain();

    const itemsBefore = storeA.getState().items;

    const docB = new Y.Doc();
    replicate(docA, docB);
    docB.transact(() => {
      docB.getMap("s").set("count", 42);
    });
    replicate(docB, docA);
    await drain();

    expect(storeA.getState().count).toBe(42);
    // Untouched keys keep their object identity (what selector subscriptions
    // rely on).
    expect(storeA.getState().items).toBe(itemsBefore);
    expect(storeA.getState().label).toBe("stable");
  });
});

describe("contract D.5 — no full-tree serialization on a scoped flush", () => {
  it("a set() touching one small key never calls toJSON on the root map or untouched subtrees", async () => {
    __scopedDiffDevSampling.rate = 0; // the tripwire itself full-serializes
    const doc = new Y.Doc();
    const store = createStore<State>(
      yjs(doc, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    // A nested structure under items.
    for (let i = 0; i < 200; i++) {
      store.getState().setItem(`book-${i}`, i, ["t1", "t2"]);
    }
    await drain();

    const rootMap = doc.getMap("s");
    const itemsMap = rootMap.get("items") as Y.Map<unknown>;

    const spy = jest.spyOn(Y.Map.prototype, "toJSON");
    try {
      store.getState().inc(); // small unrelated key
      await drain();

      expect(spy.mock.instances).not.toContain(rootMap);
      expect(spy.mock.instances).not.toContain(itemsMap);
      expect(rootMap.get("count")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("contract D.6 — first flush and lazy backfill", () => {
  it("the first flush is scoped too: only keys changed since creation are written (defaults stay lazy)", async () => {
    const scopedDoc = new Y.Doc();
    const scopedStore = createStore<State>(
      yjs(scopedDoc, "s", creator, { ...OPTS, scopedDiff: true }),
    );

    scopedStore.getState().setItem("a", 1, ["x"]);
    await drain();

    expect(scopedDoc.getMap("s").toJSON()).toEqual({
      items: { a: { n: 1, tags: ["x"] } },
    });

    // A first tick that touches every key IS the full-diff result.
    const scopedDoc2 = new Y.Doc();
    const scopedStore2 = createStore<State>(
      yjs(scopedDoc2, "s", creator, { ...OPTS, scopedDiff: true }),
    );
    const fullDoc = new Y.Doc();
    const fullStore = createStore<State>(yjs(fullDoc, "s", creator, OPTS));
    for (const store of [scopedStore2, fullStore]) {
      store.getState().inc();
      store.getState().setLabel("all-keys");
      store.getState().setItem("a", 1, ["x"]);
    }
    await drain();
    expect(scopedDoc2.getMap("s").toJSON()).toEqual(fullDoc.getMap("s").toJSON());
  });

  it("C.7 under scopedDiff (the pinned contract): a retained default backfills only when ITS key is set", async () => {
    // An old-format doc carrying only `count` (no label, no items).
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("s").set("count", 5);
    });

    const store = createStore<State>(
      yjs(doc, "s", creator, {
        ...OPTS,
        scopedDiff: true,
        hydration: "merge-defaults",
      }),
    );
    expect(store.getState().label).toBe("start"); // retained default

    // A write to an UNRELATED key does NOT backfill the retained default…
    store.getState().inc();
    await drain();
    expect(doc.getMap("s").has("label")).toBe(false);
    expect(doc.getMap("s").get("count")).toBe(6);

    // …but the doc converges once the key itself is set.
    store.getState().setLabel("written");
    await drain();
    expect(doc.getMap("s").get("label")).toBe("written");
  });
});
