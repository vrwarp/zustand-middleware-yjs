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
}

/**
 * Diffs sharedType and newState to create a list of changes for transforming
 * the contents of sharedType into that of newState. For every nested, 'pending'
 * change detected, this function recurses, as a nested object or array is
 * represented as a Y.Map or Y.Array.
 *
 * @param sharedType - The Yjs shared type to patch.
 * @param newState - The new state to patch the shared type into.
 * @param patchOptions - The patch options.
 */
export const patchSharedType = (
  sharedType: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
  newState: unknown,
  {
    atomicKeys = [],
    disableYText = false,
    previousState,
    yTextKeys = [],
  }: PatchOptions = {}
): void => {
  const options = { atomicKeys, disableYText, previousState, yTextKeys };
  const sharedTypeJson = typeof (sharedType as yjs.Map<unknown>).toJSON === "function"
    ? (sharedType as yjs.Map<unknown>).toJSON()
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    : (sharedType as yjs.Text).toString();

  const changes = getChanges(sharedTypeJson as string | unknown[] | Record<string, unknown>, newState as string | unknown[] | Record<string, unknown>);

  for (const [type, property, value] of changes) {
    switch (type) {
      case changeType.insert:
      case changeType.update: {
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
        const prev = options.previousState;

        if (prev && typeof prev === "object" && !(property as string in (prev as Record<string, unknown>))) {
          continue;
        }

        if (sharedType instanceof yjs.Map) {
          sharedType.delete(property as string);
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
              patchSharedType(
                existing as yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text,
                newValue,
                { ...options, previousState: childPreviousState }
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
                { ...options, previousState: childPreviousState }
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
 * Patches oldState to be identical to newState. This function recurses when
 * an array or object is encountered. If oldState and newState are already
 * identical (indicated by an empty diff), then oldState is returned.
 *
 * @param oldState - The state we want to patch.
 * @param newState - The state we want oldState to match after patching.
 * @returns The patched oldState, identical to newState.
 */
export const patchState = <T>(oldState: T, newState: T): T => {
  const changes = getChanges(oldState as string | unknown[] | Record<string, unknown>, newState as string | unknown[] | Record<string, unknown>);

  if (changes.length === 0) {
    return oldState;
  }

  return applyChanges(oldState as string | unknown[] | Record<string, unknown>, changes) as T;
};

/**
 * Diffs the current state stored in the Zustand store and the given newState.
 * The current Zustand state is patched into the given new state recursively.
 *
 * @param store - The Zustand API that manages the store we want to patch.
 * @param newState - The new state that the Zustand store should be patched to.
 */
export const patchStore = <S>(
  store: StoreApi<S>,
  newState: unknown
): void => {
  // Clone the oldState instead of using it directly from store.getState().
  const oldState = {
    ...(store.getState() as Record<string, unknown>),
  };

  store.setState(
    patchState(oldState, newState) as S,
    true // Replace with the patched state.
  );
};