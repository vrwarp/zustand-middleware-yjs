export declare const changeType: {
    readonly none: "none";
    readonly insert: "insert";
    readonly update: "update";
    readonly delete: "delete";
    readonly pending: "pending";
};
export type ChangeType = (typeof changeType)[keyof typeof changeType];
export type Change = [
    type: ChangeType,
    property: string | number,
    value: unknown
];
