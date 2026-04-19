/**
 * Represents the types of changes that can be made to a piece of data.
 */
export const changeType = {
  none: "none",
  insert: "insert",
  update: "update",
  delete: "delete",
  pending: "pending",
} as const;

/**
 * The literal values of the change types.
 */
export type ChangeType = (typeof changeType)[keyof typeof changeType];

/**
 * Represents a single change made to a piece of data.
 *
 * A change is a tuple containing:
 * 1. The type of change (ChangeType).
 * 2. The property name or index where the change occurred.
 * 3. The new value at that property (if applicable).
 */
export type Change = [
  type: ChangeType,
  property: string | number,
  value: unknown,
];