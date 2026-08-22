import * as yjs from "yjs";

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
    if (typeof value === "string") {
      mappedArray.push(options.disableYText ? value : stringToYText(value));
    } else if (Array.isArray(value)) {
      mappedArray.push(arrayToYArray(value, options));
    } else if (isObject(value)) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      mappedArray.push(objectToYMap(value, options));
    } else {
      mappedArray.push(value);
    }
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
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      typeof value === "function"
    ) {
      continue;
    }
    if (typeof value === "string") {
      const isWantsYText = options.disableYText
        ? options.yTextKeys.includes(key)
        : !options.atomicKeys.includes(key);

      if (isWantsYText) {
        ymap.set(key, stringToYText(value));
      } else {
        ymap.set(key, value);
      }
    } else if (Array.isArray(value)) {
      ymap.set(key, arrayToYArray(value, options));
    } else if (isObject(value)) {
      ymap.set(key, objectToYMap(value, options));
    } else {
      ymap.set(key, value);
    }
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
