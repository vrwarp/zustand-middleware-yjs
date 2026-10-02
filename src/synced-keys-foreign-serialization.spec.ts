/*
 * `syncedKeys` must make a store's cost O(its own keys), not O(the map).
 *
 * A `syncedKeys` store must ignore every other key of its map: a key removed
 * from the whitelist that old documents still carry (the resurrection
 * guard), keys another client version writes, or another store's keys when a
 * consumer binds several stores to one map instead of using unique names or
 * `scope`. Every whole-map read used to serialize the entire map (`toJSON()`)
 * and only then drop the foreign keys with pickKeys, so a tiny settings store
 * paid for the whole progress tree next to it:
 *
 * - at creation (cold-start hydration), in both diff modes;
 * - in legacy mode, on every outbound flush (patchSharedType's root read);
 * - in legacy mode, on every inbound batch — including batches that touch
 *   only foreign keys (another store's / another device's writes);
 * - in the DEV scopedDiff divergence tripwire.
 *
 * These tests pin the cost structurally — a `toJSON` spy on the foreign
 * subtrees, and Y-type serialization counts compared against the same store
 * on a map holding only its own key — never wall-clock time.
 */
import fc from "fast-check";
import * as Y from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import { assertScopedDiffConvergence, computeInboundState, patchSharedType, pickMapJson } from "./patching";

interface Settings { theme: string; fontSize: number; lineHeight: number }
interface SettingsState {
  settings: Settings;
  setFontSize: (fontSize: number) => void;
}

const MAP = "app";
const BOOKS = 40;

const defaults: Settings = { "theme": "light", "fontSize": 16, "lineHeight": 1.4 };

const makeSettingsStore = (doc: Y.Doc, scopedDiff: boolean): StoreApi<SettingsState> =>
  createStore<SettingsState>()(
    yjs(
      doc,
      MAP,
      (set) => ({
        "settings": defaults,
        "setFontSize": (fontSize) => {
          set((state) => ({ "settings": { ...state.settings, fontSize } }));
        },
      }),
      { "disableYText": true, scopedDiff, "syncedKeys": ["settings"] }
    )
  );

/**
 * A populated doc: the settings store's own key, plus (unless `ownOnly`) the
 * keys it must ignore — another store's large `progress` tree and a
 * deprecated `oldHighlights` list an old document still carries.
 */
const makeSourceDoc = (ownOnly: boolean, books = BOOKS): Y.Doc => {
  const doc = new Y.Doc();

  doc.transact(() => {
    const map = doc.getMap(MAP);
    const settings = new Y.Map<unknown>();

    settings.set("theme", "sepia");
    settings.set("fontSize", 20);
    settings.set("lineHeight", 1.5);
    map.set("settings", settings);

    if (ownOnly) {
      return;
    }

    const progress = new Y.Map<unknown>();

    for (let book = 0; book < books; book = book + 1) {
      const perBook = new Y.Map<unknown>();

      for (const deviceId of ["device-0", "device-1"]) {
        const device = new Y.Map<unknown>();
        const sessions = new Y.Array<Y.Map<unknown>>();

        device.set("cfi", `epubcfi(/6/${String(book)}!/4:0)`);
        device.set("percentage", book / 100);
        sessions.push(Array.from({ "length": 20 }, (unused, index) => {
          const session = new Y.Map<unknown>();

          session.set("start", index);
          session.set("label", `chapter ${String(index)}`);

          return session;
        }));
        device.set("readingSessions", sessions);
        perBook.set(deviceId, device);
      }
      progress.set(`book-${String(book)}`, perBook);
    }
    map.set("progress", progress);

    const oldHighlights = new Y.Array<Y.Map<unknown>>();

    oldHighlights.push(Array.from({ "length": 200 }, (unused, index) => {
      const highlight = new Y.Map<unknown>();

      highlight.set("cfi", `epubcfi(/6/2!/4/${String(index)}:0)`);
      highlight.set("color", "yellow");

      return highlight;
    }));
    map.set("oldHighlights", oldHighlights);
  });

  return doc;
};

const cloneDoc = (source: Y.Doc): Y.Doc => {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));

  return doc;
};

/** Spies on the foreign subtrees' roots; a parent's toJSON reaches them. */
const spyOnForeignKeys = (doc: Y.Doc) => {
  const map = doc.getMap(MAP);

  return [
    jest.spyOn(map.get("progress") as Y.Map<unknown>, "toJSON"),
    jest.spyOn(map.get("oldHighlights") as Y.Array<unknown>, "toJSON"),
  ];
};

const foreignCalls = (spies: ReturnType<typeof spyOnForeignKeys>): number =>
  spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

