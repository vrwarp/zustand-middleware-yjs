import { ChangeType, Change, } from "./types";

type Diffable = Record<string, any> | Array<any> | string;

const isDiffable = (v: any): v is Diffable =>
  isArray(v) || isString(v) || v instanceof Object;

const isArray = (d: Diffable): d is Array<any> =>
  d instanceof Array;

const isString = (d: Diffable): d is string =>
  typeof d === "string";

const isRecord = (d: Diffable): d is Record<string, any> =>
  !isArray(d) && !isString(d) && typeof d === "object" && d !== null;

const isSameType = (a: Diffable, b: Diffable): boolean => {
  if (isArray(a)) return isArray(b);
  if (isString(a)) return isString(b);
  if (isRecord(a)) return isRecord(b);
  return false;
};

export const getChanges = (a: Diffable, b: Diffable): Change[] => {
  if (isString(a) && isString(b))
    return getStringChanges(a, b);
  else if (isArray(a) && isArray(b))
    return getArrayChanges(a, b);
  else if (isRecord(a) && isRecord(b))
    return getRecordChanges(a, b);
  else
    return [];
};

const getStringChanges = (a: string, b: string): Change[] => {
  if (a === b)
    return [];
  else if (a.length === 0) {
    return b.split("").map((character, index) =>
      [ChangeType.INSERT, index, character]);
  }
  else if (b.length === 0) {
    return a.split("").map(() =>
      [ChangeType.DELETE, 0, undefined]);
  }
  else if (!hasCommonSubsequence(a, b)) {
    const deletes = a.split("").map<Change>(() =>
      [ChangeType.DELETE, 0, undefined]);

    const inserts = b.split("").map<Change>((character, index) =>
      [ChangeType.INSERT, index, character]);

    return deletes.concat(inserts);
  }
  else {
    const m = a.length, n = b.length;
    const reverse = m >= n;

    return reverse
      ? _diffText(b, a, reverse)
      : _diffText(a, b, reverse);
  }
};

const getArrayChanges = (a: Array<any>, b: Array<any>): Change[] => {
  const changeList: Change[] = [];

  let finalIndices = 0;
  let bOffset = 0;

  const LOOKAHEAD_WINDOW = 10;

  for (let index = 0; index < a.length; index++) {
    const value = a[index];
    const bIndex = index + bOffset;

    // Boundary check
    if (bIndex >= b.length) {
      changeList.push([ChangeType.DELETE, bIndex, undefined]);
      continue;
    }

    let matchFound = false;

    // --- WINDOWED LOOKAHEAD ---
    for (let k = 0; k <= LOOKAHEAD_WINDOW; k++) {
      // 1. Check for INSERTION (Drift in B)
      // Look ahead in B: Does A[index] match B[bIndex + k]?
      if (bIndex + k < b.length) {
        const bValue = b[bIndex + k];
        const isStrictMatch = value === bValue;
        const isDeepMatch = !isStrictMatch && isDiffable(value) && isDiffable(bValue) && isSameType(value, bValue)
          ? getChanges(value, bValue).length === 0
          : false;

        if (isStrictMatch || isDeepMatch) {
          if (k > 0) {
            // Found a match k steps away in B.
            // This means the previous k items in B were insertions.
            for (let insertIdx = 0; insertIdx < k; insertIdx++) {
              changeList.push([ChangeType.INSERT, bIndex + insertIdx, b[bIndex + insertIdx]]);
            }
            finalIndices += (k + 1);
            bOffset += k;
          } else {
            finalIndices++; // Standard match (k=0)
          }
          matchFound = true;
          break;
        }
      }

      // 2. Check for DELETION (Drift in A)
      // Look ahead in A: Does A[index + k] match B[bIndex]?
      if (k > 0 && index + k < a.length) {
        const nextA = a[index + k];
        const isStrictMatch = nextA === b[bIndex];
        const isDeepMatch = !isStrictMatch && isDiffable(nextA) && isDiffable(b[bIndex]) && isSameType(nextA, b[bIndex])
          ? getChanges(nextA, b[bIndex]).length === 0
          : false;

        if (isStrictMatch || isDeepMatch) {
          // Found a match k steps away in A.
          // This means the items A[index]...A[index+k-1] were deleted.
          for (let deleteIdx = 0; deleteIdx < k; deleteIdx++) {
            // We emit deletion at 'bIndex' repeatedly because as items are deleted,
            // the subsequent items shift into 'bIndex'.
            changeList.push([ChangeType.DELETE, bIndex, undefined]);
          }

          index += (k - 1); // Skip k-1 items (loop increments 1)
          bOffset -= k;
          matchFound = true;
          break;
        }
      }
    }

    if (matchFound) continue;

    // Fallback: UPDATE / PENDING
    // If no match found within window, assume mutation.
    if (isDiffable(value) && isDiffable(b[bIndex]) && isSameType(value, b[bIndex])) {
      const currentDiff = getChanges(value, b[bIndex]);
      if (currentDiff.length !== 0) {
        changeList.push([ChangeType.PENDING, bIndex, currentDiff]);
      }
      finalIndices++;
    } else {
      changeList.push([ChangeType.UPDATE, bIndex, b[bIndex]]);
      finalIndices++;
    }
  }

  if (finalIndices < b.length) {
    b.slice(a.length + bOffset).forEach((value, index) =>
      changeList.push([ChangeType.INSERT, finalIndices + index, value]));
  }

  return changeList;
};

