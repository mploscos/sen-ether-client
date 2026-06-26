# sen-ether-client API

Public import:

```js
import { Sen, SenInterest, SenRemoteObject } from 'sen-ether-client';
```

## Compatibility

`sen-ether-client@0.1.x` and `sen-ether-client@0.2.x` support:

- kernel protocol `9`
- ether protocol `2`

These protocol versions are checked during the SEN handshake. A different
kernel or ether protocol should be treated as unsupported unless `sen-ether-client`
explicitly adds support for it.

The protocol STL files are included in `resources/protocol` as the source for
the codec. The SEN release noted in that folder is informational; it is not a
compatibility check.

The generated protocol module is loaded at runtime; STL parsing is a maintenance
step, not part of connection or message decoding.

## Sen

```js
const sen = await Sen.connect();

// with explicit options:
const sen = new Sen(options);
await sen.connect(options);
```

Connection options:

- `interfaceAddress`: local interface address or interface name for multicast
  discovery.
- `tcpHub`: optional SEN TCP discovery hub as `host:port`. If omitted,
  multicast discovery is used. When combined with `session`, the client opens
  a local Ether listener, sends presence beams to the hub and connects to
  compatible peers announced by the hub.
- `session`: optional SEN session name. If omitted, `Sen` can use queries for
  different sessions and connects to each one on demand. When provided, the
  client also acts as an active Ether process and announces itself through the
  selected discovery transport.
- `multicastDiscovery`: enable active multicast presence beaming when no
  `tcpHub` is configured. Defaults to `true`.
- `group`: multicast discovery group. Defaults to `239.255.0.44`.
- `bindAddress`: optional multicast discovery bind address.
- `listen`: enable the local Ether TCP listener. Defaults to `true` for active
  hub sessions.
- `listenHost`: host/interface for the local Ether listener. Defaults to
  `0.0.0.0`.
- `listenPort`: local Ether listener port. Defaults to `0` so the OS picks one.
- `advertisedHost`: host advertised in discovery beams. Defaults to the
  selected interface address.
- `beamPeriodMs`: active discovery beam period. Defaults to `1000`.
- `timeout`: discovery and operation timeout in ms.
- `discoverySettleMs`: discovery settle time after the first process is found.
  Defaults to `100`.
- `busDiscoverySettleMs`: max wait after a lightweight session connection while
  bus announcements arrive. Defaults to at least `300`.
- `reconnect`: whether to reconnect and restart interests.
- `reconnectDelayMs`: delay between reconnect attempts.
- `maxReconnectAttempts`: maximum reconnect attempts. Defaults to `0`, which
  means unlimited retries.
- `participantReadyTimeoutMs`: short non-fatal grace timeout for bus
  participant acknowledgements. Defaults to `1000`.
- `socketKeepAlive`: enable TCP keepalive. Defaults to `true`.
- `socketIdleTimeoutMs`: optional TCP idle timeout. Defaults to `0` because
  valid SEN connections can be quiet on TCP while bus data flows separately.
- `presenceTimeoutMs`: close and reconnect when the connected SEN process stops
  announcing ether presence beams. Defaults to `5000`; set `0` to disable.
- `presenceCheckIntervalMs`: presence watchdog check interval. Defaults to
  `1000`.

`Sen.connect()` uses multicast discovery. `sen-ether-client` reads this SEN environment
variable as its multicast default:

- `SEN_ETHER_DISCOVERY_PORT`

Multicast group, bind address and interface selection are explicit `sen-ether-client`
options, not SEN environment variables. When no `interfaceAddress` is provided,
multicast discovery joins every local IPv4 interface visible to Node.js. If a
SEN producer on the same host sends discovery through a physical interface that
does not loop multicast packets back locally, discovery can still return no
processes; in that case run the producer discovery on `lo`, pass the matching
`interfaceAddress`, or use SEN TCP discovery.

Preferred multi-session usage:

```js
const sen = await Sen.connect();

const first = await sen.interest('SELECT * FROM session.bus');
const second = await sen.interest('SELECT * FROM otherSession.otherBus');
```

TCP discovery hub usage:

```js
const sen = await Sen.connect({
  session: 'session',
  tcpHub: '127.0.0.1:65222'
});
```

The TCP discovery hub forwards fixed-size presence beams only. Bus messages are
sent over direct process TCP connections between peers, so Node.js producers
and consumers must advertise reachable `listenHost`/`advertisedHost` endpoints.

Multicast discovery usage:

```js
const sen = await Sen.connect({
  session: 'session',
  interfaceAddress: '127.0.0.1',
  listenHost: '127.0.0.1',
  advertisedHost: '127.0.0.1'
});
```

On multi-interface machines, set `interfaceAddress` so multicast beams are sent
and received on the intended network device.

Explicit single-session usage is still supported:

```js
const session = await Sen.connect({ session: 'session' });
await session.interest('SELECT * FROM session.bus');
```

