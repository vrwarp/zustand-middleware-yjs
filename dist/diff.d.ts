import { type Change } from "./types";
export type Diffable = string | unknown[] | Record<string, unknown>;
export declare const getChanges: (a: Diffable, b: Diffable) => Change[];
