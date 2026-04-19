import type * as yjs from "yjs";
import type {
  StateCreator,
  StoreMutatorIdentifier,
} from "zustand";
import { patchSharedType, patchState, patchStore } from "./patching";

type Yjs = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(
  doc: yjs.Doc,
  name: string,
  f: StateCreator<T, Mps, Mcs>,
  options?: YjsOptions
) => StateCreator<T, Mps, Mcs>;

/**
 * Options for the Yjs middleware.
 */
export interface YjsOptions {
  /**
   * Specific keys that should be treated as atomic strings.
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
   * Disables the default behavior of converting strings to Y.Text objects.
   * If true, all strings will be stored as primitive strings in the Yjs map.
   */
  disableYText?: boolean;

  /**
   * Specific keys that should be treated as Y.Text objects when disableYText is true.
   *
   * When disableYText is enabled, this provides a way to opt-in specific keys to
   * be stored as Y.Text.
   */
  yTextKeys?: string[];

  /**
   * A callback that is called when the store is first loaded from the Yjs document.
   */
  onLoaded?: () => void;

  /**
   * The schema version this client supports. When a remote peer writes a
   * higher `__schemaVersion` into the Yjs document, the middleware permanently
   * halts synchronization to prevent legacy clients from corrupting upgraded
   * data structures.
   */
  schemaVersion?: number;

  /**
   * Called once when the middleware detects a `__schemaVersion` in the Yjs
   * document that exceeds the local `schemaVersion`. After this fires, all
   * inbound and outbound sync is permanently disabled.
   *
   * @param incomingVersion - The schema version found in the Yjs document.
   */
  onObsolete?: (incomingVersion: number) => void;
}

type YjsImpl = <T>(
  doc: yjs.Doc,
  name: string,
  config: StateCreator<T>,
  options?: YjsOptions
) => StateCreator<T>;


/**
 * This function is the middleware the sets up the Zustand store to mirror state
 * into a Yjs store for peer-to-peer synchronization.
 *
 * @param doc - The Yjs document to create the store in.
 * @param name - The name that the store should be listed under in the doc.
 * @param config - The initial state of the store we should be using.
 * @param middlewareOptions - The options for the middleware.
 * @returns A Zustand state creator.
 * @example <caption>Using yjs</caption>
 * const useState = create(
 *   yjs(
 *     new yjs.Doc(), // A yjs.Doc to back our store with.
 *     "shared",    // A name to give the yjs.Map our store is backed by.
 *     (set) =\>
 *     (\{
 *       "count": 1,
 *     \})
 *   )
 * );
 */
const yjsImpl: YjsImpl = <S>(
  doc: yjs.Doc,
  name: string,
  config: StateCreator<S>,
  {
    atomicKeys,
    disableYText,
    onLoaded,
    onObsolete,
    schemaVersion,
    yTextKeys,
  }: YjsOptions = {}
): StateCreator<S> => {
  // The root Y.Map that the store is written and read from.
  const map: yjs.Map<unknown> = doc.getMap(name);
  const middlewareOptions = {
    atomicKeys,
    disableYText,
    onLoaded,
    onObsolete,
    schemaVersion,
    yTextKeys,
  };

  // Permanent kill switch: once set, no further inbound or outbound sync occurs.
  let isObsolete = false;

  /**
   * Augment the store.
   */
  return (set, get, api) => {
    // Initialize the loading state.
    let isLoaded = false;

    if (map.size > 0) {
      isLoaded = true;
      onLoaded?.();
    }

    /*
     * Outbound Microtask Batching: multiple Zustand set() / setState() calls
     * within the same event-loop tick are coalesced into a single Yjs
     * transaction. This reduces complexity from O(T×N) to O(1×N) per tick.
     */
    let isOutboundPending = false;
    // The Zustand state captured BEFORE the first set() / setState() of each batch.
    // Subsequent calls in the same tick do not overwrite this; only the first-call
    // "user's view" baseline is needed for the three-way merge guard.
    let batchPreviousState: S | undefined;

    const originalSetState = api.setState;

    const flushOutbound = () => {
      isOutboundPending = false;
      const previousState = batchPreviousState;

      batchPreviousState = undefined;
      // Read the FINAL state after all synchronous mutations this tick.
      doc.transact(() => {
        patchSharedType(map, api.getState(), { ...middlewareOptions, previousState });
      }, api);
    };

    const scheduleOutbound = (capturedPreviousState: S) => {
      if (isObsolete) {
        return;
      } // Prevent local state from polluting newer CRDT schemas

      if (!isOutboundPending) {
        isOutboundPending = true;
        // Record the pre-mutation state only for the FIRST set() of this batch.
        batchPreviousState = capturedPreviousState;
        queueMicrotask(flushOutbound);
      }
    };

    /*
     * Capture the initial state so that we can initialize the Yjs store to the
     * same values as the initial values of the Zustand store.
     */
    let initialState = config(
      /**
       *
       * Create a new set function that applies local state immediately (for
       * optimistic UI / React responsiveness) then schedules a Yjs sync.
       */
      (partial, replace) => {
        const previousState = get();

        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        set(partial as any, replace as any);
        scheduleOutbound(previousState);
      },
      get,
      api
    );

    if (map.size > 0) {
      initialState = patchState(initialState, map.toJSON() as S);
      api.setState(initialState, true);
    }

    api.setState = (partial, replace) => {
      const previousState = api.getState();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      originalSetState(partial as any, replace as any);
      scheduleOutbound(previousState);
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
     *
     * Inbound Microtask Batching: multiple Yjs transactions arriving within the
     * same event-loop tick are coalesced into a single patchStore call.
     * This reduces complexity from O(T×N) to O(1×N) per tick, preventing
     * main-thread blocking during bulk remote updates.
     */

    // Flag to prevent scheduling more than one sync per event-loop tick.
    let isUpdatePending = false;

    const processBatch = () => {
      isUpdatePending = false;
      patchStore(
        {
          ...api,
          "setState": originalSetState,
        },
        map.toJSON()
      );
    };

    map.observeDeep((unusedArg, transaction) => {
      if (isObsolete) {
        return;
      } // Permanently disabled

      // 1. Poison Pill Check
      if (schemaVersion !== undefined) {
        const incomingVersion = (map.get("__schemaVersion") as number | undefined) || 0;

        if (incomingVersion > schemaVersion) {
          isObsolete = true;
          onObsolete?.(incomingVersion);

          return;
        }
      }

      // 2. Initial Load Handling (unchanged behaviour).
      if (!isLoaded && transaction.origin !== api) {
        isLoaded = true;
        onLoaded?.();
      }

      // 2. Local Echo Suppression.
      // If we originated this transaction, the Zustand store is already
      // up-to-date. Skip the round-trip entirely.
      if (transaction.origin === api) {
        return;
      }

      // 3. Microtask Coalescing.
      // Schedule at most one synchronisation per event-loop tick.
      if (!isUpdatePending) {
        isUpdatePending = true;
        queueMicrotask(processBatch);
      }
    });

    // Return the initial state to create or the next middleware.
    return initialState;
  };
};

export default yjsImpl as unknown as Yjs;
