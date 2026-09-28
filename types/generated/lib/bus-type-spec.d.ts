/**
 * @fileoverview Binary reader/writer functions for Sen TypeSpec structures.
 *
 * These functions translate only the schema portion of the kernel protocol;
 * they do not own sockets, routing state or decoded runtime object values.
 */
/** Resolve a numeric enum key or reject an unknown wire value. */
export declare function enumName(values: any, code: any, label: any): any;
/** Normalize a required protocol identifier to an unsigned 32-bit value. */
export declare function requiredUInt32(value: any, label: any): number;
/** Resolve the generated kernel control name for a numeric message key. */
export declare function kernelControlTypeFromKey(key: any): string | undefined;
/** Read a bounded Sen sequence with the supplied item decoder. */
export declare function readSequence(reader: any, readItem: any): any[];
/** Read a bounded sequence of unsigned 32-bit integers. */
export declare function readU32List(reader: any): any[];
/** Write a sequence of unsigned 32-bit integers. */
export declare function writeU32List(writer: any, values?: any[]): void;
/** Write a length-prefixed sequence with the supplied item encoder. */
export declare function writeSequence(writer: any, values: any[] | undefined, writeItem: any): void;
/** Write a length-prefixed sequence of UTF-8 strings. */
export declare function writeStringList(writer: any, values?: any[]): void;
/** Read a bounded length-prefixed sequence of UTF-8 strings. */
export declare function readStringList(reader: any): any[];
/** Decode one class or non-class TypeSpec response. */
export declare function readTypeSpecResponse(reader: any): {
    type: any;
    classHash: any;
    spec: {
        name: any;
        qualifiedName: any;
        description: any;
        data: {
            type: any;
            value: {
                enums: any[];
                storageType: any;
            } | {
                elementType: {
                    type: string;
                    value: any;
                };
                unit: {
                    name: any;
                    abbreviation: any;
                    category: any;
                };
                minValue: any;
                maxValue: any;
            } | {
                elementType: any;
                maxSize: any;
                fixedSize: any;
            } | {
                fields: any[];
            } | {
                aliasedType: any;
            } | {
                type: any;
            } | {
                properties: any[];
                methods: any[];
                events: any[];
                constructor: {
                    id: number;
                    name: any;
                    description: any;
                    args: any[];
                    transportMode: any;
                    constness: any;
                    deferred: any;
                    returnType: any;
                    propertyRelation: any;
                    localOnly: any;
                };
                parents: any[];
                isInterface: any;
            };
        };
    };
    dependentTypes: any[];
} | {
    classHash?: undefined;
    dependentTypes?: undefined;
    type: any;
    spec: {
        name: any;
        qualifiedName: any;
        description: any;
        data: {
            type: any;
            value: {
                enums: any[];
                storageType: any;
            } | {
                elementType: {
                    type: string;
                    value: any;
                };
                unit: {
                    name: any;
                    abbreviation: any;
                    category: any;
                };
                minValue: any;
                maxValue: any;
            } | {
                elementType: any;
                maxSize: any;
                fixedSize: any;
            } | {
                fields: any[];
            } | {
                aliasedType: any;
            } | {
                type: any;
            } | {
                properties: any[];
                methods: any[];
                events: any[];
                constructor: {
                    id: number;
                    name: any;
                    description: any;
                    args: any[];
                    transportMode: any;
                    constness: any;
                    deferred: any;
                    returnType: any;
                    propertyRelation: any;
                    localOnly: any;
                };
                parents: any[];
                isInterface: any;
            };
        };
    };
};
/** Encode one class or non-class TypeSpec response. */
export declare function writeTypeSpecResponse(writer: any, item?: {}): void;
