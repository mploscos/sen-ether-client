export type SenConnectOptions = {
    /**
     * Local Ether process name.
     */
    appName?: string;
    /**
     * Optional SEN TCP discovery hub as `host:port`. If omitted, multicast discovery is used.
     */
    tcpHub?: string;
    /**
     * Optional SEN session name. Omit it to let
     * `interest(query)` connect to the session named in the query.
     */
    session?: string;
    /**
     * Enable active multicast presence beaming when no TCP hub is configured.
     */
    multicastDiscovery?: boolean;
    /**
     * Advertise this process to peers. Enable for discoverable publishers.
     */
    announceDiscovery?: boolean;
    /**
     * Host the named session without discovering an existing process first.
     */
    localSession?: boolean;
    /**
     * Multicast discovery group.
     */
    group?: string;
    /**
     * Optional multicast discovery bind address.
     */
    bindAddress?: string;
    /**
     * Remote process appName substring filter.
     */
    app?: string;
    /**
     * Discovery and operation timeout in ms.
     */
    timeout?: number;
    /**
     * Local method response timeout in ms. `0` disables it.
     */
    methodTimeout?: number;
    /**
     * Discovery settle time after the first process is found.
     */
    discoverySettleMs?: number;
    /**
     * Target collection window for root multi-session discovery.
     */
    targetDiscoverySettleMs?: number;
    /**
     * Root connect resolves when discovery is operational, without waiting for producers. False enables legacy snapshot discovery.
     */
    progressiveDiscovery?: boolean;
    /**
     * Progressive session discovery deadline; 0 waits until the session appears or the client closes. Separate from transport operation timeout.
     */
    sessionDiscoveryTimeoutMs?: number;
    /**
     * Max wait after lightweight session connect before reading bus announcements. Defaults to at least 1000 ms.
     */
    busDiscoverySettleMs?: number;
    /**
     * Short grace timeout for non-fatal bus participant acknowledgements.
     */
    participantReadyTimeoutMs?: number;
    /**
     * Reconnect and restart interests after disconnection.
     */
    reconnect?: boolean;
    /**
     * Delay between reconnect attempts.
     */
    reconnectDelayMs?: number;
    /**
     * Maximum reconnect attempts. `0` means unlimited.
     */
    maxReconnectAttempts?: number;
    /**
     * Discover a fresh target instead of reusing a direct target on reconnect.
     */
    rediscoverTargetOnReconnect?: boolean;
    /**
     * Enable TCP keepalive on SEN ether connections.
     */
    socketKeepAlive?: boolean;
    /**
     * TCP keepalive initial delay.
     */
    socketKeepAliveInitialDelayMs?: number;
    /**
     * Optional transport idle timeout in ms. `0` disables it.
     */
    socketIdleTimeoutMs?: number;
    /**
     * Close and reconnect when the connected SEN process stops announcing presence beams. `0` disables it.
     */
    presenceTimeoutMs?: number;
    /**
     * Presence watchdog check interval in ms.
     */
    presenceCheckIntervalMs?: number;
    /**
     * Local interface address or interface name for multicast discovery.
     */
    interfaceAddress?: string;
    /**
     * Enable the local Ether TCP listener for active discovery.
     */
    listen?: boolean;
    /**
     * Local host/interface for the Ether listener.
     */
    listenHost?: string;
    /**
     * Local Ether listener port. `0` lets the OS choose.
     */
    listenPort?: number;
    /**
     * Host advertised in TCP discovery beams.
     */
    advertisedHost?: string;
    /**
     * Active discovery beam period in ms.
     */
    beamPeriodMs?: number;
    /**
     * Ether multicast discovery port. Defaults to `SEN_ETHER_DISCOVERY_PORT`, then 60543.
     */
    port?: number;
    /**
     * Join native bus multicast groups. When disabled, event delivery falls back to TCP.
     */
    busMulticast?: boolean;
    /**
     * Native bus multicast UDP port.
     */
    busMulticastPort?: number;
    /**
     * Four-octet range used to derive native bus multicast groups.
     */
    busMulticastRange?: Array<{
        min: number;
        max: number;
    }>;
    /**
     * Already discovered/direct SEN target.
     */
    target?: object;
    /**
     * Limits for remote-controlled sizes and in-memory protocol state.
     */
    resourceLimits?: SenResourceLimits;
    /**
     * Reusable local type definitions. A StlTypeRegistry is obtained from Sen.loadStl(), Sen.loadFom() or Sen.loadRprFom().
     */
    types?: import('./lib/stl.js').StlTypeRegistry | Map<string, object> | Record<string, object> | object[];
};
export type SenInterestOptions = {
    /**
     * Explicit bus name when it cannot be inferred from the query.
     */
    bus?: string;
    /**
     * Explicit interest query when using `sen.subscribe(busName)`.
     */
    query?: string;
    /**
     * Join without waiting for the remote process to announce the bus.
     */
    forceBus?: boolean;
    /**
     * Operation timeout in ms.
     */
    timeout?: number;
    /**
     * Optional native interest id. Defaults to CRC32(query).
     */
    id?: number;
    /**
     * Optional property names to decode and emit.
     */
    properties?: string[] | string;
    /**
     * Change emission mode.
     */
    changeMode?: 'individual' | 'batch' | 'both';
    /**
     * Batched change flush interval in ms.
     */
    batchIntervalMs?: number;
    /**
     * Batched change flush size.
     */
    batchMaxSize?: number;
    /**
     * Batched change queue limit.
     */
    maxQueuedChanges?: number;
    /**
     * Queue overflow policy.
     */
    backpressure?: 'drop-oldest' | 'drop-newest' | 'error';
    /**
     * Keep only latest queued change per object/property.
     */
    coalesce?: boolean;
};
export type SenMethodCallOptions = {
    /**
     * Local method response timeout in ms. `0` disables the local timeout.
     */
    timeout?: number;
};
export type SenPublishedObjectDescriptor = {
    /**
     * SEN object name.
     */
    name: string;
    /**
     * SEN class name.
     */
    className: string;
    /**
     * Advanced protocol ObjectId override. By default a SEN-compatible random UUID hash is combined with the object name. This is unrelated to an STL property named `id`.
     */
    id?: number;
    /**
     * Optional class hash. Defaults to the SEN structural hash of the resolved ClassTypeSpec.
     */
    typeHash?: number;
    /**
     * Current object property values.
     */
    properties?: object;
    /**
     * Alias for properties.
     */
    snapshot?: object;
    /**
     * JavaScript handlers for methods declared in the class.
     */
    methods?: object;
    /**
     * Optional SEN ClassTypeSpec. If omitted, the class is resolved from configured STL types. Scalar inference is used only when no types are configured.
     */
    spec?: object;
    /**
     * Optional SEN timestamp in ns.
     */
    timestamp?: bigint | number | string;
};
export type SenPublishOptions = {
    /**
     * Extra SEN type specs required by the object.
     */
    types?: import('./lib/stl.js').StlTypeRegistry | Map<string, object> | Record<string, object> | object[];
    /**
     * Optional local participant id for a newly joined bus.
     */
    participantId?: number;
};
export type SenListBusesOptions = {
    /**
     * Return session-qualified bus names.
     */
    qualified?: boolean;
};
export type SenBusSummary = {
    /**
     * SEN session name.
     */
    session: string;
    /**
     * Bus name local to the session.
     */
    bus: string;
    /**
     * Session-qualified bus name usable in `SELECT * FROM <qualified>`.
     */
    qualified: string;
};
export type SenResourceLimits = {
    maxFrameSize?: number;
    maxReceiveBufferSize?: number;
    maxStringBytes?: number;
    maxBufferBytes?: number;
    maxSequenceLength?: number;
    maxDiscoveredProcesses?: number;
    maxConnections?: number;
    maxInterestsPerBus?: number;
    maxRemoteInterestsPerBus?: number;
    maxPendingRequestsPerBus?: number;
    maxForwardedObjectRoutesPerBus?: number;
    maxPendingTransitCallsPerBus?: number;
    maxRemoteParticipantsPerBus?: number;
    maxPendingStatesPerObject?: number;
    maxPendingMethodCallsPerBus?: number;
};
export type SenChange = {
    object: import('./lib/sen.js').SenRemoteObject;
    name: string;
    value: unknown;
    previous?: unknown;
    timestamp?: bigint | number | undefined;
    timestampNs?: bigint | undefined;
};
export type SenChangeBatch = {
    changes: SenChange[];
    /**
     * Number of changes dropped since the previous batch.
     */
    dropped: number;
};
export type SenObjectSelector = string | number | ((object: import('./lib/sen.js').SenRemoteObject) => boolean);
export type SenRuntimeEvent = {
    /**
     * Remote object that produced the event.
     */
    object: import('./lib/sen.js').SenRemoteObject;
    /**
     * SEN event member ID.
     */
    id: number;
    /**
     * Resolved event name.
     */
    name: string | undefined;
    /**
     * Decoded arguments when the EventSpec is known.
     */
    args: unknown[] | undefined;
    /**
     * Raw SEN creation timestamp.
     */
    creationTime: bigint | number;
    /**
     * Nanosecond timestamp normalized as a BigInt.
     */
    creationTimeNs: bigint | undefined;
    /**
     * Encoded SEN argument buffer.
     */
    raw: Buffer;
};
/**
 * Public sen-ether-client API.
 *
 * This package is a high-level JavaScript client for existing SEN kernels. It
 * intentionally hides the ether codec, discovery frames and low-level transport
 * classes from package consumers.
 *
 * @example
 * import { Sen } from 'sen-ether-client';
 *
 * const sen = await Sen.connect();
 *
 * console.log(sen.listSessions());
 * const session = await sen.session('session');
 * console.log(session.listBuses());
 *
 * const objects = await sen.interest('SELECT * FROM session.bus');
 * const object = await objects.waitFor('object-1');
 *
 * object.on('change:label', ({ value }) => console.log(value));
 * console.log(await object.get('label'));
 * await object.set('label', 'from-js');
 * console.log(await object.call('ping', ['hello']));
 *
 * await sen.close();
 */
