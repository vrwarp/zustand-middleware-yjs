/* eslint-disable @typescript-eslint/no-use-before-define */
import * as yjs from "yjs";
import type { StoreApi } from "zustand/vanilla";
import { getChanges, isDeepEqualForDiff } from "./diff";
import {
  type ArrayPlacement,
  arrayToYArray,
  type MappingOptions,
  objectToYMap,
  stringToYText,
  toJsonElement,
  toYArrayElements,
} from "./mapping";
import { type Change, type ChangeType, changeType } from "./types";

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
   * Y.Array pending recursion does not thread it because earlier sibling
   * inserts and deletes shift element positions away from the snapshot's
   * indices (the element's nested change list needs no JSON, see
   * ApplyChangesOptions.isDiffedFromDoc).
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
   * backfill lazily. Only safe once the doc has loaded: written into a doc
   * that has not, each default is a write concurrent with the persisted
   * value, and it can win the merge.
   */
  backfillAbsentKeys?: boolean;

  /**
   * The shared types that foreign transactions not yet applied to state
   * changed (their event targets), each with the keys those transactions
   * added, replaced or removed in it when it is a Y.Map (`keysChanged`).
   * Set only while such an inbound batch is pending, when the doc may be
   * ahead of state: an array leaf that none of them can have restructured
   * (it is not listed, no listed ancestor changed the key it sits under,
   * and its length still matches previousState) applies only the changes
   * from previousState to newState, so a remote edit inside an element the
   * local write left alone is not reverted.
   */
  unappliedInboundTargets?: ReadonlyMap<unknown, ReadonlySet<string>>;
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

  /**
   * Set when the change list was diffed from the shared type's CURRENT
   * content: its JSON, taken in this transaction with nothing written to it
   * since. The differ recurses into nested values with exactly the inputs a
   * re-diff of a child would use (the child's slice of that JSON, the same
   * new-state value, no previousA), so each pending entry already holds the
   * child's change list, and the recursion applies it instead of
   * serializing and diffing the child again. Left unset for a list diffed
   * from anything else (previousState, while an inbound batch is
   * unapplied): its nested lists describe state's children, not the doc's,
   * so those children are re-diffed. Never inherited by a re-diff, which
   * sets it for its own fresh list.
   */
  isDiffedFromDoc?: boolean;
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
 * has Object.prototype as its prototype and no dangerous key, and no record
 * holds a `jsonElementKeys` array. Class instances are leaves.
 *
 * Runs over every inbound doc read (cold-start hydration included), so it
 * recurses only into objects: a primitive leaf cannot be unsafe, and leaves
 * outnumber containers several to one. The key check still runs on every
 * own key, whatever its value: a primitive "constructor" is unsafe too.
 */
const isSafeDocJson = (json: unknown, jsonElementKeys: readonly string[]): boolean => {
  if (Array.isArray(json)) {
    for (const item of json) {
      if (typeof item === "object" && item !== null && !isSafeDocJson(item, jsonElementKeys)) {
        return false;
      }
    }

    return true;
  }
  if (!isPlainRecord(json)) {
    return true;
  }
  if (Object.getPrototypeOf(json) !== Object.prototype) {
    return isClassInstance(json);
  }

  for (const key of Object.keys(json)) {
    if (isDangerousKey(key)) {
      return false;
    }

    const value = json[key];

    if (typeof value === "object" && value !== null) {
      // A listed array's elements must be copied (see sanitizeDocJson).
      if (jsonElementKeys.includes(key) && Array.isArray(value)) {
        return false;
      }
      if (!isSafeDocJson(value, jsonElementKeys)) {
        return false;
      }
    }
  }

  return true;
};

/**
 * A sanitized deep copy of doc JSON: records are rebuilt from their own keys
 * minus the dangerous ones, arrays are copied, and class instances (binary)
 * stay leaves, as in sanitizeDocJson.
 */
const copyDocJson = (json: unknown): unknown => {
  if (Array.isArray(json)) {
    return json.map((item) => copyDocJson(item));
  }
  if (!isPlainRecord(json) || (Object.getPrototypeOf(json) !== Object.prototype && isClassInstance(json))) {
    return json;
  }

  const copy: Record<string, unknown> = {};

  for (const key of Object.keys(json)) {
    if (!isDangerousKey(key)) {
      const value = json[key];

      // Most fields are primitives: copy those without a call.
      copy[key] = typeof value === "object" && value !== null ? copyDocJson(value) : value;
    }
  }

  return copy;
};

/**
 * Options for sanitizeDocJson.
 */
interface DocJsonOptions extends ArrayPlacement {
  /** The `jsonElementKeys` mapping option. */
  jsonElementKeys?: readonly string[];
}

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
 *
 * The elements of a `jsonElementKeys` array always come back as sanitized
 * copies. Y.Array#toJSON returns those plain JSON elements (ContentAny) BY
 * REFERENCE, so store state would otherwise share objects with the doc's
 * content: mutating one in place would change the local doc without a Yjs
 * operation, and every later encode of it (a persistence compaction, a sync
 * to a new peer) would carry content the other replicas never received. The
 * records holding such an array are rebuilt rather than mutated, since any
 * of them may itself be a plain JSON doc value. Copying here, in the same
 * walk that checks the rest, visits each element once.
 *
 * @param json - Doc JSON.
 * @param options - The `jsonElementKeys` option, and the key `json` is stored under, if any.
 * @returns Doc JSON safe to put into store state.
 */
