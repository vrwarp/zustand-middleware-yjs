/* eslint-disable @typescript-eslint/no-use-before-define */
import * as yjs from "yjs";
import type { StoreApi } from "zustand/vanilla";
import { getChanges } from "./diff";
import { arrayToYArray, type MappingOptions, objectToYMap, stringToYText } from "./mapping";
import { type Change, changeType } from "./types";

/**
 * Options for patching yjs shared types.
 */
export interface PatchOptions extends MappingOptions {
  /** The previous state, used to optimize deletions and handle recursive patches. */
  previousState?: unknown;

  /**
   * Top-level replication whitelist. Applied only at the ROOT diff of a
   * Y.Map: both the shared-type JSON and the new state are filtered to these
   * keys before diffing, so a non-listed state key is never inserted into the
   * Y.Map and a foreign map key is never updated or deleted by this client
   * (the resurrection guard). NEVER threaded into recursion — nesting below a
   * synced key replicates fully.
   */
  syncedKeys?: ReadonlySet<string>;
}

const isDangerousKey = (key: string | number): boolean =>
  { return key === "__proto__" || key === "constructor" || key === "prototype" };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  { return typeof value === "object" && value !== null && !Array.isArray(value) };

/** Shallow-pick the listed keys (presence-preserving: `undefined` values survive). */
const pickKeys = (
  source: Record<string, unknown>,
  keys: ReadonlySet<string>
): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};

  for (const key of keys) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (key in source) {
      picked[key] = source[key];
    }
  }

  return picked;
};

/**
 * Applies an already-computed change list to a yjs shared type. Extracted from
 * patchSharedType so the scoped-diff path can reuse the exact same
 * insert/update/delete/pending application semantics (including the verbatim
 * `previousState` delete-protection, the prototype-pollution guard, and the
 * Y.Text↔string mismatch repair).
 *
 * @param sharedType - The yjs shared type to apply the changes to.
 * @param changes - The change list (as produced by getChanges).
 * @param newState - The new state the changes were computed against.
 * @param patchOptions - Mapping options; `previousState` guards Y.Map deletes.
 */