/**
 * @typedef {object} SenConnectOptions
 * @property {string} [appName='sen-ether-client'] Local Ether process name.
 * @property {string} [tcpHub] Optional SEN TCP discovery hub as `host:port`. If omitted, multicast discovery is used.
 * @property {string} [session] Optional SEN session name. Omit it to let
 * `interest(query)` connect to the session named in the query.
 * @property {boolean} [multicastDiscovery=true] Enable active multicast presence beaming when no TCP hub is configured.
 * @property {boolean} [announceDiscovery=false] Advertise this process to peers. Enable for discoverable publishers.
 * @property {boolean} [localSession=false] Host the named session without discovering an existing process first.
 * @property {string} [group='239.255.0.44'] Multicast discovery group.
 * @property {string} [bindAddress] Optional multicast discovery bind address.
 * @property {string} [app] Remote process appName substring filter.
 * @property {number} [timeout=3000] Discovery and operation timeout in ms.
 * @property {number} [methodTimeout=5000] Local method response timeout in ms. `0` disables it.
 * @property {number} [discoverySettleMs=100] Discovery settle time after the first process is found.
 * @property {number} [targetDiscoverySettleMs=1000] Target collection window for root multi-session discovery.
 * @property {boolean} [progressiveDiscovery=true] Root connect resolves when discovery is operational, without waiting for producers. False enables legacy snapshot discovery.
 * @property {number} [sessionDiscoveryTimeoutMs=0] Progressive session discovery deadline; 0 waits until the session appears or the client closes. Separate from transport operation timeout.
 * @property {number} [busDiscoverySettleMs] Max wait after lightweight session connect before reading bus announcements. Defaults to at least 1000 ms.
 * @property {number} [participantReadyTimeoutMs=1000] Short grace timeout for non-fatal bus participant acknowledgements.
 * @property {boolean} [reconnect=true] Reconnect and restart interests after disconnection.
 * @property {number} [reconnectDelayMs=500] Delay between reconnect attempts.
 * @property {number} [maxReconnectAttempts=0] Maximum reconnect attempts. `0` means unlimited.
 * @property {boolean} [rediscoverTargetOnReconnect=false] Discover a fresh target instead of reusing a direct target on reconnect.
 * @property {boolean} [socketKeepAlive=true] Enable TCP keepalive on SEN ether connections.
 * @property {number} [socketKeepAliveInitialDelayMs=1000] TCP keepalive initial delay.
 * @property {number} [socketIdleTimeoutMs=0] Optional transport idle timeout in ms. `0` disables it.
 * @property {number} [presenceTimeoutMs=5000] Close and reconnect when the connected SEN process stops announcing presence beams. `0` disables it.
 * @property {number} [presenceCheckIntervalMs=1000] Presence watchdog check interval in ms.
 * @property {string} [interfaceAddress] Local interface address or interface name for multicast discovery.
 * @property {boolean} [listen=true] Enable the local Ether TCP listener for active discovery.
 * @property {string} [listenHost='0.0.0.0'] Local host/interface for the Ether listener.
 * @property {number} [listenPort=0] Local Ether listener port. `0` lets the OS choose.
 * @property {string} [advertisedHost] Host advertised in TCP discovery beams.
 * @property {number} [beamPeriodMs=1000] Active discovery beam period in ms.
 * @property {number} [port] Ether multicast discovery port. Defaults to `SEN_ETHER_DISCOVERY_PORT`, then 60543.
 * @property {boolean} [busMulticast=true] Join native bus multicast groups. When disabled, event delivery falls back to TCP.
 * @property {number} [busMulticastPort=50985] Native bus multicast UDP port.
 * @property {Array<{min:number,max:number}>} [busMulticastRange] Four-octet range used to derive native bus multicast groups.
 * @property {object} [target] Already discovered/direct SEN target.
 * @property {SenResourceLimits} [resourceLimits] Limits for remote-controlled sizes and in-memory protocol state.
 * @property {import('./lib/stl.js').StlTypeRegistry|Map<string, object>|Record<string, object>|object[]} [types]
 * Reusable local type definitions. A StlTypeRegistry is obtained from Sen.loadStl(), Sen.loadFom() or Sen.loadRprFom().
 */
