/* eslint-disable @typescript-eslint/no-use-before-define */
import * as yjs from "yjs";
import type { StoreApi } from "zustand/vanilla";
import { getChanges } from "./diff";
import { arrayToYArray, type MappingOptions, objectToYMap, stringToYText, toYArrayElements } from "./mapping";
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

  /**
   * Already-serialized JSON of the shared type being patched, when the caller
   * has it (a parent's toJSON() includes every child subtree, so re-serializing
   * the child during pending recursion doubles the work at every level).
   * Wrapped in an object so a legitimately-undefined snapshot value stays
   * distinguishable from "not provided". The snapshot MUST reflect the shared
   * type's current content — only safe under a stable parent key (Y.Map);
   * Y.Array pending recursion recomputes because earlier sibling inserts and
   * deletes shift element positions.
   */
  precomputedJson?: { readonly value: unknown };
}

/**
 * Options for patchSharedTypeScoped.
 */
export interface ScopedPatchOptions extends PatchOptions {
  /**
   * Also write top-level state keys the map does not have, even when their
   * value is unchanged since the batch start. Required under `'replace'`
   * hydration, where every full inbound patch (a reload, a peer) deletes a
   * doc-absent key; left off under merge-defaults, whose retained defaults
   * backfill lazily.
   */
  backfillAbsentKeys?: boolean;

  /**
   * The shared types that foreign transactions not yet applied to state
   * changed (their event targets). Set only while such an inbound batch is
   * pending, when the doc may be ahead of state: an array leaf that none of
   * them can have restructured (neither it nor an ancestor is listed, and
   * its length still matches previousState) applies only the changes from
   * previousState to newState, so a remote edit inside an element the local
   * write left alone is not reverted.
   */
  unappliedInboundTargets?: ReadonlySet<unknown>;
}

/** Options threaded through scopedPatchKey's recursion. */
type ScopedKeyOptions = MappingOptions & Pick<ScopedPatchOptions, "unappliedInboundTargets">;

/**
 * Internal options for applyChangesToSharedType: additionally carries the
 * JSON snapshot the change list was computed against, so Y.Map pending
 * recursion can thread each child's snapshot down instead of re-serializing.
 */
interface ApplyChangesOptions extends PatchOptions {
  sharedTypeJson?: unknown;
}

const isDangerousKey = (key: string | number): boolean =>
  { return key === "__proto__" || key === "constructor" || key === "prototype" };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  { return typeof value === "object" && value !== null && !Array.isArray(value) };

/**
 * Whether `value` is a class instance (binary, a subdocument) rather than a
 * record whose prototype a "__proto__" entry replaced. `instanceof` cannot
 * tell: the injected prototype may itself be binary or a subdocument. Doc
 * data holds no functions, so an injected prototype never has a
 * `constructor` whose `prototype` points back at it.
 */
const isClassInstance = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { prototype?: unknown } } | null;

  return prototype?.constructor?.prototype === prototype;
};

/**
 * Whether doc JSON can enter store state as-is: every record, at any depth,
 * has Object.prototype as its prototype and no dangerous key. Class
 * instances are leaves.
 */
const isSafeDocJson = (json: unknown): boolean => {
  if (Array.isArray(json)) {
    return json.every((item) => isSafeDocJson(item));
  }
  if (!isPlainRecord(json)) {
    return true;
  }
  if (Object.getPrototypeOf(json) !== Object.prototype) {
    return isClassInstance(json);
  }

  return Object.keys(json).every((key) => !isDangerousKey(key) && isSafeDocJson(json[key]));
};

/**
 * Returns doc JSON that is safe to put into store state.
 *
 * Y.Map#toJSON (like lib0's decoding of an object-valued ContentAny) assigns
 * entries with `json[key] = value`, so a remote entry named "__proto__" sets
 * the object's PROTOTYPE instead of adding an own property: Object.keys looks
 * clean, but reads and `in` checks see the injected values, and the own-key
 * inbound diff never removes them. Every doc read that feeds store state goes
 * through here. Safe JSON (any honest peer's) comes back untouched; unsafe
 * records are rebuilt from their own keys minus the dangerous ones.
 */
