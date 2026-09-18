# sen-ether-client

Use SEN from Node.js without native bindings.

Discover sessions and buses, consume live SEN objects, subscribe to changes and
events, call methods, write writable properties, and publish JavaScript objects
through the SEN Ether component.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/sen-ether-client)](./LICENSE)

**Pure JavaScript · No native bindings · No local SEN installation · Multi-session · STL/HLA FOM support · Automatic reconnect**

## Install

```bash
npm install sen-ether-client
```

## Capabilities

| Capability | Consumer | Publisher |
| --- | :---: | :---: |
| Objects | ✅ | ✅ |
| Property updates | ✅ | ✅ |
| Writable properties | ✅ | ✅ |
| Methods | call | expose |
| Events | listen | emit |
| STL types | ✅ | ✅ |
| HLA FOM XML types | ✅ | ✅ |
| Reconnect | ✅ | ✅ |

SEN kernel protocol **9** and Ether protocol **2** are supported and checked
during the handshake.

### SEN type model

The transport-independent type catalog and resolver are available from the
browser-safe `sen-ether-client/types` entry point. This entry point does not
load Ether sockets or discovery code.

```js
import { SenTypeCatalog, SenTypeResolver } from 'sen-ether-client/types';

const catalog = new SenTypeCatalog(typeDefinitions);
const types = new SenTypeResolver(catalog);
const definition = types.resolveValueDefinition({ type: 'demo.Position' });
```

`resolveValueDefinition()` and `resolveTypeDefinition(name, { unique: true })`
accept a short name only when it identifies one definition. Qualified names
should be used when independent packages declare the same short name.

The same entry point also exposes transport-neutral helpers for applications:
`DescribeSenPrimitive`, `DescribeSenQuantity`, `NormalizeSenUnit`,
`FormatSenUnit`, `ResolveSenPresentValueDefinition`, `ResolveSenValueSpec` and
`WalkSenValue`. UI-specific editor metadata intentionally lives in `@dep/sen`
rather than in this Ether client.

## Consume SEN objects

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();

try {
  const board = await sen.interest('SELECT * FROM chess.board');
  const knight = await board.waitFor('white-knight-b1');

  console.log(knight.snapshot);
  knight.on('change:square', ({ value }) => console.log(value));
  knight.on('moved', ({ args }) => console.log(args));
} finally {
  await sen.close();
}
```

`chess` is the session and `board` is the bus. One root `Sen` instance can
create interests across several sessions.

## Publish JavaScript objects

Load the application's STL definitions once. `publish()` resolves the class and
its dependent types, then returns a persistent handle that survives reconnects.

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
    properties: { color: 'white', kind: 'knight', square: 'b1' },
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

For multi-session publishing, use a qualified bus such as `chess.board`.

## Properties, methods and events

The consumer and publisher APIs mirror the three main SEN concepts:

| Concept | Publisher | Consumer |
| --- | --- | --- |
| Properties | Read `snapshot`; change one or more with `update({...})` | Read `snapshot`; listen with `on('change')` or `on('change:<property>')`; change one writable property with `set(name, value)` |
| Methods | Expose `methods: { <methodName>(...args) }` handlers | Invoke with `call('<methodName>', args)` and await the decoded result |
| Events | Send with `emit('<eventName>', args)` | Listen with `on('<eventName>')` or catch all with `on('event')` |

`update({...})` accepts a partial object containing only the properties that
changed. `set(name, value)` always targets one remote property and requires it
to be declared `writable` in STL. Method and event arguments are positional
arrays encoded according to their STL declarations.

### Properties

```js
// Publisher
await published.update({ square: 'c3' });

// Consumer
object.on('change:square', ({ value }) => console.log(value));
await object.set('square', 'd5'); // when STL declares it writable
```

Writable properties are handled automatically by the publisher. Define a
`setNextSquare` method only when custom validation or side effects are needed.

### Methods

```js
// Publisher
let published;
published = await sen.publish('board', {
  name: 'white-knight-b1',
  className: 'chess.Piece',
  properties: { square: 'b1' },
  methods: {
    async move(square) {
      await published.update({ square });
      return true;
    }
  }
});

// Consumer
const accepted = await object.call('move', ['c3']);
```

### Events

```js
// Publisher
await published.emit('moved', ['b1', 'c3']);

// Consumer
object.on('moved', ({ args, creationTimeNs }) => {
  const [from, to] = args;
});
```

Event names, inherited event specs, argument types, transport mode and member
IDs come from the published object's STL `ClassTypeSpec`.

## High-rate telemetry

Select only required properties and batch changes for UI or gateway workloads:

```js
const tracks = await sen.interest('SELECT * FROM tactical.tracks', {
  properties: ['latitude', 'longitude', 'altitude'],
  changeMode: 'batch',
  coalesce: true
});