/**
 * @typedef {object} SenInterestOptions
 * @property {string} [bus] Explicit bus name when it cannot be inferred from the query.
 * @property {string} [query] Explicit interest query when using `sen.subscribe(busName)`.
 * @property {boolean} [forceBus=false] Join without waiting for the remote process to announce the bus.
 * @property {number} [timeout] Operation timeout in ms.
 * @property {number} [id] Optional native interest id. Defaults to CRC32(query).
 * @property {string[]|string} [properties] Optional property names to decode and emit.
 * @property {'individual'|'batch'|'both'} [changeMode='individual'] Change emission mode.
 * @property {number} [batchIntervalMs=16] Batched change flush interval in ms.
 * @property {number} [batchMaxSize=1000] Batched change flush size.
 * @property {number} [maxQueuedChanges=10000] Batched change queue limit.
 * @property {'drop-oldest'|'drop-newest'|'error'} [backpressure='drop-oldest'] Queue overflow policy.
 * @property {boolean} [coalesce=false] Keep only latest queued change per object/property.
 */
/**
 * @typedef {object} SenMethodCallOptions
 * @property {number} [timeout] Local method response timeout in ms. `0` disables the local timeout.
 */
/**
 * @typedef {object} SenPublishedObjectDescriptor
 * @property {string} name SEN object name.
 * @property {string} className SEN class name.
 * @property {number} [id] Advanced protocol ObjectId override. By default a SEN-compatible random UUID hash is combined with the object name. This is unrelated to an STL property named `id`.
 * @property {number} [typeHash] Optional class hash. Defaults to the SEN structural hash of the resolved ClassTypeSpec.
 * @property {object} [properties] Current object property values.
 * @property {object} [snapshot] Alias for properties.
 * @property {object} [methods] JavaScript handlers for methods declared in the class.
 * @property {object} [spec] Optional SEN ClassTypeSpec. If omitted, the class is resolved from configured STL types. Scalar inference is used only when no types are configured.
 * @property {bigint|number|string} [timestamp] Optional SEN timestamp in ns.
 */
