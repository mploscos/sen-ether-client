/**
 * @fileoverview Shared identity, TypeSpec and value helpers for remote objects.
 *
 * The functions are free of transport state so `SenBus`, `SenInterest` and
 * `SenRemoteObject` can stay small without duplicating ownership rules.
 */
export declare const STATE_RESYNC_DELAYS_MS: number[];
export declare const STATE_RESYNC_INTERVAL_MS = 1000;
export declare const RUNTIME_EVENT_DEDUPE_LIMIT = 2048;
/** Compare decoded Sen values, treating numeric `-0` and `0` as equal. */
export declare function senValuesEqual(left: any, right: any): boolean;
/** Look up a TypeSpec in map-like or record-like registries. */
export declare function findTypeSpec(typeRegistry: any, typeName: any): any;
/** Merge base and per-operation types with later qualified names winning. */
export declare function mergedTypeDefinitions(base: any, override: any): Map<any, any> | undefined;
/** Collect inherited class members of the requested member collection. */
export declare function collectClassMembers(spec: any, typeRegistry: any, member: any, seen?: Set<any>): any[];
/** Traverse structural references and return every required non-primitive name. */
export declare function collectReferencedTypeNames(typeNames: any, typeRegistry: any): Set<any>;
/** Find a named protocol member in a flat collection. */
export declare function findByName(items: any, name: any): any;
/** Return the native setter method name for a writable property. */
export declare function setterName(propertyName: any): string;
/** Render an object selector for diagnostics without executing predicates. */
export declare function selectorDescription(selector: any): string;
/** Normalize a comma-separated or array property filter to a set. */
export declare function normalizePropertyNames(properties: any): Set<string> | undefined;
/** Normalize an optional nanosecond timestamp to `bigint`. */
export declare function normalizeTimestampNs(value: any): bigint | undefined;
/** Build the pending-state key scoped by interest, owner and object. */
export declare function stateRequestKey(interestId: any, ownerId: any, objectId: any): string;
/** Build remote object identity from owner and ObjectId. */
export declare function remoteObjectKey(ownerId: any, objectId: any): string;
/** Resolve the provider identity carried by validated bus event metadata. */
export declare function eventOwnerId(event: any): any;
/** Build a stable deduplication key when an event has a creation timestamp. */
export declare function runtimeEventDedupeKey(ownerId: any, item: any): string | undefined;