const sanitizeDocJson = (json: unknown): unknown => {
  if (isSafeDocJson(json)) {
    return json;
  }
  if (Array.isArray(json)) {
    return json.map((item) => sanitizeDocJson(item));
  }

  const record = json as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (!isDangerousKey(key)) {
      sanitized[key] = sanitizeDocJson(record[key]);
    }
  }

  return sanitized;
};

/**
 * Own-property read. Record membership and reads are own-property only
 * throughout: `key in record` and `record[key]` also see Object.prototype
 * members, so a missing key named like one (e.g. "toString" or "valueOf")
 * would look present as an inherited function and its delete would be lost.
 */
const getOwnValue = (record: Record<string, unknown>, key: string): unknown =>
  { return Object.hasOwn(record, key) ? record[key] : undefined };

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
    if (Object.hasOwn(source, key)) {
      picked[key] = source[key];
    }
  }

  return picked;
};

/**
 *
 * The text diff emits one change per character: consecutive inserts arrive
 * with contiguous indices (i, i+1, ...) and consecutive deletes of adjacent
 * characters arrive with the SAME index (deleting at i shifts the next
 * character into i). Applying them one at a time is disastrous for Y.Text —
 * every delete(i, 1) walks the item list past the tombstones the previous
 * deletes just created (quadratic in the edit size, and worse in an aged doc),
 * and every 1-char insert allocates its own Yjs item. Coalescing adjacent
 * changes into runs turns N single-character operations into a handful of
 * range operations while preserving the exact sequential-application
 * semantics: [insert, i, "abc"] ≡ [insert, i, "a"], [insert, i+1, "b"],
 * [insert, i+2, "c"], and [delete, i, 3] ≡ three [delete, i, undefined].
 * Delete runs carry their length in the (otherwise unused) value slot;
 * consumers treat a non-number value as length 1 so uncoalesced lists still
 * apply correctly.
 */
const coalesceRunChanges = (changes: Change[], isMergingInserts: boolean): Change[] => {
  const coalesced: Change[] = [];

  for (const [type, property, value] of changes) {
    const previous = coalesced.length > 0 ? coalesced[coalesced.length - 1] : undefined;

    if (
      isMergingInserts &&
      type === changeType.insert &&
      typeof value === "string" &&
      previous?.[0] === changeType.insert &&
      typeof previous[1] === "number" &&
      typeof previous[2] === "string" &&
      property === previous[1] + previous[2].length
    ) {
      previous[2] = previous[2] + value;
    } else if (
      type === changeType.delete &&
      previous?.[0] === changeType.delete &&
      property === previous[1]
    ) {
      previous[2] = (previous[2] as number) + 1;
    } else if (type === changeType.delete) {
      coalesced.push([type, property, 1]);
    } else {
      coalesced.push([type, property, value]);
    }
  }

  return coalesced;
};

const coalesceTextChanges = (changes: Change[]): Change[] =>
  { return coalesceRunChanges(changes, true) };

/**
 * Y.Array changes only merge same-index delete runs (contiguous block
 * removals and the trailing-block deletes the differ emits at a fixed index).
 * Inserts are NOT merged: each array insert carries its own element value.
 */
const coalesceArrayChanges = (changes: Change[]): Change[] =>
  { return coalesceRunChanges(changes, false) };

const deleteRunLength = (value: unknown): number =>
   typeof value === "number" ? value : 1 ;

