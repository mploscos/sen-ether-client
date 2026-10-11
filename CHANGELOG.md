# Changelog

All notable changes are documented here. The project follows semantic version
intent while its public API remains pre-1.0.

## 0.10.0 - 2026-10-11

### Added

- Explicit `legacy` and `enhanced` protocol profiles. The enhanced profile supports kernel protocol 11, length-prefixed TCP discovery and the multicast allocation rules used by SEN 0.7.0-rc3.
- `SenInterest` now exposes handle-oriented live collection callbacks,
  `objectByName()`, `getObjectsBatchState()`, idempotent `release()` and exact
  native commit delivery through `onChanges()`.
- `SenRemoteObject` now exposes `onPropertyChanged()`, `onAnyChange()` and
  `onEventTriggered()` cancellation-based subscriptions alongside the existing
  EventEmitter API.
- Remote objects expose inherited properties, methods, events, class lineage
  and their referenced TypeSpecs without requiring consumers to walk the
  native bus registry.
- `Sen.listKnownTypes()` and `Sen.getType()` expose the TypeSpecs already known
  by joined buses.

### Changed

- An Ether object update is surfaced as one exact commit independently of the
  existing interval/size batching mode. This lets gateways forward one native
  commit without reconstructing it from individual property notifications.
- Releasing a high-level interest is idempotent and stops its native interest
  at most once.
- Interest removal callbacks receive the removal reason as a second argument,
  allowing adapters to distinguish reconnect invalidation from real removal.

### Compatibility

- `legacy` remains the default profile.
- Existing `change`, `change:<property>`, `changes`, object and event streams
  remain available. The new handle-oriented methods are additive.

## 0.9.0 - 2026-10-08

### Added

- The complete RPR FOM 2.0 XML module set is included in the npm package.
- `Sen.loadRprFom()` returns a process-cached type registry ready for standard
  RPR publications without requiring an external FOM directory.

### Compatibility

- Existing FOM and STL loading APIs are unchanged. Applications that use a
  custom RPR version can continue to call `Sen.loadFom()` explicitly.

## 0.8.2 - 2026-09-30

### Fixed

- Method calls no longer wait for nonexistent TypeSpecs when nested structs,
  quantities or other custom types reference any protocol primitive name, such
  as `float64Type`, `uint8Type`, `booleanType` or `timestampType`.
- Invalid object values supplied for enum arguments now fail with an explicit
  diagnostic describing the supported numeric-key and enumerator-name forms.

### Compatibility

- Method signatures and wire encoding are unchanged. Enum arguments continue to
  accept numeric keys and names, and complex struct arguments remain plain
  JavaScript objects whose fields follow their STL definitions.

## 0.8.1 - 2026-09-29

### Added

- `methodTimeout` configures the local method-response deadline, while a
  per-call `timeout` still takes precedence. `timeout: 0` disables the local
  timer.
- Method deadlines reject with `SEN_METHOD_TIMEOUT` and expose `method` and
  `timeout` fields.

### Fixed

- Method timeouts affect only their own pending ticket and do not close buses,
  interests or connections. Late responses remain safely ignored.
- Pending method timers are cleared on responses, send failures, bus/session
  closure, participant loss and reconnection preparation.

### Compatibility

- Existing `call()` and `set()` forms remain unchanged. Kernel protocol 9,
  Ether protocol 2 and the wire codecs are unchanged.

## 0.8.0 - 2026-09-28

### Added

- Generated TypeScript declarations for the main package export and a packed
  TypeScript/JavaScript consumer test.
- Configurable resource limits for remote frames, nested values, connections,
  interests, requests, routes, calls and queued state.
- Linux/Windows CI, lint, JSDoc/type checks, generated-protocol verification,
  package inspection and a short soak test.
- Architecture, compatibility, integration, trust boundary, upgrade and
  third-party documentation.

### Changed

- Large protocol modules are split along durable responsibilities: bus
  lifecycle, local publications, owner-scoped requests, remote objects and the
  TypeSpec/control/runtime codecs. Package exports and observable behavior stay
  compatible.
- New internal boundaries include JSDoc that feeds reproducible declarations.
- TCP-only tests explicitly disable multicast, and real multicast tests are
  opt-in with an explicit reason when unavailable.
- Invalid TCP input closes only its source connection and emits contextual
  diagnostics.
- `localSession: true` can start without multicast discovery.
- Protocol fixture provenance now identifies Sen 0.6.0 and its exact commit.

### Compatibility

- The 0.7.7 high-level API and JavaScript publication behavior are retained.
- Node.js 22 remains the minimum. Kernel protocol 9 and Ether protocol 2 remain
  the declared wire versions.
- Real Sen binary compatibility was not executed for this release candidate in
  environments where no binary was available; see `docs/INTEGRATION.md`.