const getRecordChanges = (
  a: Record<string, any>,
  b: Record<string, any>
): Change[] => {
  const changeList: Change[] = [];

  Object.entries(a).forEach(([property, value]) => {
    if (!(property in b) && !(value instanceof Function))
      changeList.push([ChangeType.DELETE, property, undefined]);
  });

  Object.entries(b).forEach(([property, value]) => {
    if (!(property in a))
      changeList.push([ChangeType.INSERT, property, value]);

    else if (isDiffable(a[property])
      && isDiffable(value)
      && isSameType(a[property], value)) {
      const d = getChanges(a[property], value);

      if (d.length !== 0)
        changeList.push([ChangeType.PENDING, property, d]);
    }

    else if (a[property] !== value)
      changeList.push([ChangeType.UPDATE, property, value]);
  });

  return changeList;
};

const hasCommonSubsequence = (a: string, b: string) => {
  const alphabetOfB = new Set(b);

  for (const c of a) {
    if (alphabetOfB.has(c)) {
      return true;
    }
  }

  return false;
};

/**
 * An adaptation of Wu et al. O(NP) text diff. (See docs/text-diff)
 *
 * Credit to [this JavaScript implementation](https://github.com/cubicdaiya/onp/blob/master/javascript/onp.js).
 *
 * @param a The old string to transform.
 * @param b The new string to transform to.
 * @param isReversed Whether or not a or b have been swapped.
 * @returns A list of changes that that turn a into b.
 */
const _diffText = (a: string, b: string, isReversed: boolean): Change[] => {
  const m = a.length, n = b.length;
  const offset = m;
  const delta = n - m;
  const size = m + n + 1;

  const frontierPoints: number[] = [];
  for (let i = 0; i < size; i++) frontierPoints[i] = -1;

  const path: number[] = [];
  for (let i = 0; i < size; i++) path[i] = -1;

  const pathPositions: { x: number, y: number, k: number }[] = [];

  const snake = (k: number, p: number, q: number) => {
    let y = Math.max(p, q);
    let x = y - k;

    while (x < m && y < n && a[x] === b[y]) {
      x++; y++;
    }

    path[k + offset] = pathPositions.length;
    pathPositions[pathPositions.length] = {
      "x": x,
      "y": y,
      "k": p > q ? path[k + offset - 1] : path[k + offset + 1],
    };

    return y;
  };

  let p = -1;
  do {
    p++;

    for (let k = -p; k < delta; k++) {
      frontierPoints[k + offset] = snake(
        k,
        frontierPoints[k + offset - 1] + 1,
        frontierPoints[k + offset + 1]
      );
    }

    for (let k = delta + p; k > delta; k--) {
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

  let k = path[delta + offset];

  const editPath: { x: number, y: number }[] = [];
  while (k !== -1) {
    editPath[editPath.length] = {
      "x": pathPositions[k].x,
      "y": pathPositions[k].y,
    };

    k = pathPositions[k].k;
  }

  const changeList: Change[] = [];
  let x = 0, y = 0, index = -1;

  for (let i = editPath.length - 1; i >= 0; i--) {
    while (x <= editPath[i].x || y <= editPath[i].y) {
      if (editPath[i].y - editPath[i].x > y - x) {
        if (isReversed) {
          changeList[changeList.length] = [
            ChangeType.DELETE,
            index,
            undefined
          ];
        }
        else {
          changeList[changeList.length] = [
            ChangeType.INSERT,
            index,
            b[y - 1]
          ];

          index++;
        }

        y++;
      }
      else if (editPath[i].y - editPath[i].x < y - x) {
        if (isReversed) {
          changeList[changeList.length] = [
            ChangeType.INSERT,
            index,
            a[x - 1]
          ];

          index++;
        }
        else {
          changeList[changeList.length] = [
            ChangeType.DELETE,
            index,
            undefined
          ];
        }

        x++;
      }
      else {
        x++; y++; index++;
      }
    }
  }

  return changeList;
};