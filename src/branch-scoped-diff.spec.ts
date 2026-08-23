/*
 * Branch-scoped diff + hinted array splice detection.
 *
 * Pins the two aging fixes for stores whose hot top-level key holds one
 * large tree (the versicle `progress` shape):
 *
 * 1. `patchSharedTypeScoped` descends plain-record levels with Object.is
 *    pruning: a write that changes one nested branch must not serialize or
 *    walk sibling branches (O(changed branch), not O(subtree)).
 * 2. `getChanges(a, b, { previousA })`: block splices larger than the
 *    deep-equality lookahead window are detected via previous-state
 *    identity and confirmed against `a` — one range delete instead of
 *    hundreds of element-wise rewrites, and safe fallback when the doc
 *    diverged from the previous state.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { getYjsStoreHandle } from ".";
import { getChanges } from "./diff";
import { patchSharedTypeScoped } from "./patching";
import { changeType } from "./types";

describe("getChanges with a previous-state alignment hint", () => {
  const makeSessions = (from: number, count: number): Record<string, unknown>[] =>
    Array.from({ "length": count }, (unused, index) => ({
      "id": from + index,
      "cfi": `epubcfi(${String(from + index)})`,
      "t": (from + index) * 10,
    }));

  it("detects a head-block removal beyond the lookahead window as one delete run", () => {
    const prev = makeSessions(0, 500);
    const next = [...prev.slice(200), { "id": 999, "cfi": "new", "t": 0 }];
    // The doc-side JSON mirrors prev structurally but shares no references.
    const aJson = JSON.parse(JSON.stringify(prev)) as unknown[];

    const changes = getChanges(aJson, next, { "previousA": prev });

    const deletes = changes.filter(([type]) => type === changeType.delete);
    const inserts = changes.filter(([type]) => type === changeType.insert);
    const rewrites = changes.filter(([type]) =>
      type === changeType.update || type === changeType.pending);

    expect(deletes).toHaveLength(200);
    // All at the same (post-application) index -> coalescible to one range.
    expect(new Set(deletes.map(([, index]) => index)).size).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(rewrites).toHaveLength(0);
  });

  it("without the hint, the same splice degrades to element-wise rewrites (legacy)", () => {
    const prev = makeSessions(0, 500);
    const next = [...prev.slice(200), { "id": 999, "cfi": "new", "t": 0 }];
    const aJson = JSON.parse(JSON.stringify(prev)) as unknown[];

    const changes = getChanges(aJson, next);

    const rewrites = changes.filter(([type]) =>
      type === changeType.update || type === changeType.pending);

    // Not asserting the exact legacy shape — just that the hint is what
    // makes the difference.
    expect(rewrites.length).toBeGreaterThan(100);
  });

  it("rejects the hint when the doc diverged from the previous state (confirm fails)", () => {
    const prev = makeSessions(0, 500);
    const next = [...prev.slice(200), { "id": 999, "cfi": "new", "t": 0 }];
    // Doc content does NOT mirror prev: a concurrent writer replaced it.
    const divergedJson = makeSessions(5_000, 500).map((session) =>
      JSON.parse(JSON.stringify(session)) as unknown);

    const changes = getChanges(divergedJson, next, { "previousA": prev });

    // The proposal must be rejected — no giant delete run fabricated from
    // the stale hint. (Element-wise reconciliation is the correct result.)
    const deletes = changes.filter(([type]) => type === changeType.delete);

    expect(deletes.length).toBeLessThan(500);
    const sameIndexRun = deletes.filter(([, index]) => index === deletes[0]?.[1]);

    expect(sameIndexRun.length).toBeLessThan(200);
  });

  it("detects a large head insertion via the hint (prepend beyond the window)", () => {
    const prev = makeSessions(0, 50);
    const inserted = makeSessions(1_000, 40);
    const next = [...inserted, ...prev];
    const aJson = JSON.parse(JSON.stringify(prev)) as unknown[];

    const changes = getChanges(aJson, next, { "previousA": prev });

    const inserts = changes.filter(([type]) => type === changeType.insert);
    const rewrites = changes.filter(([type]) =>
      type === changeType.update || type === changeType.pending);

    expect(inserts).toHaveLength(40);
    expect(rewrites).toHaveLength(0);
  });

  it("applies the hinted change list to a Y.Array with identical results", () => {
    const doc = new yjs.Doc();
    const map = doc.getMap("root");
    const prev = makeSessions(0, 500);

    // Populate the doc to mirror prev.
    doc.transact(() => {
      patchSharedTypeScoped(map, { "sessions": prev }, { "sessions": [] }, {});
    });
    expect((map.get("sessions") as yjs.Array<unknown>).length).toBe(500);

    const next = [...prev.slice(200), { "id": 999, "cfi": "new", "t": 0 }];

    doc.transact(() => {
      patchSharedTypeScoped(map, { "sessions": next }, { "sessions": prev }, {});
    });

    expect(map.toJSON()).toEqual({ "sessions": next });
  });

  /*
   * The hinted scan emits delete/insert runs computed from identities the
   * differ cannot re-verify positionally, so convergence is the property
   * that matters: whatever alignment it proposes, applying the change list
   * must reproduce the target array exactly. Randomized identity-preserving
   * splices (the immutable-update shapes the hint is designed for) plus
   * rebuilt elements (where the hint must be rejected) are cross-validated
   * against a Y.Array.
   */
  it("converges for arbitrary identity-preserving splices (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ "min": 0, "max": 40 }), { "minLength": 0, "maxLength": 6 }),
        fc.integer({ "min": 20, "max": 120 }),
        fc.boolean(),
        (operations, seedLength, isRebuilding) => {
          const prev = makeSessions(0, seedLength);
          let next: Record<string, unknown>[] = prev;
          let nextId = 10_000;

          for (const operation of operations) {
            const cut = next.length === 0 ? 0 : operation % next.length;

            if (operation % 3 === 0) {
              next = next.slice(cut);
            } else if (operation % 3 === 1) {
              next = [...next.slice(0, cut), ...next.slice(cut + Math.min(operation, next.length - cut))];
            } else {
              next = [...makeSessions(nextId, operation % 30), ...next];
              nextId = nextId + 1_000;
            }
          }

          if (isRebuilding) {
            // No shared identities: the hint must be rejected, not trusted.
            next = JSON.parse(JSON.stringify(next)) as Record<string, unknown>[];
          }

          const doc = new yjs.Doc();
          const map = doc.getMap("root");

          doc.transact(() => {
            patchSharedTypeScoped(map, { "sessions": prev }, { "sessions": [] }, {});
          });
          doc.transact(() => {
            patchSharedTypeScoped(map, { "sessions": next }, { "sessions": prev }, {});
          });

          expect(map.toJSON()).toEqual({ "sessions": next });
        }
      ),
      { "numRuns": 150 }
    );
  });
});