/**
 * @typedef {object} SenPublishOptions
 * @property {import('./lib/stl.js').StlTypeRegistry|Map<string, object>|Record<string, object>|object[]} [types] Extra SEN type specs required by the object.
 * @property {number} [participantId] Optional local participant id for a newly joined bus.
 */
/**
 * @typedef {object} SenListBusesOptions
 * @property {boolean} [qualified=false] Return session-qualified bus names.
 */
/**
 * @typedef {object} SenBusSummary
 * @property {string} session SEN session name.
 * @property {string} bus Bus name local to the session.
 * @property {string} qualified Session-qualified bus name usable in `SELECT * FROM <qualified>`.
 */
/**
 * @typedef {object} SenResourceLimits
 * @property {number} [maxFrameSize]
 * @property {number} [maxReceiveBufferSize]
 * @property {number} [maxStringBytes]
 * @property {number} [maxBufferBytes]
 * @property {number} [maxSequenceLength]
 * @property {number} [maxDiscoveredProcesses]
 * @property {number} [maxConnections]
 * @property {number} [maxInterestsPerBus]
 * @property {number} [maxRemoteInterestsPerBus]
 * @property {number} [maxPendingRequestsPerBus]
 * @property {number} [maxForwardedObjectRoutesPerBus]
 * @property {number} [maxPendingTransitCallsPerBus]
 * @property {number} [maxRemoteParticipantsPerBus]
 * @property {number} [maxPendingStatesPerObject]
 * @property {number} [maxPendingMethodCallsPerBus]
 */