const applyChangesToSharedType = (
  sharedType: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
  changes: Change[],
  newState: unknown,
  {
    atomicKeys = [],
    disableYText = false,
    previousState,
    yTextKeys = [],
  }: PatchOptions = {}
): void => {
  const options = { atomicKeys, disableYText, previousState, yTextKeys };

  for (const [type, property, value] of changes) {
    switch (type) {
      case changeType.insert:
      case changeType.update: {
        if (isDangerousKey(property)) {
          break;
        }

        if (!(value instanceof Function)) {
          if (sharedType instanceof yjs.Map) {
            const prop = property as string;

            if (typeof value === "string") {
              const isWantsYText = options.disableYText
                ? options.yTextKeys.includes(prop)
                : !options.atomicKeys.includes(prop);

              if (isWantsYText) {
                sharedType.set(prop, stringToYText(value));
              } else {
                sharedType.set(prop, value);
              }
            } else if (Array.isArray(value)) {
              sharedType.set(prop, arrayToYArray(value, options));
            } else if (typeof value === "object" && value !== null) {
              sharedType.set(prop, objectToYMap(value as Record<string, unknown>, options));
            } else {
              sharedType.set(prop, value);
            }
          } else if (sharedType instanceof yjs.Array) {
            const index = property as number;

            if (type === changeType.update) {
              sharedType.delete(index);
            }

            if (typeof value === "string") {
              if (options.disableYText) {
                sharedType.insert(index, [value]);
              } else {
                sharedType.insert(index, [stringToYText(value)]);
              }
            } else if (Array.isArray(value)) {
              sharedType.insert(index, [arrayToYArray(value, options)]);
            } else if (typeof value === "object" && value !== null) {
              sharedType.insert(index, [objectToYMap(value as Record<string, unknown>, options)]);
            } else {
              sharedType.insert(index, [value]);
            }
          } else if (sharedType instanceof yjs.Text) {
            sharedType.insert(property as number, value as string);
          }
        }
        break;
      }

      case changeType.delete: {
        if (isDangerousKey(property)) {
          break;
        }

        if (sharedType instanceof yjs.Map) {
          /*
           * previousState DELETE guard — Y.Map keys ONLY. A key present in the
           * map but absent from the batch-start state is a concurrent remote
           * insert whose inbound microtask has not run yet; never delete it
           * (the resurrection guard). `property` here is a string object key,
           * so `property in prev` is a meaningful membership test.
           *
           * This guard MUST NOT apply to Y.Array: there `property` is a
           * numeric index, and a delete whose index is >= prev.length is the
           * ordinary array-shrink case (e.g. a diff that inserts at the front
           * and deletes the now-trailing element). `index in prevArray` would
           * be false and silently drop the delete, leaving a stale trailing
           * element and drifting the doc from state.
           */
          const prev = options.previousState;
          const isConcurrentRemoteInsert = prev !== null
            && typeof prev === "object"
            && !((property as string) in (prev as Record<string, unknown>));

          if (!isConcurrentRemoteInsert) {
            sharedType.delete(property as string);
          }
        } else if (sharedType instanceof yjs.Array) {
          const index = property as number;

          sharedType.delete(sharedType.length <= index
            ? sharedType.length - 1
            : index);
        } else if (sharedType instanceof yjs.Text) {
          // A delete operation for text is only ever for a single character.
          sharedType.delete(property as number, 1);
        }

        break;
      }

      case changeType.pending: {
        if (isDangerousKey(property)) {
          break;
        }

        let childPreviousState: unknown;

        if (options.previousState && typeof options.previousState === "object") {
          childPreviousState = (options.previousState as Record<string, unknown>)[property as string];
        }

        if (sharedType instanceof yjs.Map) {
          const prop = property as string;
          const existing = sharedType.get(prop);
          const newValue = (newState as Record<string, unknown>)[prop];
          let isTextMappingMismatch = false;

          if (typeof newValue === "string") {
            const isWantsYText = options.disableYText
              ? options.yTextKeys.includes(prop)
              : !options.atomicKeys.includes(prop);

            if ((isWantsYText && !(existing instanceof yjs.Text)) || (!isWantsYText && (existing instanceof yjs.Text))) {
              isTextMappingMismatch = true;
            }
          }

          if (isTextMappingMismatch) {
            const isWantsYText = options.disableYText
              ? options.yTextKeys.includes(prop)
              : !options.atomicKeys.includes(prop);

            if (isWantsYText) {
              sharedType.set(prop, stringToYText(newValue as string));
            } else {
              sharedType.set(prop, newValue);
            }
          } else {
            if (typeof newValue === "string" && !(existing instanceof yjs.Text)) {
              // Plain string diff - set it directly since primitive strings can't be patched incrementally
              sharedType.set(prop, newValue);
            } else {
              // syncedKeys is NOT threaded into recursion: nesting below a synced key replicates fully.
              patchSharedType(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                { atomicKeys, disableYText, yTextKeys, previousState: childPreviousState }
              );
            }
          }
        } else if (sharedType instanceof yjs.Array) {
          const index = property as number;
          const existing = sharedType.get(index);
          const newValue = (newState as unknown[])[index];
          let isTextMappingMismatch = false;

          if (typeof newValue === "string") {
            const isWantsYText = !options.disableYText;

            if ((isWantsYText && !(existing instanceof yjs.Text)) || (!isWantsYText && (existing instanceof yjs.Text))) {
              isTextMappingMismatch = true;
            }
          }

          if (isTextMappingMismatch) {
            sharedType.delete(index);

            const isWantsYText = !options.disableYText;

            if (isWantsYText) {
              sharedType.insert(index, [stringToYText(newValue as string)]);
            } else {
              sharedType.insert(index, [newValue]);
            }
          } else {
            if (typeof newValue === "string" && !(existing instanceof yjs.Text)) {
              // Plain string diff - update directly by replacing the element
              sharedType.delete(index);
              sharedType.insert(index, [newValue]);
            } else {
              patchSharedType(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                { atomicKeys, disableYText, yTextKeys, previousState: childPreviousState }
              );
            }
          }
        }
        break;
      }

      case changeType.none:
      default: {
        break;
      }
    }
  }
};

