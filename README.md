# sen-ether-client

Connect Node.js applications to heterogeneous [Sen](https://github.com/airbus/sen) instances through the ether component. Read live data, subscribe to changes, call methods, write properties declared as writable, and publish JavaScript objects using Sen types. sen-ether-client is pure JavaScript, with no native bindings or local Sen installation required

## Install

```bash
npm install sen-ether-client
```

## Read Sen objects

Connect, create an interest, and wait for the object you need:

```js
import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();
const board = await sen.interest('SELECT * FROM chess.board');
const knight = await board.waitFor('white-knight-b1');

console.log(knight.snapshot.square);

knight.on('change:square', ({ value }) => {
  console.log('square:', value);
});

await sen.close();
```

The session and bus are the two parts of `chess.board`. A single `Sen` instance
can create interests in several sessions.

## Publish objects from STL

Load STL once, pass the resulting registry when connecting, then publish by
class name. The client finds the class and every type it depends on
automatically.

```js
import { Sen } from 'sen-ether-client';

const types = await Sen.loadStl('./stl');
const sen = await Sen.connect({
  session: 'chess',
  announceDiscovery: true,
  types
});

const knight = await sen.publish('board', {
  name: 'white-knight-b1',
  className: 'chess.Piece',
  properties: {
    color: 'white',
    kind: 'knight',
    square: 'b1'
  }
});

await knight.update({ square: 'c3' });
await knight.remove();
await sen.close();
```

`publish()` is the usual producer API. It returns a handle with `update(patch)`
and `remove()`, and retains the object if the local session reconnects. An
update sends only the properties in its patch; you do not need to repeat the
full object state.

With a root client that has no `session`, use a qualified bus name such as
`chess.board`. Its first segment is the session and the remaining segment is the
bus. This is useful when one process publishes in several Sen sessions.

### Writable properties

An STL property marked `writable` can be changed by a remote consumer without
adding a JavaScript method handler to the publisher:

```js
const board = await sen.interest('SELECT * FROM chess.board');
const knight = await board.waitFor('white-knight-b1');

await knight.set('square', 'c3');
```

The publisher updates the property and broadcasts its normal Sen update. Add a
`setNextSquare` handler only when the application needs custom validation or
side effects. Application commands such as `accept` or `delete` remain normal
methods under `methods` when publishing.

## Listen for updates

```js
const objects = await sen.interest('SELECT * FROM chess.board');

objects.on('object', object => {
  console.log('appeared:', object.name);
});

objects.on('change', ({ object, name, value }) => {
  console.log(object.name, name, value);
});

objects.on('remove', object => {
  console.log('removed:', object.name);
});
```

For high-rate data, request only the properties used by the UI and receive
batches:

```js
const objects = await sen.interest('SELECT * FROM chess.board', {
  properties: ['color', 'kind', 'square'],
  changeMode: 'batch',
  coalesce: true
});

objects.on('changes', ({ changes }) => {
  // Forward one compact update to a browser or another consumer.
});
```

## Connections

The default connection uses normal Sen multicast discovery. When Sen defines a
different discovery port, use the same environment variable:

```bash
export SEN_ETHER_DISCOVERY_PORT=60543
```

For local multicast testing, select loopback explicitly:

```js
const sen = await Sen.connect({
  session: 'chess',
  interfaceAddress: '127.0.0.1',
  listenHost: '127.0.0.1',
  advertisedHost: '127.0.0.1'
});
```

If the installation uses a TCP discovery hub instead, pass its address:

```js
const sen = await Sen.connect({
  session: 'chess',
  tcpHub: '127.0.0.1:65222'
});
```

## STL support

`Sen.loadStl()` accepts an STL file or directory and resolves imports before it
returns. The resulting registry is reusable for every publication. It supports
classes and inheritance, properties, methods, structs, enums, sequences,
aliases, optionals, variants, quantities, namespaces, imports, and qualified
names.

The normal workflow is simply:

```js
const types = await Sen.loadStl('./stl', {
  includePaths: ['./shared-stl']
});
const sen = await Sen.connect({ types });
```

You can still pass a `spec` or extra `types` directly when an application
builds TypeSpecs itself. Most applications do not need to do that.

## CLI

List visible Sen processes:

```bash
npx sen-ether-scan --timeout 3000
```

Inspect a bus:

```bash
npx sen-ether-probe --bus chess.board
```

## Compatibility

`sen-ether-client@0.3.x` supports Sen kernel protocol `9` and ether protocol
`2`. The versions are checked during the Sen handshake.

## API reference

See [API.md](./API.md) for all options and public methods.
