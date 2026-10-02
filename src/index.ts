import * as yjs from "yjs";
import type {
  StateCreator,
  StoreMutatorIdentifier,
} from "zustand";
import { isDeepEqualForDiff } from "./diff";
import { isDevEnvironment } from "./env";
import {
  assertScopedDiffConvergence,
  computeInboundState,
  computeInboundStateForPaths,
  type InboundPath,
  patchSharedType,
  patchSharedTypeScoped,
  patchStore,
  truncateAtArrayIndex,
} from "./patching";

/**
 * DEV-only sampling control for the scopedDiff divergence tripwire: after a
 * scoped flush, with this probability a full state-vs-map diff runs and
 * asserts convergence, failing LOUDLY on mutate-in-place divergence. Exported
 * so tests can pin it to 1 (always) or 0 (deterministic perf assertions).
 * No-op in production builds.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- public test/diagnostic hook; the double-underscore marks it internal-but-exported
export const __scopedDiffDevSampling = { rate: 0.02 };

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
   * The schema version this client supports. When the Yjs document holds a
   * higher `__schemaVersion` (already at store creation, or written later by
   * a remote peer), the middleware permanently halts synchronization to
   * prevent legacy clients from corrupting upgraded data structures. A store
   * that is obsolete at creation is not hydrated and keeps its defaults.
   */
  schemaVersion?: number;

  /**
   * Called once when the middleware detects a `__schemaVersion` in the Yjs
   * document that exceeds the local `schemaVersion`. After this fires, all
   * inbound and outbound sync is permanently disabled. When the document is
   * already newer at store creation, the call is deferred to a microtask.
   *
   * @param incomingVersion - The schema version found in the Yjs document.
   */
  onObsolete?: (incomingVersion: number) => void;

  /**
   * Top-level keys replicated to the Y.Map. `undefined` (the default) = legacy
   * behavior: every non-function top-level key syncs.
   *
   * When provided, the replication universe for this store is exactly this key
   * set, BOTH directions (top level only; nesting below a synced key
   * replicates fully):
   *
   * - Outbound: a non-listed key can never be inserted, updated, or deleted in
   * the Y.Map by this client.
   * - Inbound: a foreign map key is never inserted into store state, and a
   * non-listed local key is never touched by remote updates.
   * - Resurrection guard: a key removed from `syncedKeys` whose value still
   * exists in old docs is ignored both directions.
   *
   * `__schemaVersion` is implicitly a synced key whenever `schemaVersion` is
   * set (the poison-pill read and the migration dual-write depend on it);
   * stores need not list it.
   *
   * Dev-mode misconfiguration is a loud error at store creation: every entry
   * must exist in the initial state and must not be a function.
   */
  syncedKeys?: readonly string[];

  /**
   * Inbound semantics for top-level state keys absent from the Y.Map. Default
   * `'replace'` = legacy replace-with-delete hydration (a field newly added to
   * a synced store's initial state is wiped on first hydration from an older
   * doc).
   *
   * `'merge-defaults'`: a TOP-LEVEL inbound DELETE is suppressed iff the key is
   * one of the store's declared defaults (the non-function keys of the initial
   * state as returned by the state creator, captured before any patching).
   * Everything else applies unchanged — inserts, updates, and ALL nested
   * deletes. Retention is top-level-key-presence based and shallow. A retained
   * default is not written back to the doc until something actually set()s it
   * (lazy backfill). Deliberate top-level key removal remains a migration
   * concern: remove the key from defaults/syncedKeys and bump the schema
   * version in the same release.
   */
  hydration?: "replace" | "merge-defaults";

  /**
   * Per-top-level-key scoped diffing. Default false = legacy full-tree diff
   * (`sharedType.toJSON()` of the entire map on every outbound flush;
   * `map.toJSON()` of the whole tree on every inbound batch). In both modes a
   * flush that runs while a remote change is still unapplied to state takes
   * the scoped route, so it cannot revert that change.
   *
   * When true:
   * - Outbound: only top-level keys whose value changed by `Object.is` between
   * the batch-start previousState and the current state are diffed, each
   * against its own subtree only. Sound for stores following zustand's
   * immutable-update convention; mutate-in-place writes are invisible to the
   * fast path — guarded by the DEV sampling tripwire (loud failure) and the
   * contract suite's fast-check equivalence property. Under the default
   * `'replace'` hydration, top-level keys the map lacks are also written (so
   * the first flush writes every key, as the full diff does, and untouched
   * defaults survive a reload); under `'merge-defaults'` they stay lazy.
   * - Inbound: only the top-level keys named by the batch's Yjs events are
   * re-read and patched; untouched keys keep their object identity.
   */
  scopedDiff?: boolean;

  /**
   * Bind the store to a NESTED Y.Map at `doc.getMap(name).get(scope.key)`
   * instead of the top-level map (an unchanged flat state binds to, e.g.,
   * `preferences.<deviceId>` so zero consumer call sites change).
   *
   * Semantics:
   * - The nested map is created lazily on the first outbound flush; a store
   * whose scope key has no entry starts from its declared defaults.
   * - Inbound path filtering: only transactions touching the scope key reach
   * this store — sibling entries never patch it.
   * - The `__schemaVersion` poison pill still reads the TOP-LEVEL named map
   * (the obsolete check is unaffected by scoping).
   */
  scope?: { key: string };
}

