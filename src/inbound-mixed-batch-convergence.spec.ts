/*
 * Inbound batches mixing root-level events with deep changes, as a property.
 *
 * Under scopedDiff an inbound batch is split per top-level key: a key an
 * event named at the top level (set, replaced or deleted, an edit inside a
 * top-level array, or the caller's write next to this store's own flush) is
 * re-read whole, and the deep changes under every other key keep the
 * path-scoped route (docs/performance.md §11). Leaving a root-level key out
 * of that split would leave a replaced or deleted key unreconciled: a silent
 * divergence, not a crash.
 *
 * Random multi-transaction batches run through a scopedDiff receiver and a
 * legacy full-tree receiver of the same remote doc. After every batch both
 * must hold the same state, each must match its own doc (and, with no local
 * writes, the remote doc), and the scoped receiver must notify at most once.
 * Some batches end with a caller transaction on the receivers that wraps the
 * store's own flush and a write of the caller's, so the own-flush narrowing
 * meets remote deep changes in the same batch.
 *
 * A last test pins that a deep path under a key re-read whole is dropped
 * rather than reconciled on its own: if that key was deleted, the path
 * names a missing branch, which would escalate the whole batch.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

type Json = boolean | number | string | Json[] | { [key: string]: Json } | null;

const SYNCED = ["progress", "currentBookId", "recent", "meta"];

/** Doc layout as the middleware maps it under disableYText. */
const toY = (value: Json): unknown => {
  if (Array.isArray(value)) {
    const array = new yjs.Array<unknown>();

    array.insert(0, value.map(toY));

    return array;
  }
  if (value !== null && typeof value === "object") {
    const map = new yjs.Map<unknown>();

    for (const [key, child] of Object.entries(value)) {
      map.set(key, toY(child));
    }

    return map;
  }

  return value;
};

const makeTree = (books: number, salt: string): Record<string, Json> => {
  const tree: Record<string, Json> = {};

  for (let index = 0; index < books; index = index + 1) {
    tree[`book-${String(index)}`] = {
      "device-0": { "cfi": `c${salt}${String(index)}`, "pct": index, "tags": ["a", "b"] },
      "device-1": { "cfi": `d${salt}${String(index)}`, "pct": index, "tags": ["c"] },
    };
  }

  return tree;
};

const operation = fc.record({
  "kind": fc.constantFrom(
    "deepCfi",
    "deepTags",
    "addBook",
    "dropBook",
    "addDevice",
    "dropDevice",
    "setCurrent",
    "deleteCurrent",
    "recentInsert",
    "recentDelete",
    "replaceRecent",
    "replaceProgress",
    "deleteProgress",
    "metaDeep",
    "replaceMeta",
    "deleteMeta",
    "foreign"
  ),
  "book": fc.integer({ "min": 0, "max": 5 }),
  "device": fc.integer({ "min": 0, "max": 2 }),
  "value": fc.integer({ "min": 0, "max": 99 }),
});

interface Op { kind: string; book: number; device: number; value: number }

/** Applies one write directly to a store's Y.Map (as a peer would). */
const applyOp = (storeMap: yjs.Map<unknown>, op: Op): void => {
  const progress = storeMap.get("progress") as yjs.Map<yjs.Map<yjs.Map<unknown>>> | undefined;
  const bookId = `book-${String(op.book)}`;
  const book = progress?.get(bookId);
  const device = book?.get(`device-${String(op.device)}`);
  const recent = storeMap.get("recent") as yjs.Array<string> | undefined;

  switch (op.kind) {
    case "deepCfi": {
      device?.set("cfi", `v${String(op.value)}`);
      break;
    }
    case "deepTags": {
      const tags = device?.get("tags") as yjs.Array<string> | undefined;

      if (tags !== undefined) {
        if (op.value % 2 === 0 && tags.length > 0) {
          tags.delete(0, 1);
        } else {
          tags.insert(Math.min(tags.length, op.value % 3), [`t${String(op.value)}`]);
        }
      }
      break;
    }
    case "addBook": {
      progress?.set(bookId, toY({ "device-0": { "cfi": `n${String(op.value)}`, "pct": 0, "tags": [] } }) as yjs.Map<yjs.Map<unknown>>);
      break;
    }
    case "dropBook": {
      progress?.delete(bookId);
      break;
    }
    case "addDevice": {
      book?.set(`device-${String(op.device)}`, toY({ "cfi": "nd", "pct": op.value, "tags": ["x"] }) as yjs.Map<unknown>);
      break;
    }
    case "dropDevice": {
      book?.delete(`device-${String(op.device)}`);
      break;
    }
    case "setCurrent": {
      storeMap.set("currentBookId", bookId);
      break;
    }
    case "deleteCurrent": {
      storeMap.delete("currentBookId");
      break;
    }
    case "recentInsert": {
      recent?.insert(Math.min(recent.length, op.value % 3), [bookId]);
      break;
    }
    case "recentDelete": {
      if (recent !== undefined && recent.length > 0) {
        recent.delete(op.value % recent.length, 1);
      }
      break;
    }
    case "replaceRecent": {
      storeMap.set("recent", toY([bookId, `x${String(op.value)}`]));
      break;
    }
    case "replaceProgress": {
      storeMap.set("progress", toY(makeTree(1 + (op.value % 4), String(op.value))));
      break;
    }
    case "deleteProgress": {
      storeMap.delete("progress");
      break;
    }
    case "metaDeep": {
      ((storeMap.get("meta") as yjs.Map<unknown> | undefined)?.get("b") as yjs.Map<unknown> | undefined)
        ?.set("c", op.value);
      break;
    }
    case "replaceMeta": {
      storeMap.set("meta", toY({ "a": op.value, "b": { "c": op.value } }));
      break;
    }
    case "deleteMeta": {
      storeMap.delete("meta");
      break;
    }
    case "foreign": {
      // A top-level key this store does not replicate (another store's).
      storeMap.set("foreign", op.value);
      break;
    }
    default: {
      break;
    }
  }
};