/**
 * Diffs sharedType and newState to create a list of changes for transforming
 * the contents of sharedType into that of newState. For every nested, 'pending'
 * change detected, this function recurses, as a nested object or array is
 * represented as a Y.Map or Y.Array.
 *
 * When `options.syncedKeys` is set (top-level Y.Map calls only), BOTH sides of
 * the diff are first filtered to the whitelist, so non-listed keys are
 * invisible in either direction.
 *
 * @param sharedType - The Yjs shared type to patch.
 * @param newState - The new state to patch the shared type into.
 * @param patchOptions - The patch options.
 */
export const patchSharedType = (
  sharedType: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
  newState: unknown,
  {
    atomicKeys,
    disableYText,
    previousState,
    yTextKeys,
    syncedKeys,
  }: PatchOptions = {}
): void => {
  const sharedTypeJson = typeof (sharedType as yjs.Map<unknown>).toJSON === "function"
    ? (sharedType as yjs.Map<unknown>).toJSON()
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    : (sharedType as yjs.Text).toString();

  const shouldApplyWhitelist = syncedKeys !== undefined
    && isPlainRecord(sharedTypeJson)
    && isPlainRecord(newState);

  const a = shouldApplyWhitelist
    ? pickKeys(sharedTypeJson, syncedKeys)
    : sharedTypeJson;
  const b = shouldApplyWhitelist
    ? pickKeys(newState, syncedKeys)
    : newState;

  const changes = getChanges(
    a as string | unknown[] | Record<string, unknown>,
    b as string | unknown[] | Record<string, unknown>
  );

  // syncedKeys is intentionally NOT forwarded: it filters only the root diff.
  applyChangesToSharedType(sharedType, changes, b, {
    atomicKeys,
    disableYText,
    previousState,
    yTextKeys,
  });
};

/**
 * Per-key scoped outbound diff (the `scopedDiff` option).
 *
 * Instead of serializing the ENTIRE Y.Map (`sharedType.toJSON()`) and
 * deep-diffing the entire state on every flush, only top-level keys whose
 * value changed by reference between the batch-start `previousState` and the
 * current state are diffed — and each one only against ITS OWN subtree
 * (`map.get(key)`). Reference equality is sound for stores following zustand's
 * immutable-update convention; the divergence tripwire
 * (assertScopedDiffConvergence + the fast-check equivalence property in the
 * contract suite) guards the mutate-in-place case.
 *
 * Change application reuses applyChangesToSharedType verbatim, so the
 * `previousState` DELETE guard and the Y.Text↔string mismatch repair behave
 * exactly as in the legacy full diff.
 *
 * @param sharedType - The top-level Y.Map the store is bound to.
 * @param newState - The post-batch state.
 * @param previousState - The pre-batch state (batch-start capture).
 * @param options - Mapping options; `syncedKeys` filters the key universe.
 */
export const patchSharedTypeScoped = (
  sharedType: yjs.Map<unknown>,
  newState: unknown,
  previousState: unknown,
  {
    atomicKeys,
    disableYText,
    yTextKeys,
    syncedKeys,
  }: PatchOptions = {}
): void => {
  const prevRecord: Record<string, unknown> = isPlainRecord(previousState) ? previousState : {};
  const newRecord: Record<string, unknown> = isPlainRecord(newState) ? newState : {};

  const keys = new Set<string>([...Object.keys(prevRecord), ...Object.keys(newRecord)]);

  for (const key of keys) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (syncedKeys !== undefined && !syncedKeys.has(key)) {
      continue;
    }

    const prevValue = prevRecord[key];
    const nextValue = newRecord[key];

    if (prevValue instanceof Function || nextValue instanceof Function) {
      continue;
    }

    const hasPresenceChanged = (key in newRecord) !== (key in prevRecord);

    // The Object.is fast path: untouched keys are skipped entirely.
    if (!hasPresenceChanged && Object.is(prevValue, nextValue)) {
      continue;
    }

    /*
     * Confine the diff to this key's subtree: single-key records on both sides
     * reuse the exact legacy change computation and application
     * (insert/update/delete/pending, the previousState DELETE guard, and the
     * Y.Text↔string repair). A key present in the map but in neither prev nor
     * new state (a concurrent remote insert) never enters `keys`, so it can
     * never be deleted here — the same protection the guard gives the legacy
     * path.
     */
    const a: Record<string, unknown> = {};

    if (sharedType.has(key)) {
      const existing = sharedType.get(key);

      a[key] = existing instanceof yjs.AbstractType ? existing.toJSON() : existing;
    }

    const b: Record<string, unknown> = {};

    if (key in newRecord) {
      b[key] = nextValue;
    }

    // syncedKeys is intentionally NOT forwarded into the per-key application.
    applyChangesToSharedType(
      sharedType,
      getChanges(a, b),
      b,
      { atomicKeys, disableYText, yTextKeys, previousState: prevRecord }
    );
  }
};

