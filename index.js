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
 * @property {string} [tcpHub] Optional SEN TCP discovery hub as `host:port`. If omitted, multicast discovery is used.
 * @property {string} [session] Optional SEN session name. Omit it to let
 * `interest(query)` connect to the session named in the query.
 * @property {boolean} [multicastDiscovery=true] Enable active multicast presence beaming when no TCP hub is configured.
 * @property {string} [group='239.255.0.44'] Multicast discovery group.
 * @property {string} [bindAddress] Optional multicast discovery bind address.
 * @property {string} [app] Remote process appName substring filter.
 * @property {number} [timeout=3000] Discovery and operation timeout in ms.
 * @property {number} [discoverySettleMs=100] Discovery settle time after the first process is found.
 * @property {number} [busDiscoverySettleMs=300] Max wait after lightweight session connect before reading bus announcements.
 * @property {number} [participantReadyTimeoutMs=1000] Short grace timeout for non-fatal bus participant acknowledgements.
 * @property {boolean} [reconnect=true] Reconnect and restart interests after disconnection.
 * @property {number} [reconnectDelayMs=500] Delay between reconnect attempts.
 * @property {number} [maxReconnectAttempts=0] Maximum reconnect attempts. `0` means unlimited.
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
 * @property {object} [target] Already discovered/direct SEN target.
 */

/**
 * @typedef {object} SenInterestOptions
 * @property {string} [bus] Explicit bus name when it cannot be inferred from the query.
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
 * @typedef {object} SenPublishedObject
 * @property {string} name SEN object name.
 * @property {string} className SEN class name.
 * @property {number} [id] Optional stable object id. Defaults to CRC32(name).
 * @property {number} [typeHash] Optional class hash. Defaults to CRC32(className).
 * @property {object} [properties] Current object property values.
 * @property {object} [snapshot] Alias for properties.
 * @property {object} [spec] Optional SEN ClassTypeSpec. If omitted, a simple class spec is inferred from properties.
 * @property {bigint|number|string} [timestamp] Optional SEN timestamp in ns.
 */

/**
 * @typedef {object} SenPublishOptions
 * @property {Map<string, object>|Record<string, object>|object[]} [types] Extra SEN type specs required by object properties.
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

export {
  Sen,
  SenInterest,
  SenRemoteObject
} from './lib/sen.js';
