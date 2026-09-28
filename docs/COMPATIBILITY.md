# Compatibility policy

The package is pre-1.0. Public APIs are kept compatible within a minor line
when practical. A minor release may add options, events or stricter rejection
of malformed remote input. Removals or semantic changes require a changelog
entry and migration guidance.

## Supported and tested matrix

| Area | Declared / observed | Automated in this repository | External validation |
| --- | --- | --- | --- |
| Node.js | `>=22` | Node 22 and 24 on Linux and Windows | — |
| Sen current | not pinned | protocol fixtures and JS participant tests | requires `SEN_INTEGRATION_COMMAND` |
| Minimum Sen | not yet established by repeatable binary tests | no | candidate: Sen 0.6.0; unverified as a release guarantee |
| Kernel protocol | 9 | codec, handshake and routing tests | real Sen run required |
| Ether protocol | 2 | codec, handshake and routing tests | real Sen run required |

Matching protocol numbers is necessary but not sufficient. A Sen release is
listed as compatible only after the integration harness has covered discovery,
interests, state/types, writes, methods, events, publication and reconnect.

The protocol source files bundled for generation are byte-identical to Sen
0.6.0, but this is provenance rather than proof of runtime compatibility.

## Platforms and networking

CI tests Linux and Windows. General tests are TCP-only and do not assume a
multicast-capable interface. Multicast discovery and native bus multicast need
an IPv4 multicast interface and are manual/opt-in (`npm run test:network`). A
TCP discovery hub supports networks and CI environments where multicast is not
available.

## Public API

The following are treated as public for 0.8.x:

- the root exports `Sen`, `SenInterest`, `SenPublishedObject` and
  `SenRemoteObject`;
- documented methods, properties, events and connection/interest/publication
  options in [`API.md`](../API.md);
- subpaths `sen-ether-client/types` and
  `sen-ether-client/interest-query`;
- publishing plain JavaScript objects with STL or HLA FOM TypeSpecs;
- documented CLI commands and generated STL helper shape.

Files under `lib/`, wire codecs, internal maps and routing diagnostics are not
public API unless re-exported by a documented package entry point.

## Trust and deployment boundary

Sen Ether does not provide authentication, peer authorization or transport
encryption. `sen-ether-client` therefore assumes that discovered hubs and peers
belong to a trusted Sen network. Bind/listen addresses, firewalls, network
segmentation and encrypted tunnels remain deployment responsibilities.

The client validates remote frame lengths, nested buffer/string lengths and
sequence counts before allocating or iterating. It also bounds connections,
interests, pending requests, forwarded routes, transit calls and queued
pre-type state. A protocol violation emits a contextual warning and closes only
the responsible TCP connection.

These controls limit accidental or hostile resource consumption; they are not
an authentication system.

## Known limitations

- Ether provides no authentication or confidentiality. Use trusted networks or
  a protected tunnel and restrict listener exposure.
- Compatibility with Sen 0.6.0 and newer installations is not claimed until a
  real binary completes the documented matrix.
- Multicast behavior depends on host routing, interfaces and firewall policy.
- Type conversion follows the available TypeSpecs; applications must keep
  publisher and consumer schemas compatible.
- Resource limits may need increasing for unusually large TypeSpecs or object
  states.