/** An array in the form its Y.Array stores it; any other value as is. */
const asStoredElements = (value: unknown): unknown =>
  { return Array.isArray(value) ? toYArrayElements(value) : value };

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
    sharedTypeJson,
  }: ApplyChangesOptions = {}
): void => {
  /*
   * getChanges diffs an array toward its stored form (toYArrayElements:
   * functions dropped, undefined -> null), so Y.Array change indices address
   * that form; index the new and the previous state through it as well.
   */
  const elementState = asStoredElements(newState);
  const options = { atomicKeys, disableYText, "previousState": asStoredElements(previousState), yTextKeys };

  // Y.Text edits arrive as per-character changes and Y.Array shrinks as
  // per-element same-index deletes; apply both as runs instead.
  let effectiveChanges = changes;

  if (sharedType instanceof yjs.Text) {
    effectiveChanges = coalesceTextChanges(changes);
  } else if (sharedType instanceof yjs.Array) {
    effectiveChanges = coalesceArrayChanges(changes);
  }

  // Y.Array length before any change applies: maps pending indices back to
  // the batch-start positions previousState is indexed by (see pending).
  const initialArrayLength = sharedType instanceof yjs.Array ? sharedType.length : 0;

  for (const [type, property, value] of effectiveChanges) {
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
           * so an own-property check on `prev` is a meaningful membership
           * test.
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
            && !Object.hasOwn(prev, property as string);

          if (!isConcurrentRemoteInsert) {
            sharedType.delete(property as string);
          }
        } else if (sharedType instanceof yjs.Array) {
          const index = property as number;
          const count = deleteRunLength(value);
          const { length } = sharedType;

          /*
           * Range form of the legacy per-op semantics: each single delete
           * targeted `index` while in range and clamped to the LAST element
           * once the array had shrunk to (or below) `index`. A run of k
           * same-index deletes therefore removes min(k, length - index)
           * consecutive elements at `index`, then trims the tail.
           */
          const inRange = index < length ? Math.min(count, length - index) : 0;

          if (inRange > 0) {
            sharedType.delete(index, inRange);
          }

          const remaining = count - inRange;

          if (remaining > 0) {
            const lengthAfter = length - inRange;
            const trim = Math.min(remaining, lengthAfter);

            if (trim > 0) {
              sharedType.delete(lengthAfter - trim, trim);
            }
          }
        } else if (sharedType instanceof yjs.Text) {
          // Coalesced runs carry their length in the value slot (default 1).
          sharedType.delete(property as number, deleteRunLength(value));
        }

        break;
      }

      case changeType.pending: {
        if (isDangerousKey(property)) {
          break;
        }

        let childPreviousState: unknown;

        if (options.previousState && typeof options.previousState === "object") {
          /*
           * A Y.Array pending index is in POST-application coordinates (the
           * earlier inserts/deletes of this list have already shifted the
           * element), but previousState mirrors the array BEFORE this list.
           * The differ emits left to right, so every earlier insert/delete
           * sits before this element: undo their net shift to read the
           * element's OWN batch-start value. Indexing by the shifted position
           * hands the nested Y.Map delete guard a different record, dropping
           * a genuine local delete or deleting a concurrent remote insert.
           */
          const previousKey = sharedType instanceof yjs.Array
            ? (property as number) - (sharedType.length - initialArrayLength)
            : property;

          childPreviousState = (options.previousState as Record<string, unknown>)[previousKey as string];
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
            } else if (existing instanceof yjs.AbstractType) {
              /*
               * The parent snapshot (which the change list was computed
               * against) already contains this child's JSON — thread it down
               * so the recursion never re-serializes the subtree. Safe here
               * because `prop` is a stable Y.Map key and getRecordChanges
               * emits at most one change per key, so nothing in this loop has
               * touched the child since the snapshot was taken.
               */
              const childJson = isPlainRecord(sharedTypeJson) && Object.hasOwn(sharedTypeJson, prop)
                ? { "value": sharedTypeJson[prop] }
                : undefined;

              // syncedKeys is NOT threaded into recursion: nesting below a synced key replicates fully.
              patchSharedType(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                {
                  atomicKeys,
                  disableYText,
                  yTextKeys,
                  previousState: childPreviousState,
                  precomputedJson: childJson,
                }
              );
            } else {
              /*
               * A plain JSON object/array stored in the doc (ContentAny, e.g.
               * map.set(k, { ... }) by a migration or another writer) has no
               * shared type to recurse into — replace it with the mapped value.
               */
              sharedType.set(prop, Array.isArray(newValue)
                ? arrayToYArray(newValue, options)
                : objectToYMap(newValue as Record<string, unknown>, options));
            }
          }
        } else if (sharedType instanceof yjs.Array) {
          const index = property as number;
          const existing = sharedType.get(index);
          const newValue = (elementState as unknown[])[index];
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
            } else if (existing instanceof yjs.AbstractType) {
              patchSharedType(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                { atomicKeys, disableYText, yTextKeys, previousState: childPreviousState }
              );
            } else {
              // Plain JSON object/array element (ContentAny): replace it with the mapped value.
              sharedType.delete(index);
              sharedType.insert(index, [Array.isArray(newValue)
                ? arrayToYArray(newValue, options)
                : objectToYMap(newValue as Record<string, unknown>, options)]);
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
    precomputedJson,
  }: PatchOptions = {}
): void => {
  let sharedTypeJson: unknown;

  if (precomputedJson !== undefined) {
    sharedTypeJson = precomputedJson.value;
  } else if (typeof (sharedType as yjs.Map<unknown>).toJSON === "function") {
    sharedTypeJson = (sharedType as yjs.Map<unknown>).toJSON();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    sharedTypeJson = (sharedType as yjs.Text).toString();
  }

  const shouldApplyWhitelist = syncedKeys !== undefined
    && isPlainRecord(sharedTypeJson)
    && isPlainRecord(newState);

  const a = shouldApplyWhitelist
    ? pickKeys(sharedTypeJson as Record<string, unknown>, syncedKeys)
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
    sharedTypeJson: a,
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
 * With `backfillAbsentKeys`, an unchanged top-level key the map does not
 * have yet (a never-set declared default) is written whole, as the legacy
 * full diff would; without it such keys stay lazy until first set.
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
    backfillAbsentKeys,
    unappliedInboundTargets,
  }: ScopedPatchOptions = {}
): void => {
  const prevRecord: Record<string, unknown> = isPlainRecord(previousState) ? previousState : {};
  const newRecord: Record<string, unknown> = isPlainRecord(newState) ? newState : {};
  const options: ScopedKeyOptions = { atomicKeys, disableYText, yTextKeys, unappliedInboundTargets };

  const keys = new Set<string>([...Object.keys(prevRecord), ...Object.keys(newRecord)]);

  for (const key of keys) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (syncedKeys !== undefined && !syncedKeys.has(key)) {
      continue;
    }

    const prevValue = getOwnValue(prevRecord, key);
    const nextValue = getOwnValue(newRecord, key);

    if (prevValue instanceof Function || nextValue instanceof Function) {
      continue;
    }

    const hasPresenceChanged = Object.hasOwn(newRecord, key) !== Object.hasOwn(prevRecord, key);
    const isAbsentFromMap = backfillAbsentKeys === true
      && Object.hasOwn(newRecord, key)
      && !sharedType.has(key);

    // The Object.is fast path: untouched keys are skipped entirely.
    if (!hasPresenceChanged && !isAbsentFromMap && Object.is(prevValue, nextValue)) {
      continue;
    }

    scopedPatchKey(sharedType, key, prevRecord, newRecord, options);
  }
};

