import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ETHER_CONTROL_MESSAGE_KEY,
  ETHER_PROTOCOL_VERSION,
  KERNEL_CONTROL_MESSAGE_KEY,
  KERNEL_PROTOCOL_VERSION
} from '../lib/protocol/generated.js';

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