/**
 * @typedef {object} SenChange
 * @property {import('./lib/sen.js').SenRemoteObject} object
 * @property {string} name
 * @property {unknown} value
 * @property {unknown} [previous]
 * @property {bigint|number|undefined} [timestamp]
 * @property {bigint|undefined} [timestampNs]
 */
/**
 * @typedef {object} SenChangeBatch
 * @property {SenChange[]} changes
 * @property {number} dropped Number of changes dropped since the previous batch.
 */
/**
 * @typedef {string | number | ((object: import('./lib/sen.js').SenRemoteObject) => boolean)} SenObjectSelector
 */
/**
 * @typedef {object} SenRuntimeEvent
 * @property {import('./lib/sen.js').SenRemoteObject} object Remote object that produced the event.
 * @property {number} id SEN event member ID.
 * @property {string|undefined} name Resolved event name.
 * @property {unknown[]|undefined} args Decoded arguments when the EventSpec is known.
 * @property {bigint|number} creationTime Raw SEN creation timestamp.
 * @property {bigint|undefined} creationTimeNs Nanosecond timestamp normalized as a BigInt.
 * @property {Buffer} raw Encoded SEN argument buffer.
 */
export { Sen, SenPublishedObject, SenInterest, SenRemoteObject } from './lib/sen.js';
export { generateStlModule } from './lib/stl-module.js';
export { parseFom, resolveFom, FomResolutionError } from './lib/fom.js';
export { parseXml, XmlSyntaxError } from './lib/xml.js';
export { senTypeHash, senTypeHashes } from './lib/type-hash.js';
export { compileInterestQuery, parseInterestQuery } from './lib/interest-query.js';