const sanitizeDocJson = (json: unknown, { jsonElementKeys = [], key }: DocJsonOptions = {}): unknown => {
  if (Array.isArray(json) && key !== undefined && jsonElementKeys.includes(key)) {
    return json.map((element) => copyDocJson(element));
  }
  if (isSafeDocJson(json, jsonElementKeys)) {
    return json;
  }
  if (Array.isArray(json)) {
    return json.map((item) => sanitizeDocJson(item, { jsonElementKeys }));
  }

  const record = json as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const childKey of Object.keys(record)) {
    if (!isDangerousKey(childKey)) {
      sanitized[childKey] = sanitizeDocJson(record[childKey], { jsonElementKeys, "key": childKey });
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
 * `pickKeys(map.toJSON(), keys)` without serializing the map's other keys: a
 * key outside the whitelist (a deprecated one an old document still carries,
 * another client version's, another store's) can hold a large tree that the
 * caller would discard anyway. Presence-preserving like pickKeys; ContentAny
 * values pass through as-is.
 */
export const pickMapJson = (
  map: yjs.Map<unknown>,
  keys: ReadonlySet<string>
): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};

  for (const key of keys) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (map.has(key)) {
      const value = map.get(key);

      picked[key] = value instanceof yjs.AbstractType ? value.toJSON() : value;
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
 * Y.Array inserts and updates applied as one run: the values the change's
 * value slot carries are placed with a single Y.Array insert. A wrapper
 * rather than the bare list, because an element value can itself be an array.
 */
interface ArrayElementRun {
  readonly values: unknown[];
}

/**
 * Like the text differ, the array differ emits inserts and updates one
 * element at a time: an append of k elements is [insert, n], [insert, n+1],
 * ..., a rewrite is k contiguous updates. Applying each as its own
 * `yarray.insert(i, [value])` is quadratic in Yjs for elements that integrate
 * with a single clock (primitives, empty Y.Maps and Y.Arrays): one
 * transaction hands them consecutive clocks, and every insert's findMarker
 * walks left across the whole mergeable run inserted so far. So every
 * insert/update is wrapped in a run that grows while the next change has the
 * same type at the next index; sequential semantics are preserved exactly: k
 * inserts at i..i+k-1 place k values at i..i+k-1 in order, and k updates
 * there replace the same k elements (one ranged delete, one insert). Inserts
 * at the SAME index never merge (the later one lands first), and
 * pending/delete/none changes and function values (skipped, so they take no
 * index) end a run, which leaves the pending previousState alignment and the
 * delete-run clamp untouched.
 *
 * Under disableYText a pending string element is an update in all but name —
 * both pending sub-branches replace it by delete(i) + insert(i, [string]) —
 * and a string-list rewrite diffs every element as pending, so it joins
 * update runs. `elementState` is read at the post-application index the
 * pending branch reads; the doc is never read here.
 */
const coalesceArrayElementRuns = (
  changes: Change[],
  elementState: unknown,
  disableYText: boolean
): Change[] => {
  const coalesced: Change[] = [];
  // The open run: its change type, the index right after it, and its values.
  let runType: ChangeType | undefined;
  let runEnd = 0;
  let runValues: unknown[] = [];

  for (const [changeKind, property, changeValue] of changes) {
    const isStringReplacement = disableYText &&
      changeKind === changeType.pending &&
      Array.isArray(elementState) &&
      typeof elementState[property as number] === "string";
    const type = isStringReplacement ? changeType.update : changeKind;
    const value = isStringReplacement ? (elementState as unknown[])[property as number] : changeValue;

    if ((type !== changeType.insert && type !== changeType.update) || value instanceof Function) {
      runType = undefined;
      coalesced.push([type, property, value]);
    } else if (type === runType && property === runEnd) {
      runValues.push(value);
      runEnd = runEnd + 1;
    } else {
      runType = type;
      runEnd = (property as number) + 1;
      runValues = [value];

      const run: ArrayElementRun = { "values": runValues };

      coalesced.push([type, property, run]);
    }
  }

  return coalesced;
};

/**
 * Y.Array changes merge same-index delete runs (contiguous block removals and
 * the trailing-block deletes the differ emits at a fixed index), then
 * contiguous insert and update runs (see coalesceArrayElementRuns).
 */
const coalesceArrayChanges = (changes: Change[], elementState: unknown, disableYText: boolean): Change[] =>
  { return coalesceArrayElementRuns(coalesceRunChanges(changes, false), elementState, disableYText) };

const deleteRunLength = (value: unknown): number =>
   typeof value === "number" ? value : 1 ;

/** An array in the form its Y.Array stores it; any other value as is. */
const asStoredElements = (value: unknown): unknown =>
  { return Array.isArray(value) ? toYArrayElements(value) : value };

/**
 * Whether a Y.Array is stored under one of `jsonElementKeys` in its parent
 * Y.Map (an array nested directly in another array is under no key).
 */
const isJsonElementArray = (yarray: yjs.Array<unknown>, jsonElementKeys: readonly string[]): boolean => {
  const key = yarray._item?.parentSub;

  return typeof key === "string" && jsonElementKeys.includes(key);
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
    jsonElementKeys = [],
    sharedTypeJson,
    isDiffedFromDoc = false,
  }: ApplyChangesOptions = {}
): void => {
  /*
   * getChanges diffs an array toward its stored form (toYArrayElements:
   * functions dropped, undefined -> null), so Y.Array change indices address
   * that form; index the new and the previous state through it as well.
   */
  const elementState = asStoredElements(newState);
  const options = {
    atomicKeys,
    disableYText,
    "previousState": asStoredElements(previousState),
    yTextKeys,
    jsonElementKeys,
  };

  // Object and array elements of a jsonElementKeys array are plain JSON.
  const isJsonElements = sharedType instanceof yjs.Array && isJsonElementArray(sharedType, jsonElementKeys);

  // Y.Text edits arrive as per-character changes and Y.Array edits as
  // per-element changes; apply both as runs instead.
  let effectiveChanges = changes;

  if (sharedType instanceof yjs.Text) {
    effectiveChanges = coalesceTextChanges(changes);
  } else if (sharedType instanceof yjs.Array) {
    effectiveChanges = coalesceArrayChanges(changes, elementState, options.disableYText);
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
              sharedType.set(prop, arrayToYArray(value, { ...options, "key": prop }));
            } else if (typeof value === "object" && value !== null) {
              sharedType.set(prop, objectToYMap(value as Record<string, unknown>, options));
            } else {
              sharedType.set(prop, value);
            }
          } else if (sharedType instanceof yjs.Array) {
            // coalesceArrayChanges wraps every Y.Array insert/update in a run.
            const index = property as number;
            const { values } = value as ArrayElementRun;

            if (type === changeType.update) {
              sharedType.delete(index, values.length);
            }

            sharedType.insert(index, values.map((element) => {
              if (typeof element === "string") {
                return options.disableYText ? element : stringToYText(element);
              }
              if (isJsonElements && typeof element === "object" && element !== null) {
                return toJsonElement(element);
              }
              if (Array.isArray(element)) {
                return arrayToYArray(element, options);
              }
              if (typeof element === "object" && element !== null) {
                return objectToYMap(element as Record<string, unknown>, options);
              }

              return element;
            }));
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

        /*
         * The nested change list in `value` is never read (for a string it
         * is deferredTextDiff, see patchSharedType): a primitive string is
         * written whole, and a shared type child is re-diffed by its own
         * patchSharedType call.
         */
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

        // Anything but a real change list (or a list not diffed from the
        // doc) makes the child re-diff itself.
        const nestedChanges = isDiffedFromDoc && Array.isArray(value) ? value as Change[] : undefined;

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
               * touched the child since the snapshot was taken (which is
               * also what keeps `nestedChanges` valid).
               */
              const childJson = isPlainRecord(sharedTypeJson) && Object.hasOwn(sharedTypeJson, prop)
                ? { "value": sharedTypeJson[prop] }
                : undefined;

              patchPendingChild(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                nestedChanges,
                {
                  atomicKeys,
                  disableYText,
                  yTextKeys,
                  jsonElementKeys,
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
                ? arrayToYArray(newValue, { ...options, "key": prop })
                : objectToYMap(newValue as Record<string, unknown>, options));
            }
          }
        } else if (sharedType instanceof yjs.Array) {
          // (Under disableYText a string element arrives as an update run
          // instead; see coalesceArrayElementRuns.)
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

          if (isJsonElements && typeof newValue === "object" && newValue !== null) {
            /*
             * A JSON element (or a shared-type element written before the
             * option, which this migrates) is replaced whole, and only when
             * its stored form changes: a pending change can also come from
             * state the doc never stores (a function value, a "constructor"
             * key), and rewriting the element for it would churn the doc on
             * every flush.
             */
            const element = toJsonElement(newValue);
            const stored = existing instanceof yjs.AbstractType ? existing.toJSON() : existing;

            if (!isDeepEqualForDiff(stored, element)) {
              sharedType.delete(index);
              sharedType.insert(index, [element]);
            }
          } else if (isTextMappingMismatch) {
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
              /*
               * `index` is post-application: the earlier changes of this list
               * have shifted the aligned element (the one the nested list was
               * diffed from) to exactly this position. Never reorder or
               * regroup the list's changes: that would break it, along with
               * the previousState shift above.
               */
              patchPendingChild(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                nestedChanges,
                { atomicKeys, disableYText, yTextKeys, jsonElementKeys, previousState: childPreviousState }
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
 * Patches the shared type behind a pending change. The differ has already
 * recursed into it, so when the parent list was diffed from the doc the
 * pending entry holds the child's own change list (`nestedChanges`): apply
 * it directly instead of serializing and diffing the child again, which
 * would repeat the whole diff below this level once per ancestor. Without
 * one, diff the child from scratch.
 *
 * The `syncedKeys` whitelist is NOT threaded into recursion: nesting below a
 * synced key replicates fully.
 *
 * @param child - The shared type to patch.
 * @param newState - The child's new state.
 * @param nestedChanges - The child's change list, when it can be trusted.
 * @param patchOptions - Mapping options, the child's previousState, and its
 * JSON snapshot when the parent has one.
 */
const patchPendingChild = (
  child: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
  newState: unknown,
  nestedChanges: Change[] | undefined,
  { precomputedJson, ...options }: PatchOptions
): void => {
  if (nestedChanges === undefined) {
    patchSharedType(child, newState, { ...options, precomputedJson });

    return;
  }

  applyChangesToSharedType(child, nestedChanges, newState, {
    ...options,
    "isDiffedFromDoc": true,
    "sharedTypeJson": precomputedJson?.value,
  });
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
    jsonElementKeys,
    syncedKeys,
    precomputedJson,
  }: PatchOptions = {}
): void => {
  let sharedTypeJson: unknown;

  if (precomputedJson !== undefined) {
    sharedTypeJson = precomputedJson.value;
  } else if (syncedKeys !== undefined && sharedType instanceof yjs.Map && isPlainRecord(newState)) {
    // The whitelist below keeps only these keys: serialize nothing else.
    sharedTypeJson = pickMapJson(sharedType, syncedKeys);
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

  /*
   * Nested string pairs are deferred, not diffed: the applier writes a
   * primitive string whole and diffs a Y.Text child in that child's own
   * patchSharedType call, so a text diff here would only be thrown away.
   * A top-level string pair (this call patching a Y.Text) is still diffed.
   */
  const changes = getChanges(
    a as string | unknown[] | Record<string, unknown>,
    b as string | unknown[] | Record<string, unknown>,
    { "nestedStrings": "defer" }
  );

  /*
   * syncedKeys is intentionally NOT forwarded: it filters only the root diff
   * (the nested lists of the keys it keeps are unaffected by it). `a` is the
   * shared type's own JSON, so its nested lists can be applied as they are.
   */
  applyChangesToSharedType(sharedType, changes, b, {
    atomicKeys,
    disableYText,
    previousState,
    yTextKeys,
    jsonElementKeys,
    sharedTypeJson: a,
    isDiffedFromDoc: true,
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
    jsonElementKeys,
    syncedKeys,
    backfillAbsentKeys,
    unappliedInboundTargets,
  }: ScopedPatchOptions = {}
): void => {
  const prevRecord: Record<string, unknown> = isPlainRecord(previousState) ? previousState : {};
  const newRecord: Record<string, unknown> = isPlainRecord(newState) ? newState : {};
  const options: ScopedKeyOptions = { atomicKeys, disableYText, yTextKeys, jsonElementKeys, unappliedInboundTargets };

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
    const isDiffedFromPreviousState = unappliedInboundTargets !== undefined &&
      isArrayStructureUnchanged(existing, previousElements.length, unappliedInboundTargets);
    const changes = isDiffedFromPreviousState
      ? getChanges(previousElements, nextValue, { "nestedStrings": "defer", "previousA": prevValue })
      : getChanges(existing.toJSON() as unknown[], nextValue, { "nestedStrings": "defer", "previousA": prevValue });

    applyChangesToSharedType(
      existing,
      changes,
      nextValue,
      /*
       * Diffed from previousState, the nested lists describe state's
       * elements, not the doc's (which may hold those remote edits):
       * applied to a remotely edited Y.Text they would interleave the two
       * edits. The pending recursion re-diffs such elements instead.
       */
      { ...mappingOptions, "isDiffedFromDoc": !isDiffedFromPreviousState, "previousState": prevValue }
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
    getChanges(a, b, { "nestedStrings": "defer" }),
    b,
    // Threading `a` lets the pending recursion for this key reuse the
    // toJSON() snapshot taken above (and the list diffed from it) instead of
    // serializing and diffing the subtree twice.
    { ...mappingOptions, "isDiffedFromDoc": true, "previousState": prevRecord, "sharedTypeJson": a }
  );
};

/**
 * Whether the foreign transactions that changed `changedTypes` cannot have
 * inserted, deleted or replaced elements of `array`: a Y.Array whose
 * elements were inserted or deleted is itself an event target, and one
 * placed (or re-placed) by those transactions sits under a key that a
 * changed ancestor map lists. A write to any other key of an ancestor (a
 * sibling of the array, or of a record above it) leaves the array in place.
 * The length must also still match previousState's stored form.
 */
const isArrayStructureUnchanged = (
  array: yjs.Array<unknown>,
  previousLength: number,
  changedTypes: ReadonlyMap<unknown, ReadonlySet<string>>
): boolean => {
  if (array.length !== previousLength || changedTypes.has(array)) {
    return false;
  }

  // The key the walk's current child sits under in `type` (null in an array).
  let key = array._item?.parentSub;
  let type: unknown = array.parent;

  while (type instanceof yjs.AbstractType) {
    const changedKeys = changedTypes.get(type);

    if (changedKeys !== undefined && (!(type instanceof yjs.Map) || typeof key !== "string" || changedKeys.has(key))) {
      return false;
    }
    key = type._item?.parentSub;
    type = type.parent;
  }

  return true;
};

/**
 * Drops function-valued keys (store actions) from a state record, and the
 * same keys from the doc JSON beside it, at every depth. An action is never
 * replicated and inbound patches never replace one with replicated data, so
 * whatever the doc holds at an action's key is by design, not drift.
 *
 * @param docValue - The doc's JSON at this level.
 * @param stateValue - The state at the same level.
 * @returns Both values with action keys removed.
 */
const withoutActionKeys = (docValue: unknown, stateValue: unknown): [unknown, unknown] => {
  if (!isPlainRecord(stateValue)) {
    return [docValue, stateValue];
  }

  const docRecord = isPlainRecord(docValue) ? docValue : undefined;
  const docOut: Record<string, unknown> = {};
  const stateOut: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(stateValue)) {
    if (isDangerousKey(key) || value instanceof Function) {
      continue;
    }
    if (docRecord !== undefined && Object.hasOwn(docRecord, key)) {
      const [docChild, stateChild] = withoutActionKeys(docRecord[key], value);

      docOut[key] = docChild;
      stateOut[key] = stateChild;
    } else {
      stateOut[key] = value;
    }
  }

  if (docRecord === undefined) {
    return [docValue, stateOut];
  }

  for (const [key, value] of Object.entries(docRecord)) {
    if (!isDangerousKey(key) && !Object.hasOwn(stateValue, key)) {
      docOut[key] = value;
    }
  }

  return [docOut, stateOut];
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
  const stateRecord: Record<string, unknown> = isPlainRecord(state) ? state : {};
  const docJson: unknown = syncedKeys ? pickMapJson(sharedType, syncedKeys) : sharedType.toJSON();
  const [a, b] = withoutActionKeys(
    docJson,
    syncedKeys ? pickKeys(stateRecord, syncedKeys) : stateRecord
  );

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
  const revisedObject = { ...initialObject };
  /*
   * Deleted keys are removed in one pass at the end: rebuilding the record
   * once per delete made k deletes from an n-key record O(n * k).
   */
  let deletedKeys: Set<string> | undefined;

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
        // getRecordChanges never deletes and writes one key in one list;
        // should a later write follow a delete anyway, it must not be lost.
        deletedKeys?.delete(prop);
        break;
      }
      case changeType.pending: {
        revisedObject[prop] = applyChanges(revisedObject[prop] as string | unknown[] | Record<string, unknown>, value as Change[]);
        deletedKeys?.delete(prop);
        break;
      }
      case changeType.delete: {
        deletedKeys = deletedKeys ?? new Set<string>();
        deletedKeys.add(prop);
        break;
      }
      case changeType.none:
      default: {
        break;
      }
    }
  }

  if (deletedKeys === undefined) {
    return revisedObject;
  }

  // Filter keys to avoid the delete operator. Object.fromEntries keeps an own
  // "__proto__" key as a data property; assignment would set the prototype.
  return Object.fromEntries(Object.entries(revisedObject).filter(([p]) => !deletedKeys.has(p)));
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
 * Strings, at any depth, are taken whole from newState: they are primitives
 * (no identity to preserve), and applying their text diff would only rebuild
 * newState's string after an O(NP) diff.
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
  if (typeof oldState === "string" && typeof newState === "string") {
    return newState;
  }

  let changes = getChanges(
    oldState as string | unknown[] | Record<string, unknown>,
    newState as string | unknown[] | Record<string, unknown>,
    { "nestedStrings": "update" }
  );

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

  /**
   * The `jsonElementKeys` mapping option: elements of arrays under these
   * keys are plain JSON in the doc and are copied on their way into state.
   */
  jsonElementKeys?: readonly string[];
}

