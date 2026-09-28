/**
 * @fileoverview STL import resolution and adaptation to Sen TypeSpecs.
 *
 * Sources are supplied by callers, which keeps this module synchronous and
 * independent of the filesystem. Parsed declarations are resolved once into a
 * reusable immutable registry.
 */
export declare class StlResolutionError extends Error {
    location: any;
    constructor(message: any, node: any);
}
/** A resolved, immutable STL type registry. */
export declare class StlTypeRegistry {
    typeByName: Map<any, any>;
    files: Map<any, any>;
    constructor(typeByName: any, files: any);
    get(name: any): any;
    has(name: any): boolean;
    values(): MapIterator<any>;
    /** Converts all resolved custom types to sen-ether-client CustomTypeSpecs. */
    toTypeSpecs(options?: {}): Map<any, any>;
}
/**
 * Resolves an STL source graph once. `sources` is a record or Map keyed by the
 * exact entry/import string; `load(name)` is an optional synchronous fallback.
 */
export declare function resolveStl(entry: any, options?: {}): StlTypeRegistry;
