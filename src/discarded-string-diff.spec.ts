/*
 * Text diffs whose result nobody uses.
 *
 * getRecordChanges / getArrayChanges build the nested change list for every
 * unequal string pair, which runs the full Wu O(NP) text diff — quadratic in
 * the edit distance (a 4k-char replacement costs ~0.5-1 s and hundreds of MB
 * of heap). Nothing consumes that list for strings:
 *
 * - Outbound, a PRIMITIVE string (disableYText, atomicKeys) is written with
 *   map.set / delete+insert; the list is discarded.
 * - Outbound, a Y.Text child goes to patchSharedType(Y.Text), which diffs the
 *   same pair AGAIN and applies only that second list.
 * - Inbound, patchState diffs the state string against the doc string and
 *   applyChangesToString rebuilds a string that is, by construction, exactly
 *   the doc string (strings are primitives — no identity to preserve).
 *
 * These tests pin the number of text diffs (getChanges calls on two unequal
 * strings) per flush and per inbound batch. They are counters, not timings:
 * the expected values are what the work actually needs — zero for primitive
 * strings and for receivers, exactly one for a Y.Text edit (the diff that is
 * applied).
 *
 * Instrumentation: ts-jest emits CommonJS, where every call to an exported
 * `const` — including diff.ts's own recursion and patching.ts's import — goes
 * through the module's export object, so a spy on `diff.getChanges` sees
 * nested calls too. The Y.Text cases assert EXACTLY one (not "at most one"),
 * which doubles as a liveness check: if the spy ever stopped seeing the
 * applied diff, those cases would fail instead of the suite passing
 * vacuously.
 */
import * as fc from "fast-check";
import * as yjs from "yjs";
import { createStore } from "zustand/vanilla";
import yjsMiddleware, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";
import * as diff from "./diff";
import { type Change, changeType } from "./types";

/*
 * The DEV-only scopedDiff tripwire runs a sampled full-tree getChanges after
 * a flush; pin it off so the counts measure the flush itself.
 */
const originalSamplingRate = __scopedDiffDevSampling.rate;

beforeAll(() => {
  __scopedDiffDevSampling.rate = 0;
});

afterAll(() => {
  __scopedDiffDevSampling.rate = originalSamplingRate;
});

/** Deterministic same-alphabet text (so the O(NP) path, not the disjoint fallback, runs). */
const makeText = (length: number, seed: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz ";
  let state = seed;
  let text = "";

  for (let index = 0; index < length; index = index + 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    text = text + alphabet[(state >>> 16) % alphabet.length];
  }

  return text;
};

const BEFORE = makeText(300, 1);
const AFTER = makeText(300, 2);

interface TextDiffCount {
  /** Text diffs run: getChanges calls on two unequal strings. */
  count: () => number;
  /** Characters fed into those diffs (sum of both sides' lengths). */
  chars: () => number;
  restore: () => void;
}

const spyOnTextDiffs = (): TextDiffCount => {
  const spy = jest.spyOn(diff, "getChanges");
  const textCalls = (): [string, string][] => spy.mock.calls
    .map(([a, b]) => [a, b])
    .filter((pair): pair is [string, string] =>
      typeof pair[0] === "string" && typeof pair[1] === "string" && pair[0] !== pair[1]);

  return {
    "count": () => textCalls().length,
    "chars": () => textCalls().reduce((sum, [a, b]) => sum + a.length + b.length, 0),
    "restore": () => { spy.mockRestore(); },
  };
};

type Mode = "legacy" | "scoped";

const MODES: readonly Mode[] = ["legacy", "scoped"];

type AnyState = Record<string, unknown>;

interface MakeStoreOptions {
  disableYText?: boolean;
  atomicKeys?: string[];
}

