import * as yjs from "yjs";
import type { StateCreator, StoreMutatorIdentifier } from "zustand";
export declare const __scopedDiffDevSampling: {
    rate: number;
};
type Yjs = <T, Mps extends [StoreMutatorIdentifier, unknown][] = [], Mcs extends [StoreMutatorIdentifier, unknown][] = []>(doc: yjs.Doc, name: string, f: StateCreator<T, Mps, Mcs>, options?: YjsOptions) => StateCreator<T, Mps, Mcs>;
export interface YjsOptions {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
    onLoaded?: () => void;
    schemaVersion?: number;
    onObsolete?: (incomingVersion: number) => void;
    syncedKeys?: readonly string[];
    hydration?: "replace" | "merge-defaults";
    scopedDiff?: boolean;
    scope?: {
        key: string;
    };
}
export interface YjsStoreHandle {
    hasHydrated: () => boolean;
    whenHydrated: () => Promise<void>;
    markHydrated: () => void;
    flush: () => void;
    isObsolete: () => boolean;
}
export declare const getYjsStoreHandle: (store: unknown) => YjsStoreHandle;
declare const _default: Yjs;
export default _default;
