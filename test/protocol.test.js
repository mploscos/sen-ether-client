import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ETHER_CONTROL_MESSAGE_KEY,
  ETHER_PROTOCOL_VERSION,
  KERNEL_CONTROL_MESSAGE_KEY,
  KERNEL_PROTOCOL_VERSION
} from '../lib/protocol/generated.js';
import { resolveProtocolProfile } from '../lib/protocol/profiles.js';
import {
  computeBusMulticastGroup,
  encodeTcpDiscoveryBeam,
  extractTcpDiscoveryBeams
} from '../lib/ether-network.js';

test('generated protocol metadata matches bundled protocol pack', () => {
  const protocol = JSON.parse(fs.readFileSync(new URL('../resources/protocol/protocol.json', import.meta.url), 'utf8'));

  assert.equal(KERNEL_PROTOCOL_VERSION, protocol.kernelProtocolVersion);
  assert.equal(ETHER_PROTOCOL_VERSION, protocol.etherProtocolVersion);

  assert.deepEqual(ETHER_CONTROL_MESSAGE_KEY, {
    Hello: 0,
    Ready: 1,
    BusJoined: 2,
    BusLeft: 3
  });

  assert.deepEqual(KERNEL_CONTROL_MESSAGE_KEY, {
    RemoteParticipantReady: 0,
    InterestStarted: 1,
    InterestStopped: 2,
    ObjectsPublished: 3,
    ObjectsRemoved: 4,
    PublicationRejection: 5,
    ObjectsStateRequest: 6,
    ObjectsStateResponse: 7,
    TypesInfoRequest: 8,
    TypesInfoResponse: 9,
    TypesInfoRejection: 10
  });
});

test('SEN compatibility profiles select the released transport variants', () => {
  assert.deepEqual(
    [resolveProtocolProfile('legacy').kernelProtocolVersion, resolveProtocolProfile('enhanced').kernelProtocolVersion],
    [9, 11]
  );
  assert.equal(resolveProtocolProfile('enhanced').etherProtocolVersion, 2);
  assert.equal(resolveProtocolProfile('enhanced').tcpDiscoveryFraming, 'length-prefixed');
  assert.throws(() => resolveProtocolProfile('sen-0.7'), /unsupported SEN protocol profile/);
  assert.throws(() => resolveProtocolProfile(''), /unsupported SEN protocol profile/);
});

test('SEN 0.7 TCP discovery framing handles fragmented and coalesced records', () => {
  const first = Buffer.from([1, 2, 3]);
  const second = Buffer.from([4, 5]);
  const stream = Buffer.concat([
    encodeTcpDiscoveryBeam(first, 'length-prefixed'),
    encodeTcpDiscoveryBeam(second, 'length-prefixed')
  ]);
  const partial = extractTcpDiscoveryBeams(stream.subarray(0, 6), 'length-prefixed');
  assert.equal(partial.messages.length, 0);
  const complete = extractTcpDiscoveryBeams(
    Buffer.concat([partial.remaining, stream.subarray(6)]),
    'length-prefixed'
  );
  assert.deepEqual(complete.messages, [first, second]);
  assert.equal(complete.remaining.length, 0);
});

test('SEN 0.7 multicast allocation matches the official RC3 footprint', () => {
  const profile = resolveProtocolProfile('enhanced');
  assert.equal(computeBusMulticastGroup(
    1572376476,
    2702338936,
    60606,
    profile.busMulticastRange,
    {
      allocation: profile.busMulticastAllocation,
      exclusions: profile.busMulticastExclusions
    }
  ), '239.157.174.214');
});
