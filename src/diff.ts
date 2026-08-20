/* eslint-disable @typescript-eslint/no-use-before-define */
import { type Change,changeType } from "./types";

export type Diffable = string | unknown[] | Record<string, unknown>;

const isDiffable = (d: unknown): d is Diffable =>
  { return typeof d === "string" || (typeof d === "object" && d !== null) };

const isRecord = (d: unknown): d is Record<string, unknown> =>
  { return typeof d === "object" && d !== null && !Array.isArray(d) };

const isSameType = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string" && typeof b === "string") {return true;}

  return (Array.isArray(a) && Array.isArray(b)) || (isRecord(a) && isRecord(b));
};

const hasCommonSubsequence = (a: string, b: string): boolean => {
  const alphabetOfB = new Set(b);

  for (const char of a) {
    if (alphabetOfB.has(char)) {
      return true;
    }
  }

  return false;
};

/**
 * An adaptation of Wu et al. O(NP) text diff.
 */
const diffTextInternal = (
  a: string,
  b: string,
  isReversed: boolean
): Change[] => {
  const m = a.length;
  const n = b.length;
  const offset = m;
  const delta = n - m;
  const size = m + n + 1;

  const frontierPoints = Array.from({ length: size }, () => -1);
  const path = Array.from({ length: size }, () => -1);

  interface InlineInterface { x: number; y: number; k: number }
const pathPositions: InlineInterface[] = [];

  const snake = (snakeK: number, snakeP: number, snakeQ: number): number => {
    let innerY = Math.max(snakeP, snakeQ);
    let innerX = innerY - snakeK;

    while (innerX < m && innerY < n && a[innerX] === b[innerY]) {
      innerX = innerX + 1;
      innerY = innerY + 1;
    }

    const pathIdx = pathPositions.length;

    path[snakeK + offset] = pathIdx;
    pathPositions[pathIdx] = {
      k: snakeP > snakeQ ? path[snakeK + offset - 1] : path[snakeK + offset + 1],
      x: innerX,
      y: innerY,
    };

    return innerY;
  };

  let loopP = -1;

  do {
    loopP = loopP + 1;
    for (let k = -loopP; k < delta; k = k + 1) {
      frontierPoints[k + offset] = snake(
        k,
        frontierPoints[k + offset - 1] + 1,
        frontierPoints[k + offset + 1]
      );
    }
    for (let k = delta + loopP; k > delta; k = k - 1) {
      frontierPoints[k + offset] = snake(
        k,
        frontierPoints[k + offset - 1] + 1,
        frontierPoints[k + offset + 1]
      );
    }
    frontierPoints[delta + offset] = snake(
      delta,
      frontierPoints[delta + offset - 1] + 1,
      frontierPoints[delta + offset + 1]
    );
  } while (frontierPoints[delta + offset] !== n);

  let traceK = path[delta + offset];

  interface EditPoint { x: number; y: number }
  const editPath: EditPoint[] = [];

  while (traceK !== -1) {
    const pos = pathPositions[traceK] as { x: number; y: number; k: number };

    editPath.push({ x: pos.x, y: pos.y });
    traceK = pos.k;
  }

  const changeList: Change[] = [];
  let curX = 0;
  let curY = 0;
  let curIndex = -1;

  for (let i = editPath.length - 1; i >= 0; i = i - 1) {
    const point = editPath[i] as { x: number; y: number };

    while (curX <= point.x || curY <= point.y) {
      if (point.y - point.x > curY - curX) {
        if (isReversed) {
          changeList.push([changeType.delete, curIndex, undefined]);
        } else {
          changeList.push([changeType.insert, curIndex, b[curY - 1]]);
          curIndex = curIndex + 1;
        }
        curY = curY + 1;
      } else if (point.y - point.x < curY - curX) {
        if (isReversed) {
          changeList.push([changeType.insert, curIndex, a[curX - 1]]);
          curIndex = curIndex + 1;
        } else {
          changeList.push([changeType.delete, curIndex, undefined]);
        }
        curX = curX + 1;
      } else {
        curX = curX + 1;
        curY = curY + 1;
        curIndex = curIndex + 1;
      }
    }
  }

  return changeList;
};

const getChangesTextInner = (a: string, b: string): Change[] => {
  if (!hasCommonSubsequence(a, b)) {
    const deletes = Array.from({ length: a.length }, (): Change => [changeType.delete, 0, undefined]);
    const inserts = Array.from({ length: b.length }, (value, index): Change => [changeType.insert, index, b[index]]);

    return [...deletes, ...inserts];
  }

  const m = a.length;
  const n = b.length;
  const isReverse = m >= n;

  return isReverse ? diffTextInternal(b, a, isReverse) : diffTextInternal(a, b, isReverse);
};

