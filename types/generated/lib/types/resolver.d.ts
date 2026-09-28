export { SenTypeCatalog } from './catalog.js';
export declare const SenTypeCode: Readonly<{
    enum: 0;
    quantity: 1;
    sequence: 2;
    struct: 3;
    variant: 4;
    alias: 5;
    optional: 6;
    class: 7;
}>;
export declare const SenTypeKindByCode: Readonly<{
    [k: string]: string;
}>;
export declare const SenTypeCodeByKind: Readonly<{
    enum: 0;
    quantity: 1;
    sequence: 2;
    struct: 3;
    variant: 4;
    alias: 5;
    optional: 6;
    class: 7;
}>;
export declare function GetSenTypeCode(definition: any): any;
export declare function GetSenTypeKind(definition: any): string | null;
export declare function GetSenTypeValue(definition: any): any;
export declare function NormalizeSenTypeName(value: any): string;
export declare function GetSenTypeNameFromSpec(spec: any): string;
export declare class SenTypeResolver {
    typeDefinitions: Function;
    /** @param {Map<string, any> | Record<string, any> | (() => Map<string, any> | Record<string, any>)} definitions */
    constructor(definitions: Map<string, any> | Record<string, any> | (() => Map<string, any> | Record<string, any>));
    resolveTypeDefinition(typeName: any, options?: {}): any;
    /**
     * Resolve a member spec or type reference and follow every alias.
     * Unknown primitive and external references remain explicit `{ type }` specs.
     */
    resolveValueDefinition(spec: any): any;
    /** Resolve alias chains and reject cycles. */
    unwrapTypeDefinition(definition: any): any;
    optionalValueDefinition(definition: any): {
        typeName: string;
        definition: {
            type: string;
        };
    } | null;
    isArrayDefinition(definition: any): boolean;
    arrayItemDefinition(definition: any): any;
    isQuantityDefinition(definition: any): boolean;
    variantDefinition(definition: any): {
        options: any;
    } | null;
    typeFields(definition: any): any[];
    enumOptions(definition: any): any;
    classLineage(typeName: any): any[];
    classMembers(typeName: any, member: any): any[];
    typeDefinitionKey(args: any): any;
}
