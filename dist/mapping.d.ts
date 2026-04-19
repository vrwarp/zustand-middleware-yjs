import * as yjs from "yjs";
import { type Change } from "./types";
export interface MappingOptions {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
}
export declare const stringToYText: (value: string) => yjs.Text;
export declare const yTextToString: (ytext: yjs.Text) => string;
export declare const arrayToYArray: (array: unknown[], { atomicKeys, disableYText, yTextKeys, }?: MappingOptions) => yjs.Array<unknown>;
export declare const yArrayToArray: (yarray: yjs.Array<unknown>) => unknown[];
export declare const objectToYMap: (object: Record<string, unknown>, { atomicKeys, disableYText, yTextKeys, }?: MappingOptions) => yjs.Map<unknown>;
export declare const yMapToObject: (ymap: yjs.Map<unknown>) => Record<string, unknown>;
export declare const yTypeToChanges: (ytype: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text) => Change[];
