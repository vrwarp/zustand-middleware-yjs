/*
 * String writes: text diffs computed and thrown away.
 *
 * getRecordChanges / getArrayChanges build the nested change list for every
 * unequal string pair, which runs the full Wu O(NP) text diff: quadratic in
 * the edit distance, in time and in memory. Nothing uses that list:
 *
 * - Outbound, a PRIMITIVE string (atomicKeys, disableYText) is written with
 *   map.set / delete+insert and the list is discarded. These are the keys
 *   the docs recommend for blobs and long non-collaborative strings, and
 *   versicle runs with disableYText: true.
 * - Outbound, a Y.Text child goes to patchSharedType(Y.Text), which diffs
 *   the same pair again (legacy mode re-diffs once more per ancestor level).
 * - Inbound, patchState diffs the state string against the doc string, and
 *   applyChangesToString rebuilds a string that is exactly the doc string.
 *
 * Each scenario reports `textDiffs` (text diffs one operation actually ran,
 * counted on a separate untimed run) next to `needed` (the text diffs the
 * operation requires: zero for a primitive string or a receiver, one for a
 * Y.Text edit), so the waste reads off without relying on timings.
 *
 * Part of `npm run bench`. To run only these scenarios (~25 s at baseline):
 *
 *   npx ts-node -T -P bench/tsconfig.json -e 'import { __scopedDiffDevSampling } from "./src"; import { formatTable } from "./bench/harness"; import { runStringDiffBench } from "./bench/string-diffs"; __scopedDiffDevSampling.rate = 0; console.log(formatTable(runStringDiffBench()));'
 */
import * as yjs from "yjs";
import { createStore, type StoreApi } from "zustand/vanilla";
import yjsMiddleware, { getYjsStoreHandle, type YjsStoreHandle } from "../src";
import * as diffModule from "../src/diff";
import { patchStore } from "../src/patching";
import { bench, type BenchResult, makeRandom, randomText } from "./harness";

type AnyState = Record<string, unknown>;

interface TextDiffCount {
  textDiffs: number;
  diffChars: number;
}

/**
 * Counts the text diffs `run` performs: getChanges calls on two unequal
 * strings. The bench runs as CommonJS under ts-node, where every call to
 * an exported const (diff.ts's own recursion and patching.ts's import
 * alike) goes through the module's export object, so swapping that
 * property also sees nested calls.
 *
 * @param run - The operation to count.
 * @returns The number of text diffs and the characters fed into them.
 */
const countTextDiffs = (run: () => void): TextDiffCount => {
  const original = diffModule.getChanges;
  const count: TextDiffCount = { "diffChars": 0, "textDiffs": 0 };
  const counting: typeof original = (a, b, options) => {
    if (typeof a === "string" && typeof b === "string" && a !== b) {
      count.textDiffs = count.textDiffs + 1;
      count.diffChars = count.diffChars + a.length + b.length;
    }

    return original(a, b, options);
  };

  Object.defineProperty(diffModule, "getChanges", { "configurable": true, "value": counting, "writable": true });

  try {
    run();
  } finally {
    Object.defineProperty(diffModule, "getChanges", { "configurable": true, "value": original, "writable": true });
  }

  return count;
};

interface Scenario<F> {
  name: string;
  /** Text diffs the operation needs (its floor): 0 or 1. */
  needed: number;
  meta: Record<string, string | number>;
  setup: () => F;
  run: (fixture: F) => void;
  runs: number;
  warmupRuns: number;
}

const measure = <F>({ meta, name, needed, run, runs, setup, warmupRuns }: Scenario<F>): BenchResult => {
  const counted = countTextDiffs(() => { run(setup()); });
  const result = bench(name, (fixture) => { run(fixture as F); }, { runs, setup, warmupRuns });

  return { ...result, "meta": { ...meta, "diffChars": counted.diffChars, needed, "textDiffs": counted.textDiffs } };
};

interface StoreFixture {
  store: StoreApi<AnyState>;
  handle: YjsStoreHandle;
  doc: yjs.Doc;
}

interface StoreOptions {
  scopedDiff: boolean;
  disableYText?: boolean;
  atomicKeys?: string[];
}

/** A store bound to a fresh doc, with its initial state flushed in. */
const makeStore = (initial: AnyState, options: StoreOptions): StoreFixture => {
  const doc = new yjs.Doc();
  const store = createStore<AnyState>()(
    yjsMiddleware(doc, "store", (): AnyState => ({ ...initial, "tick": 0 }), options)
  );
  const handle = getYjsStoreHandle(store);

  // An empty doc is seeded on the first write; flush it so timed runs are steady state.
  store.setState({ "tick": 1 });
  handle.flush();

  return { doc, handle, store };
};

const modeLabel = (isScopedDiff: boolean): string => { return isScopedDiff ? "scopedDiff" : "full-tree" };

/**
 * Runs the string-write scenarios.
 *
 * @returns One result per scenario; `meta` carries textDiffs vs needed.
 */