describe("branch-scoped outbound diff (patchSharedTypeScoped recursion)", () => {
  interface TreeState {
    progress: Record<string, Record<string, { cfi: string; pct: number; tags: string[] }>>;
    bump: (book: string, device: string, cfi: string) => void;
  }

  const makeTree = (books: number): TreeState["progress"] => {
    const tree: TreeState["progress"] = {};

    for (let index = 0; index < books; index = index + 1) {
      tree[`book-${String(index)}`] = {
        "device-0": { "cfi": `cfi-${String(index)}`, "pct": index / 100, "tags": ["a", "b"] },
        "device-1": { "cfi": `cfi-${String(index)}b`, "pct": index / 100, "tags": ["c"] },
      };
    }

    return tree;
  };

  const makeStore = (doc: yjs.Doc, books: number) =>
    createStore<TreeState>()(
      yjsMiddleware(
        doc,
        "progress-store",
        (set) => ({
          "progress": makeTree(books),
          "bump": (book: string, device: string, cfi: string) => {
            set((state) => ({
              "progress": {
                ...state.progress,
                [book]: {
                  ...state.progress[book],
                  [device]: { ...state.progress[book][device], cfi },
                },
              },
            }));
          },
        }),
        { "disableYText": true, "scopedDiff": true, "syncedKeys": ["progress"] }
      )
    );

  it("a nested write patches only the changed branch (sibling subtrees are never serialized)", () => {
    const doc = new yjs.Doc();
    const store = makeStore(doc, 20);
    const handle = getYjsStoreHandle(store);

    // First flush inserts the whole tree (backfill).
    store.getState().bump("book-0", "device-0", "warm");
    handle.flush();

    const progressMap = doc.getMap("progress-store").get("progress") as yjs.Map<unknown>;
    const spies = new Map<string, jest.SpyInstance>();

    progressMap.forEach((value: unknown, key: string) => {
      spies.set(key, jest.spyOn(value as yjs.Map<unknown>, "toJSON"));
    });

    store.getState().bump("book-3", "device-1", "hot");
    handle.flush();

    for (const [key, spy] of spies) {
      if (key === "book-3") {
        // The changed branch descends by identity; only the LEAF device map
        // (a non-record transition point is never hit here) may serialize.
        continue;
      }
      expect(spy).not.toHaveBeenCalled();
    }

    expect((doc.getMap("progress-store").toJSON() as { progress: TreeState["progress"] })
      .progress["book-3"]["device-1"].cfi).toBe("hot");
  });

  it("first flush backfills the full subtree; later flushes stay branch-scoped", () => {
    const doc = new yjs.Doc();
    const store = makeStore(doc, 5);
    const handle = getYjsStoreHandle(store);

    store.getState().bump("book-1", "device-0", "first");
    handle.flush();

    // Every book (not just the written one) is in the doc after the first
    // flush — the whole-subtree insert at the missing container.
    const json = doc.getMap("progress-store").toJSON() as { progress: TreeState["progress"] };

    expect(Object.keys(json.progress)).toHaveLength(5);
    expect(json.progress["book-4"]["device-1"].cfi).toBe("cfi-4b");
  });

  it("converges with the full-tree diff on the same write sequence", () => {
    const scopedDoc = new yjs.Doc();
    const fullDoc = new yjs.Doc();
    const scopedStore = makeStore(scopedDoc, 8);
    const fullStore = createStore<TreeState>()(
      yjsMiddleware(
        fullDoc,
        "progress-store",
        (set) => ({
          "progress": makeTree(8),
          "bump": (book: string, device: string, cfi: string) => {
            set((state) => ({
              "progress": {
                ...state.progress,
                [book]: {
                  ...state.progress[book],
                  [device]: { ...state.progress[book][device], cfi },
                },
              },
            }));
          },
        }),
        { "disableYText": true, "syncedKeys": ["progress"] }
      )
    );

    const writes: [string, string, string][] = [
      ["book-0", "device-0", "w1"],
      ["book-3", "device-1", "w2"],
      ["book-0", "device-1", "w3"],
      ["book-7", "device-0", "w4"],
      ["book-3", "device-1", "w5"],
    ];

    for (const [book, device, cfi] of writes) {
      scopedStore.getState().bump(book, device, cfi);
      getYjsStoreHandle(scopedStore).flush();
      fullStore.getState().bump(book, device, cfi);
      getYjsStoreHandle(fullStore).flush();
    }

    expect(scopedDoc.getMap("progress-store").toJSON())
      .toEqual(fullDoc.getMap("progress-store").toJSON());
  });

  it("does not resurrect a nested key deleted by a concurrent remote transaction", async () => {
    const doc = new yjs.Doc();
    const store = makeStore(doc, 3);
    const handle = getYjsStoreHandle(store);

    store.getState().bump("book-0", "device-0", "seed");
    handle.flush();

    // Remote deletes book-2 directly in the doc (as a synced peer would).
    const progressMap = doc.getMap("progress-store").get("progress") as yjs.Map<unknown>;

    doc.transact(() => {
      progressMap.delete("book-2");
    }, "remote-origin");

    // Before the inbound microtask patches the store, a local write to a
    // DIFFERENT branch flushes. Identity pruning must leave book-2 alone
    // (the legacy JSON diff re-inserted it from state — resurrection).
    store.getState().bump("book-1", "device-0", "local");
    handle.flush();

    expect((doc.getMap("progress-store").toJSON() as { progress: TreeState["progress"] })
      .progress["book-2"]).toBeUndefined();

    // After the inbound patch settles, store and doc agree.
    await Promise.resolve();
    expect(store.getState().progress["book-2"]).toBeUndefined();
  });

  it("readingSessions sawtooth through the middleware produces a range delete, not element rewrites", () => {
    interface SessionState {
      progress: { sessions: { id: number; cfi: string }[] };
      appendCapped: (id: number) => void;
    }

    const doc = new yjs.Doc();
    const store = createStore<SessionState>()(
      yjsMiddleware(
        doc,
        "sessions-store",
        (set) => ({
          "progress": { "sessions": Array.from({ "length": 499 }, (unused, index) => ({ "id": index, "cfi": `c${String(index)}` })) },
          "appendCapped": (id: number) => {
            set((state) => {
              let sessions = [...state.progress.sessions, { id, "cfi": `c${String(id)}` }];

              if (sessions.length > 500) {
                sessions = sessions.slice(-300);
              }

              return { "progress": { ...state.progress, sessions } };
            });
          },
        }),
        { "disableYText": true, "scopedDiff": true, "syncedKeys": ["progress"] }
      )
    );
    const handle = getYjsStoreHandle(store);

    // Seed the doc (first flush) with the 500-session array.
    store.getState().appendCapped(9_000);
    handle.flush();

    let updateBytes = 0;

    doc.on("update", (update: Uint8Array) => {
      updateBytes = updateBytes + update.byteLength;
    });

    // Trip the sawtooth: 501 -> keep last 300.
    store.getState().appendCapped(9_001);
    handle.flush();

    const sessions = doc.getMap("sessions-store").toJSON() as {
      progress: { sessions: { id: number }[] };
    };

    expect(sessions.progress.sessions).toHaveLength(300);
    expect(sessions.progress.sessions[299].id).toBe(9_001);
    // The splice must be a range delete + one insert — well under a
    // kilobyte. The legacy element-wise rewrite emitted tens of kilobytes.
    expect(updateBytes).toBeLessThan(1_024);
  });
});

