export declare function decodeValueFromReader(reader: any, typeName: any, typeRegistry: any): any;
export declare function encodeValueToWriter(writer: any, value: any, typeName: any, typeRegistry: any): void;
export declare function encodeValue(value: any, typeName: any, typeRegistry: any): Buffer<ArrayBuffer>;
export declare function encodePropertyUpdateBuffer(updates: any[] | undefined, typeRegistry: any): Buffer<ArrayBuffer>;
export declare function encodeArguments(values: any, argSpecs: any[] | undefined, typeRegistry: any): Buffer<ArrayBuffer>;
export declare function decodeArguments(buffer: any, argSpecs: any[] | undefined, typeRegistry: any, options?: {}): any[];
export declare function decodeValue(buffer: any, typeName: any, typeRegistry: any, options?: {}): any;
export declare function decodePropertyValues(buffer: any, classSpec: any, typeRegistry: any, options?: {}): ({
    id: number;
    size: number;
    name: undefined;
    type: undefined;
    value: undefined;
    decoded: boolean;
} | {
    id: number;
    size: number;
    name: any;
    type: any;
    property: any;
    value: any;
    decoded: boolean;
} | {
    id: number;
    size: number;
    name: any;
    type: any;
    property: any;
    value: undefined;
    error: unknown;
    decoded: boolean;
})[];
