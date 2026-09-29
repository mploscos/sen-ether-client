/**
 * @fileoverview High-level state machine for one joined Sen bus.
 *
 * `SenBus` associates interests, owner-scoped objects, TypeSpecs, state
 * requests and method calls. It consumes validated events from `EtherClient`.
 */
import { EventEmitter } from 'node:events';
import { SenInterest } from './sen-interest.js';
import { SenRemoteObject } from './sen-remote-object.js';
/** Owns high-level objects and interests for one native bus participant. */
export declare class SenBus extends EventEmitter {
    #private;
    sen: import("./sen.js").Sen;
    name: string;
    id: number;
    objectsById: Map<any, any>;
    typeRegistry: Map<any, any>;
    typeRegistryByHash: Map<any, any>;
    requestedTypeHashes: Set<any>;
    stateRequestedObjectIds: Set<any>;
    stateResyncTimers: Set<any>;
    stateResyncInterval: NodeJS.Timeout | undefined;
    interests: Map<any, any>;
    pendingCalls: Map<any, any>;
    nextTicketId: number;
    reconnectPrepared: boolean;
    seenRuntimeEvents: Map<any, any>;
    /**
     * Create high-level state for a joined native bus.
     * @param {import('./sen.js').Sen} sen
     * @param {string} name
     * @param {number} id
     */
    constructor(sen: import('./sen.js').Sen, name: string, id: number);
    /**
     * Start and register a high-level interest.
     * @param {string} query
     * @param {import('../index.js').SenInterestOptions} [options]
     * @returns {SenInterest}
     */
    startInterest(query: string, options?: import('../index.js').SenInterestOptions): SenInterest;
    /**
     * Stop an interest and detach every object visible only through it.
     * @param {number|SenInterest} id
     */
    stopInterest(id: number | SenInterest): void;
    /** Close all interests and leave the native bus. */
    close(): void;
    /** Mark remote state stale and clear connection-bound pending work. */
    prepareReconnect(): void;
    /**
     * Rejoin the bus and restart existing interests after transport recovery.
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    rejoin(timeoutMs: number): Promise<void>;
    /** @returns {SenRemoteObject[]} Current owner-scoped remote objects. */
    objects(): SenRemoteObject[];
    /**
     * Find the first remote object matching a public selector.
     * @param {import('../index.js').SenObjectSelector} selector
     * @returns {SenRemoteObject|undefined}
     */
    getObject(selector: import('../index.js').SenObjectSelector): SenRemoteObject | undefined;
    /** Apply a validated remote publication announcement. */
    handleObjectsPublished(event: any): void;
    /** Remove objects withdrawn for one or more interests. */
    handleObjectsRemoved(event: any): void;
    /** Remove every object owned by a participant that left the bus. */
    handleParticipantLeft(event: any): void;
    /** Cache TypeSpecs and resume objects waiting for their schema. */
    handleTypesInfoResponse(event: any): void;
    /** Apply validated full-state responses to their matching interest. */
    handleObjectsStateResponse(event: any): void;
    /** Apply a runtime property update to an unambiguous remote object. */
    handleRuntimeObjectUpdate(event: any): void;
    /** Deduplicate and dispatch runtime events to their producer object. */
    handleRuntimeEvents(event: any): void;
    /** Resolve or reject the pending call identified by a response ticket. */
    handleRuntimeMethodResponse(event: any): void;
    /**
     * Wait until all structural TypeSpecs needed by a method are available.
     * @param {Iterable<string>} typeNames
     * @param {{timeout?:number}} [options]
     * @returns {Promise<void>}
     */
    waitForReferencedTypes(typeNames: Iterable<string>, options?: {
        timeout?: number;
    }): Promise<void>;
    /** Encode and send one remote method call with a bounded pending ticket. */
    callObjectMethod(object: any, method: any, args: any, options?: {}): Promise<any>;
    /**
     * Reject and remove matching method calls still waiting for a response.
     * @param {Error} error
     * @param {(pending:object) => boolean} [predicate]
     */
    rejectPendingCalls(error: Error, predicate?: (pending: object) => boolean): void;
}
