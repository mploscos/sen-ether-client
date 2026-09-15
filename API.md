# sen-ether-client API

Public import:

```js
import { Sen, SenInterest, SenPublishedObject, SenRemoteObject } from 'sen-ether-client';
```

## Compatibility

`sen-ether-client@0.1.x` through `sen-ether-client@0.4.x` support:

- kernel protocol `9`
- ether protocol `2`

These protocol versions are checked during the SEN handshake. A different
kernel or ether protocol should be treated as unsupported unless `sen-ether-client`
explicitly adds support for it.

The protocol STL files are included in `resources/protocol` as the source for
the codec. The SEN release noted in that folder is informational; it is not a
compatibility check.

The bundled protocol module is pre-generated. Application STL is parsed only
when you explicitly call `Sen.loadStl()`; publishing and receiving updates use
the resolved registry already held in memory.

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
  a local Ether listener and connects to compatible peers announced by the
  hub.
- `session`: optional SEN session name. If omitted, `Sen` can use queries for
  different sessions and connects to each one on demand.
- `announceDiscovery`: emit presence beams for this process. `Sen` defaults to
  `false`. Set it to `true` for a process that publishes objects and must be
  discovered by peers.
- `localSession`: host the named session without first discovering an existing
  process. Defaults to `false`; it is selected automatically for an active
  session when no target is found.
- `multicastDiscovery`: enable active multicast presence beaming when no
  `tcpHub` is configured. Defaults to `true`.
- `group`: multicast discovery group. Defaults to `239.255.0.44`.
- `bindAddress`: optional multicast discovery bind address.
- `listen`: enable the local Ether TCP listener. Defaults to `true`.
- `listenHost`: host/interface for the local Ether listener. Defaults to
  `0.0.0.0`.
- `listenPort`: local Ether listener port. Defaults to `0` so the OS picks one.
- `advertisedHost`: host advertised in discovery beams. Defaults to the
  selected interface address.
- `beamPeriodMs`: active discovery beam period. Defaults to `1000`.
- `timeout`: discovery and operation timeout in ms.
- `discoverySettleMs`: discovery settle time after the first process is found.
  Defaults to `100`.
- `targetDiscoverySettleMs`: target collection window when connecting without a
  fixed session. Defaults to `1000`, matching SEN Ether's default beam period.
  Increase it when producers use a larger `beamPeriod`.
- `busDiscoverySettleMs`: max wait after a lightweight session connection while
  bus announcements arrive. Defaults to at least `1000`.
- `reconnect`: whether to reconnect and restart interests.
- `reconnectDelayMs`: delay between reconnect attempts.
- `maxReconnectAttempts`: maximum reconnect attempts. Defaults to `0`, which
  means unlimited retries.
- `participantReadyTimeoutMs`: short non-fatal grace timeout for bus
  participant acknowledgements. Defaults to `1000`.
- `socketKeepAlive`: enable TCP keepalive. Defaults to `true`.
- `socketKeepAliveInitialDelayMs`: TCP keepalive initial delay. Defaults to
  `1000`.
- `socketIdleTimeoutMs`: optional TCP idle timeout. Defaults to `0` because
  valid SEN connections can be quiet on TCP while bus data flows separately.
- `presenceTimeoutMs`: close and reconnect when the connected SEN process stops
  announcing ether presence beams. Defaults to `5000`; set `0` to disable.
- `presenceCheckIntervalMs`: presence watchdog check interval. Defaults to
  `1000`.
- `rediscoverTargetOnReconnect`: discover a fresh target instead of reusing a
  direct target. Defaults to `false`.
- `busMulticast`: use native SEN bus multicast when available. Defaults to
  `true`; disabling it uses direct process TCP for runtime events.
- `busMulticastPort`: native bus multicast port. Defaults to `50985`.
- `types`: an STL registry from `Sen.loadStl()` or compatible TypeSpec
  collection used for decoding and publishing.

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
- `await Sen.loadStl(sourcePath, options)`
- `await sen.interest(query, options)`
- `await sen.publish(busName, object, options)`
- `await sen.publishObject(busName, object, options)`
- `await sen.publishObjects(busName, objects, options)`
- `await sen.updatePublishedObject(busName, object, patch, options)`
- `await sen.emitPublishedEvent(busName, object, eventName, args, options)`
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

### Load STL

```js
const types = await Sen.loadStl('./stl', {
  includePaths: ['./shared-stl']
});
const sen = await Sen.connect({ types });
```

`Sen.loadStl()` loads one STL file or a directory, resolves its imports, and
returns a reusable registry. It is a Node.js filesystem helper; the parser and
resolver themselves are pure JavaScript. Load once during startup, rather than
while publishing objects.