/**
 * Options for assertScopedDiffConvergence.
 */
export interface ScopedDiffConvergenceOptions {
  /** Optional whitelist — the same filter the flush used. */
  syncedKeys?: ReadonlySet<string>;
}

/**
 * DEV-only divergence tripwire for `scopedDiff`: after a scoped flush, a full
 * state-vs-map diff must find no residual update/pending changes — any such
 * residual means a `set()` mutated state in place (same object reference),
 * which the Object.is fast path cannot see, and doc/store would drift
 * silently.
 *
 * Deliberately exempted residual change types (NOT divergence):
 * - delete: the map can legitimately be richer than the state — a concurrent
 * remote insert whose inbound microtask has not run yet (the same case the
 * outbound previousState guard protects).
 * - insert: the state can legitimately be richer than the map — a retained
 * declared default under merge-defaults hydration is only lazily backfilled
 * when its key is actually written.
 *
 * @param sharedType - The top-level Y.Map that was just flushed.
 * @param state - The current store state.
 * @param syncedKeys - Optional whitelist (the same filter the flush used).
 */
export const assertScopedDiffConvergence = (
  sharedType: yjs.Map<unknown>,
  state: unknown,
  { syncedKeys }: ScopedDiffConvergenceOptions = {}
): void => {
  const mapJson = sharedType.toJSON();

  const stateRecord: Record<string, unknown> = {};

  if (isPlainRecord(state)) {
    for (const [key, value] of Object.entries(state)) {
      if (!(value instanceof Function)) {
        stateRecord[key] = value;
      }
    }
  }

  const a = syncedKeys ? pickKeys(mapJson as Record<string, unknown>, syncedKeys) : mapJson;
  const b = syncedKeys ? pickKeys(stateRecord, syncedKeys) : stateRecord;

  const residual = getChanges(
    a as string | unknown[] | Record<string, unknown>,
    b as string | unknown[] | Record<string, unknown>
  ).filter(([type]) => type === changeType.update || type === changeType.pending);

  if (residual.length > 0) {
    const keys = residual
      .map(([type, property]) => `"${String(property)}" (${type})`)
      .join(", ");

    throw new Error(
      `[zustand-middleware-yjs] scopedDiff divergence tripwire: after a ` +
      `scoped flush, a full diff still finds changes for ${keys}. This ` +
      `almost always means a set() mutated state IN PLACE (same object ` +
      `reference), which the Object.is fast path cannot see — the Y.Doc and ` +
      `the store would drift silently. Fix the store to use immutable ` +
      `updates, or turn scopedDiff off for this store.`
    );
  }
};

const applyChangesToString = (initialString: string, stringChanges: Change[]): string => {
  let revisedString = initialString;

  for (const [type, index, value] of stringChanges) {
    switch (type) {
      case changeType.insert: {
        const idx = index as number;
        const left = revisedString.slice(0, idx);
        const right = revisedString.slice(idx);

        revisedString = left + (value as string) + right;
        break;
      }
      case changeType.delete: {
        const idx = index as number;
        const left = revisedString.slice(0, idx);
        const right = revisedString.slice(idx + 1);

        revisedString = left + right;
        break;
      }
      case changeType.update:
      case changeType.pending:
      case changeType.none:
      default: {
        break;
      }
    }
  }

  return revisedString;
};