const getChangesText = (a: string, b: string): Change[] => {
  if (a === b) {
    return [];
  }

  /*
   * Trim the common prefix and suffix before diffing so the O(NP) algorithm
   * (and its O(m + n) frontier allocations) run only on the edited window.
   * A small edit inside a large string costs O(edit) instead of O(m + n).
   * The prefix is untouched by every emitted change, so shifting the change
   * indices by the prefix length reproduces whole-string coordinates exactly.
   */
  const maxPrefix = Math.min(a.length, b.length);
  let prefix = 0;

  while (prefix < maxPrefix && a[prefix] === b[prefix]) {
    prefix = prefix + 1;
  }

  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;

  while (
    suffix < maxSuffix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix = suffix + 1;
  }

  const changes = getChangesTextInner(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix)
  );

  if (prefix === 0) {
    return changes;
  }

  for (const change of changes) {
    change[1] = (change[1] as number) + prefix;
  }

  return changes;
};

/**
 *
 * Early-exit deep equality with the exact semantics of
 * `getChanges(a, b).length === 0` for same-type diffable pairs, without
 * building change lists. Mirrors getChanges' quirks on purpose: a
 * function-valued key missing from `b` does not count as a difference, and
 * non-diffable values (including NaN) compare by strict equality.
 */
const isDeepEqualForDiff = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }

  if (typeof a === "string" || typeof b === "string") {
    return false;
  }

  /*
   * Hot path: this runs for every element of every diffed array and every key
   * of every diffed record, so the per-field cost matters. `===` is checked
   * before any type classification (most fields are primitives), and
   * Object.keys/every are used instead of Object.entries/for-of to avoid
   * per-field tuple and iterator allocations.
   */
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }

    return a.every((left, index) => {
      const right = b[index];

      if (left === right) {
        return true;
      }

      return isDiffable(left) && isDiffable(right) && isSameType(left, right) &&
        isDeepEqualForDiff(left, right);
    });
  }

  if (isRecord(a) && isRecord(b)) {
    const isEveryAKeyAccounted = Object.keys(a).every((property) =>
       property in b || a[property] instanceof Function );

    if (!isEveryAKeyAccounted) {
      return false;
    }

    return Object.keys(b).every((property) => {
      if (!(property in a)) {
        return false;
      }

      const other = a[property];
      const value = b[property];

      if (other === value) {
        return true;
      }

      return isDiffable(other) && isDiffable(value) && isSameType(other, value) &&
        isDeepEqualForDiff(other, value);
    });
  }

  return false;
};

/**
 * Options for array diffing.
 */
interface ArrayDiffOptions {
  /** The caller's previous state for the same array (alignment hint). */
  previousA?: unknown[];
}

