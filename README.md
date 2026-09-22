# sen-ether-client

Use SEN from Node.js without native bindings or a local SEN installation.

Connect to existing SEN sessions, read live objects, react to changes and
events, call methods, or publish JavaScript objects as regular SEN
participants.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/sen-ether-client)](./LICENSE)

**Pure JavaScript · ESM · Multi-session · STL and HLA FOM support · Automatic reconnect**

## Get started

Install the package:

```bash
npm install sen-ether-client
```

Then connect and create an interest:

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();

try {
  const board = await sen.interest('SELECT * FROM chess.board');
  const knight = await board.waitFor('white-knight-b1');

  console.log(knight.snapshot);

  knight.on('change:square', ({ value }) => {
    console.log('New square:', value);
  });
} finally {
  await sen.close();
}
```

In `chess.board`, `chess` is the SEN session and `board` is the bus. Discovery
uses SEN multicast by default and continues while the client is running.

## Work with a remote object

Once an object has been returned by `waitFor()` or `objects()`, the usual
operations are:

```js
console.log(object.name, object.className, object.snapshot);

object.on('change', change => console.log(change));
object.on('change:altitude', ({ value }) => console.log(value));
object.on('warningRaised', ({ args }) => console.log(args));

await object.set('selected', true);            // Writable STL property
const result = await object.call('reset', []); // SEN method
```

| Need | API |
| --- | --- |
| Current properties | `object.snapshot` |
| Property changes | `object.on('change:<name>', handler)` |
| SEN events | `object.on('<eventName>', handler)` |
| Writable property | `object.set(name, value)` |
| Method call | `object.call(name, args)` |

Values and arguments are decoded from the object's SEN type information.

## Publish a JavaScript object

Load your STL definitions and give the client a session. `publish()` returns a
handle that remains usable after an automatic reconnect.

```js
import { Sen } from 'sen-ether-client';

const types = await Sen.loadStl('./stl');
const sen = await Sen.connect({
  session: 'chess',
  announceDiscovery: true,
  types
});

try {
  let knight;
  knight = await sen.publish('board', {
    name: 'white-knight-b1',
    className: 'chess.Piece',
    properties: {
      color: 'white',
      kind: 'knight',
      square: 'b1'
    },
    methods: {
      async move(square) {
        await knight.update({ square });
        return true;
      }
    }
  });

  await knight.update({ square: 'c3' });
  await knight.emit('moved', ['b1', 'c3']);
} finally {
  await sen.close();
}
```

To native applications, the JavaScript publisher behaves like any other SEN
participant.

For buses in different sessions, use a qualified name such as `chess.board`.

## Connect in your environment

The default connection is enough when multicast discovery works:

```js
const sen = await Sen.connect();
```

To use one known session and network interface:

```js
const sen = await Sen.connect({
  session: 'chess',
  interfaceAddress: '192.0.2.10'
});
```

To use a TCP discovery hub:

```js
const sen = await Sen.connect({
  session: 'chess',
  tcpHub: '127.0.0.1:65222'
});
```

Useful navigation methods are:

```js
console.log(sen.listSessions());
console.log(sen.listBuses());
console.log(await sen.discoverBuses());
```

`Sen.connect()` waits until discovery is operational, not until a particular
producer exists. An interest can therefore be created before its producer
starts. See [connection and discovery options](./API.md#sen) for timeouts,
fixed targets, multicast settings and reconnect behaviour.

## Load application types

For consumers, type information is normally requested from the SEN publisher.
For publishers, load the STL used by the application:

```js
const types = await Sen.loadStl('./stl', {
  includePaths: ['./shared-stl']
});

const sen = await Sen.connect({ types });
```

A module-relative URL also works:

```js
const types = await Sen.loadStl(new URL('./stl', import.meta.url));
```

STL classes, inheritance, properties, methods, events and value types are
resolved automatically. HLA FOM XML layouts can be loaded with `Sen.loadFom()`
or imported from STL. This imports the FOM as SEN type information; it does not
join an HLA federation.

See [STL loading](./API.md#load-stl) and
[HLA FOM loading](./API.md#load-hla-fom-xml) for supported layouts and mapping
options.

## High-rate data

For tracks or telemetry, select only the properties you need and receive
batched changes:

```js
const tracks = await sen.interest('SELECT * FROM tactical.tracks', {
  properties: ['latitude', 'longitude', 'altitude'],
  changeMode: 'batch',
  coalesce: true
});

tracks.on('changes', ({ changes, dropped }) => {
  // Update the UI or forward one compact batch.
});
```

Queue limits, batch intervals and backpressure policies are described in the
[`SenInterest` reference](./API.md#seninterest).

## Command-line tools

Inspect the SEN environment without writing an application:

```bash
npx sen-ether-scan --timeout 3000
npx sen-ether-probe
npx sen-ether-probe --bus chess.board
```

Generate typed JavaScript helpers from an STL layout:

```bash
npx sen-stl-types ./stl --output ./stl.mjs
```

The generated module provides `publish<Class>()` and `waitFor<Class>()`
helpers with JSDoc typing. The [`examples/`](./examples) directory includes a
consumer, publisher, methods, events and a generated STL module.

## If an object does not appear

Check these first:

1. Use a session-qualified query: `SELECT * FROM session.bus`.
2. Confirm discovery with `npx sen-ether-scan`.
3. On a multi-interface machine, set `interfaceAddress` to the SEN interface.
4. Confirm the publisher uses the same STL revision as the consumer.
5. Use a TCP discovery hub if multicast is unavailable between hosts.

## Compatibility

| sen-ether-client | Node.js | SEN kernel | Ether |
| --- | --- | --- | --- |
| 0.7.x | >= 22 | 9 | 2 |

The protocol versions are checked during the handshake. The library has no
runtime dependencies.

## More documentation

- [Complete API reference](./API.md)
- [Runnable examples](./examples)
- Advanced browser-safe type inspection is available from
  `sen-ether-client/types`.
