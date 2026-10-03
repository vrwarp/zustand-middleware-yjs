/*
 * Regression: non-JSON array elements must not break outbound replication.
 *
 * `undefined` array elements (from `arr.map(o => o.optional)`), holes in
 * sparse arrays (`Array(n)`, `arr[i] = v` past the end) and function elements
 * are not JSON values. Writing one must neither throw out of the outbound
 * flush (it runs in a queueMicrotask, so the throw would be uncaught) nor stop
 * the OTHER keys of the store from replicating on this and every later flush.
 *
 * Any reasonable normalization is accepted for the array itself: JSON
 * semantics (undefined/hole/function -> null) or omitting the element. Once
 * normalized, later flushes must not rewrite the array either (the state still
 * holds the non-JSON element, so a diff that disagrees with the normalization
 * would churn `list` on every flush, and under scopedDiff the dev divergence
 * tripwire would report a false drift).
 */
import { createStore } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { __scopedDiffDevSampling, getYjsStoreHandle } from ".";

interface State {
  list: unknown[];
  x: number;
}

const setup = (initialList: unknown[], scopedDiff: boolean) => {
  const doc = new Y.Doc();
  const store = createStore<State>(yjs(
    doc,
    "s",
    (): State => ({ list: initialList, x: 0 }),
    { scopedDiff }
  ));
  const map = doc.getMap("s");
  const errors: string[] = [];

  // Drain the outbound batch synchronously (instead of racing the microtask)
  // and record anything it throws.
  const flush = (): void => {
    try {
      getYjsStoreHandle(store).flush();
    } catch (error) {
      errors.push(String(error));
    }
  };

  return { errors, flush, map, store };
};

/**
 * Writes x = 3 and x = 4 in two separate flushes after the trigger, and
 * returns how many doc events touched `list` meanwhile (expected: none).
 */
const writeLaterKeys = (
  { flush, map, store }: Pick<ReturnType<typeof setup>, "flush" | "map" | "store">
): number => {
  let listEvents = 0;
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    for (const event of events) {
      if (event.target !== map || event.changes.keys.has("list")) {
        listEvents += 1;
      }
    }
  };

  map.observeDeep(observer);
  store.setState({ x: 3 });
  flush();
  store.setState({ x: 4 });
  flush();
  map.unobserveDeep(observer);

  return listEvents;
};

describe.each([
  ["full diff", false],
  ["scopedDiff", true],
])("non-JSON array elements in outbound state (%s)", (_mode, scopedDiff) => {
  beforeEach(() => {
    // Run the scopedDiff divergence tripwire on every flush (dev only).
    __scopedDiffDevSampling.rate = 1;
  });

  afterEach(() => {
    __scopedDiffDevSampling.rate = 0.02; // restore the default
  });

  it("an undefined element inserted into a synced array does not throw and later keys keep syncing", () => {
    const { errors, flush, map, store } = setup([], scopedDiff);

    store.setState({ list: [1, 2], x: 1 });
    flush();
    expect(map.toJSON()).toEqual({ list: [1, 2], x: 1 });

    // e.g. items.map((item) => item.optionalField)
    store.setState({ list: [1, undefined, 2], x: 2 });
    flush();
    const listEvents = writeLaterKeys({ flush, map, store });

    expect({ errors, listEvents, x: map.get("x") }).toEqual({ errors: [], listEvents: 0, x: 4 });
    expect([[1, null, 2], [1, 2]]).toContainEqual(map.toJSON().list);
  });

  it("a brand-new array containing undefined does not throw and later keys keep syncing", () => {
    const { errors, flush, map, store } = setup([], scopedDiff);

    const rows: { optional?: number }[] = [{ optional: 1 }, {}, { optional: 2 }];

    // The list key is new to the doc: written whole (arrayToYArray path).
    store.setState({ list: rows.map((row) => row.optional), x: 2 });
    flush();
    const listEvents = writeLaterKeys({ flush, map, store });

    expect({ errors, listEvents, x: map.get("x") }).toEqual({ errors: [], listEvents: 0, x: 4 });
    expect([[1, null, 2], [1, 2]]).toContainEqual(map.toJSON().list);
  });

  it("a sparse array (holes) does not throw and later keys keep syncing", () => {
    const { errors, flush, map, store } = setup([], scopedDiff);

    store.setState({ list: [1], x: 1 });
    flush();
    expect(map.toJSON()).toEqual({ list: [1], x: 1 });

    const sparse: number[] = [1];

    sparse[2] = 2; // index 1 is a hole

    store.setState({ list: sparse, x: 2 });
    flush();
    const listEvents = writeLaterKeys({ flush, map, store });

    expect({ errors, listEvents, x: map.get("x") }).toEqual({ errors: [], listEvents: 0, x: 4 });
    expect([[1, null, 2], [1, 2]]).toContainEqual(map.toJSON().list);
  });

  it("a function element prepended to a synced array does not desync later indices", () => {
    const { errors, flush, map, store } = setup([], scopedDiff);

    store.setState({ list: [1, 2, 3], x: 1 });
    flush();
    expect(map.toJSON()).toEqual({ list: [1, 2, 3], x: 1 });

    const callback = (): void => undefined;

    store.setState({ list: [callback, 1, 2, 4], x: 2 });
    flush();
    const listEvents = writeLaterKeys({ flush, map, store });

    expect({ errors, listEvents, x: map.get("x") }).toEqual({ errors: [], listEvents: 0, x: 4 });
    expect([[null, 1, 2, 4], [1, 2, 4]]).toContainEqual(map.toJSON().list);
  });

  it("a function element does not misalign the previous state of later elements", () => {
    const { errors, flush, map, store } = setup([], scopedDiff);
    const callback = (): void => undefined;

    store.setState({ list: [callback, { c: 1 }, { a: 1, b: 2 }], x: 1 });
    flush();

    // Deleting `b` must not be mistaken for a concurrent remote insert, which
    // is what the delete guard concludes if it reads the previous state of
    // the element at the wrong index ({ c: 1 } instead of { a: 1, b: 2 }).
    store.setState({ list: [callback, { c: 1 }, { a: 1 }], x: 2 });
    flush();

    expect({ errors, list: map.toJSON().list }).toEqual({
      errors: [],
      list: [{ c: 1 }, { a: 1 }],
    });
  });
});