/**
 * Patches one key of a Y.Map from `prevRecord[key]` to `newRecord[key]`,
 * descending recursively through plain-record levels with `Object.is`
 * pruning — the branch-scoped extension of the scoped diff.
 *
 * Why: `scopedDiff` confines the flush to changed TOP-LEVEL keys, but a
 * store whose hot key holds one large tree (versicle's `progress`:
 * books × devices × reading sessions) changes that top-level key on every
 * write, so the "scoped" flush still serialized (`toJSON`) and structurally
 * walked the ENTIRE subtree per write — O(total state under the key), and a
 * fresh JSON snapshot shares no references with state, so the deep-equality
 * prefilter cannot prune. With immutable updates, identity survives exactly
 * along UNCHANGED branches of the state itself, so prev-vs-next pruning
 * descends only the changed path(s): O(changed branch) per write.
 *
 * Descent rule: recurse only where prev and next are BOTH plain records AND
 * the doc-side child is an existing Y.Map. Everything else — arrays,
 * strings and Y.Text (including the mapping-mismatch repair), primitives,
 * type transitions, and keys the doc does not have yet — falls back to the
 * confined legacy JSON diff at that node, reusing
 * insert/update/delete/pending application (and the `previousState` DELETE
 * guard) verbatim.
 *
 * Backfill invariant (why skipped-equal branches are safe): a Y.Map child
 * the doc contains was either created by this fallback (inserting the FULL
 * `next` subtree at that moment) or arrived remotely (in which case the
 * inbound patch made state mirror it). Either way, any branch beneath it
 * whose value is identity-equal to the previous flush is already in the
 * doc. A branch the doc lacks entirely is inserted whole by the fallback.
 * Compared to the legacy per-key JSON diff this also stops resurrecting
 * nested keys a concurrent remote transaction deleted (the JSON diff saw
 * "state has it, map doesn't" and re-inserted; identity pruning leaves the
 * remote delete to the inbound patch).
 *
 * @param parentMap - The Y.Map that holds `key`.
 * @param key - The key to patch.
 * @param prevRecord - The record `key` lived in at batch start (delete guard).
 * @param newRecord - The record `key` lives in now.
 * @param options - Mapping options (atomicKeys / disableYText / yTextKeys),
 * plus the unapplied inbound targets (see ScopedPatchOptions).
 */