/**
 * Computes the next Zustand state for an inbound patch from map JSON.
 *
 * Without options this is exactly the legacy `patchState` call
 * (replace-with-delete hydration). With `syncedKeys` the diff/application
 * universe is restricted to the whitelist; deletes are still honored INSIDE
 * the subset.
 *
 * Never mutates `currentState`: every applier copies what it changes, which
 * is what lets patchStore pass `store.getState()` in uncloned.
 *
 * @param currentState - The current Zustand state.
 * @param newState - The Y.Map JSON to patch toward.
 * @param options - Inbound options (whitelist, default-key retention).
 * @returns The next state object to set with replace=true, or
 * `currentState` itself when nothing changed.
 */
export const computeInboundState = <T>(
  currentState: T,
  newState: unknown,
  { syncedKeys, suppressTopLevelDeleteKeys, jsonElementKeys }: InboundStateOptions = {}
): T => {
  const patchOptions: PatchStateOptions = { suppressTopLevelDeleteKeys };
  const docJson = sanitizeDocJson(newState, { jsonElementKeys });

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

  // Empty diff: hand back the input itself, so the caller can skip setState
  // (a fresh object would notify every subscriber for nothing).
  if (patchedSubset === oldSubset) {
    return currentState;
  }

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
 * When that changes nothing, setState is not called at all.
 *
 * @param store - The Zustand API that manages the store we want to patch.
 * @param newState - The new state that the Zustand store should be patched to.
 * @param options - Inbound options (replication whitelist, default retention).
 */
export const patchStore = <S>(
  store: StoreApi<S>,
  newState: unknown,
  { syncedKeys, suppressTopLevelDeleteKeys, jsonElementKeys }: InboundStateOptions = {}
): void => {
  /*
   * Not cloned: computeInboundState never mutates its input, and returns it
   * as is when nothing changed. A batch that changes nothing for this store
   * (an identical value, a key outside syncedKeys) then keeps the state
   * object, instead of notifying every subscriber and re-running nested
   * middlewares (persist, devtools) with an equal copy.
   */
  const oldState = store.getState();
  const nextState = computeInboundState(oldState, newState, {
    syncedKeys,
    suppressTopLevelDeleteKeys,
    jsonElementKeys,
  });

  if (!Object.is(nextState, oldState)) {
    store.setState(nextState, true); // Replace with the patched state.
  }
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

/**
 * Store-safe JSON of a doc value: a shared type is serialized, anything else
 * is already JSON. `options.key` is the key the value is stored under, so the
 * elements of a `jsonElementKeys` array come back as copies (sanitizeDocJson).
 */
const readDocJson = (value: unknown, options: DocJsonOptions): unknown =>
  { return sanitizeDocJson(value instanceof yjs.AbstractType ? value.toJSON() : value, options) };

const readDocJsonAtPath = (
  dataMap: yjs.Map<unknown>,
  path: InboundPath,
  jsonElementKeys: readonly string[] | undefined
): unknown => {
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

  return readDocJson(node, { jsonElementKeys, "key": String(path.at(-1)) });
};

/** The Y.Map at `path` (map keys only), or undefined when a step is missing or not a Y.Map. */
const readDocMapAtPath = (dataMap: yjs.Map<unknown>, path: InboundPath): yjs.Map<unknown> | undefined => {
  let node: unknown = dataMap;

  for (const step of path) {
    if (!(node instanceof yjs.Map)) {
      return undefined;
    }
    node = node.get(String(step));
  }

  return node instanceof yjs.Map ? node : undefined;
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
 * Returns `state` with `value` at `path` (from segment `depth` on), sharing
 * every object that is not on the path. Containers along the spine are
 * copied in kind (array vs record) so array-typed levels stay arrays.
 *
 * Why `owned`: a batch of P paths under one W-key parent (a catch-up or a
 * bulk edit of sibling records) used to copy that parent once per path,
 * O(P x W). A container this batch already copied is in `owned` and is
 * written in place instead, so each spine container is copied once per
 * batch. Only those copies are ever written: `state` and everything
 * reachable from it may be frozen or shared with subscribers. Writing in
 * place cannot land inside a value another path patched, because the
 * caller's paths are prefix-free (`minimizeInboundPaths`).
 */
const setStateAtPath = (
  state: unknown,
  path: InboundPath,
  depth: number,
  value: unknown,
  owned: WeakSet<object>
): unknown => {
  if (depth === path.length) {
    return value;
  }

  const step = path[depth];

  if (Array.isArray(state)) {
    const index = Number(step);
    const copy: unknown[] = owned.has(state) ? state : [...state];

    owned.add(copy);
    copy[index] = setStateAtPath(state[index], path, depth + 1, value, owned);

    return copy;
  }

  const key = String(step);

  if (isDangerousKey(key)) {
    return state;
  }

  let record: Record<string, unknown> = {};

  if (isPlainRecord(state)) {
    record = owned.has(state) ? state : { ...state };
  }
  owned.add(record);
  record[key] = setStateAtPath(record[key], path, depth + 1, value, owned);

  return record;
};

/** A node of the trie of kept paths that minimizeInboundPaths walks. */
interface PathTrieNode {
  children: Map<string, PathTrieNode>;
  isKept: boolean;
}

/**
 * Drops any path that a shallower collected path already covers, so a branch
 * is reconciled once. `['a','b']` covers `['a','b','c']`; `['a','bb']` does
 * not cover `['a','b']` (segment-wise comparison, not string prefix). Of two
 * equal paths, the one listed first is kept.
 *
 * Kept paths go into a trie keyed by `String(step)`, so each path costs one
 * walk of its own length rather than a comparison with every kept path
 * (O(P^2) for a batch of P sibling paths; one bulk remote batch — an offline
 * catch-up, an import — can name thousands of keys). A walk that reaches a
 * kept path's end is covered, and it only crosses existing nodes, so it adds
 * none.
 */
export const minimizeInboundPaths = (paths: readonly InboundPath[]): InboundPath[] => {
  const sorted = [...paths];

  sorted.sort((left, right) => left.length - right.length);

  const root: PathTrieNode = { "children": new Map(), "isKept": false };
  const kept: InboundPath[] = [];

  for (const path of sorted) {
    let node = root;

    for (const step of path) {
      if (node.isKept) {
        break;
      }

      const segment = String(step);
      let child = node.children.get(segment);

      if (child === undefined) {
        child = { "children": new Map(), "isKept": false };
        node.children.set(segment, child);
      }
      node = child;
    }

    // Still on a kept node: a shallower (or equal) kept path covers this one.
    if (!node.isKept) {
      node.isKept = true;
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

/** What `getEventPathWithoutIndices` puts where `event.path` has an index. */
export const UNCOUNTED_ARRAY_INDEX = -1;

/**
 * `event.path` with every array index replaced by `UNCOUNTED_ARRAY_INDEX`:
 * same length, same map keys, so `truncateAtArrayIndex` cuts both at the
 * same place.
 *
 * Why: Yjs does not cache `YEvent#path`. Every read runs getPathTo, which
 * counts each array ancestor's items from its start up to the child,
 * tombstones included — O(index) per read, for an index the inbound
 * observer only cuts away. A catch-up of edits to the elements of a large
 * or aged object array paid that several times per event. This is the same
 * parent walk without the count: O(depth).
 */
export const getEventPathWithoutIndices = (
  event: yjs.YEvent<yjs.AbstractType<unknown>>
): InboundPath => {
  const path: (string | number)[] = [];
  let child: yjs.AbstractType<unknown> = event.target;

  // Same walk and stop condition as getPathTo(event.currentTarget, target).
  while (child._item !== null && child !== event.currentTarget) {
    path.unshift(child._item.parentSub ?? UNCOUNTED_ARRAY_INDEX);
    child = child._item.parent as yjs.AbstractType<unknown>;
  }

  return path;
};

/**
 * Options for computeInboundStateForPaths.
 */
export interface InboundPathOptions extends InboundStateOptions {
  /**
   * Store-relative paths that each name ONE key of a Y.Map that a Yjs event
   * reported as changed (`keysChanged`: added, replaced or removed). The
   * parent must exist on both sides, as a Y.Map in the doc and a record in
   * state; the key itself may be missing from either.
   */
  keyPaths?: readonly InboundPath[];
}

/**
 * The state value patched toward the doc value: the same `patchState` diff
 * as the key-scoped route when both have the same shape, else the doc value.
 */
const reconcileStateValue = (stateValue: unknown, docValue: unknown): unknown =>
  { return isDiffableState(stateValue) && isDiffableState(docValue) &&
    isSameShape(stateValue, docValue)
    ? patchState(stateValue, docValue)
    : docValue };

/**
 * Applies the changed `keys` of a doc Y.Map to the state record that mirrors
 * it: a key only the doc has is inserted, a key only state has is removed,
 * a key on both sides is reconciled, and a key on neither (changed and then
 * removed again within the batch) is left alone.
 *
 * The record is copied at most once, however many keys changed, and filtered
 * once for all removals; a copy this patch already owns is updated in place.
 * One bulk batch can name thousands of keys under the same parent, so a copy
 * or a filter per key would be quadratic.
 *
 * @param record - The state record at the event's path.
 * @param docMap - The Y.Map at the same path.
 * @param keys - The changed keys (no duplicates).
 * @param owned - Containers this patch already copied.
 * @param jsonElementKeys - The `jsonElementKeys` mapping option.
 * @returns The updated record, or `record` when it is unchanged or was
 * updated in place.
 */
const applyChangedKeys = (
  record: Record<string, unknown>,
  docMap: yjs.Map<unknown>,
  keys: readonly string[],
  owned: WeakSet<object>,
  jsonElementKeys: readonly string[] | undefined
): Record<string, unknown> => {
  let next = record;
  let removedKeys: Set<string> | undefined;

  for (const key of keys) {
    // sanitizeDocJson would drop the key, so it never reaches state.
    if (isDangerousKey(key)) {
      continue;
    }

    const stateValue = getOwnValue(record, key);

    if (stateValue instanceof Function) {
      // A function (store action) is never replicated, so never replaced.
      continue;
    }

    const isInState = Object.hasOwn(record, key);

    if (!docMap.has(key)) {
      if (isInState) {
        removedKeys = removedKeys ?? new Set<string>();
        removedKeys.add(key);
      }
      continue;
    }

    const docValue = readDocJson(docMap.get(key), { jsonElementKeys, key });
    const patched = isInState ? reconcileStateValue(stateValue, docValue) : docValue;

    if (!isInState || !Object.is(patched, stateValue)) {
      if (!owned.has(next)) {
        next = { ...record };
        owned.add(next);
      }
      next[key] = patched;
    }
  }

  if (removedKeys === undefined) {
    return next;
  }

  // Built by filtering rather than the delete operator. Object.fromEntries
  // keeps an own "__proto__" key as a data property, as applyChangesToObject
  // does; plain assignment would set the prototype.
  const filtered: Record<string, unknown> = Object.fromEntries(
    Object.entries(next).filter(([key]) => !removedKeys.has(key))
  );

  owned.add(filtered);

  return filtered;
};

/**
 * Path-scoped inbound patch: reconciles ONLY the branches named by `paths`
 * (each at least two segments deep) and the map keys named by
 * `options.keyPaths` instead of re-reading and re-diffing a whole top-level
 * key.
 *
 * Why: `observeDeep` already hands us the exact path of every remote change,
 * but the scoped inbound patch threw all but the first segment away and
 * re-read the entire top-level key. For a store whose hot key holds one
 * large tree, that is O(total state) per inbound batch — the receiving
 * device pays for its whole library on every remote page turn, and the cost
 * grows forever. Patching at the event's own path makes it O(changed
 * branch). Key paths do the same for a change to a map's own keys: a new
 * book or annotation from another device costs the added value, not the
 * map it was added to (for a map directly under a top-level key, the whole
 * key).
 *
 * Semantics match the top-level patch for the branches it touches: the value
 * at each path is reconciled with the same `patchState` diff, and the spine
 * above it is rebuilt with structural sharing, so untouched siblings keep
 * their object identity (better referential stability than rebuilding the
 * whole top-level value, which is what the caller did before). Each
 * container on a spine is copied once per call, however many paths cross
 * it.
 *
 * The caller must only pass paths that Yjs events named, cut at their first
 * array index (`truncateAtArrayIndex`), and key paths only for map keys
 * with no array index above them. Like the key-scoped path it replaces,
 * this reconciles what changed rather than the whole subtree — one level
 * deeper, but the same assumption.
 *
 * Returns `undefined` when a path cannot be reconciled in isolation — the
 * branch (for a key path: the parent map) is missing on one side, so the
 * change is only visible at a level this call was not given. Reconciling
 * the rest and dropping that path would silently lose the change, so the
 * caller must fall back to the key-scoped patch for the whole batch
 * instead. (Adding or removing a branch normally also raises an event on
 * its parent, whose key path covers it.).
 *
 * @param currentState - The current store state.
 * @param dataMap - The Y.Map the store is bound to.
 * @param paths - Store-relative paths of the changed nodes, each at least two segments long.
 * @param options - Inbound options; `syncedKeys` gates the first segment,
 * `keyPaths` names changed map keys.
 * @returns The next state, `currentState` when nothing changed, or
 * `undefined` when the caller must fall back.
 */
export const computeInboundStateForPaths = <T>(
  currentState: T,
  dataMap: yjs.Map<unknown>,
  paths: readonly InboundPath[],
  { syncedKeys, keyPaths = [], jsonElementKeys }: InboundPathOptions = {}
): T | undefined => {
  const keyPathSet = new Set(keyPaths);
  const changedKeysByParent = new Map<string, { parentPath: InboundPath; keys: string[] }>();
  const nodePaths: InboundPath[] = [];

  // Key paths first: of two equal paths the key path is kept, because it
  // tolerates the key being absent on either side.
  for (const path of minimizeInboundPaths([...keyPaths, ...paths])) {
    if (path.length < 2 || isDangerousKey(String(path[0]))) {
      return undefined;
    }
    if (syncedKeys !== undefined && !syncedKeys.has(String(path[0]))) {
      // Not replicated into this store: correctly ignored, not an escalation.
      continue;
    }
    if (keyPathSet.has(path)) {
      const parentPath = path.slice(0, -1);
      const parentId = JSON.stringify(parentPath);
      const group = changedKeysByParent.get(parentId) ?? { parentPath, "keys": [] };

      group.keys.push(String(path.at(-1)));
      changedKeysByParent.set(parentId, group);
    } else {
      nodePaths.push(path);
    }
  }

  // Spine containers this call copied: written in place by later paths.
  const owned = new WeakSet();
  let next: unknown = currentState;

  for (const { parentPath, keys } of changedKeysByParent.values()) {
    const docMap = readDocMapAtPath(dataMap, parentPath);
    const record = readStateAtPath(next, parentPath);

    if (docMap === undefined || !isPlainRecord(record)) {
      return undefined;
    }

    const updated = applyChangedKeys(record, docMap, keys, owned, jsonElementKeys);

    if (updated !== record) {
      next = setStateAtPath(next, parentPath, 0, updated, owned);
    }
  }

  for (const path of nodePaths) {
    const docValue = readDocJsonAtPath(dataMap, path, jsonElementKeys);
    const stateValue = readStateAtPath(next, path);

    if (docValue === absent || stateValue === absent) {
      return undefined;
    }
    if (stateValue instanceof Function) {
      // A function (store action) is never replicated, so never replaced.
      continue;
    }

    const patched = reconcileStateValue(stateValue, docValue);

    if (!Object.is(patched, stateValue)) {
      next = setStateAtPath(next, path, 0, patched, owned);
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
