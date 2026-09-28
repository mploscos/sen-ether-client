# Changelog

All notable changes are documented here. The project follows semantic version
intent while its public API remains pre-1.0.

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
