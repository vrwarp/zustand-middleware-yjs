import * as yjs from "yjs";
import { type Change, changeType } from "./types";

/**
 * Options for mapping values to Yjs types.
 */
export interface MappingOptions {
  /** Keys that should be stored as primitive strings instead of Y.Text. */
  atomicKeys?: string[];
  /** If true, all strings are stored as primitive strings. */
  disableYText?: boolean;
  /** Keys that should be stored as Y.Text even if disableYText is true. */
  yTextKeys?: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof yjs.AbstractType) &&
    !(value instanceof yjs.Doc)
  );
};

/**
 * Converts a string to a Y.Text object.
 *
 * @param value - The string to convert.
 * @returns A Y.Text object representing the string.
 */
export const stringToYText = (value: string): yjs.Text => new yjs.Text(value);

/**
 * Converts a value to a Yjs shared type based on the mapping options.
 *
 * @param value - The value to convert.
 * @param options - The mapping options.
 * @param convertOptions - Additional options for conversion.
 * @param convertOptions.key - The key associated with the value, if applicable.
 * @returns The converted value, which may be a Yjs shared type or a primitive.
 */
export const convertValue = (
  value: unknown,
  options: MappingOptions,
  { key }: { key?: string } = {}
): unknown => {
  if (typeof value === "string") {
    const isWantsYText = options.disableYText
      ? (key !== undefined && options.yTextKeys?.includes(key))
      : (key === undefined || !options.atomicKeys?.includes(key));

    return isWantsYText ? stringToYText(value) : value;
  }

  if (Array.isArray(value)) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return arrayToYArray(value, options);
  }

  if (isObject(value)) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return objectToYMap(value, options);
  }

  return value;
};

/**
 * Converts an array to a Y.Array object.
 *
 * @param array - The array to convert.
 * @param mappingOptions - The mapping options.
 * @returns A Y.Array object representing the array.
 */
export const arrayToYArray = (
  array: unknown[],
  {
    atomicKeys = [],
    disableYText = false,
    yTextKeys = [],
  }: MappingOptions = {}
): yjs.Array<unknown> => {
  const options = { atomicKeys, disableYText, yTextKeys };
  const yarray = new yjs.Array<unknown>();
  const mappedArray: unknown[] = [];

  for (const value of array) {
    if (typeof value === "function") {
      continue;
    }

    mappedArray.push(convertValue(value, options));
  }

  yarray.insert(0, mappedArray);

  return yarray;
};

/**
 * Converts a YArray to a normal JavaScript array.
 *
 * @param yarray - The YArray to convert.
 * @returns A plain JavaScript array.
 */
export const yArrayToArray = (yarray: yjs.Array<unknown>): unknown[] => {
  return yarray.toJSON() as unknown[];
};

/**
 * Converts an object to a Y.Map object.
 *
 * @param object - The object to convert.
 * @param mappingOptions - The mapping options.
 * @returns A Y.Map object representing the object.
 */
export const objectToYMap = (
  object: Record<string, unknown>,
  {
    atomicKeys = [],
    disableYText = false,
    yTextKeys = [],
  }: MappingOptions = {}
): yjs.Map<unknown> => {
  const options = { atomicKeys, disableYText, yTextKeys };
  const ymap = new yjs.Map<unknown>();

  for (const [key, value] of Object.entries(object)) {
    if (typeof value === "function") {
      continue;
    }

    ymap.set(key, convertValue(value, options, { key }));
  }

  return ymap;
};

/**
 * Converts a YMap to a normal JavaScript object.
 *
 * @param ymap - The YMap to convert.
 * @returns A plain JavaScript object.
 */
export const yMapToObject = (ymap: yjs.Map<unknown>): Record<string, unknown> => {
  return ymap.toJSON() as Record<string, unknown>;
};

/**
 * Converts a Yjs shared type to its JSON representation as a list of changes.
 *
 * @param ytype - The Yjs shared type to convert.
 * @returns A list of changes representing the Yjs shared type's contents.
 */
export const yTypeToChanges = (
  ytype: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text
): Change[] => {
  if (ytype instanceof yjs.Text) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return [[changeType.insert, 0, ytype.toString()]];
  }

  if (ytype instanceof yjs.Array) {
    return ytype.map((value, index) => {
      if (
        value instanceof yjs.Map ||
        value instanceof yjs.Array ||
        value instanceof yjs.Text
      ) {
        return [changeType.pending, index, yTypeToChanges(value)];
      }

      return [changeType.insert, index, value];
    });
  }

  const entries = Object.entries(ytype.toJSON() as Record<string, unknown>);

  return entries.map(([key, value]) => {
    const yValue = ytype.get(key);

    if (
      yValue instanceof yjs.Map ||
      yValue instanceof yjs.Array ||
      yValue instanceof yjs.Text
    ) {
      return [changeType.pending, key, yTypeToChanges(yValue)];
    }

    return [changeType.insert, key, value];
  });
};