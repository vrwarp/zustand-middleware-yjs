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
  /**
   * Keys whose arrays store their object and array elements as plain JSON
   * values (toJsonElement) instead of nested Y.Maps / Y.Arrays.
   */
  jsonElementKeys?: string[];
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
 * The elements of an array as its Y.Array stores them: function elements are
 * dropped and `undefined` (including a hole in a sparse array) becomes `null`,
 * as in JSON — Y.Array.insert throws on `undefined`. The differ diffs against
 * this form, so change indices address it. Returns `array` itself when it
 * holds neither (the common case).
 *
 * @param array - The array to normalize.
 * @returns The elements as stored in a Y.Array.
 */
export const toYArrayElements = (array: unknown[]): unknown[] => {
  /*
   * An indexed loop: unlike some/filter it also visits holes (as undefined),
   * and it allocates nothing for a JSON-clean array (the differ calls this
   * for every array it diffs).
   */
  for (let index = 0; index < array.length; index = index + 1) {
    const value = array[index];

    if (value === undefined || typeof value === "function") {
      return Array.from(array, (element) => element ?? null)
        .filter((element) => typeof element !== "function");
    }
  }

  return array;
};

/**
 * The plain JSON form of a `jsonElementKeys` array element: exactly what
 * objectToYMap (or arrayToYArray) followed by toJSON() would read back, but
 * built without shared types. Own enumerable entries only; function values
 * and the keys "__proto__", "constructor" and "prototype" are skipped;
 * nested arrays are normalized like toYArrayElements; class instances (Date,
 * Uint8Array, ...) become records of their own entries; every other value is
 * kept as is, including undefined, NaN, Infinity and -0 (lib0 encodes all of
 * them).
 *
 * Storing exactly this form keeps an element diff-equal to the state it came
 * from (so an unchanged element is never rewritten), lets it round-trip
 * lib0's encoding unchanged (so the local doc holds what peers decode), and
 * shares no object with store state (so mutating state never mutates the
 * doc's content behind Yjs' back).
 *
 * @param value - The element to convert.
 * @returns A fresh plain JSON copy (or the primitive itself).
 */
export const toJsonElement = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return toYArrayElements(value).map((element) => toJsonElement(element));
  }
  if (!isObject(value)) {
    return value;
  }

  const json: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(value)) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      typeof field === "function"
    ) {
      continue;
    }
    json[key] = toJsonElement(field);
  }

  return json;
};

/**
 * Where a value is going to be stored.
 */
export interface ArrayPlacement {
  /** The Y.Map key it is stored under; none for an element of an array. */
  key?: string;
}

/**
 * Converts an array to a Y.Array object.
 *
 * @param array - The array to convert.
 * @param mappingOptions - The mapping options, plus the key the array is
 * stored under: under a `jsonElementKeys` key, its object and array elements
 * are stored as plain JSON (toJsonElement) instead of nested shared types.
 * @returns A Y.Array object representing the array.
 */
export const arrayToYArray = (
  array: unknown[],
  {
    atomicKeys = [],
    disableYText = false,
    yTextKeys = [],
    jsonElementKeys = [],
    key,
  }: MappingOptions & ArrayPlacement = {}
): yjs.Array<unknown> => {
  const options = { atomicKeys, disableYText, yTextKeys, jsonElementKeys };
  const isJsonElements = key !== undefined && jsonElementKeys.includes(key);
  const yarray = new yjs.Array<unknown>();
  const mappedArray: unknown[] = [];

  for (const value of toYArrayElements(array)) {
    if (typeof value === "string") {
      mappedArray.push(options.disableYText ? value : stringToYText(value));
    } else if (isJsonElements && (Array.isArray(value) || isObject(value))) {
      mappedArray.push(toJsonElement(value));
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
    jsonElementKeys = [],
  }: MappingOptions = {}
): yjs.Map<unknown> => {
  const options = { atomicKeys, disableYText, yTextKeys, jsonElementKeys };
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
      ymap.set(key, arrayToYArray(value, { ...options, key }));
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
