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
 * const hmi = await sen.session('hmi');
 * console.log(hmi.listBuses());
 *
 * const diagnostics = await sen.interest('SELECT * FROM hmi.diagnostics');
 * const world = await sen.interest('SELECT * FROM world1.environment');
 * const probe = await diagnostics.waitFor('EtherProbe');
 *
 * probe.on('change:label', ({ value }) => console.log(value));
 * console.log(await probe.get('label'));
 * await probe.set('label', 'from-js');
 * console.log(await probe.call('ping', ['hello']));
 *
 * await sen.close();
 */

/**
 * @typedef {object} SenConnectOptions
 * @property {string} [tcpHub] Optional SEN TCP discovery hub as `host:port`. If omitted, multicast discovery is used.
 * @property {string} [session] Optional SEN session name. Omit it to let
 * `interest(query)` connect to the session named in the query.
 * @property {string} [app] Remote process appName substring filter.
 * @property {number} [timeout=3000] Discovery and operation timeout in ms.
 * @property {number} [discoverySettleMs=100] Discovery settle time after the first process is found.
 * @property {number} [participantReadyTimeoutMs=1000] Short grace timeout for non-fatal bus participant acknowledgements.
 * @property {boolean} [reconnect=true] Reconnect and restart interests after disconnection.
 * @property {number} [reconnectDelayMs=500] Delay between reconnect attempts.
 * @property {number} [maxReconnectAttempts=10] Maximum reconnect attempts.
 * @property {boolean} [socketKeepAlive=true] Enable TCP keepalive on SEN ether connections.
 * @property {number} [socketKeepAliveInitialDelayMs=1000] TCP keepalive initial delay.
 * @property {number} [socketIdleTimeoutMs=0] Optional transport idle timeout in ms. `0` disables it.
 * @property {string} [interfaceAddress] Local interface address or interface name for multicast discovery.
 * @property {object} [target] Already discovered/direct SEN target.
 */

/**
 * @typedef {object} SenInterestOptions
 * @property {string} [bus] Explicit bus name when it cannot be inferred from the query.
 * @property {boolean} [forceBus=false] Join without waiting for the remote process to announce the bus.
 * @property {number} [timeout] Operation timeout in ms.
 * @property {string[]|string} [properties] Optional property names to decode and emit.
 * @property {'individual'|'batch'|'both'} [changeMode='individual'] Change emission mode.
 * @property {number} [batchIntervalMs=16] Batched change flush interval in ms.
 * @property {number} [batchMaxSize=1000] Batched change flush size.
 * @property {number} [maxQueuedChanges=10000] Batched change queue limit.
 * @property {'drop-oldest'|'drop-newest'|'error'} [backpressure='drop-oldest'] Queue overflow policy.
 * @property {boolean} [coalesce=false] Keep only latest queued change per object/property.
 */

/**
 * @typedef {object} SenListBusesOptions
 * @property {boolean} [qualified=false] Return session-qualified bus names.
 */

/**
 * @typedef {string | number | ((object: SenRemoteObject) => boolean)} SenObjectSelector
 */

export {
  Sen,
  SenInterest,
  SenRemoteObject
} from './lib/sen.js';