const scopedPatchKey = (
  parentMap: yjs.Map<unknown>,
  key: string,
  prevRecord: Record<string, unknown>,
  newRecord: Record<string, unknown>,
  options: ScopedKeyOptions
): void => {
  const { unappliedInboundTargets, ...mappingOptions } = options;
  const prevValue = prevRecord[key];
  const nextValue = newRecord[key];
  const hasInMap = parentMap.has(key);
  const existing = hasInMap ? parentMap.get(key) : undefined;

  if (
    Object.hasOwn(prevRecord, key) &&
    Object.hasOwn(newRecord, key) &&
    Array.isArray(prevValue) &&
    Array.isArray(nextValue) &&
    existing instanceof yjs.Array
  ) {
    /*
     * Array leaf with both states in hand: diff the doc's JSON against the
     * new state WITH the previous state as an identity-alignment hint, so
     * block splices beyond the differ's lookahead window (e.g. versicle's
     * readingSessions 500 -> keep-last-300 cap) become one range delete
     * instead of hundreds of element-wise rewrites. Application semantics
     * (including previousState threading into nested pending recursion)
     * match the legacy pending path for this array exactly.
     */
    const previousElements = toYArrayElements(prevValue);

    /*
     * While an inbound batch is unapplied, the doc array may hold remote
     * edits state has not seen, and a doc-vs-new diff would revert them.
     * When those transactions cannot have restructured it, its positions
     * still match previousState: apply only what the local batch changed.
     */
    const changes = unappliedInboundTargets !== undefined &&
      isArrayStructureUnchanged(existing, previousElements.length, unappliedInboundTargets)
      ? getChanges(previousElements, nextValue, { "previousA": prevValue })
      : getChanges(existing.toJSON() as unknown[], nextValue, { "previousA": prevValue });

    applyChangesToSharedType(
      existing,
      changes,
      nextValue,
      { ...mappingOptions, "previousState": prevValue }
    );

    return;
  }

  if (
    Object.hasOwn(prevRecord, key) &&
    Object.hasOwn(newRecord, key) &&
    isPlainRecord(prevValue) &&
    isPlainRecord(nextValue) &&
    existing instanceof yjs.Map
  ) {
    const childKeys = new Set<string>([...Object.keys(prevValue), ...Object.keys(nextValue)]);

    for (const childKey of childKeys) {
      if (isDangerousKey(childKey)) {
        continue;
      }

      const prevChild = getOwnValue(prevValue, childKey);
      const nextChild = getOwnValue(nextValue, childKey);

      if (prevChild instanceof Function || nextChild instanceof Function) {
        continue;
      }

      const hasPresenceChanged = Object.hasOwn(prevValue, childKey) !== Object.hasOwn(nextValue, childKey);

      if (!hasPresenceChanged && Object.is(prevChild, nextChild)) {
        continue;
      }

      scopedPatchKey(existing, childKey, prevValue, nextValue, options);
    }

    return;
  }

  /*
   * Leaf / fallback: confine the legacy JSON diff to this key. A key present
   * in the map but in neither prev nor new state (a concurrent remote
   * insert) never reaches here — the callers' key unions cannot contain it —
   * and the previousState DELETE guard protects the delete path at every
   * level exactly as in the legacy scoped flush.
   */
  const a: Record<string, unknown> = {};

  if (hasInMap) {
    a[key] = existing instanceof yjs.AbstractType ? existing.toJSON() : existing;
  }

  const b: Record<string, unknown> = {};

  if (Object.hasOwn(newRecord, key)) {
    b[key] = nextValue;
  }

  applyChangesToSharedType(
    parentMap,
    getChanges(a, b),
    b,
    // Threading `a` lets the pending recursion for this key reuse the
    // toJSON() snapshot taken above instead of serializing the subtree twice.
    { ...mappingOptions, "previousState": prevRecord, "sharedTypeJson": a }
  );
};