type State = Record<string, unknown>;

const localWrite = fc.record({
  "kind": fc.constantFrom("current", "deep", "meta"),
  "book": fc.integer({ "min": 0, "max": 5 }),
  "value": fc.integer({ "min": 0, "max": 99 }),
});

type LocalWrite = typeof localWrite extends fc.Arbitrary<infer T> ? T : never;

/*
 * A receiver-local store write, as an immutable update. It recreates a
 * top-level key the store no longer holds, so the caller's write that
 * follows the flush may delete a key the flush has just created.
 */
const applyLocalWrite = (state: State, write: LocalWrite): State => {
  if (write.kind === "current") {
    return { "currentBookId": `own${String(write.value)}` };
  }
  if (write.kind === "meta") {
    return { "meta": { ...(state.meta as State | undefined), "a": write.value } };
  }

  const progress = (state.progress ?? {}) as Record<string, State | undefined>;
  const bookId = `book-${String(write.book)}`;

  return {
    "progress": {
      ...progress,
      [bookId]: { ...progress[bookId], "device-0": { "cfi": "own", "pct": write.value, "tags": [] } },
    },
  };
};

const pickSynced = (json: State): State => {
  const picked: State = {};

  for (const key of SYNCED) {
    if (Object.hasOwn(json, key)) {
      picked[key] = json[key];
    }
  }

  return picked;
};

interface Batch {
  // Remote transactions, delivered in one tick.
  transactions: Op[][];
  // A caller transaction on both receivers, in the same tick: the store's
  // own write and flush, then a write of the caller's.
  caller?: { write: LocalWrite; op: Op };
}

interface CaseOptions {
  hydration: "replace" | "merge-defaults";
  scopeKey?: string;
}

const runCase = async (batches: Batch[], { hydration, scopeKey }: CaseOptions): Promise<void> => {
  const remoteDoc = new yjs.Doc();

  remoteDoc.clientID = 2;

  const initial: Record<string, Json> = {
    "progress": makeTree(4, "i"),
    "currentBookId": "book-0",
    "recent": ["book-0", "book-1"],
    "meta": { "a": 1, "b": { "c": 2 } },
  };

  remoteDoc.transact(() => {
    const root = remoteDoc.getMap("root");

    if (scopeKey === undefined) {
      for (const [key, value] of Object.entries(initial)) {
        root.set(key, toY(value));
      }
    } else {
      root.set(scopeKey, toY(initial));
    }
  });

  const storeMap = (doc: yjs.Doc): yjs.Map<unknown> => {
    const root = doc.getMap("root");

    return scopeKey === undefined ? root : root.get(scopeKey) as yjs.Map<unknown>;
  };

  const makeReceiver = (scopedDiff: boolean) => {
    const doc = new yjs.Doc();

    // Both receivers make the same local writes; the same client id makes
    // Yjs resolve them against concurrent remote writes the same way.
    doc.clientID = 1;
    yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(remoteDoc));

    const store = createStore<State>()(
      yjsMiddleware(
        doc,
        "root",
        (): State => { return { "progress": {}, "currentBookId": "", "recent": [], "meta": { "a": 0, "b": { "c": 0 } } } },
        {
          "disableYText": true,
          scopedDiff,
          "syncedKeys": SYNCED,
          hydration,
          ...(scopeKey === undefined ? {} : { "scope": { "key": scopeKey } }),
        }
      )
    );
    let notifications = 0;

    store.subscribe(() => { notifications = notifications + 1; });

    return { doc, store, "notifications": () => notifications };
  };

  const scoped = makeReceiver(true);
  const legacy = makeReceiver(false);
  let hasLocalWrites = false;
  let isInboundUnapplied = false;

  scoped.doc.getMap("root").observeDeep(() => {
    isInboundUnapplied = true;
  });

  for (const batch of batches) {
    const updates = batch.transactions.map((ops) => {
      const vector = yjs.encodeStateVector(remoteDoc);

      remoteDoc.transact(() => {
        for (const op of ops) {
          applyOp(storeMap(remoteDoc), op);
        }
      });

      return yjs.encodeStateAsUpdate(remoteDoc, vector);
    });

    isInboundUnapplied = false;

    for (const update of updates) {
      yjs.applyUpdate(scoped.doc, update);
      yjs.applyUpdate(legacy.doc, update);
    }

    /*
     * Only while a remote change is unapplied: then both receivers flush
     * with the same three-way merge. With nothing pending, the legacy
     * receiver's full-tree flush backfills merge-defaults keys the scoped
     * one leaves lazy, which is documented and not under test here.
     */
    if (batch.caller !== undefined && isInboundUnapplied) {
      const { write, op } = batch.caller;

      for (const receiver of [scoped, legacy]) {
        receiver.doc.transact(() => {
          receiver.store.setState((state) => applyLocalWrite(state, write));
          getYjsStoreHandle(receiver.store).flush();
          applyOp(storeMap(receiver.doc), op);
        });
      }
      hasLocalWrites = true;
    }

    const notificationsBefore = scoped.notifications();

    // eslint-disable-next-line no-await-in-loop -- each batch drains before the next
    await Promise.resolve();
    // eslint-disable-next-line no-await-in-loop -- each batch drains before the next
    await Promise.resolve();

    expect(scoped.notifications() - notificationsBefore).toBeLessThanOrEqual(1);
    // The whole state: a key outside syncedKeys must never reach it either.
    expect(scoped.store.getState()).toStrictEqual(legacy.store.getState());
    expect(pickSynced(storeMap(scoped.doc).toJSON())).toStrictEqual(pickSynced(storeMap(legacy.doc).toJSON()));

    for (const { doc, store } of [scoped, legacy]) {
      const docJson = pickSynced(storeMap(doc).toJSON());
      const state = pickSynced(store.getState());

      if (hydration === "replace") {
        expect(state).toStrictEqual(docJson);
      } else {
        // merge-defaults retains a declared default the doc deleted.
        expect(pickSynced({ ...state, ...docJson })).toStrictEqual(state);
      }
    }

    if (!hasLocalWrites && hydration === "replace") {
      expect(pickSynced(scoped.store.getState())).toStrictEqual(pickSynced(storeMap(remoteDoc).toJSON()));
    }
  }
};

