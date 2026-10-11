# Compatibility policy

The package is pre-1.0. Public APIs are kept compatible within a minor line
when practical. A minor release may add options, events or stricter rejection
of malformed remote input. Removals or semantic changes require a changelog
entry and migration guidance.

## Supported and tested matrix

| Area | Declared / observed | Automated in this repository | External validation |
| --- | --- | --- | --- |
| Node.js | `>=22` | Node 22 and 24 on Linux and Windows | — |
| Sen 0.6.x | profile `legacy` (default) | codec, handshake and routing tests | kernel protocol 9 |
| Sen 0.7.0-rc3 | profile `enhanced` | framing/profile tests | discovery, interests and state updates exercised against the official RC3 binary |
| Kernel protocol | 9 or 11, selected by profile | codec, handshake and routing tests | exact match required |
| Ether protocol | 2 | codec, handshake and routing tests | real Sen run required |

Matching protocol numbers is necessary but not sufficient. A Sen release is
listed as compatible only after the integration harness has covered discovery,
interests, state/types, writes, methods, events, publication and reconnect.

The bus, Ether runtime and discovery message schemas used by these profiles are
shared by SEN 0.6.0 and 0.7.0-rc3. The `enhanced` profile additionally selects its
length-prefixed TCP discovery and reserved-aware multicast allocation.

## Platforms and networking

CI tests Linux and Windows. General tests are TCP-only and do not assume a
multicast-capable interface. Multicast discovery and native bus multicast need
an IPv4 multicast interface and are manual/opt-in (`npm run test:network`). A
TCP discovery hub supports networks and CI environments where multicast is not
available.

## Public API

The following are treated as public for 0.10.x:

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
- Patch or prerelease builds that change the kernel protocol require a matching
  profile; version-number proximity alone does not imply wire compatibility.
- Multicast behavior depends on host routing, interfaces and firewall policy.
- Type conversion follows the available TypeSpecs; applications must keep
  publisher and consumer schemas compatible.
- Resource limits may need increasing for unusually large TypeSpecs or object
  states.