/**
 * Whether the foreign transactions that changed `changedTypes` cannot have
 * inserted, deleted or replaced elements of `array`: a Y.Array whose
 * elements were inserted or deleted is itself an event target, and one
 * placed (or re-placed) by those transactions has a changed ancestor. The
 * length must also still match previousState's stored form.
 */
const isArrayStructureUnchanged = (
  array: yjs.Array<unknown>,
  previousLength: number,
  changedTypes: ReadonlySet<unknown>
): boolean => {
  if (array.length !== previousLength) {
    return false;
  }

  let type: unknown = array;

  while (type instanceof yjs.AbstractType) {
    if (changedTypes.has(type)) {
      return false;
    }
    type = type.parent;
  }

  return true;
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

  // Apply per-character text changes as runs: one slice per run instead of
  // one whole-string rebuild per character.
  for (const [type, index, value] of coalesceTextChanges(stringChanges)) {
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
        const right = revisedString.slice(idx + deleteRunLength(value));

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

  /*
   * Changes are applied strictly in list order with evolving indices — the
   * SAME interpretation applyChangesToSharedType uses when applying this
   * change list to a Y.Array (getArrayChanges emits indices in sequential
   * post-application coordinates, not original-array coordinates). The
   * previous strategy here — all deletes first, in descending index order —
   * assumed original coordinates and silently corrupted arrays whose change
   * lists mixed lookahead deletes with trailing deletes (e.g. patching
   * [1, 2, 3] toward [2] produced [3]), diverging the store from the doc.
   */
  for (const [type, index, value] of arrayChanges) {
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
      case changeType.delete: {
        // Mirror the Y.Array applier's clamp: an out-of-range delete removes
        // the last element (a no-op on an empty array).
        revisedArray.splice(revisedArray.length <= idx ? revisedArray.length - 1 : idx, 1);
        break;
      }
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
    // Functions (store actions) are never replicated, so replicated data
    // under the same key (schema drift, a foreign writer) must not replace one.
    if (getOwnValue(revisedObject, prop) instanceof Function) {
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
  const docJson = sanitizeDocJson(newState);

  if (syncedKeys === undefined) {
    return patchState(currentState, docJson as T, patchOptions);
  }

  // pickKeys is presence-preserving, but function-valued state keys are
  // excluded from the replication universe entirely (functions are never
  // synced; a function entry in syncedKeys is a dev-mode error upstream) —
  // on BOTH sides of the diff, or a map value under that key would be
  // merged over the action below.
  const current = currentState as Record<string, unknown>;
  const oldSubset: Record<string, unknown> = {};
  const replicatedKeys = new Set<string>();

  for (const key of syncedKeys) {
    if (isDangerousKey(key) || getOwnValue(current, key) instanceof Function) {
      continue;
    }
    replicatedKeys.add(key);
    if (Object.hasOwn(current, key)) {
      oldSubset[key] = current[key];
    }
  }

  const newSubset = isPlainRecord(docJson) ? pickKeys(docJson, replicatedKeys) : {};
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

/** A store-relative path to a changed node: top-level key, then descendants. */
export type InboundPath = readonly (string | number)[];

/**
 * Reads the JSON of the value at `path` inside a Y.Map, without serializing
 * anything outside it. Returns the `absent` sentinel when any step of the
 * path does not exist (or crosses a non-container), which tells the caller
 * to escalate the patch to the parent — the level at which the removal is
 * actually visible as a missing key.
 */
const absent = Symbol("absent");

const readDocJsonAtPath = (dataMap: yjs.Map<unknown>, path: InboundPath): unknown => {
  let node: unknown = dataMap;

  for (const step of path) {
    if (node instanceof yjs.Map) {
      const key = String(step);

      if (!node.has(key)) {
        return absent;
      }
      node = node.get(key);
    } else if (node instanceof yjs.Array) {
      const index = Number(step);

      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return absent;
      }
      node = node.get(index);
    } else {
      return absent;
    }
  }

  return sanitizeDocJson(node instanceof yjs.AbstractType ? node.toJSON() : node);
};

/** Reads the value at `path` in plain state, or `absent`. */
const readStateAtPath = (state: unknown, path: InboundPath): unknown => {
  let node: unknown = state;

  for (const step of path) {
    if (isPlainRecord(node)) {
      const key = String(step);

      if (!Object.hasOwn(node, key)) {
        return absent;
      }
      node = node[key];
    } else if (Array.isArray(node)) {
      const index = Number(step);

      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return absent;
      }
      node = node[index];
    } else {
      return absent;
    }
  }

  return node;
};

/**
 * Returns a copy of `state` with `value` at `path`, sharing every object
 * that is not on the path. Containers along the spine are copied in kind
 * (array vs record) so array-typed levels stay arrays.
 */
const setStateAtPath = (state: unknown, path: InboundPath, value: unknown): unknown => {
  if (path.length === 0) {
    return value;
  }

  const [step, ...rest] = path;

  if (Array.isArray(state)) {
    const index = Number(step);
    const copy = [...state];

    copy[index] = setStateAtPath(state[index], rest, value);

    return copy;
  }

  const record = isPlainRecord(state) ? state : {};
  const key = String(step);

  if (isDangerousKey(key)) {
    return state;
  }

  return { ...record, [key]: setStateAtPath(record[key], rest, value) };
};

/**
 * Drops any path that a shallower collected path already covers, so a branch
 * is reconciled once. `['a','b']` covers `['a','b','c']`; `['a','bb']` does
 * not cover `['a','b']` (segment-wise comparison, not string prefix).
 */
export const minimizeInboundPaths = (paths: readonly InboundPath[]): InboundPath[] => {
  const sorted = [...paths];

  sorted.sort((left, right) => left.length - right.length);

  const kept: InboundPath[] = [];

  for (const path of sorted) {
    const isCovered = kept.some((candidate) =>
      { return candidate.length <= path.length &&
      candidate.every((step, index) => String(step) === String(path[index])) });

    if (!isCovered) {
      kept.push(path);
    }
  }

  return kept;
};

/**
 * Cuts a Yjs event path at its first array index, so the branch it names is
 * addressed by map keys alone.
 *
 * Why: numeric segments of `event.path` are not reliable element indices by
 * the time the batched patch reads them. Yjs up to 13.6.15 counts Items
 * rather than elements in `getPathTo` (primitives inserted together share
 * one Item, so a container after them gets too small an index), and a local
 * write applied or flushed before the batch runs can shift the array.
 * Reading both sides at such an index reconciles the wrong element — or two
 * equal wrong elements, silently dropping the change. Map keys are stable,
 * so the prefix names the same node on both sides and its array is
 * reconciled whole.
 */
export const truncateAtArrayIndex = (path: InboundPath): InboundPath => {
  const index = path.findIndex((step) => typeof step === "number");

  return index === -1 ? path : path.slice(0, index);
};

/**
 * Path-scoped inbound patch: reconciles ONLY the branches named by `paths`
 * (each at least two segments deep) instead of re-reading and re-diffing a
 * whole top-level key.
 *
 * Why: `observeDeep` already hands us the exact path of every remote change,
 * but the scoped inbound patch threw all but the first segment away and
 * re-read the entire top-level key. For a store whose hot key holds one
 * large tree, that is O(total state) per inbound batch — the receiving
 * device pays for its whole library on every remote page turn, and the cost
 * grows forever. Patching at the event's own path makes it O(changed
 * branch).
 *
 * Semantics match the top-level patch for the branches it touches: the value
 * at each path is reconciled with the same `patchState` diff, and the spine
 * above it is rebuilt with structural sharing, so untouched siblings keep
 * their object identity (better referential stability than rebuilding the
 * whole top-level value, which is what the caller did before).
 *
 * The caller must only pass paths that Yjs events named, cut at their first
 * array index (`truncateAtArrayIndex`). Like the key-scoped path it
 * replaces, this reconciles what changed rather than the whole subtree — one
 * level deeper, but the same assumption.
 *
 * Returns `undefined` when a path cannot be reconciled in isolation — the
 * branch is missing on one side, so the change is only visible at a level
 * this call was not given. Reconciling the rest and dropping that path would
 * silently lose the change, so the caller must fall back to the key-scoped
 * patch for the whole batch instead. (Adding or removing a branch normally
 * also raises a shallower event, which makes the caller take that route
 * before ever reaching this function.).
 *
 * @param currentState - The current store state.
 * @param dataMap - The Y.Map the store is bound to.
 * @param paths - Store-relative paths of the changed nodes, each at least two segments long.
 * @param options - Inbound options; `syncedKeys` gates the first segment.
 * @returns The next state, `currentState` when nothing changed, or
 * `undefined` when the caller must fall back.
 */
export const computeInboundStateForPaths = <T>(
  currentState: T,
  dataMap: yjs.Map<unknown>,
  paths: readonly InboundPath[],
  { syncedKeys }: InboundStateOptions = {}
): T | undefined => {
  let next: unknown = currentState;

  for (const path of minimizeInboundPaths(paths)) {
    if (path.length < 2 || isDangerousKey(String(path[0]))) {
      return undefined;
    }
    if (syncedKeys !== undefined && !syncedKeys.has(String(path[0]))) {
      // Not replicated into this store: correctly ignored, not an escalation.
      continue;
    }

    const docValue = readDocJsonAtPath(dataMap, path);
    const stateValue = readStateAtPath(next, path);

    if (docValue === absent || stateValue === absent) {
      return undefined;
    }
    if (stateValue instanceof Function) {
      // A function (store action) is never replicated, so never replaced.
      continue;
    }

    const patched = isDiffableState(stateValue) && isDiffableState(docValue) &&
      isSameShape(stateValue, docValue)
      ? patchState(stateValue, docValue)
      : docValue;

    if (!Object.is(patched, stateValue)) {
      next = setStateAtPath(next, path, patched);
    }
  }

  return next as T;
};

const isDiffableState = (value: unknown): boolean =>
  { return typeof value === "string" || (typeof value === "object" && value !== null) };

const isSameShape = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string") {
    return true;
  }

  return (Array.isArray(a) && Array.isArray(b)) || (isPlainRecord(a) && isPlainRecord(b));
};