/** A store bound to a fresh doc, with its initial state flushed into the doc. */
const makeSyncedStore = (mode: Mode, initial: AnyState, options: MakeStoreOptions) => {
  const doc = new yjs.Doc();
  const store = createStore<AnyState>()(
    yjsMiddleware(doc, "root", (): AnyState => ({ ...initial, "tick": 0 }), {
      ...options,
      "scopedDiff": mode === "scoped",
    })
  );
  const handle = getYjsStoreHandle(store);

  // An empty doc is seeded on the first write once the store is hydrated
  // (a new doc, so mark it); make it (and flush, since outbound is
  // microtask-batched) so measured flushes are steady-state.
  handle.markHydrated();
  store.setState({ "tick": 1 });
  handle.flush();

  return { doc, handle, "map": doc.getMap("root"), store };
};

/** Runs one flushed write and returns the text diffs it ran. */
const measureFlush = (
  store: ReturnType<typeof makeSyncedStore>["store"],
  handle: ReturnType<typeof makeSyncedStore>["handle"],
  update: (state: AnyState) => AnyState
): { count: number; chars: number } => {
  const textDiffs = spyOnTextDiffs();

  try {
    store.setState(update);
    handle.flush();

    return { "chars": textDiffs.chars(), "count": textDiffs.count() };
  } finally {
    textDiffs.restore();
  }
};

/** Inserts one character into the middle of a string (a keystroke). */
const typeChar = (text: string): string =>
  `${text.slice(0, text.length / 2)}x${text.slice(text.length / 2)}`;

describe("outbound: primitive string writes run no text diff", () => {
  describe.each(MODES)("%s", (mode) => {
    it("replacing a disableYText string", () => {
      const { handle, map, store } = makeSyncedStore(mode, { "blob": BEFORE }, { "disableYText": true });

      const measured = measureFlush(store, handle, () => ({ "blob": AFTER }));

      expect(map.get("blob")).toBe(AFTER);
      expect(measured.count).toBe(0);
    });

    it("replacing an atomicKeys string", () => {
      const { handle, map, store } = makeSyncedStore(mode, { "cover": BEFORE }, { "atomicKeys": ["cover"] });

      const measured = measureFlush(store, handle, () => ({ "cover": AFTER }));

      expect(map.get("cover")).toBe(AFTER);
      expect(measured.count).toBe(0);
    });

    it("replacing a disableYText string three records deep", () => {
      const nest = (description: string) => ({ "books": { "b1": { description, "title": "t" } } });
      const { handle, map, store } = makeSyncedStore(mode, { "library": nest(BEFORE) }, { "disableYText": true });

      const measured = measureFlush(store, handle, () => ({ "library": nest(AFTER) }));

      expect(map.toJSON()["library"]).toStrictEqual(nest(AFTER));
      expect(measured.count).toBe(0);
    });

    it("replacing one disableYText string inside an array", () => {
      const items = Array.from({ "length": 10 }, (unused, index) => makeText(300, 100 + index));
      const nextItems = items.map((item, index) => (index === 5 ? AFTER : item));
      const { handle, map, store } = makeSyncedStore(mode, { items }, { "disableYText": true });

      const measured = measureFlush(store, handle, () => ({ "items": nextItems }));

      expect(map.toJSON()["items"]).toStrictEqual(nextItems);
      expect(measured.count).toBe(0);
    });
  });
});