const getArrayChanges = (a: unknown[], b: unknown[], { previousA }: ArrayDiffOptions = {}): Change[] => {
  const changeList: Change[] = [];
  let finalIndices = 0;
  let bOffset = 0;
  const LOOKAHEAD_WINDOW = 10;

  /*
   * Beyond the deep-equality window, block shifts are still detectable at
   * pointer-comparison cost: immutable-update splices (slice/filter/concat)
   * preserve the identity of the surviving elements, so a head/mid block
   * removal or insertion larger than the window shows up as the SAME object
   * reference further along the other side. Without this, e.g. trimming a
   * 500-element array to its last 300 (a 200-element head removal) degrades
   * into ~300 element-wise rewrites — hundreds of Yjs items and kilobytes of
   * update payload for what is really one range delete.
   *
   * Two scan modes, both identity-only (never deep equality — that would be
   * O(n²) in subtree size) and budgeted so arrays sharing no identities
   * (fully rebuilt every write) stop scanning and keep the legacy behavior:
   *
   * - Direct: `a` itself shares references with `b` (state-vs-state diffs).
   * - Hinted: `a` is a fresh `toJSON()` snapshot (shares nothing with `b`),
   *   but `previousA` — the caller's previous STATE for the same array —
   *   does. `previousA` mirrors `a` positionally whenever the doc reflects
   *   the last flush, so an identity hit in `previousA` proposes a shift
   *   that ONE deep-equality check against `a` then confirms (or rejects,
   *   falling back to the legacy element-wise path — concurrent remote
   *   edits make the confirm fail, never a wrong emit).
   */
  let identityScanBudget = Math.max(1_000, 4 * (a.length + b.length));

  for (let index = 0; index < a.length; index = index + 1) {
    const value = a[index];
    const bIndex = index + bOffset;

    if (bIndex >= b.length) {
      /*
       * Trailing-block deletes. Once b is exhausted, no later element of `a`
       * can match (the lookahead needs b elements), so EVERY remaining element
       * of `a` is deleted — this branch is terminal. Emit the whole block at
       * this one fixed index: applying a delete at a fixed index repeatedly
       * removes consecutive elements (each removal shifts the next one into
       * place), which is exactly the trailing block, and the fixed index lets
       * the Y.Array applier coalesce the block into a single range delete
       * instead of N tombstone-walking single deletes.
       */
      for (let rest = index; rest < a.length; rest = rest + 1) {
        changeList.push([changeType.delete, bIndex, undefined]);
      }
      break;
    }

    let isMatchFound = false;

    for (let k = 0; k <= LOOKAHEAD_WINDOW; k = k + 1) {
      if (bIndex + k < b.length) {
        const bValue = b[bIndex + k];
        const isStrictMatch = value === bValue;
        const isDeepMatch =
          !isStrictMatch &&
          isDiffable(value) &&
          isDiffable(bValue) &&
          isSameType(value, bValue)
            ? isDeepEqualForDiff(value, bValue)
            : false;

        if (isStrictMatch || isDeepMatch) {
          if (k > 0) {
            for (let insertIdx = 0; insertIdx < k; insertIdx = insertIdx + 1) {
              changeList.push([changeType.insert, bIndex + insertIdx, b[bIndex + insertIdx]]);
            }
            finalIndices = finalIndices + k + 1;
            bOffset = bOffset + k;
          } else {
            finalIndices = finalIndices + 1;
          }
          isMatchFound = true;
          break;
        }
      }

      if (k > 0 && index + k < a.length) {
        const nextA = a[index + k];
        const isStrictMatch = nextA === b[bIndex];
        const isDeepMatch =
          !isStrictMatch &&
          isDiffable(nextA) &&
          isDiffable(b[bIndex]) &&
          isSameType(nextA, b[bIndex])
            ? isDeepEqualForDiff(nextA, b[bIndex])
            : false;

        if (isStrictMatch || isDeepMatch) {
          for (let deleteIdx = 0; deleteIdx < k; deleteIdx = deleteIdx + 1) {
            changeList.push([changeType.delete, bIndex, undefined]);
          }
          index = index + (k - 1);
          bOffset = bOffset - k;
          isMatchFound = true;
          break;
        }
      }
    }

    if (isMatchFound) {
      continue;
    }

    // Extended identity scan (see identityScanBudget above): look past the
    // deep-equality window for a strict-identity alignment on either side,
    // and take the shorter shift when both exist.
    if (identityScanBudget > 0) {
      const bTarget = b[bIndex];
      let deleteShift = -1;

      for (
        let j = index + LOOKAHEAD_WINDOW + 1;
        j < a.length && identityScanBudget > 0;
        j = j + 1
      ) {
        identityScanBudget = identityScanBudget - 1;
        if (a[j] === bTarget) {
          deleteShift = j - index;
          break;
        }
      }

      if (deleteShift === -1 && previousA !== undefined) {
        // Hinted mode: propose the shift from the previous state's
        // identities, then confirm the proposal against `a` itself.
        for (
          let j = index + LOOKAHEAD_WINDOW + 1;
          j < previousA.length && identityScanBudget > 0;
          j = j + 1
        ) {
          identityScanBudget = identityScanBudget - 1;
          if (previousA[j] === bTarget) {
            if (
              j < a.length &&
              isDiffable(a[j]) &&
              isDiffable(bTarget) &&
              isSameType(a[j], bTarget) &&
              isDeepEqualForDiff(a[j], bTarget)
            ) {
              deleteShift = j - index;
            }
            break;
          }
        }
      }

      let insertShift = -1;

      for (
        let j = bIndex + LOOKAHEAD_WINDOW + 1;
        j < b.length && identityScanBudget > 0;
        j = j + 1
      ) {
        identityScanBudget = identityScanBudget - 1;
        if (b[j] === value) {
          insertShift = j - bIndex;
          break;
        }
      }

      if (insertShift === -1 && previousA !== undefined && index < previousA.length) {
        // Hinted mode, insertion side: the current a-element's previous-state
        // twin found further along b proposes an insert block; one deep
        // equality against `a` confirms it.
        const prevTwin = previousA[index];

        if (prevTwin !== undefined || index in previousA) {
          for (
            let j = bIndex + LOOKAHEAD_WINDOW + 1;
            j < b.length && identityScanBudget > 0;
            j = j + 1
          ) {
            identityScanBudget = identityScanBudget - 1;
            if (b[j] === prevTwin) {
              if (
                isDiffable(value) &&
                isDiffable(b[j]) &&
                isSameType(value, b[j]) &&
                isDeepEqualForDiff(value, b[j])
              ) {
                insertShift = j - bIndex;
              }
              break;
            }
          }
        }
      }

      if (deleteShift !== -1 && (insertShift === -1 || deleteShift <= insertShift)) {
        // Mirror of the in-window delete branch with k = deleteShift.
        for (let deleteIdx = 0; deleteIdx < deleteShift; deleteIdx = deleteIdx + 1) {
          changeList.push([changeType.delete, bIndex, undefined]);
        }
        index = index + (deleteShift - 1);
        bOffset = bOffset - deleteShift;
        continue;
      }

      if (insertShift !== -1) {
        // Mirror of the in-window insert branch with k = insertShift.
        for (let insertIdx = 0; insertIdx < insertShift; insertIdx = insertIdx + 1) {
          changeList.push([changeType.insert, bIndex + insertIdx, b[bIndex + insertIdx]]);
        }
        finalIndices = finalIndices + insertShift + 1;
        bOffset = bOffset + insertShift;
        continue;
      }
    }

    if (isDiffable(value) && isDiffable(b[bIndex]) && isSameType(value, b[bIndex])) {
      const currentDiff = getChanges(value, b[bIndex]);

      if (currentDiff.length > 0) {
        changeList.push([changeType.pending, bIndex, currentDiff]);
      }
      finalIndices = finalIndices + 1;
    } else {
      changeList.push([changeType.update, bIndex, b[bIndex]]);
      finalIndices = finalIndices + 1;
    }
  }

  if (finalIndices < b.length) {
    const trailingValues = b.slice(a.length + bOffset);

    for (const [i, trailingValue] of trailingValues.entries()) {
      changeList.push([changeType.insert, finalIndices + i, trailingValue]);
    }
  }

  return changeList;
};

