import * as Y from "yjs";
import { StoreApi } from "zustand/vanilla";
export declare const patchSharedType: (sharedType: Y.Map<any> | Y.Array<any> | Y.Text, newState: any, options?: {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
    previousState?: any;
}) => void;
export declare const patchState: (oldState: any, newState: any) => any;
export declare const patchStore: <S>(store: StoreApi<S>, newState: any) => void;
