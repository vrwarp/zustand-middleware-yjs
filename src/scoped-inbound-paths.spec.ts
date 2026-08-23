/*
 * Inbound path collection under `scope: { key }` and the fast-route guards.
 *
 * Under a scope, Yjs event paths carry the scope segment in front, so the
 * store-relative path is the tail after it. Mutation testing reported every
 * branch of that shift — and each guard on the deep-path fast route — as
 * surviving: the scope tests exercised top-level keys only, so nothing ever
 * produced a path deep enough to distinguish the branches.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs, { getYjsStoreHandle } from ".";

const drain = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

interface Tree {
  branches: Record<string, { label: string; items: number[] }>;
  spare: number;
}

const makeTree = (): Tree["branches"] => ({
  "one": { "label": "first", "items": [1, 2] },
  "two": { "label": "second", "items": [3] },
});

const creator = (): Tree => ({ "branches": makeTree(), "spare": 0 });

const OPTS = { "disableYText": true, "scopedDiff": true } as const;

/** A writer/reader pair bound to the same scope key on two documents. */
const makePair = (scopeKey?: string) => {
  const options = scopeKey === undefined ? OPTS : { ...OPTS, "scope": { "key": scopeKey } };
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const storeA = createStore<Tree>()(yjs(docA, "root", creator, options));
  const handleA = getYjsStoreHandle(storeA);

  // Seed: an empty doc is only written on the first outbound flush.
  storeA.setState((state) => ({ "branches": { ...state.branches } }));
  handleA.flush();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

  const storeB = createStore<Tree>()(yjs(docB, "root", creator, options));

  const sync = async () => {
    handleA.flush();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    await drain();
  };

  return { docA, docB, storeA, storeB, sync };
};

describe.each([
  ["unscoped", undefined],
  ["scoped", "device-a"],
])("deep inbound paths (%s)", (unused, scopeKey) => {
  it("applies a change two levels below the store root", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();

    const untouched = storeB.getState().branches.two;

    storeA.setState((state) => ({
      "branches": { ...state.branches, "one": { ...state.branches.one, "label": "renamed" } },
    }));
    await sync();

    expect(storeB.getState().branches.one.label).toBe("renamed");
    expect(storeB.getState().branches.two).toBe(untouched);
  });

  it("applies a change three levels below the store root (nested array)", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();

    storeA.setState((state) => ({
      "branches": { ...state.branches, "two": { ...state.branches.two, "items": [3, 4, 5] } },
    }));
    await sync();

    expect(storeB.getState().branches.two.items).toStrictEqual([3, 4, 5]);
  });

  it("applies a top-level key change (shallow event takes the key-scoped route)", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();

    storeA.setState(() => ({ "spare": 42 }));
    await sync();

    expect(storeB.getState().spare).toBe(42);
  });

  it("applies a batch mixing a shallow and a deep change", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();

    storeA.setState((state) => ({
      "spare": 7,
      "branches": { ...state.branches, "one": { ...state.branches.one, "label": "both" } },
    }));
    await sync();

    expect(storeB.getState().spare).toBe(7);
    expect(storeB.getState().branches.one.label).toBe("both");
  });

  it("applies a nested key deletion", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();
    expect(storeB.getState().branches.two).toBeDefined();

    storeA.setState((state) => {
      const next = { ...state.branches };

      delete next.two;

      return { "branches": next };
    });
    await sync();

    expect(storeB.getState().branches.two).toBeUndefined();
    expect(storeB.getState().branches.one).toBeDefined();
  });

  it("applies a newly added branch", async () => {
    const { storeA, storeB, sync } = makePair(scopeKey);

    await sync();

    storeA.setState((state) => ({
      "branches": { ...state.branches, "three": { "label": "third", "items": [9] } },
    }));
    await sync();

    expect(storeB.getState().branches.three).toStrictEqual({ "label": "third", "items": [9] });
  });
});

describe("scoped stores ignore traffic outside their scope", () => {
  it("a sibling scope's deep change never reaches this store", async () => {
    const doc = new Y.Doc();
    const store = createStore<Tree>()(
      yjs(doc, "root", creator, { ...OPTS, "scope": { "key": "device-a" } })
    );
    const handle = getYjsStoreHandle(store);

    store.setState((state) => ({ "branches": { ...state.branches } }));
    handle.flush();

    const before = store.getState().branches;

    // A foreign writer edits a DIFFERENT scope key on the same root map.
    doc.transact(() => {
      const sibling = new Y.Map<unknown>();
      const nested = new Y.Map<unknown>();

      nested.set("label", "not mine");
      sibling.set("branches", nested);
      doc.getMap("root").set("device-b", sibling);
    });
    await drain();

    expect(store.getState().branches).toBe(before);
  });

  it("replacing the scoped child map itself re-reads the whole store", async () => {
    const doc = new Y.Doc();
    const store = createStore<Tree>()(
      yjs(doc, "root", creator, { ...OPTS, "scope": { "key": "device-a" } })
    );
    const handle = getYjsStoreHandle(store);

    store.setState((state) => ({ "branches": { ...state.branches } }));
    handle.flush();

    // A remote peer swaps the entire scoped child: a path-length-0 event on
    // the root map, which must force the full inbound patch.
    doc.transact(() => {
      const replacement = new Y.Map<unknown>();
      const branches = new Y.Map<unknown>();
      const one = new Y.Map<unknown>();

      one.set("label", "swapped");
      one.set("items", new Y.Array<unknown>());
      branches.set("one", one);
      replacement.set("branches", branches);
      replacement.set("spare", 5);
      doc.getMap("root").set("device-a", replacement);
    });
    await drain();

    expect(store.getState().branches.one.label).toBe("swapped");
    expect(store.getState().spare).toBe(5);
  });
});
