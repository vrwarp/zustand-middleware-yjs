import {
  StateCreator,
  StoreMutatorIdentifier,
  StoreApi,
} from "zustand";
import * as Y from "yjs";
import { patchSharedType, patchStore, } from "./patching";
import { convertValue } from "./mapping";

type Yjs = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(
  doc: Y.Doc,
  name: string,
  f: (
    set: YjsSet<T>,
    get: StoreApi<T>["getState"],
    api: StoreApi<T>
  ) => T,
  options?: YjsOptions
) => StateCreator<T, Mps, Mcs>;

/**
 * Options for the Yjs middleware.
 */
export interface YjsOptions
{
  /**
   * specific keys that should be treated as atomic strings.
   *
   * By default, strings in the Zustand store are converted to Y.Text objects
   * in Yjs to support collaborative text editing. However, for some strings
   * like UUIDs, Enums, or base64 data, this behavior is not desirable.
   *
   * Keys listed here will be stored as primitive strings in the Yjs map,
   * bypassing the Y.Text conversion.
   */
  atomicKeys?: string[];

  /**
   * A callback that is called when the store is first loaded from the Yjs document.
   */
  onLoaded?: () => void;
}

export interface YjsProxy {
  set(key: string | number, value: any): void;
  delete(key: string | number): void;
  push(items: any[]): void;
  insert(index: number, items: any[]): void;
}

export type YjsSet<T> = StoreApi<T>["setState"] & {
  yjs: (path?: string) => YjsProxy;
};

type YjsImpl = <T>(
  doc: Y.Doc,
  name: string,
  config: (
    set: YjsSet<T>,
    get: StoreApi<T>["getState"],
    api: StoreApi<T>
  ) => T,
  options?: YjsOptions
) => StateCreator<T, [], []>;


/**
 * This function is the middleware the sets up the Zustand store to mirror state
 * into a Yjs store for peer-to-peer synchronization.
 *
 * @example <caption>Using yjs</caption>
 * const useState = create(
 *   yjs(
 *     new Y.Doc(), // A Y.Doc to back our store with.
 *     "shared",    // A name to give the Y.Map our store is backed by.
 *     (set) =>
 *     ({
 *       "count": 1,
 *     })
 *   )
 * );
 *
 * @param doc The Yjs document to create the store in.
 * @param name The name that the store should be listed under in the doc.
 * @param config The initial state of the store we should be using.
 * @param options The options for the middleware.
 * @returns A Zustand state creator.
 */
const yjs: YjsImpl = <S>(
  doc: Y.Doc,
  name: string,
  config: (
    set: YjsSet<S>,
    get: StoreApi<S>["getState"],
    api: StoreApi<S>
  ) => S,
  options?: YjsOptions
): StateCreator<S> =>
{
  // The root Y.Map that the store is written and read from.
  const map: Y.Map<any> = doc.getMap(name);

  // Augment the store.
  return (set, get, api) =>
  {
    // Initialize the loading state.
    let loaded = false;

    if (map.size > 0)
    {
      loaded = true;
      options?.onLoaded?.();
    }

    /*
     * Capture the initial state so that we can initialize the Yjs store to the
     * same values as the initial values of the Zustand store.
     */
    const setWrapper: any = (partial: any, replace: any) =>
    {
      set(partial as any, replace as any);
      doc.transact(() =>
        patchSharedType(map, get(), options), api);
    };

    setWrapper.yjs = (path: string = "") =>
    {
      const getSharedType = (
        root: Y.Map<any> | Y.Array<any>,
        path: string
      ): Y.AbstractType<any> | undefined =>
      {
        if (!path) return root;
        const parts = path.split(".");
        let current: any = root;
        for (const part of parts)
        {
          if (current instanceof Y.Map)
          {
            current = current.get(part);
          }
          else if (current instanceof Y.Array)
          {
            current = current.get(parseInt(part, 10));
          }
          else
          {
            return undefined;
          }
        }
        return current instanceof Y.AbstractType ? current : undefined;
      };

      const target = getSharedType(map, path);

      if (!target)
      {
        throw new Error(`Path ${path} does not resolve to a Yjs shared type`);
      }

      return {
        "set": (key: string | number, value: any) =>
        {
          doc.transact(() =>
          {
            if (target instanceof Y.Map)
            {
              target.set(
                String(key),
                convertValue(String(key), value, options)
              );
            }
            else if (target instanceof Y.Array)
            {
              const index = Number(key);
              if (index < target.length)
              {
                target.delete(index, 1);
              }
              target.insert(index, [ convertValue("", value, options) ]);
            }
          }, api);
        },
        "delete": (key: string | number) =>
        {
          doc.transact(() =>
          {
            if (target instanceof Y.Map)
            {
              target.delete(String(key));
            }
            else if (target instanceof Y.Array)
            {
              target.delete(Number(key), 1);
            }
          }, api);
        },
        "push": (items: any[]) =>
        {
          doc.transact(() =>
          {
            if (target instanceof Y.Array)
            {
              target.push(items.map((item) =>
                convertValue("", item, options)));
            }
          }, api);
        },
        "insert": (index: number, items: any[]) =>
        {
          doc.transact(() =>
          {
            if (target instanceof Y.Array)
            {
              target.insert(index, items.map((item) =>
                convertValue("", item, options)));
            }
          }, api);
        },
      };
    };

    const initialState = config(
      setWrapper,
      get,
      api
    );

    const originalSetState = api.setState;
    api.setState = (partial, replace) =>
    {
      originalSetState(partial as any, replace as any);
      doc.transact(() =>
        patchSharedType(map, api.getState(), options), api);
    };

    /*
     * We do not initialize the Yjs map with the initial state here.
     * Doing so would trigger a transaction that could overwrite remote state
     * in offline-first scenarios (e.g. "late join"), because the local write
     * might appear newer than the remote state.
     *
     * See "Does not reset state on second join" test in index.spec.ts.
     */

    /*
     * Whenever the Yjs store changes, we perform a set operation on the local
     * Zustand store. We avoid using the Yjs enabled set to prevent unnecessary
     * ping-pong of updates.
     */
    map.observeDeep((_, transaction) =>
    {
      if (!loaded && transaction.origin !== api)
      {
        loaded = true;
        options?.onLoaded?.();
      }

      patchStore(
        {
          ...api,
          "setState": originalSetState,
        },
        map.toJSON()
      );
    });

    // Return the initial state to create or the next middleware.
    return initialState;
  };
};

export default yjs as unknown as Yjs;