/** Counts every Y.Map / Y.Array serialized (nested calls included) during `fn`. */
const countSerializedTypes = async (fn: () => unknown): Promise<number> => {
  const mapSpy = jest.spyOn(Y.Map.prototype, "toJSON");
  const arraySpy = jest.spyOn(Y.Array.prototype, "toJSON");

  try {
    await fn();

    return mapSpy.mock.calls.length + arraySpy.mock.calls.length;
  } finally {
    mapSpy.mockRestore();
    arraySpy.mockRestore();
  }
};

/** Applies one peer transaction to `doc` and drains the inbound microtask. */
const receive = async (doc: Y.Doc, peer: Y.Doc, write: (map: Y.Map<unknown>) => void) => {
  const stateVector = Y.encodeStateVector(doc);

  peer.transact(() => { write(peer.getMap(MAP)); });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, stateVector));
  await Promise.resolve();
  await Promise.resolve();
};

const writeOwnKey = (value: number) => (map: Y.Map<unknown>) => {
  (map.get("settings") as Y.Map<unknown>).set("lineHeight", value);
};

/** Another device's page turn: touches only the foreign `progress` tree. */
const writeForeignKey = (value: number) => (map: Y.Map<unknown>) => {
  const progress = map.get("progress") as Y.Map<Y.Map<Y.Map<unknown>>> | undefined;

  if (progress === undefined) {
    map.set("progress", value);

    return;
  }
  progress.get("book-3")?.get("device-1")?.set("percentage", value);
};

let savedRate: number;

beforeAll(() => {
  savedRate = __scopedDiffDevSampling.rate;
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = savedRate;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each([
  ["legacy", false],
  ["scopedDiff", true],
])("syncedKeys cold-start hydration (%s)", (unusedLabel, scopedDiff) => {
  it("never serializes a key outside syncedKeys", () => {
    const doc = cloneDoc(makeSourceDoc(false));
    const spies = spyOnForeignKeys(doc);
    const store = makeSettingsStore(doc, scopedDiff);

    expect(store.getState().settings).toEqual({ "theme": "sepia", "fontSize": 20, "lineHeight": 1.5 });
    expect(Object.hasOwn(store.getState(), "progress")).toBe(false);
    expect(Object.hasOwn(store.getState(), "oldHighlights")).toBe(false);
    expect(foreignCalls(spies)).toBe(0);
  });

  it("serializes no more Y types than on a map holding only its own key", async () => {
    const reference = makeSourceDoc(true);
    const shared = makeSourceDoc(false);
    const ownOnlyTypes = await countSerializedTypes(() => makeSettingsStore(cloneDoc(reference), scopedDiff));
    const sharedTypes = await countSerializedTypes(() => makeSettingsStore(cloneDoc(shared), scopedDiff));

    // cloneDoc itself serializes nothing; the counts are the store's own work.
    expect(ownOnlyTypes).toBeLessThanOrEqual(2);
    expect(sharedTypes).toBeLessThanOrEqual(ownOnlyTypes);
  });

  it("hydration cost does not grow with the foreign tree (n vs 4n books)", async () => {
    const small = makeSourceDoc(false, 10);
    const large = makeSourceDoc(false, 40);
    const smallTypes = await countSerializedTypes(() => makeSettingsStore(cloneDoc(small), scopedDiff));
    const largeTypes = await countSerializedTypes(() => makeSettingsStore(cloneDoc(large), scopedDiff));

    expect(largeTypes).toBe(smallTypes);
  });
});

describe("syncedKeys legacy steady state (full-tree diff mode)", () => {
  it("an outbound settings flush never serializes a foreign key", async () => {
    const doc = cloneDoc(makeSourceDoc(false));
    const store = makeSettingsStore(doc, false);
    const spies = spyOnForeignKeys(doc);

    store.getState().setFontSize(24);
    getYjsStoreHandle(store).flush();

    expect((doc.getMap(MAP).get("settings") as Y.Map<unknown>).get("fontSize")).toBe(24);
    expect(foreignCalls(spies)).toBe(0);
    jest.restoreAllMocks();

    // No more Y types than the same write on a map holding only `settings`.
    const ownOnlyDoc = cloneDoc(makeSourceDoc(true));
    const ownOnlyStore = makeSettingsStore(ownOnlyDoc, false);
    const ownOnlyTypes = await countSerializedTypes(() => {
      ownOnlyStore.getState().setFontSize(24);
      getYjsStoreHandle(ownOnlyStore).flush();
    });
    const sharedTypes = await countSerializedTypes(() => {
      store.getState().setFontSize(25);
      getYjsStoreHandle(store).flush();
    });

    expect(sharedTypes).toBeLessThanOrEqual(ownOnlyTypes);
  });

  it("an inbound change to a synced key never serializes a foreign key", async () => {
    const source = makeSourceDoc(false);
    const doc = cloneDoc(source);
    const peer = cloneDoc(source);
    const store = makeSettingsStore(doc, false);
    const spies = spyOnForeignKeys(doc);

    await receive(doc, peer, writeOwnKey(2));

    expect(store.getState().settings.lineHeight).toBe(2);
    expect(foreignCalls(spies)).toBe(0);
  });

  it("an inbound batch touching only foreign keys never serializes them", async () => {
    const source = makeSourceDoc(false);
    const doc = cloneDoc(source);
    const peer = cloneDoc(source);
    const store = makeSettingsStore(doc, false);
    const settingsBefore = store.getState().settings;
    const spies = spyOnForeignKeys(doc);

    await receive(doc, peer, writeForeignKey(0.99));

    expect(store.getState().settings).toBe(settingsBefore);
    expect(Object.hasOwn(store.getState(), "progress")).toBe(false);
    expect(foreignCalls(spies)).toBe(0);
  });

  it("inbound cost is no more than on a map holding only the synced key", async () => {
    const measure = async (ownOnly: boolean, write: (map: Y.Map<unknown>) => void) => {
      const source = makeSourceDoc(ownOnly);
      const doc = cloneDoc(source);
      const peer = cloneDoc(source);

      makeSettingsStore(doc, false);

      return countSerializedTypes(() => receive(doc, peer, write));
    };

    expect(await measure(false, writeOwnKey(3))).toBeLessThanOrEqual(await measure(true, writeOwnKey(3)));
    expect(await measure(false, writeForeignKey(0.5))).toBeLessThanOrEqual(await measure(true, writeForeignKey(0.5)));
  });
});

describe("syncedKeys under scopedDiff steady state (guards: already O(own keys))", () => {
  it("flush and inbound never serialize a foreign key", async () => {
    const source = makeSourceDoc(false);
    const doc = cloneDoc(source);
    const peer = cloneDoc(source);
    const store = makeSettingsStore(doc, true);
    const spies = spyOnForeignKeys(doc);

    store.getState().setFontSize(30);
    getYjsStoreHandle(store).flush();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)));
    await receive(doc, peer, writeOwnKey(4));
    await receive(doc, peer, writeForeignKey(0.25));

    expect(store.getState().settings).toEqual({ "theme": "sepia", "fontSize": 30, "lineHeight": 4 });
    expect(foreignCalls(spies)).toBe(0);
  });
});