If a SEN bus name itself contains dots and is not a session-qualified bus, pass
it explicitly. This is useful for standalone scenarios that run in one Ether
session but publish on a bus such as `domain.bus`:

```js
const session = await Sen.connect({
  session: 'session'
});

const objects = await session.interest('SELECT * FROM domain.bus', {
  bus: 'domain.bus',
  forceBus: true
});
```

Main methods:

- `await sen.connect(options)`
- `await sen.interest(query, options)`
- `await sen.publishObjects(busName, objects, options)`
- `await sen.removePublishedObjects(busName, objects, options)`
- `await sen.session(name)`
- `await sen.discoverBuses(options)`
- `sen.listSessions()`
- `sen.listBuses(options)`
- `await sen.bus(name, options)`
- `sen.objects()`
- `sen.getObject(selector)`
- `await sen.waitForObject(selector, options)`
- `await sen.close()`

By default, interest creation uses the SEN-native `CRC32(query)` value as the
interest id. Pass `options.id` only when a caller must force a specific native
interest id.

Session and bus navigation:

```js
const sen = await Sen.connect();

console.log(await sen.discoverBuses());
// [{ session: 'session', bus: 'bus', qualified: 'session.bus' }]

for (const sessionName of sen.listSessions()) {
  const session = await sen.session(sessionName);
  console.log(sessionName, session.listBuses());
}

const bus = await sen.session('session').then(session => session.bus('bus'));
```

`discoverBuses()` does not create interests and does not join any SEN bus. It
does open a lightweight process connection per discovered session, because SEN
presence beams announce sessions/processes but not the bus list.

Publishing local objects:

```js
const sen = await Sen.connect({
  session: 'session',
  tcpHub: '127.0.0.1:65222'
});

await sen.publishObjects('session.bus', [{
  name: 'demo-counter',
  className: 'demo.Counter',
  properties: {
    label: 'Demo Counter',
    count: 1,
    running: true
  }
}]);
```

When no `spec` is provided, `sen-ether-client` infers a simple ClassTypeSpec
from scalar `properties`. For objects with nested structs, sequences, enums or
aliases, pass the exact SEN `spec` and dependent `types` so consumers can decode
the state with the same model as native SEN producers.

Main events:

- `connect`
- `close`
- `reconnecting`
- `reconnect`
- `reconnectError`
- `warning`
- `object`
- `remove`
- `change`
- `event`

## SenInterest

Returned by `await sen.interest(query)`.

```js
const interest = await sen.interest('SELECT * FROM session.bus');
const object = await interest.waitFor('object-1');
```

Main methods:

- `interest.objects()`
- `interest.get(selector)`
- `await interest.waitFor(selector, options)`
- `interest.close()`

Main events:

- `object`
- `remove`
- `change`
- `changes`
- `event`
- `stale`
- `restart`

For browser gateways or high-frequency telemetry, request only the properties
you need and emit batches instead of one JS event per property update:

```js
const objects = await sen.interest('SELECT demo.Object FROM session.bus', {
  properties: ['latitude', 'longitude', 'altitude', 'heading'],
  changeMode: 'batch',
  batchIntervalMs: 16,
  batchMaxSize: 1000,
  maxQueuedChanges: 10000,
  backpressure: 'drop-oldest',
  coalesce: true
});

objects.on('changes', ({ changes, dropped }) => {
  // Send one compact WebSocket frame to the browser.
});
```

`changeMode: 'individual'` is the default and preserves the traditional
`change`/`change:<property>` events. `changeMode: 'both'` emits both forms.

## SenRemoteObject

Returned by `interest.waitFor(...)`, `interest.getObject(...)`, or
`sen.getObject(...)`.

```js
console.log(await object.get('label'));
await object.set('label', 'from-js');
console.log(await object.call('ping', ['hello']));
```

Main properties:

- `id`
- `name`
- `className`
- `snapshot`
- `timestampNs`: latest SEN source timestamp as a nanosecond `BigInt`
- `propertyTimestamps`: `Map<string, bigint>` with the latest known timestamp per property

Main methods:

- `object.matches(selector)`
- `await object.waitForType(options)`
- `await object.get(property)`
- `object.getPropertyTimestamp(property)`
- `await object.set(property, value)`
- `await object.call(method, args)`

Main events:

- `change`
- `change:<property>`
- SEN runtime event names emitted by the remote object.
- `stale`

`change.timestampNs` is also a nanosecond `BigInt`. This keeps SEN's original
64-bit timestamp precision. Convert it explicitly at JSON boundaries:

```js
objects.on('change', ({ object, name, value, timestampNs }) => {
  websocket.send(JSON.stringify({
    object: object.name,
    name,
    value,
    timestampNs: timestampNs?.toString()
  }));
});
```

Low-level protocol modules are intentionally not public API.
