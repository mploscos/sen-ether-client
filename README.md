# sen-ether-client

JavaScript client for SEN from Node.js.

[SEN](https://github.com/airbus/sen) is a general-purpose, distributed,
object-oriented system for applications that demand high modularity and rich
communication.

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();

const objects = await sen.interest('SELECT * FROM session.bus');
const object = await objects.waitFor('object-1');

object.on('change:label', ({ value }) => {
  console.log('label changed:', value);
});

console.log(await object.get('label'));
await object.set('label', 'from-js');
console.log(await object.call('ping', ['hello']));

await sen.close();
```

## Install

```bash
npm install sen-ether-client
```

## Compatibility

`sen-ether-client` speaks SEN ether directly, so compatibility is tied to SEN protocol
versions, not to a specific SEN release name.

| sen-ether-client | Kernel protocol | Ether protocol |
| --- | ---: | ---: |
| 0.1.x | 9 | 2 |
| 0.2.x | 9 | 2 |

If a remote kernel reports another kernel or ether protocol version during the
SEN handshake, `sen-ether-client` treats it as incompatible until that protocol version
is explicitly supported.

The protocol STL files used to maintain this codec are shipped in
`resources/protocol`. The source SEN release recorded there is informational;
runtime compatibility is checked only with the kernel and ether protocol
numbers announced by the remote process.

The runtime imports generated protocol constants from those STL files, so the
hot path does not parse STL while receiving updates.

## Connect

By default, `sen-ether-client` uses SEN ether multicast discovery and connects to the
visible SEN processes:

```js
const sen = await Sen.connect();
```

When a `session` is provided, the client also behaves as an active Ether
process: it opens a TCP listener, announces its presence through multicast
discovery, and connects to compatible peers announced on the same session.

If your SEN ether discovery port is configured through SEN's environment,
`sen-ether-client` reads the same variable:

```bash
export SEN_ETHER_DISCOVERY_PORT=60543
```

For machines with more than one network interface, select the multicast
interface explicitly with either its IPv4 address or interface name:

```js
const sen = await Sen.connect({ interfaceAddress: 'enp0s25' });
```

If your setup uses a SEN TCP discovery hub instead of multicast, pass it
explicitly:

```js
const sen = await Sen.connect({
  session: 'session',
  tcpHub: '127.0.0.1:65222'
});
```

With a `session` and `tcpHub`, `sen-ether-client` acts as an active Ether
process: it opens a TCP listener, announces a SEN presence beam to the hub, and
connects to compatible peers announced by the hub. This allows Node.js
producers and consumers to discover each other without a native SEN process
brokering their bus messages.

For local multicast tests, select loopback explicitly:

```js
const sen = await Sen.connect({
  session: 'session',
  interfaceAddress: '127.0.0.1',
  listenHost: '127.0.0.1',
  advertisedHost: '127.0.0.1'
});
```

Connected sessions are monitored through SEN ether presence beams. If the
remote process stops announcing itself for `presenceTimeoutMs` milliseconds
(default `5000`), the client closes the stale connection and restarts the
configured interests.

`sen-ether-client` can work with several SEN sessions from the same client. The session
is inferred from the query:

```js
const first = await sen.interest('SELECT * FROM session.bus');
const second = await sen.interest('SELECT * FROM otherSession.otherBus');
```

You can also navigate explicitly through sessions and buses:

```js
const sen = await Sen.connect();

console.log(sen.listSessions());
console.log(await sen.discoverBuses());
// [{ session: 'session', bus: 'bus', qualified: 'session.bus' }]

const session = await sen.session('session');
console.log(session.listBuses());

const bus = await session.bus('bus');
const object = await bus.waitFor('object-1');
```

`discoverBuses()` does not create interests and does not join any SEN bus. It
uses discovery to find sessions and opens lightweight process connections only
to read bus announcements. If buses are not announced immediately after the
process connection, it waits up to `busDiscoverySettleMs` milliseconds.

You can also connect to one explicit session:

```js
const session = await Sen.connect({
  session: 'session'
});

const objects = await session.interest('SELECT * FROM session.bus');
```

## Interests

Create an interest with a normal SEN query:

```js
const objects = await sen.interest('SELECT * FROM session.bus');
```

Listen for objects and changes:

```js
objects.on('object', object => {
  console.log(object.name, object.className);
});

objects.on('change', ({ object, name, value }) => {
  console.log(object.name, name, value);
});
```

For browser gateways or high-frequency telemetry, batch changes and decode only
the properties needed by the UI:

```js
const objects = await sen.interest('SELECT demo.Object FROM session.bus', {
  properties: ['latitude', 'longitude', 'altitude', 'heading'],
  changeMode: 'batch',
  coalesce: true
});

objects.on('changes', ({ changes }) => {
  websocket.send(JSON.stringify(changes.map(({ object, name, value, timestampNs }) => ({
    object: object.name,
    name,
    value,
    timestampNs: timestampNs?.toString()
  }))));
});
```

Get an object by name, id, class name, or predicate:

```js
const object = await objects.waitFor('object-1');

const firstDemoObject = await objects.waitFor(
  object => object.className === 'demo.Object'
);
```

## Publish objects

`sen-ether-client` can also act as a lightweight producer. The producer joins
the bus, publishes local objects to remote interests, and answers type/state
requests for those objects.

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect({
  session: 'session',
  tcpHub: '127.0.0.1:65222'
});

await sen.publishObjects('session.bus', {
  name: 'demo-counter',
  className: 'demo.Counter',
  properties: {
    label: 'Demo Counter',
    count: 1,
    running: true
  }
});
```

For exact SEN typing, pass a `spec` on each object and any dependent custom
types through `types`. This is required for structured values such as structs,
sequences, enums and variants.

## Objects

Read and write properties:

```js
const label = await probe.get('label');
await probe.set('label', 'ready');
```

Call methods:

```js
const result = await probe.call('ping', ['hello']);
```

Subscribe to property changes:

```js
probe.on('change:label', ({ value, previous, timestampNs }) => {
  console.log(previous, '->', value, timestampNs);
});
```

SEN timestamps are exposed as nanosecond `BigInt` values (`timestampNs`) so the
64-bit source timestamp is not rounded by JavaScript numbers.

Subscribe to SEN runtime events:

```js
probe.on('probeEvent', event => {
  console.log(event.args);
});
```

## CLI

List visible SEN processes:

```bash
npx sen-ether-scan --tcp-hub 127.0.0.1:65222 --timeout 3000
```

Probe a bus:

```bash
npx sen-ether-probe \
  --tcp-hub 127.0.0.1:65222 \
  --bus session.bus
```

## API

The public import is:

```js
import { Sen, SenInterest, SenRemoteObject } from 'sen-ether-client';
```

See [API.md](./API.md) for the complete public interface.