describe("outbound: a Y.Text edit runs exactly one text diff (the applied one)", () => {
  describe.each(MODES)("%s", (mode) => {
    it("one keystroke in a top-level Y.Text", () => {
      const { handle, map, store } = makeSyncedStore(mode, { "note": BEFORE }, {});
      const next = typeChar(BEFORE);

      const measured = measureFlush(store, handle, () => ({ "note": next }));

      expect(map.get("note")).toBeInstanceOf(yjs.Text);
      expect(String(map.get("note"))).toBe(next);
      expect(measured.count).toBe(1);
    });

    it("one keystroke in a Y.Text two records deep", () => {
      const nest = (body: string) => ({ "n1": { body, "title": "t" } });
      const { handle, map, store } = makeSyncedStore(mode, { "notes": nest(BEFORE) }, {});
      const next = typeChar(BEFORE);

      const measured = measureFlush(store, handle, () => ({ "notes": nest(next) }));

      expect(map.toJSON()["notes"]).toStrictEqual(nest(next));
      expect(measured.count).toBe(1);
    });

    it("one keystroke in a Y.Text array element", () => {
      const items = [BEFORE, makeText(300, 3), makeText(300, 4)];
      const nextItems = [items[0], typeChar(items[1]), items[2]];
      const { handle, map, store } = makeSyncedStore(mode, { items }, {});

      const measured = measureFlush(store, handle, () => ({ "items": nextItems }));

      expect(map.toJSON()["items"]).toStrictEqual(nextItems);
      expect(measured.count).toBe(1);
    });
  });
});

/** A sender/receiver pair bound to two docs; updates flow sender -> receiver on demand. */
const makePair = (mode: Mode, initial: AnyState, options: MakeStoreOptions) => {
  const sender = makeSyncedStore(mode, initial, options);
  const receiverDoc = new yjs.Doc();

  yjs.applyUpdate(receiverDoc, yjs.encodeStateAsUpdate(sender.doc));

  const receiver = createStore<AnyState>()(
    yjsMiddleware(receiverDoc, "root", (): AnyState => ({}), { ...options, "scopedDiff": mode === "scoped" })
  );

  /** Sends one write and returns the text diffs the RECEIVER ran to apply it. */
  const measureInbound = async (update: (state: AnyState) => AnyState): Promise<number> => {
    sender.store.setState(update);
    sender.handle.flush();

    const payload = yjs.encodeStateAsUpdate(sender.doc, yjs.encodeStateVector(receiverDoc));
    const textDiffs = spyOnTextDiffs();

    try {
      yjs.applyUpdate(receiverDoc, payload);
      // Inbound is microtask-batched: let the batch (and its patch) run.
      await Promise.resolve();
      await Promise.resolve();

      return textDiffs.count();
    } finally {
      textDiffs.restore();
    }
  };

  return { measureInbound, receiver };
};

describe("inbound: receivers run no text diff", () => {
  describe.each(MODES)("%s", (mode) => {
    it("a replaced disableYText string", async () => {
      const { measureInbound, receiver } = makePair(mode, { "blob": BEFORE }, { "disableYText": true });

      expect(receiver.getState()["blob"]).toBe(BEFORE);

      const count = await measureInbound(() => ({ "blob": AFTER }));

      expect(receiver.getState()["blob"]).toBe(AFTER);
      expect(count).toBe(0);
    });

    it("a replaced disableYText string three records deep", async () => {
      const nest = (description: string) => ({ "books": { "b1": { description, "title": "t" } } });
      const { measureInbound, receiver } = makePair(mode, { "library": nest(BEFORE) }, { "disableYText": true });

      expect(receiver.getState()["library"]).toStrictEqual(nest(BEFORE));

      const count = await measureInbound(() => ({ "library": nest(AFTER) }));

      expect(receiver.getState()["library"]).toStrictEqual(nest(AFTER));
      expect(count).toBe(0);
    });

    it("one keystroke in a Y.Text", async () => {
      const { measureInbound, receiver } = makePair(mode, { "note": BEFORE }, {});
      const next = typeChar(BEFORE);

      const count = await measureInbound(() => ({ "note": next }));

      expect(receiver.getState()["note"]).toBe(next);
      expect(count).toBe(0);
    });

    // Under scopedDiff the event path names the Y.Text itself, so this takes
    // computeInboundStateForPaths' string-vs-string branch.
    it("one keystroke in a Y.Text two records deep", async () => {
      const nest = (body: string) => ({ "n1": { body, "title": "t" } });
      const { measureInbound, receiver } = makePair(mode, { "notes": nest(BEFORE) }, {});
      const next = typeChar(BEFORE);

      const count = await measureInbound(() => ({ "notes": nest(next) }));

      expect(receiver.getState()["notes"]).toStrictEqual(nest(next));
      expect(count).toBe(0);
    });
  });
});