export const runStringDiffBench = (): BenchResult[] => {
  const results: BenchResult[] = [];

  /*
   * 1. Replace a disableYText string (a long description, a serialized
   * blob). Same alphabet on both sides, so the O(NP) diff (not the disjoint
   * fallback) runs: cost grows with the square of the edit distance.
   */
  for (const chars of [1_000, 2_000, 4_000]) {
    for (const isScopedDiff of chars === 4_000 ? [false, true] : [true]) {
      let seed = chars;

      results.push(measure<{ fixture: StoreFixture; next: string }>({
        "name": `string/outbound: replace a ${String(chars / 1_000)}k-char disableYText string (${modeLabel(isScopedDiff)})`,
        "needed": 0,
        "meta": { chars },
        "setup": () => {
          seed = seed + 2;

          return {
            "fixture": makeStore({ "blob": randomText(chars, makeRandom(seed)) }, { "disableYText": true, "scopedDiff": isScopedDiff }),
            "next": randomText(chars, makeRandom(seed + 1)),
          };
        },
        "run": ({ fixture, next }) => {
          fixture.store.setState({ "blob": next });
          fixture.handle.flush();
        },
        "runs": 5,
        "warmupRuns": 1,
      }));
    }
  }

  /* 2. Replace an atomicKeys string (a base64 cover) in a Y.Text store. */
  {
    const chars = 4_000;
    let seed = 40_000;

    results.push(measure<{ fixture: StoreFixture; next: string }>({
      "name": "string/outbound: replace a 4k-char atomicKeys string (full-tree)",
      "needed": 0,
      "meta": { chars },
      "setup": () => {
        seed = seed + 2;

        return {
          "fixture": makeStore({ "cover": randomText(chars, makeRandom(seed)) }, { "atomicKeys": ["cover"], "scopedDiff": false }),
          "next": randomText(chars, makeRandom(seed + 1)),
        };
      },
      "run": ({ fixture, next }) => {
        fixture.store.setState({ "cover": next });
        fixture.handle.flush();
      },
      "runs": 5,
      "warmupRuns": 1,
    }));
  }

  /* 3. Replace one string in a disableYText array of fifty 1k-char strings. */
  for (const isScopedDiff of [false, true]) {
    let seed = 50_000;

    results.push(measure<{ fixture: StoreFixture; next: string[] }>({
      "name": `string/outbound: replace one of fifty 1k-char strings in an array (${modeLabel(isScopedDiff)})`,
      "needed": 0,
      "meta": { "chars": 1_000, "items": 50 },
      "setup": () => {
        seed = seed + 100;

        const items = Array.from({ "length": 50 }, (unused, index) => randomText(1_000, makeRandom(seed + index)));

        return {
          "fixture": makeStore({ items }, { "disableYText": true, "scopedDiff": isScopedDiff }),
          "next": items.map((item, index) => (index === 25 ? randomText(1_000, makeRandom(seed + 99)) : item)),
        };
      },
      "run": ({ fixture, next }) => {
        fixture.store.setState({ "items": next });
        fixture.handle.flush();
      },
      "runs": 7,
      "warmupRuns": 2,
    }));
  }

  /*
   * 4. Type one character into a 50k-char Y.Text note. One store per mode;
   * every run types one more character, so each flush is a real keystroke
   * against a steady-state doc.
   */
  const NOTE_CHARS = 50_000;
  const note = randomText(NOTE_CHARS, makeRandom(42));

  for (const isScopedDiff of [false, true]) {
    const fixture = makeStore({ note }, { "scopedDiff": isScopedDiff });
    const typing = makeRandom(3);
    let current = note;

    results.push(measure<string>({
      "name": `string/outbound: 1-char insert into a 50k-char Y.Text (${modeLabel(isScopedDiff)})`,
      "needed": 1,
      "meta": { "chars": NOTE_CHARS },
      "setup": () => {
        const position = Math.floor(typing() * current.length);

        current = `${current.slice(0, position)}x${current.slice(position)}`;

        return current;
      },
      "run": (next) => {
        fixture.store.setState({ "note": next });
        fixture.handle.flush();
      },
      "runs": 31,
      "warmupRuns": 5,
    }));

    if (String(fixture.doc.getMap("store").get("note")) !== current) {
      throw new Error("Y.Text note diverged from state");
    }
  }

  /*
   * 5. Receivers: the inbound patch for the same writes (patchStore is what
   * both the full-tree and the key-scoped inbound routes reduce to). The
   * result is, by construction, exactly the doc string.
   */
  for (const chars of [1_000, 2_000, 4_000]) {
    let seed = 60_000 + chars;

    results.push(measure<{ store: StoreApi<AnyState>; remote: AnyState }>({
      "name": `string/inbound: patch a replaced ${String(chars / 1_000)}k-char string`,
      "needed": 0,
      "meta": { chars },
      "setup": () => {
        seed = seed + 2;

        const before = randomText(chars, makeRandom(seed));

        return {
          "remote": { "blob": randomText(chars, makeRandom(seed + 1)), "tick": 1 },
          "store": createStore<AnyState>(() => ({ "blob": before, "tick": 1 })),
        };
      },
      "run": ({ remote, store }) => {
        patchStore(store, remote);
      },
      "runs": 5,
      "warmupRuns": 1,
    }));
  }

  {
    const typing = makeRandom(5);

    results.push(measure<{ store: StoreApi<AnyState>; remote: AnyState }>({
      "name": "string/inbound: patch a 1-char insert into a 50k-char string",
      "needed": 0,
      "meta": { "chars": NOTE_CHARS },
      "setup": () => {
        const position = Math.floor(typing() * note.length);

        return {
          "remote": { "note": `${note.slice(0, position)}x${note.slice(position)}`, "tick": 1 },
          "store": createStore<AnyState>(() => ({ note, "tick": 1 })),
        };
      },
      "run": ({ remote, store }) => {
        patchStore(store, remote);
      },
      "runs": 31,
      "warmupRuns": 5,
    }));
  }

  return results;
};