describe("scopedDiff DEV divergence tripwire with syncedKeys", () => {
  it("assertScopedDiffConvergence never serializes a foreign key", () => {
    const doc = cloneDoc(makeSourceDoc(false));
    const spies = spyOnForeignKeys(doc);

    expect(() => {
      assertScopedDiffConvergence(
        doc.getMap(MAP),
        { "settings": { "theme": "sepia", "fontSize": 20, "lineHeight": 1.5 } },
        { "syncedKeys": new Set(["settings"]) }
      );
    }).not.toThrow();
    expect(foreignCalls(spies)).toBe(0);
  });
});

/*
 * The subset read must be exactly `pickKeys(map.toJSON(), keys)`, the read it
 * replaces: presence-preserving (a ContentAny `undefined` is still an own
 * key), dangerous names skipped, ContentAny values passed by reference, and
 * the same result through the inbound sanitizer — including "__proto__"
 * entries at the top level, nested in Y types and nested in ContentAny
 * (which lib0 decodes into an injected prototype after a sync).
 */
describe("pickMapJson is the whole-map read followed by pickKeys", () => {
  const TOP_KEYS = [
    "settings", "progress", "undef", "toString", "hasOwnProperty", "__proto__", "constructor", "prototype",
  ];

  const docValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    "leaf": fc.oneof(fc.integer(), fc.string({ "maxLength": 3 }), fc.boolean(), fc.constant(null)),
    "node": fc.oneof(
      { "depthSize": "small" },
      tie("leaf"),
      fc.dictionary(fc.constantFrom("a", "b", "__proto__", "toString"), tie("node"), {
        "maxKeys": 3,
        "noNullPrototype": true,
      }),
      fc.array(tie("node"), { "maxLength": 3 })
    ),
  })).node;

  /** Stores `value` as nested Y types, or as one ContentAny value. */
  const toDocValue = (value: unknown, isYType: boolean): unknown => {
    if (!isYType) {
      return value;
    }
    if (Array.isArray(value)) {
      const yArray = new Y.Array<unknown>();

      yArray.push(value.map((item) => toDocValue(item, true)));

      return yArray;
    }
    if (typeof value === "object" && value !== null) {
      const yMap = new Y.Map<unknown>();

      for (const [key, item] of Object.entries(value)) {
        yMap.set(key, toDocValue(item, true));
      }

      return yMap;
    }

    return value;
  };

  /** A map holding `entries` (plus an explicit `undefined`), optionally after a sync. */
  const makeMap = (entries: [string, unknown, boolean][], isSynced: boolean): Y.Map<unknown> => {
    const source = new Y.Doc();

    source.transact(() => {
      const map = source.getMap(MAP);

      for (const [key, value, isYType] of entries) {
        map.set(key, toDocValue(value, isYType));
      }
      map.set("undef", undefined);
    });

    return (isSynced ? cloneDoc(source) : source).getMap(MAP);
  };

  const entriesArbitrary = fc.array(fc.tuple(fc.constantFrom(...TOP_KEYS), docValue, fc.boolean()), {
    "maxLength": 6,
  });

  it("returns the same own keys and values as pickKeys(map.toJSON())", () => {
    fc.assert(
      fc.property(entriesArbitrary, fc.subarray(TOP_KEYS), fc.boolean(), (entries, keys, isSynced) => {
        const map = makeMap(entries, isSynced);
        const full = map.toJSON();
        const picked = pickMapJson(map, new Set(keys));
        const expectedKeys = keys.filter((key) =>
          !["__proto__", "constructor", "prototype"].includes(key) && Object.hasOwn(full, key));

        expect(Object.keys(picked)).toEqual(expectedKeys);
        for (const key of expectedKeys) {
          expect(picked[key]).toStrictEqual(full[key]);
          if (!(map.get(key) instanceof Y.AbstractType)) {
            expect(picked[key]).toBe(full[key]);
          }
        }
      }),
      { "numRuns": 300 }
    );
  });

  it("feeds computeInboundState exactly what the whole-map read did", () => {
    fc.assert(
      fc.property(
        entriesArbitrary,
        fc.subarray(TOP_KEYS),
        fc.dictionary(fc.constantFrom(...TOP_KEYS), fc.oneof(docValue, fc.constant(() => 0)), {
          "maxKeys": 4,
          "noNullPrototype": true,
        }),
        fc.boolean(),
        fc.boolean(),
        (entries, keys, current, isMergingDefaults, isSynced) => {
          const map = makeMap(entries, isSynced);
          const syncedKeys = new Set(keys);
          const options = {
            syncedKeys,
            "suppressTopLevelDeleteKeys": isMergingDefaults ? new Set(Object.keys(current)) : undefined,
          };
          const viaWholeMap = computeInboundState({ ...current }, map.toJSON(), options);
          const viaSubset = computeInboundState({ ...current }, pickMapJson(map, syncedKeys), options);

          expect(Object.keys(viaSubset)).toEqual(Object.keys(viaWholeMap));
          expect(viaSubset).toStrictEqual(viaWholeMap);
        }
      ),
      { "numRuns": 300 }
    );
  });

  it("makes the legacy outbound root diff emit the same operations", () => {
    const stateValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      "leaf": fc.oneof(fc.integer(), fc.string({ "maxLength": 3 }), fc.boolean(), fc.constant(null)),
      "node": fc.oneof(
        { "depthSize": "small" },
        tie("leaf"),
        fc.dictionary(fc.constantFrom("a", "b", "c"), tie("node"), { "maxKeys": 3, "noNullPrototype": true }),
        fc.array(tie("node"), { "maxLength": 3 })
      ),
    })).node;
    const stateKeys = ["settings", "progress", "toString", "x", "__proto__"];
    const stateArbitrary = fc.dictionary(fc.constantFrom(...stateKeys), stateValue, {
      "maxKeys": 4,
      "noNullPrototype": true,
    });

    fc.assert(
      fc.property(
        stateArbitrary,
        stateArbitrary,
        fc.subarray(stateKeys),
        fc.boolean(),
        (before, after, keys, disableYText) => {
          const base = new Y.Doc();

          base.clientID = 1;
          patchSharedType(base.getMap(MAP), before, { disableYText });

          const viaWholeMap = cloneDoc(base);
          const viaSubset = cloneDoc(base);
          const syncedKeys = new Set(keys);

          viaWholeMap.clientID = 2;
          viaSubset.clientID = 2;
          viaWholeMap.transact(() => {
            const map = viaWholeMap.getMap(MAP);

            patchSharedType(map, after, { disableYText, syncedKeys, "precomputedJson": { "value": map.toJSON() } });
          });
          viaSubset.transact(() => {
            patchSharedType(viaSubset.getMap(MAP), after, { disableYText, syncedKeys });
          });

          expect(Y.encodeStateAsUpdate(viaSubset)).toEqual(Y.encodeStateAsUpdate(viaWholeMap));
        }
      ),
      { "numRuns": 300 }
    );
  });
});