/**
 * The per-store sync/hydration handle, attached to the store api as `api.yjs`
 * (modeled on `zustand/persist`'s `api.persist`).
 */
export interface YjsStoreHandle {
  /** True once the store has applied its first patch from the doc (or was marked). */
  hasHydrated: () => boolean;
  /**
   * Resolves after hydration; resolution strictly follows the hydrating
   * `setState`, so an awaiting caller always observes hydrated state.
   */
  whenHydrated: () => Promise<void>;
  /**
   * Call when the doc is synced and this store's map is legitimately empty
   * (the middleware alone cannot detect that — the knowledge belongs to the
   * persistence layer). Idempotent; safe after real hydration.
   */
  markHydrated: () => void;
  /** Synchronously drain the pending outbound microtask. */
  flush: () => void;
  /** True once the schema-version poison pill permanently halted sync. */
  isObsolete: () => boolean;
}

/**
 * Typed accessor for the `api.yjs` handle the middleware attaches.
 * Throws if the store was not created with this middleware.
 *
 * @param store - The Zustand store (or its api) to read the handle from.
 * @returns The store's YjsStoreHandle.
 */
export const getYjsStoreHandle = (store: unknown): YjsStoreHandle => {
  const handle = (store as { yjs?: YjsStoreHandle }).yjs;

  if (handle === undefined) {
    throw new Error(
      "[zustand-middleware-yjs] store has no `yjs` handle — was it created " +
      "with the yjs middleware?"
    );
  }

  return handle;
};

type YjsImpl = <T>(
  doc: yjs.Doc,
  name: string,
  config: StateCreator<T>,
  options?: YjsOptions
) => StateCreator<T>;

/**
 * What a store's flush wrote, recorded in the meta of a transaction it shares
 * with a caller (see recordOwnFlush).
 */
interface OwnFlush {
  dataMap: yjs.Map<unknown>;
  state: Record<string, unknown>;
}

