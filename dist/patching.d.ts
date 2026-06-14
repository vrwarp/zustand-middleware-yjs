import * as yjs from "yjs";
import type { StoreApi } from "zustand/vanilla";
import { type MappingOptions } from "./mapping";
export interface PatchOptions extends MappingOptions {
    previousState?: unknown;
    syncedKeys?: ReadonlySet<string>;
}
export declare const patchSharedType: (sharedType: yjs.Map<unknown> | yjs.Array<unknown> | yjs.Text, newState: unknown, { atomicKeys, disableYText, previousState, yTextKeys, syncedKeys, }?: PatchOptions) => void;
export declare const patchSharedTypeScoped: (sharedType: yjs.Map<unknown>, newState: unknown, previousState: unknown, { atomicKeys, disableYText, yTextKeys, syncedKeys, }?: PatchOptions) => void;
export interface ScopedDiffConvergenceOptions {
    syncedKeys?: ReadonlySet<string>;
}
export declare const assertScopedDiffConvergence: (sharedType: yjs.Map<unknown>, state: unknown, { syncedKeys }?: ScopedDiffConvergenceOptions) => void;
export interface PatchStateOptions {
    suppressTopLevelDeleteKeys?: ReadonlySet<string>;
}
export declare const patchState: <T>(oldState: T, newState: T, { suppressTopLevelDeleteKeys }?: PatchStateOptions) => T;
export interface InboundStateOptions {
    syncedKeys?: ReadonlySet<string>;
    suppressTopLevelDeleteKeys?: ReadonlySet<string>;
}
export declare const computeInboundState: <T>(currentState: T, newState: unknown, { syncedKeys, suppressTopLevelDeleteKeys }?: InboundStateOptions) => T;
export declare const patchStore: <S>(store: StoreApi<S>, newState: unknown, { syncedKeys, suppressTopLevelDeleteKeys }?: InboundStateOptions) => void;
