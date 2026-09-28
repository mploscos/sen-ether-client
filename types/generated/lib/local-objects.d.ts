/**
 * @fileoverview Type-aware construction and encoding of local Sen objects.
 *
 * Helpers in this file walk inherited class members, infer simple schemas and
 * encode full or partial state. They are transport-independent.
 */
/** Collect inherited and directly declared class properties in wire order. */
export declare function collectClassProperties(spec: any, typeRegistry: any, seen?: Set<any>): any[];
/** Collect inherited and directly declared class methods in wire order. */
export declare function collectClassMethods(spec: any, typeRegistry: any, seen?: Set<any>): any[];
/** Collect inherited and directly declared class events in wire order. */
export declare function collectClassEvents(spec: any, typeRegistry: any, seen?: Set<any>): any[];
/** Return structural hashes for every non-primitive referenced TypeSpec. */
export declare function collectTypeDependencies(spec: any, typeRegistry: any, seen?: Set<any>): Set<any>;
/** Normalize map, array or object type registries to a dense array. */
export declare function normalizeTypeDefinitions(typeDefinitions?: any[]): any[];
/** Validate and normalize one JavaScript publication descriptor. */
export declare function buildLocalObject(input: any, typeRegistry: any, options?: {}): {
    id: number;
    name: string;
    className: string;
    typeHash: number;
    spec: any;
    state: any;
    stateBuffer: Buffer<any>;
    methods: {};
    timestamp: any;
};
/** Resolve an inherited method by explicit or computed Sen member hash. */
export declare function methodById(spec: any, typeRegistry: any, methodId: any): any;
/** Return the native setter method name for a writable property. */
export declare function setterName(propertyName: any): string;
/** Resolve a writable property from its generated setter method hash. */
export declare function writablePropertySetterById(spec: any, typeRegistry: any, methodId: any): any;
/** Build the effective type registry for a local object and its bus. */
export declare function localObjectTypeRegistry(busState: any, localObject: any): Map<any, any>;
/** Encode the complete known property state of a local object. */
export declare function localObjectStateBuffer(localObject: any, registry: any, state?: any): Buffer<ArrayBuffer>;
/** Encode a validated partial property update for a local object. */
export declare function localObjectPatchBuffer(localObject: any, registry: any, patch: any): Buffer<ArrayBuffer>;
/**
 * Create a ProcessInfo compatible with sen::kernel::getOwnProcessInfo.
 *
 * @param {object} options
 * @param {string} options.sessionName
 * @param {string} [options.appName]
 * @param {string} [options.hostName]
 * @param {number} [options.hostId]
 * @param {number} [options.processId]
 */