/**
 * This function is the middleware the sets up the Zustand store to mirror state
 * into a Yjs store for peer-to-peer synchronization.
 *
 * @param doc - The Yjs document to create the store in.
 * @param name - The name that the store should be listed under in the doc.
 * @param config - The initial state of the store we should be using.
 * @param options - The options for the middleware.
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
    yTextKeys,
    onLoaded,
    onObsolete,
    schemaVersion,
    syncedKeys,
    hydration,
    scopedDiff,
    scope,
  }: YjsOptions = {}
): StateCreator<S> => {
  // The top-level named Y.Map. Without `scope` this IS the store's data map;
  // with `scope` the data lives in a nested Y.Map under scope.key and the
  // named map remains the observation root and the poison-pill surface.
  const rootMap: yjs.Map<unknown> = doc.getMap(name);

  const scopeKey: string | undefined = scope?.key;

  /**
   * The store's data map, or undefined while the scoped child doesn't exist.
   */
  const getDataMap = (): yjs.Map<unknown> | undefined => {
    if (scopeKey === undefined) {
      return rootMap;
    }

    const child = rootMap.get(scopeKey);

    return child instanceof yjs.Map ? child : undefined;
  };

  /**
   * The store's data map, lazily creating the scoped child.
   */
  const ensureDataMap = (): yjs.Map<unknown> => {
    const existing = getDataMap();

    if (existing !== undefined) {
      return existing;
    }

    const created = new yjs.Map();

    rootMap.set(scopeKey as string, created);

    return created;
  };

  /*
   * The effective replication whitelist (undefined = legacy "all non-function
   * keys"). `__schemaVersion` is implicitly synced whenever the poison pill is
   * configured — the per-map version check and the migration dual-write depend
   * on it reaching both the doc and store state.
   */
  const syncedKeySet: ReadonlySet<string> | undefined = syncedKeys
    ? new Set<string>(
      schemaVersion === undefined
        ? syncedKeys
        : [...syncedKeys, "__schemaVersion"]
    )
    : undefined;

  // Permanent kill switch: once set, no further inbound or outbound sync occurs.
  let isObsolete = false;

  /**
   * Poison Pill Check (always on the TOP-LEVEL named map — the obsolete check
   * is unaffected by scoping). Returns the doc's `__schemaVersion` when it
   * exceeds the local `schemaVersion`, otherwise undefined.
   */
  const getNewerSchemaVersion = (): number | undefined => {
    if (schemaVersion === undefined) {
      return undefined;
    }

    const incomingVersion = (rootMap.get("__schemaVersion") as number | undefined) || 0;

    return incomingVersion > schemaVersion ? incomingVersion : undefined;
  };

  /**
   * Augment the store.
   */
  return (set, get, api) => {
    /*
     * The doc may already hold a newer schema at creation (a persistence
     * provider loaded it before the store was constructed). The observer only
     * sees later transactions, so check here as well: skip onLoaded and the
     * creation hydration, keeping the declared defaults. onObsolete is
     * deferred so it never runs while the store is still being created.
     */
    const creationSchemaVersion = getNewerSchemaVersion();

    if (creationSchemaVersion !== undefined) {
      isObsolete = true;
      queueMicrotask(() => {
        onObsolete?.(creationSchemaVersion);
      });
    }

    // Initialize the loading state.
    let isLoaded = false;

    if (!isObsolete && (getDataMap()?.size ?? 0) > 0) {
      isLoaded = true;
      onLoaded?.();
    }

    /*
     * Hydration state for the api.yjs handle. `isHydrated` flips at the end of
     * whichever happens first:
     * (a) the synchronous initial patch when the data map is pre-populated at
     * store creation;
     * (b) the first applied inbound processBatch;
     * (c) api.yjs.markHydrated() (provider: doc synced + map empty).
     * The resolve call always happens AFTER the corresponding setState returns,
     * so an awaiting caller observes hydrated state.
     */
    let isHydrated = false;
    let resolveHydrated!: () => void;
    const hydratedPromise = new Promise<void>((resolve) => {
      resolveHydrated = resolve;
    });
    const markHydrated = (): void => {
      if (isHydrated) {
        return;
      }

      isHydrated = true;
      resolveHydrated();
    };

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

    // Inbound counterpart (processBatch, below): at most one inbound sync per
    // tick, and true while a foreign transaction is in the doc but not yet
    // applied to state.
    let isUpdatePending = false;
    // The shared types those unapplied transactions changed (their event
    // targets), for the same-tick flush's three-way array merge.
    let unappliedInboundTargets: Set<yjs.AbstractType<unknown>> | undefined;

    /*
     * The doc state an inbound patch is applying right now. A middleware
     * nested inside yjs (immer, devtools) forwards it to the `set` below,
     * which must not schedule it back out to the doc. Matching this exact
     * object rather than raising a flag keeps the sets that subscribers make
     * in reaction to the patch syncing.
     */
    let inboundState: unknown;

    /**
     *
     * Inside a caller's doc.transact, Yjs reuses the outer transaction and
     * drops our origin, so the observer cannot tell this store's write from
     * the caller's by origin alone. Record what was flushed on the
     * transaction itself (keyed by the store api) so it still can.
     */
    const recordOwnFlush = (
      transaction: yjs.Transaction,
      dataMap: yjs.Map<unknown>,
      state: S
    ) => {
      if (transaction.origin === api) {
        return;
      }

      const ownFlush: OwnFlush = {
        dataMap,
        state: state as Record<string, unknown>,
      };

      transaction.meta.set(api, ownFlush);
    };

    const flushOutbound = () => {
      isOutboundPending = false;
      const previousState = batchPreviousState;

      batchPreviousState = undefined;

      // The poison pill may have fired after this flush was queued (a remote
      // schema bump in the same tick): never write legacy state over it.
      if (isObsolete) {
        return;
      }

      const sharedOptions = {
        atomicKeys,
        disableYText,
        yTextKeys,
        syncedKeys: syncedKeySet,
      };

      /*
       * A foreign transaction whose inbound batch has not run yet is already
       * in the doc but not in state, so a doc-vs-state diff would write the
       * stale local values back over it. Write only what changed since the
       * batch-start previousState instead (the scoped diff is that three-way
       * merge), whatever the diff mode.
       */
      const hasUnappliedInbound = isUpdatePending;

      if ((scopedDiff || hasUnappliedInbound) && previousState !== undefined) {
        // Scoped path: diff only the Object.is-changed top-level keys, each
        // against its own subtree.
        const state = api.getState();

        // Under 'replace' a never-set default the doc lacks would be deleted
        // by every full inbound patch (reloads, peers), so write it now as
        // the full diff does; merge-defaults retains it and backfills lazily.
        // Not while an inbound batch is unapplied: a key the doc lacks may
        // then be a remote delete state has not seen yet, and the next flush
        // backfills any key that is still absent.
        doc.transact((transaction) => {
          const dataMap = ensureDataMap();

          patchSharedTypeScoped(dataMap, state, previousState, {
            ...sharedOptions,
            backfillAbsentKeys: hydration !== "merge-defaults" && !hasUnappliedInbound,
            unappliedInboundTargets: hasUnappliedInbound ? unappliedInboundTargets : undefined,
          });
          recordOwnFlush(transaction, dataMap, state);
        }, api);

        // Divergence tripwire: occasionally verify the scoped flush against a
        // full diff and fail loudly on drift (mutate-in-place writes). A doc
        // still ahead of state by an unapplied inbound batch is not drift.
        if (
          isDevEnvironment() &&
          !hasUnappliedInbound &&
          Math.random() < __scopedDiffDevSampling.rate
        ) {
          const dataMap = getDataMap();

          if (dataMap !== undefined) {
            assertScopedDiffConvergence(dataMap, api.getState(), { syncedKeys: syncedKeySet });
          }
        }
      } else {
        /*
         * Legacy full-tree diff. Also the defensive fallback for a first flush
         * without a captured previousState. Read the FINAL state after all
         * synchronous mutations this tick.
         */
        const state = api.getState();

        doc.transact((transaction) => {
          const dataMap = ensureDataMap();

          patchSharedType(dataMap, state, {
            ...sharedOptions,
            previousState,
          });
          recordOwnFlush(transaction, dataMap, state);
        }, api);
      }
    };

    const scheduleOutbound = (capturedPreviousState: S) => {
      if (isObsolete) {
        return;
      } // Prevent local state from polluting newer CRDT schemas

      if (!isOutboundPending) {
        isOutboundPending = true;
        // Record the pre-mutation state only for the FIRST set() of this batch.
        // Callers schedule BEFORE applying their write: zustand notifies
        // listeners synchronously inside set, so a set() made from a
        // subscriber must not claim the batch with a post-write baseline.
        batchPreviousState = capturedPreviousState;
        // The guard makes api.yjs.flush() (synchronous drain) safe: a manual
        // flush clears the flag and the stale microtask becomes a no-op.
        queueMicrotask(() => {
          if (isOutboundPending) {
            flushOutbound();
          }
        });
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
        // Doc state forwarded here by a nested middleware is never echoed.
        if (partial !== inboundState) {
          scheduleOutbound(get());
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        set(partial as any, replace as any);
      },
      get,
      api
    );

    /*
     * Merge-over-declared-defaults hydration: capture the declared defaults —
     * the non-function keys of the initial state as returned by the state
     * creator, BEFORE any patching. Inbound top-level DELETEs for these keys
     * are suppressed; nested deletes still propagate. Undefined (hydration
     * 'replace', the default) = legacy replace-with-delete behavior.
     */
    const declaredDefaultKeys: ReadonlySet<string> | undefined =
      hydration === "merge-defaults"
        ? new Set(
          Object.entries(initialState as Record<string, unknown>)
            .filter(([, value]) => !(value instanceof Function))
            .map(([key]) => key)
        )
        : undefined;

    /*
     * Loud dev-mode misconfiguration check: a syncedKeys entry that is absent
     * from the initial state would silently never sync (a typo), and a
     * function entry could never sync (functions are excluded from replication
     * by design).
     */
    if (syncedKeys && isDevEnvironment()) {
      const initialRecord = initialState as Record<string, unknown>;

      for (const key of syncedKeys) {
        if (!Object.hasOwn(initialRecord, key)) {
          throw new Error(
            `[zustand-middleware-yjs] syncedKeys entry "${key}" is not a key ` +
            `of the initial state of store "${name}". Synced keys must exist ` +
            `in the object returned by the state creator (likely a typo — ` +
            `the key would otherwise silently never sync).`
          );
        }
        if (initialRecord[key] instanceof Function) {
          throw new TypeError(
            `[zustand-middleware-yjs] syncedKeys entry "${key}" of store ` +
            `"${name}" is a function. Functions are never replicated; remove ` +
            `it from syncedKeys.`
          );
        }
      }
    }

    /*
     * Captured only now that config() has run: a middleware nested inside yjs
     * (immer, persist, devtools) installs its own api.setState while it runs,
     * and wrapping the one from before would silently bypass it.
     */
    const originalSetState = api.setState;

    /**
     * Applies doc state to the store through the full setState chain, so a
     * nested middleware still sees it (persist stores remote changes), without
     * scheduling an outbound echo.
     */
    const setInboundState: typeof api.setState = (state, replace) => {
      inboundState = state;

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        originalSetState(state as any, replace as any);
      } finally {
        inboundState = undefined;
      }
    };

    const creationDataMap = getDataMap();

    if (!isObsolete && creationDataMap !== undefined && creationDataMap.size > 0) {
      initialState = computeInboundState(
        initialState,
        creationDataMap.toJSON(),
        {
          syncedKeys: syncedKeySet,
          suppressTopLevelDeleteKeys: declaredDefaultKeys,
        }
      );
      setInboundState(initialState, true);
      markHydrated(); // hydration source (a): synchronous initial patch
    }

    api.setState = (partial, replace) => {
      scheduleOutbound(api.getState());
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      originalSetState(partial as any, replace as any);
    };

    /*
     * Attach the per-store handle (api.yjs — the zustand/persist-style
     * augmentation). Consumers reach it through getYjsStoreHandle(store).
     */
    const handle: YjsStoreHandle = {
      hasHydrated: () => isHydrated,
      whenHydrated: () => hydratedPromise,
      markHydrated,
      flush: () => {
        if (isOutboundPending) {
          flushOutbound();
        }
      },
      isObsolete: () => isObsolete,
    };

    (api as unknown as { yjs: YjsStoreHandle }).yjs = handle;

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

    // Under scopedDiff: the top-level keys named by the foreign Yjs events of
    // the current inbound batch, plus a full-patch escape hatch for "the
    // scoped child map itself was (re)placed" events.
    let pendingInboundKeys: Set<string> | undefined;
    let hasPendingInboundFull = false;

    /*
     * Full store-relative paths of the changed nodes in this batch, when
     * every event in it named one at least two segments deep. Yjs already
     * tells us exactly which branch changed; keeping the whole path lets the
     * patch reconcile that branch instead of re-reading the entire
     * top-level key. Cleared (and the batch falls back to the key-scoped
     * path) as soon as any event names a top-level key directly.
     */
    let pendingInboundPaths: InboundPath[] | undefined;
    let hasShallowInboundEvent = false;

    const processBatch = () => {
      /*
       * Flush a pending local write into the doc first, while this batch
       * still counts as unapplied (so the flush writes only the local
       * change): patching state from the doc below would otherwise roll the
       * write back, and the later flush would find nothing to send.
       */
      if (isOutboundPending) {
        flushOutbound();
      }

      isUpdatePending = false;
      unappliedInboundTargets = undefined;

      /*
       * Take this batch's deep-path accumulators up front so every exit below
       * leaves a clean slate: a leftover shallow flag would keep forcing the
       * slow route on later batches that do not need it.
       */
      const deepPaths = pendingInboundPaths;
      const hasShallowEvent = hasShallowInboundEvent;

      pendingInboundPaths = undefined;
      hasShallowInboundEvent = false;

      // A later transaction in this batch may have fired the poison pill: the
      // doc now holds newer-schema data the legacy store must never absorb.
      if (isObsolete) {
        pendingInboundKeys = undefined;
        hasPendingInboundFull = false;

        return;
      }

      const storeForPatch = {
        ...api,
        "setState": setInboundState,
      };

      const dataMap = getDataMap();

      if (scopedDiff && !hasPendingInboundFull) {
        // Scoped inbound: re-read ONLY the affected top-level keys; the patched
        // subset is applied over the full state, so untouched keys keep their
        // object identity (referential stability).
        const collected = pendingInboundKeys;

        pendingInboundKeys = undefined;

        if (collected === undefined || collected.size === 0) {
          return;
        }

        const affectedKeys: ReadonlySet<string> = syncedKeySet
          ? new Set([...collected].filter((key) => syncedKeySet.has(key)))
          : collected;

        if (affectedKeys.size === 0) {
          return;
        }

        /*
         * Deep-path fast route: every event in this batch named a branch at
         * least two segments below the store root, so only those branches
         * need reconciling. Avoids serializing and diffing the whole
         * top-level value, which is O(total state) per inbound batch.
         */
        if (!hasShallowEvent && deepPaths !== undefined && dataMap !== undefined) {
          const currentState = storeForPatch.getState() as Record<string, unknown>;
          const nextState = computeInboundStateForPaths(currentState, dataMap, deepPaths, {
            syncedKeys: affectedKeys,
          });

          // `undefined` = a named branch is missing on one side, so the
          // change is only visible above these paths: fall through to the
          // key-scoped patch rather than dropping it.
          if (nextState !== undefined) {
            if (!Object.is(nextState, currentState)) {
              setInboundState(nextState as never, true);
            }
            markHydrated(); // hydration source (b): first applied inbound batch

            return;
          }
        }

        const partialMapJson: Record<string, unknown> = {};

        for (const key of affectedKeys) {
          if (dataMap?.has(key)) {
            const value = dataMap.get(key);

            partialMapJson[key] = value instanceof yjs.AbstractType ? value.toJSON() : value;
          }
        }

        patchStore(storeForPatch, partialMapJson, {
          syncedKeys: affectedKeys,
          suppressTopLevelDeleteKeys: declaredDefaultKeys,
        });
        markHydrated(); // hydration source (b): first applied inbound batch

        return;
      }

      pendingInboundKeys = undefined;
      hasPendingInboundFull = false;

      patchStore(
        storeForPatch,
        dataMap === undefined ? {} : dataMap.toJSON(),
        {
          syncedKeys: syncedKeySet,
          suppressTopLevelDeleteKeys: declaredDefaultKeys,
        }
      );
      markHydrated(); // hydration source (b): first applied inbound batch
    };

    /**
     *
     * Scope relevance filter: without scoping every event is relevant; with
     * scoping only transactions touching scope.key reach the store (deep
     * events carry the key in path[0]; root-map events name it in
     * changes.keys). Sibling entries never trigger inbound patches.
     */
    const touchesScope = (events: yjs.YEvent<yjs.AbstractType<unknown>>[]): boolean =>
      { return scopeKey === undefined ||
      events.some((event) =>
        { return event.path.length > 0
          ? String(event.path[0]) === scopeKey
          : event.changes.keys.has(scopeKey) }) };

    /**
     *
     * Narrows a batch that also carries this store's own flush (made inside a
     * caller's doc.transact, so it shares the caller's origin) to the
     * top-level keys whose doc value differs from what the flush wrote: the
     * caller's own writes. Returns undefined when the batch cannot be
     * narrowed (the scoped child was replaced or removed after the flush).
     */
    const getForeignKeys = (
      events: yjs.YEvent<yjs.AbstractType<unknown>>[],
      ownFlush: OwnFlush
    ): Set<string> | undefined => {
      const { dataMap, state } = ownFlush;

      if (getDataMap() !== dataMap) {
        return undefined;
      }

      const changedKeys = new Set<string>();

      for (const event of events) {
        if (scopeKey !== undefined && event.path.length === 0) {
          // The scoped child itself was placed in this transaction. Yjs raises
          // no events inside a type created in the same transaction, so every
          // key it holds is a candidate.
          if (event.changes.keys.has(scopeKey)) {
            for (const key of dataMap.keys()) {
              changedKeys.add(key);
            }
          }
        } else if (scopeKey === undefined || String(event.path[0]) === scopeKey) {
          const storePath = scopeKey === undefined ? event.path : event.path.slice(1);

          if (storePath.length > 0) {
            changedKeys.add(String(storePath[0]));
          } else {
            for (const key of event.changes.keys.keys()) {
              changedKeys.add(key);
            }
          }
        }
      }

      const foreignKeys = new Set<string>();

      for (const key of changedKeys) {
        const value = dataMap.get(key);
        const isFlushed = dataMap.has(key)
          ? Object.hasOwn(state, key) && isDeepEqualForDiff(
            state[key],
            value instanceof yjs.AbstractType ? value.toJSON() : value
          )
          : !Object.hasOwn(state, key);

        if (!isFlushed) {
          foreignKeys.add(key);
        }
      }

      return foreignKeys;
    };

    rootMap.observeDeep((events: yjs.YEvent<yjs.AbstractType<unknown>>[], transaction) => {
      if (isObsolete) {
        return;
      } // Permanently disabled

      // 1. Poison Pill Check.
      const incomingVersion = getNewerSchemaVersion();

      if (incomingVersion !== undefined) {
        isObsolete = true;
        onObsolete?.(incomingVersion);

        return;
      }

      if (!touchesScope(events)) {
        return;
      }

      // A flush made inside a caller's doc.transact shares the caller's
      // origin, so the origin checks below would take it for a remote write.
      // Narrow such a batch to the caller's writes; none means a local echo.
      const ownFlush = transaction.meta.get(api) as OwnFlush | undefined;
      const foreignKeys = ownFlush === undefined ? undefined : getForeignKeys(events, ownFlush);

      if (foreignKeys?.size === 0) {
        return;
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

      if (scopedDiff && foreignKeys !== undefined) {
        // Only the caller's writes are inbound: the store already holds what
        // it flushed itself.
        pendingInboundKeys = pendingInboundKeys ?? new Set<string>();

        for (const key of foreignKeys) {
          pendingInboundKeys.add(key);
        }
        hasShallowInboundEvent = true;
      } else if (scopedDiff) {
        // Scoped inbound: collect the affected top-level keys across the
        // microtask batch. Key positions shift by one level under `scope`.
        pendingInboundKeys = pendingInboundKeys ?? new Set<string>();
        const keys = pendingInboundKeys;

        pendingInboundPaths = pendingInboundPaths ?? [];

        const paths = pendingInboundPaths;

        /*
         * `event.path` is relative to the ROOT map, so under `scope` the
         * store-relative path is the tail after the scope segment. A path of
         * two or more store-relative segments identifies a branch the
         * path-scoped patch can reconcile on its own; anything shallower
         * (a top-level key added, replaced or deleted) still needs the
         * key-scoped route, which reconciles that whole key. Paths are cut
         * at their first array index, which may be miscounted or stale by
         * the time the batch runs (see truncateAtArrayIndex).
         */
        for (const event of events) {
          if (scopeKey === undefined) {
            if (event.path.length > 0) {
              keys.add(String(event.path[0]));

              const path = truncateAtArrayIndex(event.path);

              if (path.length >= 2) {
                paths.push([...path]);
              } else {
                hasShallowInboundEvent = true;
              }
            } else {
              for (const key of event.changes.keys.keys()) {
                keys.add(key);
              }
              hasShallowInboundEvent = true;
            }
          } else if (event.path.length === 0) {
            // The scoped child itself was inserted/replaced/deleted on the root
            // map: fall back to a full inbound patch for this batch.
            if (event.changes.keys.has(scopeKey)) {
              hasPendingInboundFull = true;
            }
          } else if (String(event.path[0]) === scopeKey) {
            if (event.path.length === 1) {
              for (const key of event.changes.keys.keys()) {
                keys.add(key);
              }
              hasShallowInboundEvent = true;
            } else {
              keys.add(String(event.path[1]));

              const path = truncateAtArrayIndex(event.path.slice(1));

              if (path.length >= 2) {
                paths.push(path);
              } else {
                hasShallowInboundEvent = true;
              }
            }
          }
        }
      }

      // Until processBatch applies this transaction, a flush must not undo
      // it: record what it changed (see patchSharedTypeScoped).
      unappliedInboundTargets = unappliedInboundTargets ?? new Set();

      for (const event of events) {
        unappliedInboundTargets.add(event.target);
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
