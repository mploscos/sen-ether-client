/** Return the protocol-visible unit together with a stable display label. */
export declare function NormalizeSenUnit(unit: any): {
    name: string;
    abbreviation: string;
    category: string;
    label: any;
};
/** Format SEN unit abbreviations without changing their canonical identity. */
export declare function FormatSenUnit(value: any): any;
/** Classify primitive/numeric specs after aliases have been resolved. */
export declare function DescribeSenPrimitive(spec: any): {
    name: string;
    normalized: any;
    integer: boolean;
    numeric: boolean;
    boolean: boolean;
    string: boolean;
    largeInteger: boolean;
    timestamp: boolean;
};
/** Resolve a QuantityTypeSpec into transport-neutral metadata. */
export declare function DescribeSenQuantity(spec: any, definitions: any): {
    definition: any;
    elementType: any;
    unit: {
        name: string;
        abbreviation: string;
        category: string;
        label: any;
    };
    minValue: any;
    maxValue: any;
    integer: boolean;
} | null;
/** Resolve aliases and transparent OptionalTypeSpec wrappers for a present value. */
export declare function ResolveSenPresentValueDefinition(spec: any, definitions: any): any;
/** Resolve a nested value spec. Paths use string/number segments, not UI notation. */
export declare function ResolveSenValueSpec(spec: any, path: any, definitions: any): any;
/**
 * Walk a SEN value according to its TypeSpec. The visitor receives canonical
 * path segments so every UI can choose its own path syntax.
 */
export declare function WalkSenValue(value: any, spec: any, definitions: any, visitor: any, path?: any[], depth?: number): void;
