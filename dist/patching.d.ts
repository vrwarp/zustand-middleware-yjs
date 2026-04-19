import * as yjs from "yjs";
import type { StoreApi } from "zustand/vanilla";
import { type MappingOptions } from "./mapping";
export interface PatchOptions extends MappingOptions {
    previousState?: unknown;
}
export declare const patchSharedType: (sharedType: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text, newState: unknown, { atomicKeys, disableYText, previousState, yTextKeys, }?: PatchOptions) => void;
export declare const patchState: <T>(oldState: T, newState: T) => T;
export declare const patchStore: <S>(store: StoreApi<S>, newState: unknown) => void;
