/*
 * Inbound bulk record deletes must cost O(n + k), not O(n * k).
 *
 * A remote peer that removes k entries from one n-key record (bulk-deleting
 * books, clearing or pruning an id-keyed map) produces k `[delete, key]`
 * changes for that record. Every inbound route — the scopedDiff deep-path
 * route, the key-scoped route, the legacy full-tree route and creation
 * hydration — applies them with the inbound state applier. Rebuilding the
 * whole record once per deleted key makes that O(n * k): seconds of
 * main-thread work on every receiving device for a few thousand keys.
 *
 * The cost is pinned without wall-clock timing: the Object enumeration
 * built-ins (Object.entries / keys / values / fromEntries) are spied and the
 * number of record entries they materialize is counted. That count depends
 * only on the code path. Each test compares two workloads on the same code
 * (a scaling ratio, or k = n/2 against k = 1), so unrelated constant-factor
 * changes elsewhere in the diff do not move the thresholds.
 */
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling } from ".";
import { getChanges } from "./diff";
import { patchState } from "./patching";
import { changeType } from "./types";

interface Book { title: string; author: string; addedAt: number }

const makeBooks = (count: number): Record<string, Book> => {
  const books: Record<string, Book> = {};

  for (let index = 0; index < count; index = index + 1) {
    books[`book-${String(index)}`] = {
      "title": `Title ${String(index)}`,
      "author": `Author ${String(index % 97)}`,
      "addedAt": 1_700_000_000_000 + index,
    };
  }

  return books;
};

/** Every (n / k)-th id, so the deletes are spread across the record. */
const pickDeletedIds = (count: number, deleteCount: number): string[] =>
  Array.from({ "length": deleteCount }, (_, index) => `book-${String(Math.floor(index * (count / deleteCount)))}`);

const withoutKeys = (books: Record<string, Book>, ids: readonly string[]): Record<string, Book> => {
  const removed = new Set(ids);
  const next: Record<string, Book> = {};

  for (const id of Object.keys(books)) {
    if (!removed.has(id)) {
      next[id] = books[id];
    }
  }

  return next;
};

/**
 * Number of record entries materialized by the Object enumeration built-ins
 * while `fn` runs (awaited, so an inbound microtask drain is included).
 */