const getRecordChanges = (a: Record<string, unknown>, b: Record<string, unknown>): Change[] => {
  const changeList: Change[] = [];

  for (const [property, value] of Object.entries(a)) {
    if (!(property in b) && !(value instanceof Function)) {
      changeList.push([changeType.delete, property, undefined]);
    }
  }

  for (const [property, value] of Object.entries(b)) {
    if (!(property in a)) {
      changeList.push([changeType.insert, property, value]);
    } else if (isDiffable(a[property]) && isDiffable(value) && isSameType(a[property], value)) {
      /*
       * Equality prefilter: for unchanged subtrees (the common case in a
       * full-tree diff), the early-exit comparison avoids building and
       * discarding a whole tree of empty change lists. isDeepEqualForDiff
       * matches `getChanges(x, y).length === 0` exactly, so a `false` here
       * guarantees a non-empty change list.
       */
      if (!isDeepEqualForDiff(a[property], value)) {
        changeList.push([changeType.pending, property, getChanges(a[property], value)]);
      }
    } else if (a[property] !== value) {
      changeList.push([changeType.update, property, value]);
    }
  }

  return changeList;
};

/**
 * Options for computing changes between two diffable values.
 */
export interface GetChangesOptions {
  /**
   * Optional alignment hint for ARRAY diffs only: the caller's previous
   * STATE for the same array. When `a` is a fresh `toJSON()` snapshot it
   * shares no references with `b`, but `previousA` does — letting block
   * splices larger than the deep-equality lookahead window be detected at
   * pointer cost and confirmed with one deep equality against `a` (see
   * getArrayChanges). Ignored for strings and records.
   */
  previousA?: unknown;
}

/**
 * Calculates the changes between two diffable values.
 *
 * @param a - The value to change from (for shared types: their JSON).
 * @param b - The value to change to (the new state).
 * @param options - Diff options; see {@link GetChangesOptions} for the
 * array alignment hint.
 */
export const getChanges = (a: Diffable, b: Diffable, { previousA }: GetChangesOptions = {}): Change[] => {
  if (typeof a === "string" && typeof b === "string") {
    return getChangesText(a, b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return getArrayChanges(a, b, Array.isArray(previousA) ? { previousA } : {});
  }
  if (isRecord(a) && isRecord(b)) {
    return getRecordChanges(a, b);
  }

  return [];
};