describe("mixed shallow and deep inbound batches converge (scopedDiff vs legacy)", () => {
  let previousRate: number;

  beforeEach(() => {
    previousRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = previousRate;
  });

  const batches = fc.array(
    fc.record(
      {
        "transactions": fc.array(fc.array(operation, { "minLength": 1, "maxLength": 4 }), { "minLength": 1, "maxLength": 3 }),
        "caller": fc.record({ "write": localWrite, "op": operation }),
      },
      { "requiredKeys": ["transactions"] }
    ),
    { "minLength": 1, "maxLength": 6 }
  );

  for (const hydration of ["replace", "merge-defaults"] as const) {
    for (const scopeKey of [undefined, "device-A"]) {
      it(`hydration=${hydration}, scope=${String(scopeKey)}`, async () => {
        await fc.assert(
          fc.asyncProperty(batches, async (generated) => {
            await runCase(generated, { hydration, scopeKey });
          }),
          { "numRuns": 200 }
        );
      });
    }
  }

  it("drops a deep path under a key the batch deletes instead of escalating the whole batch", async () => {
    const remoteDoc = new yjs.Doc();
    const remote = remoteDoc.getMap("root");

    remoteDoc.transact(() => {
      remote.set("progress", toY(makeTree(4, "i")));
      remote.set("meta", toY({ "a": 1, "b": { "c": 2 } }));
    });

    const doc = new yjs.Doc();

    yjs.applyUpdate(doc, yjs.encodeStateAsUpdate(remoteDoc));

    const store = createStore<State>()(
      yjsMiddleware(doc, "root", (): State => { return { "progress": {}, "meta": {} } }, {
        "disableYText": true,
        "scopedDiff": true,
        "syncedKeys": ["progress", "meta"],
      })
    );
    const updates = [
      () => {
        applyOp(remote, { "kind": "metaDeep", "book": 0, "device": 0, "value": 7 });
        applyOp(remote, { "kind": "deepCfi", "book": 1, "device": 0, "value": 7 });
      },
      () => { applyOp(remote, { "kind": "deleteMeta", "book": 0, "device": 0, "value": 0 }); },
    ].map((write) => {
      const vector = yjs.encodeStateVector(remoteDoc);

      remoteDoc.transact(write);

      return yjs.encodeStateAsUpdate(remoteDoc, vector);
    });
    const progressToJson = jest.spyOn(doc.getMap("root").get("progress") as yjs.Map<unknown>, "toJSON");

    for (const update of updates) {
      yjs.applyUpdate(doc, update);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(Object.hasOwn(store.getState(), "meta")).toBe(false);
    expect((store.getState().progress as Record<string, Record<string, State>>)["book-1"]["device-0"].cfi).toBe("v7");
    expect(progressToJson).not.toHaveBeenCalled();
    progressToJson.mockRestore();
  });
});
