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
 * @property {number} [discoverySettleMs=100] Discovery settle time after the first process is found.
 * @property {number} [targetDiscoverySettleMs=1000] Target collection window for root multi-session discovery.
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
 * @property {import('./lib/stl.js').StlTypeRegistry|Map<string, object>|Record<string, object>|object[]} [types]
 * Reusable local type definitions. A StlTypeRegistry is obtained from Sen.loadStl().
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
 * @typedef {object} SenPublishedObjectDescriptor
 * @property {string} name SEN object name.
 * @property {string} className SEN class name.
 * @property {number} [id] Optional stable object id. Defaults to CRC32(name).
 * @property {number} [typeHash] Optional class hash. Defaults to CRC32(className).
 * @property {object} [properties] Current object property values.
 * @property {object} [snapshot] Alias for properties.
 * @property {object} [methods] JavaScript handlers for methods declared in the class.
 * @property {object} [spec] Optional SEN ClassTypeSpec. If omitted, the class is resolved from configured STL types, then inferred from scalar properties.
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
 * @typedef {string | number | ((object: SenRemoteObject) => boolean)} SenObjectSelector
 */

/**
 * @typedef {object} SenRuntimeEvent
 * @property {SenRemoteObject} object Remote object that produced the event.
 * @property {number} id SEN event member ID.
 * @property {string|undefined} name Resolved event name.
 * @property {unknown[]|undefined} args Decoded arguments when the EventSpec is known.
 * @property {bigint|number} creationTime Raw SEN creation timestamp.
 * @property {bigint|undefined} creationTimeNs Nanosecond timestamp normalized as a BigInt.
 * @property {Buffer} raw Encoded SEN argument buffer.
 */

export {
  Sen,
  SenPublishedObject,
  SenInterest,
  SenRemoteObject
} from './lib/sen.js';