const applyChangesToArray = (initialArray: unknown[], arrayChanges: Change[]): unknown[] => {
  const revisedArray = [...initialArray];

  // Handle deletions in descending order to avoid index shifts
  const deletions = [...arrayChanges]
    .filter(([type]) => type === changeType.delete)
    // eslint-disable-next-line unicorn/no-array-sort
    .sort(([, indexA], [, indexB]) => (indexB as number) - (indexA as number));

  for (const [, index] of deletions) {
    revisedArray.splice(index as number, 1);
  }

  // Handle other changes in ascending order
  const others = [...arrayChanges]
    .filter(([type]) => type !== changeType.delete)
    // eslint-disable-next-line unicorn/no-array-sort
    .sort(([, indexA], [, indexB]) => (indexA as number) - (indexB as number));

  for (const [type, index, value] of others) {
    const idx = index as number;

    switch (type) {
      case changeType.insert: {
        revisedArray.splice(idx, 0, value);
        break;
      }
      case changeType.update: {
        revisedArray[idx] = value;
        break;
      }
      case changeType.pending: {
        revisedArray[idx] = applyChanges(revisedArray[idx] as string | unknown[] | Record<string, unknown>, value as Change[]);
        break;
      }
      case changeType.delete:
      case changeType.none:
      default: {
        break;
      }
    }
  }

  return revisedArray;
};

const applyChangesToObject = (initialObject: Record<string, unknown>, objectChanges: Change[]): Record<string, unknown> => {
  let revisedObject = { ...initialObject };

  for (const [type, property, value] of objectChanges) {
    const prop = property as string;

    if (prop === "__proto__" || prop === "constructor" || prop === "prototype") {
      continue;
    }

    switch (type) {
      case changeType.insert:
      case changeType.update: {
        revisedObject[prop] = value;
        break;
      }
      case changeType.pending: {
        revisedObject[prop] = applyChanges(revisedObject[prop] as string | unknown[] | Record<string, unknown>, value as Change[]);
        break;
      }
      case changeType.delete: {
        // Filter keys to avoid the delete operator
        revisedObject = Object.fromEntries(Object.entries(revisedObject).filter(([p]) => p !== prop));
        break;
      }
      case changeType.none:
      default: {
        break;
      }
    }
  }

  return revisedObject;
};

const applyChanges = (
  state: string | unknown[] | Record<string, unknown>,
  changes: Change[]
): unknown => {
  if (typeof state === "string") {
    return applyChangesToString(state, changes);
  }
  if (Array.isArray(state)) {
    return applyChangesToArray(state, changes);
  }

  return applyChangesToObject(state, changes);
};

/**
 * Options for patchState.
 */
export interface PatchStateOptions {
  /**
   * Merge-over-declared-defaults hydration: a TOP-LEVEL `[delete, key]` change
   * is suppressed iff `key` is in this set. Everything else — inserts,
   * updates, and ALL nested deletes (which ride inside pending chains under a
   * present top-level key) — applies unchanged. Only the top-level change list
   * is filtered; getChanges itself is untouched, so recursion keeps emitting
   * nested deletes.
   */
  suppressTopLevelDeleteKeys?: ReadonlySet<string>;
}

/**
 * Patches oldState to be identical to newState. This function recurses when
 * an array or object is encountered. If oldState and newState are already
 * identical (indicated by an empty diff), then oldState is returned.
 *
 * @param oldState - The state we want to patch.
 * @param newState - The state we want oldState to match after patching.
 * @param options - Top-level delete suppression (merge-defaults hydration).
 * @returns The patched oldState, identical to newState (modulo retained keys).
 */
