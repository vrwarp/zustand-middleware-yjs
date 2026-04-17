import * as Y from "yjs";
export declare const arrayToYArray: (array: any[], options?: {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
}) => Y.Array<any>;
export declare const yArrayToArray: (yarray: Y.Array<any>) => any[];
export declare const objectToYMap: (object: Record<string, any>, options?: {
    atomicKeys?: string[];
    disableYText?: boolean;
    yTextKeys?: string[];
}) => Y.Map<any>;
export declare const yMapToObject: (ymap: Y.Map<any>) => any;
export declare const yTextToString: (ytext: Y.Text) => string;
export declare const stringToYText: (string: string) => Y.Text;