/*
 * The internal nestedStrings modes that skip those diffs must change nothing
 * but the description of an unequal NESTED string pair: array alignment,
 * every other change, and the top-level text diff (the one a Y.Text applies)
 * stay exactly the default output.
 */
describe("getChanges nestedStrings modes", () => {
  type Pair = [before: unknown, after: unknown];
  type Side = "both" | "before" | "after";

  // Few distinct strings, keys and scalars, so pairs collide; elements and
  // keys present on one side only shift arrays, so the lookahead, block
  // shifts and in-place replacements all occur at every depth.
  const text = fc.constantFrom("", "a", "ab", "ba", "abc");
  const leaf = fc.oneof(text, fc.constantFrom<unknown>(null, 0, 1, true));
  const side = fc.constantFrom<Side>("both", "both", "before", "after");
  const pairs = fc.letrec<{ pair: Pair; arrays: Pair; records: Pair }>((tie) => ({
    "pair": fc.oneof({ "depthSize": "medium" }, fc.tuple(leaf, leaf), fc.tuple(text, text), tie("arrays"), tie("records")),
    "arrays": fc.array(fc.tuple(tie("pair"), side), { "maxLength": 6, "minLength": 1 }).map((entries): Pair => [
      entries.filter(([, where]) => where !== "after").map(([[before]]) => before),
      entries.filter(([, where]) => where !== "before").map(([[, after]]) => after),
    ]),
    "records": fc.dictionary(fc.constantFrom("x", "y", "z"), fc.tuple(tie("pair"), side), { "maxKeys": 3, "minKeys": 1 })
      .map((entries): Pair => {
        const list = Object.entries(entries);

        return [
          Object.fromEntries(list.filter(([, [, where]]) => where !== "after").map(([key, [[before]]]) => [key, before])),
          Object.fromEntries(list.filter(([, [, where]]) => where !== "before").map(([key, [[, after]]]) => [key, after])),
        ];
      }),
  }));
  const samePair = fc.oneof(pairs.arrays, pairs.records) as fc.Arbitrary<[diff.Diffable, diff.Diffable]>;

  /** The default output, with each nested string pair re-described as `mode` describes it. */
  const describeNestedStrings = (b: unknown, changes: Change[], mode: "defer" | "update"): Change[] =>
    changes.map(([type, key, value]): Change => {
      if (type !== changeType.pending) {
        return [type, key, value];
      }

      const next = (b as Record<string | number, unknown>)[key];

      if (typeof next === "string") {
        return mode === "defer"
          ? [changeType.pending, key, diff.deferredTextDiff]
          : [changeType.update, key, next];
      }

      return [type, key, describeNestedStrings(next, value as Change[], mode)];
    });

  it.each(["defer", "update"] as const)("%s re-describes only nested string pairs", (mode) => {
    fc.assert(
      fc.property(samePair, ([a, b]) => {
        expect(diff.getChanges(a, b, { "nestedStrings": mode }))
          .toStrictEqual(describeNestedStrings(b, diff.getChanges(a, b), mode));
      }),
      { "numRuns": 500 }
    );
  });

  it.each(["defer", "update"] as const)("%s still diffs a top-level string pair", (mode) => {
    expect(diff.getChanges(BEFORE, AFTER, { "nestedStrings": mode }))
      .toStrictEqual(diff.getChanges(BEFORE, AFTER));
  });

  it("defers with a marker that cannot be applied as an empty change list", () => {
    const [[type, , marker]] = diff.getChanges({ "k": BEFORE }, { "k": AFTER }, { "nestedStrings": "defer" });

    expect(type).toBe(changeType.pending);
    expect(Array.isArray(marker)).toBe(false);
    expect(() => [...(marker as Change[])]).toThrow(TypeError);
  });
});
