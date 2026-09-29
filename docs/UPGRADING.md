# Updating from 0.8.0 to 0.8.1

No migration is required. Existing method calls keep a 5000 ms local response
timeout. Applications with slower methods can configure a default or override
one call:

```js
const sen = await Sen.connect({ methodTimeout: 30_000 });
await object.call('join', ['world1'], { timeout: 60_000 });
await object.set('selected', true, { timeout: 0 });
```

`timeout: 0` means no local method timer; connection or bus closure can still
reject the call. `SEN_METHOD_TIMEOUT` means only that no response arrived by the
local deadline. It does not cancel the remote operation or indicate a
disconnection, and a side-effecting operation may still complete. Audit broad
`catch`/`finally` cleanup that calls `leave()` or treats every method error as a
lost connection.

## Updating from 0.7.x to 0.8.0

The documented 0.7.7 API remains available. Existing `Sen.connect()`, interests,
remote objects and JavaScript publication code do not require a migration.

Changes to account for:

- malformed or excessive frames, strings, buffers, sequences and protocol
  state are rejected with `SEN_RESOURCE_LIMIT`; the responsible connection is
  closed;
- default limits are documented in [`API.md`](../API.md) and can be overridden through
  `resourceLimits` for legitimate large deployments;
- TypeScript resolves declarations from the root package export;
- automated tests no longer require multicast; actual multicast verification
  is opt-in;
- Node.js 22 remains the minimum supported runtime.

If an application legitimately sends frames over 16 MiB, set both
`maxFrameSize` and `maxReceiveBufferSize` (the latter must be at least the frame
limit plus the five-byte header). Observe `warning` events before raising a
limit: they include the resource, actual size and responsible connection.