const countEnumerated = async (fn: () => unknown): Promise<number> => {
  const originalEntries = Object.entries;
  const originalKeys = Object.keys;
  const originalValues = Object.values;
  const originalFromEntries = Object.fromEntries;
  let count = 0;
  const spies = [
    jest.spyOn(Object, "entries").mockImplementation((value: object) => {
      const result = originalEntries(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "keys").mockImplementation((value: object) => {
      const result = originalKeys(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "values").mockImplementation((value: object) => {
      const result = originalValues(value);

      count += result.length;

      return result;
    }),
    jest.spyOn(Object, "fromEntries").mockImplementation((entries: Iterable<readonly unknown[]>) => {
      const list = [...entries];

      count += list.length;

      return originalFromEntries(list as (readonly [PropertyKey, unknown])[]);
    }),
  ];

  try {
    await fn();
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  return count;
};

const patchStateCost = async (count: number, deleteCount: number): Promise<number> => {
  const before = { "books": makeBooks(count) };
  const after = { "books": withoutKeys(before.books, pickDeletedIds(count, deleteCount)) };

  return countEnumerated(() => patchState(before, after));
};

type Route = "deep" | "key-scoped" | "legacy";

const ROOT = "library-store";

/**
 * A hydrated receiving store plus a peer update that deletes `deleteCount`
 * of `count` books in one transaction.
 */
const makeInboundFixture = (route: Route, count: number, deleteCount: number) => {
  const peerDoc = new yjs.Doc();
  const peerRoot = peerDoc.getMap(ROOT);
  const books = new yjs.Map<unknown>();

  peerDoc.transact(() => {
    if (route === "deep") {
      // Event target library.books: two segments below the store root.
      const library = new yjs.Map<unknown>();

      peerRoot.set("library", library);
      library.set("books", books);
    } else {
      peerRoot.set("books", books);
    }
    for (const [id, book] of Object.entries(makeBooks(count))) {
      const bookMap = new yjs.Map<unknown>();

      books.set(id, bookMap);
      for (const [field, value] of Object.entries(book)) {
        bookMap.set(field, value);
      }
    }
  });

  const receiverDoc = new yjs.Doc();

  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(peerDoc));

  let readBooks: () => Record<string, unknown>;

  if (route === "deep") {
    const store = createStore<{ library: { books: Record<string, unknown> } }>()(
      yjsMiddleware(receiverDoc, ROOT, () => ({ "library": { "books": {} } }), {
        "disableYText": true,
        "scopedDiff": true,
      })
    );

    readBooks = () => store.getState().library.books;
  } else {
    const store = createStore<{ books: Record<string, unknown> }>()(
      yjsMiddleware(receiverDoc, ROOT, () => ({ "books": {} }), {
        "disableYText": true,
        "scopedDiff": route === "key-scoped",
      })
    );

    readBooks = () => store.getState().books;
  }

  expect(Object.keys(readBooks())).toHaveLength(count);

  const stateVector = yjs.encodeStateVector(peerDoc);

  peerDoc.transact(() => {
    for (const id of pickDeletedIds(count, deleteCount)) {
      books.delete(id);
    }
  });

  return { receiverDoc, "update": yjs.encodeStateAsUpdate(peerDoc, stateVector), readBooks };
};

const inboundCost = async (route: Route, count: number, deleteCount: number): Promise<number> => {
  const fixture = makeInboundFixture(route, count, deleteCount);
  const cost = await countEnumerated(async () => {
    yjs.applyUpdate(fixture.receiverDoc, fixture.update);
    // The store patch is microtask-batched: drain it inside the window.
    await Promise.resolve();
  });

  // The patch must actually have run (and converged), or the count is moot.
  expect(Object.keys(fixture.readBooks())).toHaveLength(count - deleteCount);

  return cost;
};

/** Cold start: the initializer has `count` books, the doc dropped `deleteCount` of them. */
const hydrationCost = async (count: number, deleteCount: number): Promise<number> => {
  const doc = new yjs.Doc();
  const root = doc.getMap(ROOT);
  const books = new yjs.Map<unknown>();
  const docBooks = withoutKeys(makeBooks(count), pickDeletedIds(count, deleteCount));

  doc.transact(() => {
    root.set("books", books);
    for (const [id, book] of Object.entries(docBooks)) {
      books.set(id, book);
    }
  });

  const initialBooks: Record<string, unknown> = makeBooks(count);
  let readBooks: () => Record<string, unknown> = () => ({});
  const cost = await countEnumerated(() => {
    const store = createStore<{ books: Record<string, unknown> }>()(
      yjsMiddleware(doc, ROOT, () => ({ "books": initialBooks }), { "disableYText": true })
    );

    readBooks = () => store.getState().books;
  });

  expect(Object.keys(readBooks())).toHaveLength(count - deleteCount);

  return cost;
};

describe("inbound bulk record deletes", () => {
  const originalRate = __scopedDiffDevSampling.rate;

  beforeAll(() => {
    __scopedDiffDevSampling.rate = 0;
  });

  afterAll(() => {
    __scopedDiffDevSampling.rate = originalRate;
  });

  it("emits one delete change per removed key (the workload under test)", () => {
    const before = { "books": makeBooks(400) };
    const after = { "books": withoutKeys(before.books, pickDeletedIds(400, 200)) };
    const [pending] = getChanges(before, after);
    const nested = pending[2] as unknown[];

    expect(pending[0]).toBe(changeType.pending);
    expect(nested).toHaveLength(200);
    expect(nested.every((change) => (change as unknown[])[0] === changeType.delete)).toBe(true);
  });

  it("patchState: 4x the record width and delete count costs ~4x, not ~16x", async () => {
    const small = await patchStateCost(200, 100);
    const large = await patchStateCost(800, 400);

    // Linear (O(n + k)) gives ~4; a per-delete record rebuild gives ~16.
    expect(large / small).toBeLessThan(6);
  });

  it("patchState: deleting half of a 1,000-key record costs about as much as deleting one key", async () => {
    const one = await patchStateCost(1_000, 1);
    const half = await patchStateCost(1_000, 500);

    // Both are dominated by the O(n) diff walk when application is O(n + k).
    expect(half).toBeLessThanOrEqual(2 * one);
  });

  it("patchState: a bulk delete keeps survivor key order and the remaining values", () => {
    const before = { "books": makeBooks(50) };
    const deleted = pickDeletedIds(50, 20);
    const after = {
      "books": {
        ...withoutKeys(before.books, deleted),
        "book-8": { ...before.books["book-8"], "title": "renamed" },
        "book-new": { "title": "new", "author": "x", "addedAt": 1 },
      },
    };
    const patched = patchState(before, after);

    expect(deleted).not.toContain("book-8");
    expect(patched).toEqual(after);
    // Survivors keep their original relative order (updated in place); inserts append.
    expect(Object.keys(patched.books)).toEqual([
      ...Object.keys(before.books).filter((id) => !deleted.includes(id)),
      "book-new",
    ]);
  });

  it("patchState: a delete keeps an own \"__proto__\" key as data, never as the prototype", () => {
    // JSON.parse (or persist rehydration) can put an own "__proto__" key in state.
    const before = JSON.parse('{"books":{"__proto__":{"injected":true},"a":1,"b":2}}') as {
      books: Record<string, unknown>;
    };
    const patched = patchState(before, { "books": { "a": 1 } });

    expect(Object.hasOwn(patched.books, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(patched.books)).toBe(Object.prototype);
    expect(patched.books.injected).toBeUndefined();
    expect(Object.keys(patched.books)).toEqual(["__proto__", "a"]);
  });

  it.each(["deep", "key-scoped", "legacy"] as const)(
    "%s route: a peer deleting 500 of 1,000 books costs about as much as deleting one",
    async (route) => {
      const one = await inboundCost(route, 1_000, 1);
      const half = await inboundCost(route, 1_000, 500);

      expect(half).toBeLessThanOrEqual(2 * one);
    }
  );

  it("creation hydration: a doc that dropped 500 of 1,000 keys costs about as much as one dropped", async () => {
    const one = await hydrationCost(1_000, 1);
    const half = await hydrationCost(1_000, 500);

    expect(half).toBeLessThanOrEqual(2 * one);
  });
});
