# Test and integration guide

## Test classes

| Class | Command | Requirements |
| --- | --- | --- |
| Unit/self-contained | `npm test` | Node.js; TCP loopback where socket tests are available |
| Open-handle guard | `npm run test:handles` | same as unit tests; fails if the child does not exit in time |
| Real Sen integration | `npm run test:integration:sen` | running Sen fixture; reconnect test can start its own command |
| External compatibility | `npm run test:compat` | an already running compatible RPR/Sen installation |
| Manual network | `npm run test:network` | multicast-capable interface |
| Stability/load | `npm run test:soak` | TCP loopback; duration controlled by environment |

Skipped integration tests always print the missing variable or capability.
They are not counted as evidence of compatibility.

## Real Sen harness

For the diagnostics fixture already running behind a TCP discovery hub:

```bash
SEN_TCP_HUB=127.0.0.1:65222 \
SEN_SESSION=hmi \
npm run test:integration:sen
```

Use `SEN_DISCOVERY=multicast` instead of `SEN_TCP_HUB` for multicast and set
`NODE_SEN_INTERFACE` when an explicit interface is needed. To opt into the
publication/topology test on a writable session, add:

```bash
SEN_INTEGRATION_PUBLISH=1 \
SEN_INTEGRATION_PUBLISH_BUS=js_integration \
SEN_INTEGRATION_SECONDARY_BUS=js_integration_secondary \
SEN_TCP_HUB=127.0.0.1:65222 \
SEN_SESSION=hmi \
npm run test:integration:sen
```

For restart/reconnect, provide the exact fixture command and selectors:

```bash
SEN_RECONNECT_COMMAND='/absolute/path/to/sen-fixture --config /absolute/path/to/config' \
SEN_RECONNECT_CWD=/absolute/path/to/working-directory \
SEN_RECONNECT_TCP_HUB=127.0.0.1:65222 \
SEN_RECONNECT_SESSION=hmi \
SEN_RECONNECT_INTEREST='SELECT * FROM hmi.diagnostics' \
SEN_RECONNECT_OBJECT=EtherProbe \
npm run test:integration:sen
```

Set `SEN_RECONNECT_PUBLISH_BUS` to include publication restoration in that run.
Other optional reconnect variables are documented directly in
`test/integration-reconnect.test.js` and include startup/operation timeouts,
additional interests, selected properties and batch mode.

For the external compatibility smoke test:

```bash
RPR_SEN_TCP_HUB=127.0.0.1:65222 \
RPR_SEN_SESSION=hmi \
RPR_SEN_INTEREST='SELECT * FROM hmi.tracks' \
npm run test:compat
```

Optional variables:

- `RPR_SEN_BUS`, `RPR_SEN_FORCE_BUS` and `RPR_SEN_TIMEOUT_MS` adjust the
  compatibility interest.

The diagnostics fixture is expected to expose `hmi.diagnostics/EtherProbe` as
described by the test. Together the opt-in tests cover discovery, interests,
decode, property writes, method calls, events, JavaScript publication,
coincident ObjectIds, simultaneous interests on multiple buses and reconnect.
The reconnect publication check runs only when its bus variable is set.
Self-contained routing tests additionally cover simultaneous state/type
requests and replaced connection generations.

To qualify a Sen version, record the Sen version/commit, OS, discovery mode,
kernel protocol, Ether protocol, command and complete test result. Run the same
matrix for the current version and the proposed minimum; do not infer
compatibility only from protocol numbers.

## Stability runs

The default soak is short and intended for CI:

```bash
npm run test:soak
```

For a one-minute local run:

```bash
SEN_SOAK_DURATION_MS=60000 npm run test:soak
```

The report includes operations, reconnects, heap change, listeners and pending
calls. A short run is not evidence of multi-hour stability.