tracks.on('changes', ({ changes, dropped }) => {
  // Forward one compact batch.
});
```

Queue size, interval and backpressure policies are configurable; see
[API.md](./API.md#seninterest).

## STL

```js
const types = await Sen.loadStl('./stl', {
  includePaths: ['./shared-stl']
});
const sen = await Sen.connect({ types });
```

Paths may be relative to the current working directory. A `file:` URL is also
accepted, which is convenient for paths relative to an ES module:

```js
const types = await Sen.loadStl(new URL('./stl', import.meta.url));
```

When a type registry is supplied, publishing rejects a `className` that is not
present in that registry. Without configured types, scalar-property inference
remains available for simple dynamic objects.

The parser supports classes and inheritance, properties, methods, events,
structs, enums, sequences, aliases, optionals, variants, quantities, namespaces
and imports. Imports ending in `.xml` are loaded as IEEE 1516.2-2010 HLA FOM
modules and converted to the same SEN type registry. Explicit TypeSpecs remain
supported, but most applications should load STL.

## HLA FOM XML

Load a FOM layout directly when no STL entry file is needed:

```js
const types = await Sen.loadFom('./fom', {
  mappingPaths: ['./application-mappings.xml']
});
const sen = await Sen.connect({ types });
```

`./fom` may be a module directory containing XML documents, a root containing
one directory per package, or one XML file in a SEN-style FOM layout. For an
XML import from STL, the imported file's parent directory is the package and
its grandparent is the layout root. XML files at that root are treated as SEN
mapping documents.

The loader supports FOM dependencies, basic and simple data, enumerations,
arrays, fixed and variant records, object classes, attributes, interactions,
optional semantics, transport modes, and SEN property/method/event mappings.
It imports the FOM as a SEN interface; it does not join an HLA federation or
implement HLA wire encoding.

## Sessions, buses and discovery

Without a fixed session or target, `await Sen.connect()` now means discovery is
operational, not that any producers have been found. Sessions are discovered
continuously; `listSessions()` may initially be empty. Interests wait independently
for their session, including producers started later, until `sen.close()` cancels
them. Set `sessionDiscoveryTimeoutMs` to a positive deadline if needed (default
`0`, unlimited). Transport/bus operation timeouts remain separate. Startup socket
or hub-connection failures reject `connect()` rather than reporting success.
For compatibility with the previous snapshot startup, set `progressiveDiscovery: false`.

Multicast discovery is the default. On multi-interface hosts, select the SEN
interface explicitly:

```js
const sen = await Sen.connect({
  session: 'chess',
  interfaceAddress: '192.0.2.10'
});
```

For a TCP discovery hub:

```js
const sen = await Sen.connect({
  session: 'chess',
  tcpHub: '127.0.0.1:65222'
});
```

Use `sen.listSessions()`, `sen.listBuses()` and `sen.discoverBuses()` for
navigation. `SEN_ETHER_DISCOVERY_PORT` changes the default discovery port.

## CLI

```bash
npx sen-ether-scan --timeout 3000
npx sen-ether-probe
npx sen-ether-probe --bus chess.board
npx sen-stl-types ./stl --output ./stl.mjs
```

Without `--bus`, `sen-ether-probe` connects to the selected process, prints its
announced buses and exits. Pass `--bus <name>` to join a bus and inspect its
objects.

`sen-stl-types` generates a self-contained ESM module with JSDoc types and one
pair of helpers per STL class: `publish<Class>()` and `waitFor<Class>()`. Use
`-I <directory>` (repeatable) for additional import paths.

The bundled Counter example includes its generated `stl.mjs`. Regenerate it
from the repository root with:

```bash
npx sen-stl-types ./examples/stl --output ./examples/stl.mjs
```

The generated helpers give JavaScript contextual typing without local JSDoc
imports or casts:

```js
// @ts-check
import { publishCounter } from './stl.mjs';

const counter = await publishCounter(sen, 'devices', {
  name: 'counter-1',
  className: 'demo.Counter',
  properties: { count: 0 },
  methods: {
    async increment(delta) {
      const count = this.state.count + delta;
      await this.update({ count });
      return count;
    }
  }
});
```

Consumers use the matching wait helper:

```js
import { waitForCounter } from './stl.mjs';

const counter = await waitForCounter(counters, 'counter-1');

counter.on('change:count', ({ value }) => console.log(value));
await counter.call('increment', [1]);
```

## Compatibility

| sen-ether-client | Node.js | SEN kernel | Ether |
| --- | --- | --- | --- |
| 0.4.x | >= 22 | 9 | 2 |

The library is JavaScript ESM and has no runtime dependencies.

## API reference and examples

See [API.md](./API.md) for the complete API and [`examples/`](./examples) for
small runnable consumer, publisher, method and event programs.
