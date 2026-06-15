# sen-ether-client

JavaScript client for SEN from Node.js.

[SEN](https://github.com/airbus/sen) is a general-purpose, distributed,
object-oriented system for applications that demand high modularity and rich
communication.

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();

const diagnostics = await sen.interest('SELECT * FROM hmi.diagnostics');
const probe = await diagnostics.waitFor('EtherProbe');

probe.on('change:label', ({ value }) => {
  console.log('label changed:', value);
});

console.log(await probe.get('label'));
await probe.set('label', 'from-js');
console.log(await probe.call('ping', ['hello']));

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
  tcpHub: '127.0.0.1:65222'
});
```

`sen-ether-client` can work with several SEN sessions from the same client. The session
is inferred from the query:

```js
const hmi = await sen.interest('SELECT * FROM hmi.diagnostics');
const world = await sen.interest('SELECT * FROM world1.environment');
```

You can also navigate explicitly through sessions and buses:

```js
const sen = await Sen.connect();

console.log(sen.listSessions());

const hmi = await sen.session('hmi');
console.log(hmi.listBuses());

const diagnostics = await hmi.bus('diagnostics');
const probe = await diagnostics.waitFor('EtherProbe');
```

You can also connect to one explicit session:

```js
const hmi = await Sen.connect({
  session: 'hmi'
});

const diagnostics = await hmi.interest('SELECT * FROM hmi.diagnostics');
```

## Interests

Create an interest with a normal SEN query:

```js
const tracks = await sen.interest('SELECT * FROM world1.environment');
```

Listen for objects and changes:

```js
tracks.on('object', object => {
  console.log(object.name, object.className);
});

tracks.on('change', ({ object, name, value }) => {
  console.log(object.name, name, value);
});
```

For browser gateways or high-frequency telemetry, batch changes and decode only
the properties needed by the UI:

```js
const tracks = await sen.interest('SELECT hmi.tactical.BaseTrack FROM hmi.loadtest', {
  properties: ['latitude', 'longitude', 'altitude', 'trackHeading'],
  changeMode: 'batch',
  coalesce: true
});

tracks.on('changes', ({ changes }) => {
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
const aircraft = await tracks.waitFor('blue-air-1');

const firstAircraft = await tracks.waitFor(
  object => object.className === 'rpr.Aircraft'
);
```

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
  --bus hmi.diagnostics
```

## API

The public import is:

```js
import { Sen, SenInterest, SenRemoteObject } from 'sen-ether-client';
```

See [API.md](./API.md) for the complete public interface.