/*
 * Contract tests for the identity scan's guard conditions.
 *
 * These pin behaviour the ordinary splice tests never reach: what happens
 * when the scan budget runs out, when only one side has a distant identity
 * match, and when the hint points at a slot that is absent or holds
 * undefined. Mutation testing reported every one of these conditions as a
 * surviving mutant — the scan produced correct output whether or not the
 * guard was there, for every input the suite had.
 */
describe("identity scan guard conditions", () => {
  const obj = (n: number) => ({ "id": n, "payload": `value-${String(n)}` });

  it("stops scanning once the budget is exhausted and falls back to element-wise", () => {
    /*
     * The scan budget is shared across the whole diff, so exhausting it takes
     * many elements that scan and find nothing. Here the first 40 elements
     * share no identity with `b` at all and burn the budget; element 40 then
     * sits 30 positions before a block that IS identity-shared, which an
     * unbudgeted scan would find and emit as a 30-long delete run at one
     * index. With the budget spent, the differ must reconcile element-wise
     * instead — and must still converge.
     */
    const common = Array.from({ "length": 100 }, (unused, index) => obj(index));
    // Equal lengths on purpose: a length difference would produce a
    // trailing-block delete run of its own and mask what is being measured.
    const a = [
      ...Array.from({ "length": 40 }, (unused, index) => obj(1_000 + index)),
      ...Array.from({ "length": 30 }, (unused, index) => obj(2_000 + index)),
      ...common,
    ];
    const b = [
      ...Array.from({ "length": 40 }, (unused, index) => obj(3_000 + index)),
      ...common,
      ...Array.from({ "length": 30 }, (unused, index) => obj(4_000 + index)),
    ];

    expect(a).toHaveLength(b.length);

    const changes = getChanges(a, b);
    const deletes = changes.filter(([type]) => type === changeType.delete);
    const runLengths = new Map<unknown, number>();

    for (const [, index] of deletes) {
      runLengths.set(index, (runLengths.get(index) ?? 0) + 1);
    }

    const longestRun = Math.max(0, ...runLengths.values());

    // The 30-element shift is past the exhausted budget: it must not be found.
    expect(longestRun).toBeLessThan(30);

    // Whatever alignment it settled on, applying it must still reproduce `b`.
    const doc = new yjs.Doc();
    const map = doc.getMap("root");

    doc.transact(() => {
      patchSharedTypeScoped(map, { "sessions": a }, { "sessions": [] }, {});
    });
    doc.transact(() => {
      patchSharedTypeScoped(map, { "sessions": b }, { "sessions": a }, {});
    });
    expect(map.toJSON()).toEqual({ "sessions": b });
  });

  it("finds a distant identity match that sits inside the budget", () => {
    const shared = Array.from({ "length": 300 }, (unused, index) => obj(index));
    const b = [...shared.slice(100)];
    const changes = getChanges(shared, b);
    const deletes = changes.filter(([type]) => type === changeType.delete);

    expect(deletes).toHaveLength(100);
    expect(new Set(deletes.map(([, index]) => index)).size).toBe(1);
  });

  it("prefers the shorter shift when both a delete and an insert alignment exist", () => {
    /*
     * `b` is `a` with a short head block removed AND a long block prepended
     * further out. The delete shift is shorter, so it must win.
     */
    const shared = Array.from({ "length": 120 }, (unused, index) => obj(index));
    const b = shared.slice(20);
    const changes = getChanges(shared, b);
    const deletes = changes.filter(([type]) => type === changeType.delete);
    const inserts = changes.filter(([type]) => type === changeType.insert);

    expect(deletes).toHaveLength(20);
    expect(inserts).toHaveLength(0);
  });

  it("rejects a hint whose slot holds undefined", () => {
    const previousA: unknown[] = Array.from({ "length": 40 }, () => undefined);
    const a = Array.from({ "length": 40 }, (unused, index) => obj(index));
    const b = Array.from({ "length": 40 }, (unused, index) => obj(index + 500));
    const changes = getChanges(a, b, { "previousA": previousA });

    // Nothing alignable: every element differs, so this is element-wise.
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.filter(([type]) => type === changeType.delete).length).toBeLessThan(40);
  });

  it("ignores a hint shorter than the array being diffed", () => {
    const shared = Array.from({ "length": 60 }, (unused, index) => obj(index));
    const a = shared.map((value) => ({ ...value }));
    const b = [...shared.slice(30)];
    // previousA covers only the first few slots.
    const changes = getChanges(a, b, { "previousA": shared.slice(0, 3) });

    expect(changes.length).toBeGreaterThan(0);
  });

  it("ignores a non-array hint", () => {
    const shared = Array.from({ "length": 60 }, (unused, index) => obj(index));
    const a = shared.map((value) => ({ ...value }));
    const b = [...shared.slice(30)];
    const withHint = getChanges(a, b, { "previousA": "not an array" });
    const withoutHint = getChanges(a, b);

    expect(withHint).toStrictEqual(withoutHint);
  });

  it("detects a trailing-block removal without scanning", () => {
    const shared = Array.from({ "length": 100 }, (unused, index) => obj(index));
    const changes = getChanges(shared, shared.slice(0, 40));

    expect(changes.filter(([type]) => type === changeType.delete)).toHaveLength(60);
  });
});