The path may be absolute, relative to `process.cwd()`, or a `file:` `URL`.
When configured types are passed to publishing, an unknown `className` is an
error; inference is used only when no type registry is supplied.

Generate a typed JavaScript helper module for an STL tree with:

```bash
npx sen-stl-types ./stl --output ./stl.mjs
```

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

### Publish local objects

JavaScript publishers filter each remote interest by its selected class (including
registered base classes) and `WHERE` expression. Conditions read published
properties, including nested fields. As in native SEN, `name` identifies the
object at application level. The numeric protocol `ObjectId` is internal and is
unrelated to a property named `id` declared in STL. Updating properties adds or
removes objects from matching interests automatically.

Supported conditions use quoted strings, numbers, booleans, comparisons
(`=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`), arithmetic, parentheses,
`AND`, `OR`, `NOT` and `IN`. Unsupported expressions emit a `warning` on the
publisher and do not create a subscription. Queries sent to native SEN
publishers retain the native query language.

For one long-lived application object, prefer `publish()`. It returns a
`SenPublishedObject` with `update(patch)`, `emit(name, args)` and `remove()`:

```js
const types = await Sen.loadStl('./stl');
const sen = await Sen.connect({
  session: 'session',
  announceDiscovery: true,
  types
});

const counter = await sen.publish('devices', {
  name: 'demo-counter',
  className: 'demo.Counter',
  properties: { count: 1 }
});

await counter.update({ count: 2 });
await counter.emit('limitReached', [2]);
await counter.remove();
```

`emit()` resolves the event (including inherited events) from the published
class, validates and encodes its arguments, uses its native member ID and
transport mode, and attaches the published object ID and a SEN nanosecond
creation timestamp. The handle remains valid after automatic reconnect.
Confirmed events use the direct process connection, multicast events use the
native bus group, and `bestEffort`/unicast events use the peer's advertised UDP
endpoint. UDP modes fall back to the direct connection when UDP is unavailable.

The selector-based form is available when a handle is not convenient:

```js
await sen.emitPublishedEvent(
  'session.devices',
  'demo-counter',
  'limitReached',
  [2]
);
```

Unknown objects, undeclared events, missing types and invalid argument values
reject with an error before a malformed runtime event is sent.

`publishObjects()` is useful when publishing several objects at once.
`publishObject()` returns the lower-level publication record. Both remain
available for code that manages objects through
`updatePublishedObject()`/`removePublishedObjects()`.

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

Published objects can expose JavaScript handlers for methods declared in their
SEN class spec. The handler receives decoded SEN arguments as positional
JavaScript arguments. Keep the publication handle in the surrounding scope when
the handler needs to update the object.

```js
const types = await Sen.loadStl('./stl');
const sen = await Sen.connect({ session: 'session', types });

let counter;
counter = await sen.publish('session.bus', {
  name: 'demo-counter',
  className: 'demo.Counter',
  properties: { count: 1 },
  methods: {
    async increment(delta) {
      const count = counter.snapshot.count + delta;
      await counter.update({ count });
      return count;
    }
  }
});
```

Outside a method handler, update a local object with:

```js
await sen.updatePublishedObject('session.bus', 'demo-counter', { count: 2 });
```

For an STL property declared `writable`, consumers use
`await object.set('property', value)`. The publisher handles its generated
`setNext<Property>` operation automatically and broadcasts the property update.
No `methods` entry is required. Add a matching handler only when the
application needs custom validation or side effects.

On a root producer without `session`, the first segment of `publish()`'s bus
name is the session and the rest is the local bus. Pass `{ session }` when the
local bus itself contains dots. Interest query handling is unchanged.

When no `spec` is provided, `sen-ether-client` looks up `className` in the
`types` passed to `Sen.connect`. If a registry is configured, an unknown class
is rejected. Scalar-property inference is used only when no registry or
explicit spec is supplied.

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

Returned by `interest.waitFor(...)`, `interest.get(...)`, or
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
- `event` for every SEN runtime event
- the declared SEN runtime event name, with `{ object, id, name, args,
  creationTimeNs, raw }`
- `stale`

`change.timestampNs` is a nanosecond `BigInt`. This keeps SEN's original
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

## SenPublishedObject

Returned by `await sen.publish(...)`. It is a persistent high-level handle;
publication details are restored automatically after a reconnect.

Main properties:

- `id`
- `name`
- `className`
- `snapshot` / `properties`
- `methods`

Main methods:

- `await object.update(patch)`
- `await object.emit(eventName, args, options)`
- `await object.remove()`

`options.creationTime` may override the emitted event timestamp in nanoseconds;
normal application code should let the client generate it.

Low-level protocol modules are intentionally not public API.
