import * as Y from "yjs";
import { ChangeType, Change, } from "./types";
import { getChanges, } from "./diff";
import { convertValue } from "./mapping";
import { StoreApi, } from "zustand/vanilla";

/**
 * Diffs sharedType and newState to create a list of changes for transforming
 * the contents of sharedType into that of newState. For every nested, 'pending'
 * change detected, this function recurses, as a nested object or array is
 * represented as a Y.Map or Y.Array.
 *
 * @param sharedType The Yjs shared type to patch.
 * @param newState The new state to patch the shared type into.
 */
export const patchSharedType = (
  sharedType: Y.Map<any> | Y.Array<any> | Y.Text,

  newState: any,
  options?: { atomicKeys?: string[] }
): void =>
{
  const changes = getChanges(sharedType.toJSON(), newState);

  changes.forEach(([ type, property, value ]) =>
  {
    switch (type)
    {
    case ChangeType.INSERT:
    case ChangeType.UPDATE:
      if ((value instanceof Function) === false)
      {
        if (sharedType instanceof Y.Map)
        {
          sharedType.set(
            property as string,
            convertValue(property as string, value, options)
          );
        }

        else if (sharedType instanceof Y.Array)
        {
          const index = property as number;

          if (type === ChangeType.UPDATE)
            sharedType.delete(index);

          sharedType.insert(index, [ convertValue("", value, options) ]);
        }

        else if (sharedType instanceof Y.Text)
          sharedType.insert(property as number, value);
      }
      break;

    case ChangeType.DELETE:
      if (sharedType instanceof Y.Map)
        sharedType.delete(property as string);

      else if (sharedType instanceof Y.Array)
      {
        const index = property as number;
        sharedType.delete(sharedType.length <= index
          ? sharedType.length - 1
          : index);
      }

      else if (sharedType instanceof Y.Text)
        // A delete operation for text is only ever for a single character.
        sharedType.delete(property as number, 1);

      break;

    case ChangeType.PENDING:
      if (sharedType instanceof Y.Map)
      {
        patchSharedType(
          sharedType.get(property as string),
          newState[property as string],
          options
        );
      }
      else if (sharedType instanceof Y.Array)
      {
        patchSharedType(
          sharedType.get(property as number),
          newState[property as number],
          options
        );
      }
      break;

    default:
      break;
    }
  });
};

/**
 * Patches oldState to be identical to newState. This function recurses when
 * an array or object is encountered. If oldState and newState are already
 * identical (indicated by an empty diff), then oldState is returned.
 *
 * @param oldState The state we want to patch.
 * @param newState The state we want oldState to match after patching.
 *
 * @returns The patched oldState, identical to newState.
 */

export const patchState = (oldState: any, newState: any): any =>
{
  const changes = getChanges(oldState, newState);

  const applyChanges = (
    state: (string | any[] | Record<string, any>),
    changes: Change[]
  ): any =>
  {
    if (typeof state === "string")
      return applyChangesToString(state as string, changes);
    else if (Array.isArray(state))
      return applyChangesToArray(state as any[], changes);
    else if (typeof state === "object" && state !== null)
      return applyChangesToObject(state as Record<string, any>, changes);
  };

  const applyChangesToArray = (array: any[], changes: Change[]): any =>
  {
    const revisedArray = [ ...array ];
    const deletes = changes
      .filter(([ type ]) =>
        type === ChangeType.DELETE)
      .sort(([ , indexA ], [ , indexB ]) =>
        Math.sign((indexB as number) - (indexA as number))); // Descending

    const others = changes
      .filter(([ type ]) =>
        type !== ChangeType.DELETE)
      .sort(([ , indexA ], [ , indexB ]) =>
        Math.sign((indexA as number) - (indexB as number))); // Ascending

    deletes.forEach(([ , index ]) =>
    {
      revisedArray.splice(index as number, 1);
    });

    return others.reduce(
      (currentArray, [ type, index, value ]) =>
      {
        switch (type)
        {
        case ChangeType.INSERT:
        {
          currentArray.splice(index as number, 0, value);
          return currentArray;
        }

        case ChangeType.UPDATE:
        {
          currentArray[index as number] = value;
          return currentArray;
        }

        case ChangeType.PENDING:
        {
          currentArray[index as number] =
            applyChanges(currentArray[index as number], value);
          return currentArray;
        }

        case ChangeType.NONE:
        default:
          return currentArray;
        }
      },
      revisedArray
    );
  };

  const applyChangesToObject = (
    object: Record<string, any>,
    changes: Change[]
  ): any =>
    changes
      .reduce(
        (revisedObject, [ type, property, value ]) =>
        {
          switch (type)
          {
          case ChangeType.INSERT:
          case ChangeType.UPDATE:
          {
            revisedObject[property] = value;
            return revisedObject;
          }

          case ChangeType.PENDING:
          {
            revisedObject[property] = applyChanges(object[property], value);
            return revisedObject;
          }

          case ChangeType.DELETE:
          {
            delete revisedObject[property];
            return revisedObject;
          }

          case ChangeType.NONE:
          default:
            return revisedObject;
          }
        },
        { ...object, }
      );

  const applyChangesToString = (string: string, changes: Change[]): any =>
    changes
      .reduce(
        (revisedString, [ type, index, value ]) =>
        {
          switch (type)
          {
          case ChangeType.INSERT:
          {
            const left = revisedString.slice(0, index as number);
            const right = revisedString.slice(index as number);
            return left + value + right;
          }

          case ChangeType.DELETE:
          {
            const left = revisedString.slice(0, index as number);
            const right = revisedString.slice((index as number) + 1);
            return left + right;
          }

          default:
          {
            return revisedString;
          }
          }
        },
        string
      );

  if (changes.length === 0)
    return oldState;

  else
    return applyChanges(oldState, changes);
};


/**
 * Diffs the current state stored in the Zustand store and the given newState.
 * The current Zustand state is patched into the given new state recursively.
 *
 * @param store The Zustand API that manages the store we want to patch.
 * @param newState The new state that the Zustand store should be patched to.
 */
export const patchStore = <S>(
  store: StoreApi<S>,

  newState: any
): void =>
{
  // Clone the oldState instead of using it directly from store.getState().
  const oldState = {
    ...(store.getState() as Record<string, unknown>),
  };

  store.setState(
    patchState(oldState, newState),
    true // Replace with the patched state.
  );
};