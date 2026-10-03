/*
 * Scaling of the path-scoped inbound patch with the size of one batch.
 *
 * A scopedDiff receiver takes the deep-path route for a batch whose events
 * all name branches at least two segments deep. An offline catch-up (y-cinder
 * applies its backlog inside one transaction), a backfill migration or a
 * bulk "mark all read" produces one such batch with one path per changed
 * record, all under the same wide parent: ['library', 'book-0'] ...
 * ['library', 'book-N']. The route must stay linear in the number of paths:
 *
 * - minimizeInboundPaths must not compare every path with every kept path.
 * - The shared parent must be copied once per batch, not once per path (a
 *   W-key spread per path is O(P x W)).
 *
 * The first two tests count segment reads through accessor-backed paths, so
 * they are deterministic. The parent copy leaves no trace outside the
 * function (the copies are plain objects created inside it), so the third
 * test pins it with a scaling ratio of CPU time between a 1-path and a
 * 32-path batch under the same 5,000-record parent, with a wide margin on
 * both sides. It never compares against an absolute time.
 */
import * as yjs from "yjs";
import { __scopedDiffDevSampling } from ".";
import { computeInboundStateForPaths, type InboundPath, minimizeInboundPaths } from "./patching";

interface Book { title: string; lastRead: number; tags: string[] }
interface LibraryState { library: Record<string, Book> }

const bookId = (index: number): string => `book-${String(index)}`;

const makeLibrary = (books: number): LibraryState["library"] => {
  const library: LibraryState["library"] = {};

  for (let index = 0; index < books; index = index + 1) {
    library[bookId(index)] = { "title": `Title ${String(index)}`, "lastRead": 0, "tags": ["unread"] };
  }

  return library;
};

/**
 * A doc holding `makeLibrary(books)`, then one transaction that stamps
 * `lastRead` on every record (the shape the middleware writes with
 * disableYText).
 */
const makeChangedLibraryDoc = (books: number): yjs.Map<unknown> => {
  const doc = new yjs.Doc();
  const root = doc.getMap("root");
  const library = new yjs.Map<yjs.Map<unknown>>();

  doc.transact(() => {
    root.set("library", library);

    for (const [id, book] of Object.entries(makeLibrary(books))) {
      const bookMap = new yjs.Map<unknown>();

      library.set(id, bookMap);
      bookMap.set("title", book.title);
      bookMap.set("lastRead", book.lastRead);
      bookMap.set("tags", yjs.Array.from(book.tags));
    }
  });
  doc.transact(() => {
    library.forEach((bookMap) => { bookMap.set("lastRead", 1); });
  });

  return root;
};

/**
 * The paths of one bulk batch: one per changed record, plus a deeper path
 * under every tenth record (covered by its record's path, so it must be
 * dropped, not reconciled twice).
 */
const makeBatchPaths = (books: number): InboundPath[] => {
  const paths: InboundPath[] = [];

  for (let index = 0; index < books; index = index + 1) {
    paths.push(["library", bookId(index)]);

    if (index % 10 === 0) {
      paths.push(["library", bookId(index), "tags"]);
    }
  }

  return paths;
};

/** Copies of `paths` whose segments count every read. */
const withReadCounter = (paths: readonly InboundPath[]) => {
  const counter = { "reads": 0 };
  const counted = paths.map((path) => {
    const copy: (string | number)[] = [];

    for (const [index, step] of path.entries()) {
      Object.defineProperty(copy, index, {
        "enumerable": true,
        "get": () => {
          counter.reads = counter.reads + 1;

          return step;
        },
      });
    }

    return copy as InboundPath;
  });

  return { counted, counter };
};

const SMALL_BATCH = 200;
const LARGE_BATCH = 4 * SMALL_BATCH;

describe("path-scoped inbound patch scales linearly with the batch", () => {
  let savedRate: number;

  beforeAll(() => {
    savedRate = __scopedDiffDevSampling.rate;
    __scopedDiffDevSampling.rate = 0;
  });

  afterAll(() => {
    __scopedDiffDevSampling.rate = savedRate;
  });

  it("minimizeInboundPaths reads each path a bounded number of times, whatever the batch size", () => {
    const readsPerPath = (books: number): number => {
      const paths = makeBatchPaths(books);
      const { counted, counter } = withReadCounter(paths);
      const kept = minimizeInboundPaths(counted);

      // Semantics: every record path is kept, in order; covered paths go.
      expect(kept.map((path) => path.join("/"))).toEqual(
        Array.from({ "length": books }, (unused, index) => `library/${bookId(index)}`)
      );

      return counter.reads / paths.length;
    };

    const small = readsPerPath(SMALL_BATCH);
    const large = readsPerPath(LARGE_BATCH);

    /*
     * A trie (or any linear minimizer) reads each path O(depth) times: the
     * per-path figure stays flat as the batch grows 4x. Comparing every path
     * with every kept path makes it grow 4x with the batch.
     */
    expect(large).toBeLessThanOrEqual(2 * small);
  });

  it("computeInboundStateForPaths reads each path a bounded number of times, whatever the batch size", () => {
    const readsPerPath = (books: number): number => {
      const root = makeChangedLibraryDoc(books);
      const state: LibraryState = { "library": makeLibrary(books) };
      const paths = makeBatchPaths(books);
      const { counted, counter } = withReadCounter(paths);
      const next = computeInboundStateForPaths(state, root, counted);

      expect(next?.library[bookId(0)].lastRead).toBe(1);
      expect(next?.library[bookId(books - 1)].lastRead).toBe(1);

      return counter.reads / paths.length;
    };

    const small = readsPerPath(SMALL_BATCH);
    const large = readsPerPath(LARGE_BATCH);

    expect(large).toBeLessThanOrEqual(2 * small);
  });

  it("copies the shared parent once per batch, not once per changed record", () => {
    const WIDTH = 5_000;
    const CHANGED = 32;
    const root = makeChangedLibraryDoc(WIDTH);
    const state: LibraryState = { "library": makeLibrary(WIDTH) };
    const onePath: InboundPath[] = [["library", bookId(WIDTH / 2)]];
    const manyPaths: InboundPath[] = Array.from(
      { "length": CHANGED },
      (unused, index) => ["library", bookId(index * Math.floor(WIDTH / CHANGED))]
    );

    // Correctness first: changed records are patched, untouched ones shared.
    const patched = computeInboundStateForPaths(state, root, manyPaths);

    expect(patched?.library[bookId(0)].lastRead).toBe(1);
    expect(patched?.library[bookId(1)]).toBe(state.library[bookId(1)]);

    const cpuMs = (paths: InboundPath[]): number => {
      const start = process.cpuUsage();

      computeInboundStateForPaths(state, root, paths);

      const used = process.cpuUsage(start);

      return (used.user + used.system) / 1000;
    };

    // Warm up both shapes, then interleave and keep the fastest sample.
    cpuMs(onePath);
    cpuMs(manyPaths);

    const oneSamples: number[] = [];
    const manySamples: number[] = [];

    for (let run = 0; run < 7; run = run + 1) {
      oneSamples.push(cpuMs(onePath));
      manySamples.push(cpuMs(manyPaths));
    }

    const ratio = Math.min(...manySamples) / Math.max(Math.min(...oneSamples), 0.05);

    /*
     * Both batches must copy the 5,000-key parent at least once; the extra
     * 31 paths each add only a small record diff. One copy per batch keeps
     * the ratio near 1 (about 1.5 even under coverage instrumentation); one
     * copy per path makes it about 30.
     */
    expect(ratio).toBeLessThanOrEqual(6);
  });
});