export const patchState = <T>(
  oldState: T,
  newState: T,
  { suppressTopLevelDeleteKeys }: PatchStateOptions = {}
): T => {
  let changes = getChanges(oldState as string | unknown[] | Record<string, unknown>, newState as string | unknown[] | Record<string, unknown>);

  if (suppressTopLevelDeleteKeys !== undefined) {
    changes = changes.filter(([type, property]) => {
      return !(type === changeType.delete && suppressTopLevelDeleteKeys.has(property as string));
    });
  }

  if (changes.length === 0) {
    return oldState;
  }

  return applyChanges(oldState as string | unknown[] | Record<string, unknown>, changes) as T;
};

/**
 * Options for the inbound (Y.Map JSON → Zustand state) application path.
 */
export interface InboundStateOptions {
  /**
   * Top-level replication whitelist. When set, only the listed keys are diffed
   * (map subset vs state subset) and the patched subset is applied over the
   * FULL state — a foreign map key is never inserted into store state, and a
   * non-listed local key is never touched by remote updates.
   */
  syncedKeys?: ReadonlySet<string>;

  /**
   * Merge-over-declared-defaults hydration: top-level DELETEs for these keys
   * are suppressed — the store keeps its current value (the declared default,
   * or whatever local writes produced since). Nested deletes still propagate.
   * Undefined = legacy 'replace'.
   */
  suppressTopLevelDeleteKeys?: ReadonlySet<string>;
}

/**
 * Computes the next Zustand state for an inbound patch from map JSON.
 *
 * Without options this is exactly the legacy `patchState` call
 * (replace-with-delete hydration). With `syncedKeys` the diff/application
 * universe is restricted to the whitelist; deletes are still honored INSIDE
 * the subset.
 *
 * @param currentState - The current (already cloned) Zustand state.
 * @param newState - The Y.Map JSON to patch toward.
 * @param options - Inbound options (whitelist, default-key retention).
 * @returns The next state object to set with replace=true.
 */
export const computeInboundState = <T>(
  currentState: T,
  newState: unknown,
  { syncedKeys, suppressTopLevelDeleteKeys }: InboundStateOptions = {}
): T => {
  const patchOptions: PatchStateOptions = { suppressTopLevelDeleteKeys };

  if (syncedKeys === undefined) {
    return patchState(currentState, newState as T, patchOptions);
  }

  // pickKeys is presence-preserving, but function-valued state keys are
  // excluded from the replication universe entirely (functions are never
  // synced; a function entry in syncedKeys is a dev-mode error upstream).
  const current = currentState as Record<string, unknown>;
  const oldSubset: Record<string, unknown> = {};

  for (const key of syncedKeys) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (key in current && !(current[key] instanceof Function)) {
      oldSubset[key] = current[key];
    }
  }

  const newSubset = isPlainRecord(newState) ? pickKeys(newState, syncedKeys) : {};
  const patchedSubset = patchState(oldSubset, newSubset, patchOptions);

  /*
   * Apply the patched subset over the full state: keys deleted within the
   * subset are absent from patchedSubset and must be removed; everything
   * outside the whitelist is left untouched (object identity preserved). Built
   * by filtering rather than the delete operator.
   */
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(current)) {
    const isReplaceableSyncedKey = syncedKeys.has(key) && !(value instanceof Function);

    if (!isReplaceableSyncedKey) {
      next[key] = value;
    }
  }

  return Object.assign(next, patchedSubset) as T;
};

/**
 * Diffs the current state stored in the Zustand store and the given newState.
 * The current Zustand state is patched into the given new state recursively.
 *
 * @param store - The Zustand API that manages the store we want to patch.
 * @param newState - The new state that the Zustand store should be patched to.
 * @param options - Inbound options (replication whitelist, default retention).
 */
export const patchStore = <S>(
  store: StoreApi<S>,
  newState: unknown,
  { syncedKeys, suppressTopLevelDeleteKeys }: InboundStateOptions = {}
): void => {
  // Clone the oldState instead of using it directly from store.getState().
  const oldState = {
    ...(store.getState() as Record<string, unknown>),
  };

  store.setState(
    computeInboundState(oldState, newState, { syncedKeys, suppressTopLevelDeleteKeys }) as S,
    true // Replace with the patched state.
  );
};
