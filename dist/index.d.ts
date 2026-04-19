import type * as yjs from "yjs";
import type { StateCreator, StoreMutatorIdentifier } from "zustand";
type Yjs = <T, Mps extends [StoreMutatorIdentifier, unknown][] = [], Mcs extends [StoreMutatorIdentifier, unknown][] = []>(doc: yjs.Doc, name: string, f: StateCreator<T, Mps, Mcs>, options?: YjsOptions) => StateCreator<T, Mps, Mcs>;
export interface YjsOptions {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
    onLoaded?: () => void;
    schemaVersion?: number;
    onObsolete?: (incomingVersion: number) => void;
}
declare const _default: Yjs;
export default _default;
