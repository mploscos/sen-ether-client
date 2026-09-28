/**
 * @fileoverview Public high-level Sen API, session discovery and reconnection.
 *
 * Remote object behavior and publication restoration live in dedicated modules;
 * this file coordinates sessions and preserves the package's public API.
 */
import { EventEmitter } from 'node:events';
import { EtherClient } from './client.js';
import { EtherDiscoveryScanner, TcpDiscoveryHubScanner } from './discovery.js';
import { LiveDiscovery } from './live-discovery.js';
import { SenBus } from './sen-bus.js';
import { SenInterest } from './sen-interest.js';
import { SenRemoteObject } from './sen-remote-object.js';
import { PublicationRegistry, SenPublishedObject } from './sen-publications.js';
export declare class Sen extends EventEmitter {
    #private;
    options: {
        appName: string;
        reconnect: boolean;
        reconnectDelayMs: number;
        maxReconnectAttempts: number;
        announceDiscovery: boolean;
        targetDiscoverySettleMs: number;
        timeout: number;
        discoverySettleMs: number;
        participantReadyTimeoutMs: number;
        socketKeepAlive: boolean;
        socketKeepAliveInitialDelayMs: number;
        socketIdleTimeoutMs: number;
        presenceTimeoutMs: number;
        presenceCheckIntervalMs: number;
        tcpHub?: string;
        session?: string;
        multicastDiscovery?: boolean;
        localSession?: boolean;
        group?: string;
        bindAddress?: string;
        app?: string;
        progressiveDiscovery?: boolean;
        sessionDiscoveryTimeoutMs?: number;
        busDiscoverySettleMs?: number;
        rediscoverTargetOnReconnect?: boolean;
        interfaceAddress?: string;
        listen?: boolean;
        listenHost?: string;
        listenPort?: number;
        advertisedHost?: string;
        beamPeriodMs?: number;
        port?: number;
        busMulticast?: boolean;
        busMulticastPort?: number;
        busMulticastRange?: Array<{
            min: number;
            max: number;
        }>;
        target?: object;
        resourceLimits?: import("../index.js").SenResourceLimits;
        types?: import("./stl-resolver.js").StlTypeRegistry | Map<string, object> | Record<string, object> | object[];
    };
    target: any;
    client: EtherClient | undefined;
    connectOptions: {
        appName: string;
        reconnect: boolean;
        reconnectDelayMs: number;
        maxReconnectAttempts: number;
        announceDiscovery: boolean;
        targetDiscoverySettleMs: number;
        timeout: number;
        discoverySettleMs: number;
        participantReadyTimeoutMs: number;
        socketKeepAlive: boolean;
        socketKeepAliveInitialDelayMs: number;
        socketIdleTimeoutMs: number;
        presenceTimeoutMs: number;
        presenceCheckIntervalMs: number;
        tcpHub?: string;
        session?: string;
        multicastDiscovery?: boolean;
        localSession?: boolean;
        group?: string;
        bindAddress?: string;
        app?: string;
        progressiveDiscovery?: boolean;
        sessionDiscoveryTimeoutMs?: number;
        busDiscoverySettleMs?: number;
        rediscoverTargetOnReconnect?: boolean;
        interfaceAddress?: string;
        listen?: boolean;
        listenHost?: string;
        listenPort?: number;
        advertisedHost?: string;
        beamPeriodMs?: number;
        port?: number;
        busMulticast?: boolean;
        busMulticastPort?: number;
        busMulticastRange?: Array<{
            min: number;
            max: number;
        }>;
        target?: object;
        resourceLimits?: import("../index.js").SenResourceLimits;
        types?: import("./stl-resolver.js").StlTypeRegistry | Map<string, object> | Record<string, object> | object[];
    } | undefined;
    manualClose: boolean;
    reconnecting: boolean;
    presenceScanner: EtherDiscoveryScanner | TcpDiscoveryHubScanner | undefined;
    presenceTimer: NodeJS.Timeout | undefined;
    presenceLastSeen: number;
    remoteBuses: Set<any>;
    remoteBusWaiters: Map<any, any>;
    busParticipantReadyWaiters: Map<any, any>;
    buses: Map<any, any>;
    busJoinPromises: Map<any, any>;
    sessions: Map<any, any>;
    sessionConnectPromises: Map<any, any>;
    targets: any[];
    targetsBySession: Map<any, any>;
    publications: PublicationRegistry;
    published: Map<any, any>;
    reconnectPromise: any;
    localProducer: boolean;
    liveDiscovery: LiveDiscovery | undefined;
    /**
   * Create, connect and return a SEN ether client.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @returns {Promise<Sen>}
   */
    static connect(options?: import('../index.js').SenConnectOptions): Promise<Sen>;
    /**
   * Load and resolve an STL file or directory into a reusable type registry.
   * This is a Node-only convenience; parsing itself is transport independent.
   *
   * @param {string} sourcePath Entry STL file or directory.
   * @param {{includePaths?: string[]}} [options]
   */
    static loadStl(sourcePath: string, options?: {
        includePaths?: string[];
    }): Promise<import("./stl-resolver.js").StlTypeRegistry>;
    /** Load HLA FOM XML modules into a reusable SEN type registry. */
    static loadFom(sourcePath: any, options?: {}): Promise<import("./stl-resolver.js").StlTypeRegistry>;
    /**
   * Discover visible SEN buses without creating interests or joining buses.
   *
   * SEN discovery beams expose sessions/processes. Bus names are announced only
   * after a lightweight process connection, so this method connects to each
   * discovered session long enough to read its remote bus announcements.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @returns {Promise<Array<{session:string,bus:string,qualified:string}>>}
   */
    static discoverBuses(options?: import('../index.js').SenConnectOptions): Promise<Array<{
        session: string;
        bus: string;
        qualified: string;
    }>>;
    /** @param {import('../index.js').SenConnectOptions} [options] */
    constructor(options?: import('../index.js').SenConnectOptions);
    /**
   * Discover and connect to one existing SEN ether process.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @param {string} [options.tcpHub] Discovery hub as `host:port`.
   * @param {string} [options.session] Session filter.
   * @param {string} [options.app] Remote appName substring filter.
   * @param {number} [options.timeout] Discovery and ready timeout in ms.
   * @param {number} [options.discoverySettleMs] TCP discovery settle time after the first process is found.
   * @param {{host:string, port:number}|object} [options.target] Direct target.
   */
    connect(options?: import('../index.js').SenConnectOptions): Promise<this>;
    /**
   * Join a bus and start an interest. By default the interest is
   * `SELECT * FROM <session>.<bus>`.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {import('../index.js').SenInterestOptions} [options]
   * @param {string} [options.query]
   * @param {boolean} [options.forceBus]
   * @param {number} [options.timeout]
   * @param {number} [options.id] Optional native interest id. Defaults to CRC32(query).
   * @returns {Promise<SenBus>}
   */
    subscribe(busName: string, options?: import('../index.js').SenInterestOptions): Promise<SenBus>;
    /**
   * Start a native SEN interest and return a live object collection.
   *
   * @param {string} query Native SEN interest query, for example `SELECT * FROM session.bus`.
   * @param {import('../index.js').SenInterestOptions} [options]
   * @param {string} [options.bus] Explicit bus when it cannot be inferred from the query.
   * @param {boolean} [options.forceBus]
   * @param {number} [options.timeout]
   * @param {string[]|string} [options.properties] Optional property names to decode and emit.
   * @param {'individual'|'batch'|'both'} [options.changeMode] Defaults to `individual`.
   * @param {number} [options.batchIntervalMs] Batch flush interval in ms.
   * @param {number} [options.batchMaxSize] Batch flush size.
   * @param {number} [options.maxQueuedChanges] Backpressure queue limit for batched changes.
   * @param {'drop-oldest'|'drop-newest'|'error'} [options.backpressure]
   * @param {boolean} [options.coalesce] Keep only the latest queued change per object/property.
   * @returns {Promise<SenInterest>}
   */
    interest(query: string, options?: import('../index.js').SenInterestOptions): Promise<SenInterest>;
    /**
   * @param {string} name
   * @param {import('../index.js').SenInterestOptions} [options]
   * @returns {Promise<SenBus>}
   */
    bus(name: string, options?: import('../index.js').SenInterestOptions): Promise<SenBus>;
    /**
   * Publish local JavaScript objects on a SEN bus.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {import('../index.js').SenPublishedObjectDescriptor|import('../index.js').SenPublishedObjectDescriptor[]} objects
   * @param {import('../index.js').SenPublishOptions} [options]
   * @returns {Promise<object[]>}
   */
    publishObjects(busName: string, objects: import('../index.js').SenPublishedObjectDescriptor | import('../index.js').SenPublishedObjectDescriptor[], options?: import('../index.js').SenPublishOptions): Promise<object[]>;
    /**
   * Publish one object and return a persistent handle for updates and removal.
   *
   * @param {string} busName Session-qualified bus name on a root multi-session client, or local bus name on a session client.
   * @param {import('../index.js').SenPublishedObjectDescriptor} object
   * @param {import('../index.js').SenPublishOptions} [options]
   * @returns {Promise<SenPublishedObject>}
   */
    publish(busName: string, object: import('../index.js').SenPublishedObjectDescriptor, options?: import('../index.js').SenPublishOptions): Promise<SenPublishedObject>;
    /**
   * Publish one local JavaScript object and return its local publication.
   * `className` is resolved from the configured STL registry when no `spec`
   * is supplied on the object.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {object} object
   * @param {object} [options]
   * @returns {Promise<object>}
   */
    publishObject(busName: string, object: object, options?: object): Promise<object>;
    /**
   * Update a previously published local JavaScript object.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {string | number | object} object Object id, name or published object.
   * @param {object} patch Property values to update.
   * @param {object} [options]
   * @returns {Promise<object>}
   */
    updatePublishedObject(busName: string, object: string | number | object, patch: object, options?: object): Promise<object>;
    /**
   * Emit an event from a previously published JavaScript object.
   * Prefer {@link SenPublishedObject#emit} when a publication handle is available.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {string|number|SenPublishedObject} object Published object selector.
   * @param {string} eventName Event declared by the object's ClassTypeSpec.
   * @param {unknown[]} [args]
   * @param {{ creationTime?: bigint|number, session?: string }} [options]
   */
    emitPublishedEvent(busName: string, object: string | number | SenPublishedObject, eventName: string, args?: unknown[], options?: {
        creationTime?: bigint | number;
        session?: string;
    }): Promise<any>;
    /**
   * Remove previously published local JavaScript objects from a SEN bus.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {Array<string|number>|string|number} objects Object ids or names.
   * @param {object} [options]
   */
    removePublishedObjects(busName: string, objects: Array<string | number> | string | number, options?: object): Promise<any>;
    session(name: any): Promise<any>;
    listSessions(): any[];
    listBuses(options?: {}): any[];
    /**
   * Discover visible SEN buses without creating interests or joining buses.
   *
   * @param {object} [options]
   * @param {string} [options.session] Optional session filter.
   * @param {number} [options.busDiscoverySettleMs] Delay after lightweight session connect before reading announced buses.
   * @returns {Promise<Array<{session:string,bus:string,qualified:string}>>}
   */
    discoverBuses(options?: {
        session?: string;
        busDiscoverySettleMs?: number;
    }): Promise<Array<{
        session: string;
        bus: string;
        qualified: string;
    }>>;
    objects(): any[];
    getObject(selector: any): any;
    waitForRemoteBus(busName: any, timeoutMs?: number): Promise<void>;
    /** @internal Register before joinBus() so an immediate ready event cannot be missed. */
    createBusParticipantReadyWait(busName: any, timeoutMs: any): {
        promise: Promise<any>;
        cancel: () => any;
    };
    waitForObject(selector: any, options?: {}): Promise<any>;
    close(): Promise<void>;
}
export { SenBus } from './sen-bus.js';
export { SenInterest };
export { SenRemoteObject };
export { SenPublishedObject } from './sen-publications.js';
