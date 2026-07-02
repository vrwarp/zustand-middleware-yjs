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

const getArrayChanges = (a: unknown[], b: unknown[]): Change[] => {
  const changeList: Change[] = [];
  let finalIndices = 0;
  let bOffset = 0;
  const LOOKAHEAD_WINDOW = 10;

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
 * Calculates the changes between two diffable values.
 */
export const getChanges = (a: Diffable, b: Diffable): Change[] => {
  if (typeof a === "string" && typeof b === "string") {
    return getChangesText(a, b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return getArrayChanges(a, b);
  }
  if (isRecord(a) && isRecord(b)) {
    return getRecordChanges(a, b);
  }

  return [];
};