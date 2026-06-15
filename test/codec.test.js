import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBusMessage,
  decodeConfirmedBusFrame,
  decodeKernelControlMessage,
  decodePropertyUpdateBuffer,
  encodeBusControlMessage,
  encodeConfirmedBusFrame,
  encodeKernelControlMessage,
  encodeRuntimeMethodCall
} from '../lib/bus.js';
import {
  decodeArguments,
  decodeValue,
  encodeArguments,
  encodeValue
} from '../lib/values.js';
import {
  decodeEtherControlMessage,
  decodeProcessTcpHeader,
  decodeSessionPresenceBeam,
  encodeEtherControlMessage,
  encodeProcessTcpFrame,
  encodeSessionPresenceBeam,
  ipStringToUint32,
  PROCESS_MESSAGE_CATEGORY,
  SenBinaryWriter,
  uint32ToIpString
} from '../lib/codec.js';
import { crc32 } from '../lib/crc32.js';
import { propertyHash } from '../lib/hash32.js';

test('IPv4 conversion keeps SEN endpoint integer representation', () => {
  assert.equal(uint32ToIpString(0x7f000001), '127.0.0.1');
  assert.equal(ipStringToUint32('239.255.0.44'), 0xefff002c);
});

test('SessionPresenceBeam round-trips through SEN binary codec', () => {
  const input = {
    protocolVersion: 2,
    info: {
      hostId: 1234,
      processId: 5678,
      sessionId: 9012,
      sessionName: 'rpr',
      appName: 'producer',
      hostName: 'test-host',
      osKind: 'linuxOs',
      osName: 'Linux',
      cpuArch: 'x64'
    },
    beamPeriodNs: 1_000_000_000n,
    endpoints: [
      { host: '127.0.0.1', port: 42123 },
      { host: '10.1.2.3', port: 42124 }
    ]
  };

  const decoded = decodeSessionPresenceBeam(encodeSessionPresenceBeam(input));

  assert.equal(decoded.protocolVersion, 2);
  assert.equal(decoded.info.sessionName, 'rpr');
  assert.equal(decoded.info.appName, 'producer');
  assert.equal(decoded.info.osKind, 'linuxOs');
  assert.equal(decoded.info.cpuArch, 'x64');
  assert.equal(decoded.beamPeriodNs, 1_000_000_000n);
  assert.equal(decoded.beamPeriodMs, 1000);
  assert.deepEqual(decoded.endpoints.map(endpoint => endpoint.host), ['127.0.0.1', '10.1.2.3']);
});

test('crc32 matches SEN session id hashing', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32('rpr'), 0x39000cca);
});

test('Ether ControlMessage round-trips Hello', () => {
  const hello = {
    info: {
      hostId: 1,
      processId: 2,
      sessionId: crc32('rpr'),
      sessionName: 'rpr',
      appName: 'sen-ether-client',
      hostName: 'test-host',
      osKind: 'linuxOs',
      osName: 'Linux',
      cpuArch: 'x64'
    },
    udpPort: 42300,
    version: {
      kernel: 9,
      ether: 2
    }
  };

  const decoded = decodeEtherControlMessage(encodeEtherControlMessage({ type: 'Hello', value: hello }));

  assert.equal(decoded.type, 'Hello');
  assert.equal(decoded.value.info.sessionName, 'rpr');
  assert.equal(decoded.value.udpPort, 42300);
  assert.equal(decoded.value.version.kernel, 9);
  assert.equal(decoded.value.version.ether, 2);
});

test('Ether ControlMessage round-trips bus participant messages', () => {
  const joined = { participantId: 11, busId: 22, busName: 'RPR' };
  const left = { participantId: 11, busId: 22, busName: 'RPR' };

  assert.deepEqual(
    decodeEtherControlMessage(encodeEtherControlMessage({ type: 'BusJoined', value: joined })).value,
    joined
  );
  assert.deepEqual(
    decodeEtherControlMessage(encodeEtherControlMessage({ type: 'BusLeft', value: left })).value,
    left
  );
});

test('ProcessHandler TCP frame uses 5-byte header', () => {
  const payload = encodeEtherControlMessage({ type: 'Ready' });
  const frame = encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.controlMessage, payload);

  assert.equal(frame.length, 5 + payload.length);
  assert.deepEqual(decodeProcessTcpHeader(frame), {
    category: PROCESS_MESSAGE_CATEGORY.controlMessage,
    payloadSize: payload.length
  });
});

test('Kernel bus ControlMessage round-trips RemoteParticipantReady', () => {
  const decoded = decodeKernelControlMessage(encodeKernelControlMessage({
    type: 'RemoteParticipantReady',
    value: { id: 123 }
  }));

  assert.equal(decoded.type, 'RemoteParticipantReady');
  assert.equal(decoded.value.id, 123);
});

test('Kernel bus ControlMessage round-trips InterestStarted', () => {
  const decoded = decodeKernelControlMessage(encodeKernelControlMessage({
    type: 'InterestStarted',
    value: { query: 'type is RPR', id: 456 }
  }));

  assert.deepEqual(decoded.value, { query: 'type is RPR', id: 456 });
});

test('Confirmed bus frame wraps bus control message', () => {
  const message = encodeBusControlMessage({
    type: 'RemoteParticipantReady',
    value: { id: 10 }
  });
  const frame = encodeConfirmedBusFrame({
    to: 20,
    busId: crc32('RPR'),
    message
  });

  const decodedFrame = decodeConfirmedBusFrame(frame);
  const decodedMessage = decodeBusMessage(decodedFrame.message);

  assert.equal(decodedFrame.to, 20);
  assert.equal(decodedFrame.busId, crc32('RPR'));
  assert.equal(decodedMessage.categoryName, 'controlMessage');
  assert.equal(decodedMessage.control.type, 'RemoteParticipantReady');
  assert.equal(decodedMessage.control.value.id, 10);
});

test('Property update buffer decodes id-size-value entries', () => {
  const writer = new SenBinaryWriter();
  writer.writeUInt32(propertyHash('indicatedAirSpeed'));
  writer.writeUInt32(4);
  writer.writeFloat32(123.5);

  const updates = decodePropertyUpdateBuffer(writer.toBuffer());

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 0x80ff2a87);
  assert.equal(updates[0].size, 4);
  assert.equal(decodeValue(updates[0].value, 'f32'), 123.5);
});

test('Runtime method call frame follows SEN header layout', () => {
  const args = encodeArguments(['abc', 12.5], [
    { name: 'text', type: 'string' },
    { name: 'gain', type: 'f32' }
  ]);

  const message = encodeRuntimeMethodCall({
    ownerId: 10,
    objectId: 20,
    methodId: 30,
    ticketId: 40,
    argumentsBuffer: args
  });
  const decoded = decodeBusMessage(message);

  assert.equal(decoded.categoryName, 'runtimeMethodCallBestEffort');
  assert.deepEqual(decodeArguments(message.subarray(21), [
    { name: 'text', type: 'string' },
    { name: 'gain', type: 'f32' }
  ]), ['abc', 12.5]);
});

test('Runtime method response decodes success and return value buffer', () => {
  const writer = new SenBinaryWriter();
  writer.writeUInt8(4);
  writer.writeUInt8(0);
  writer.writeUInt32(20);
  writer.writeUInt32(40);
  writer.writeUInt32(4);
  writer.writeFloat32(7.25);

  const decoded = decodeBusMessage(writer.toBuffer());

  assert.equal(decoded.categoryName, 'runtimeMethodResponse');
  assert.equal(decoded.response.result, 'success');
  assert.equal(decoded.response.objectId, 20);
  assert.equal(decoded.response.ticketId, 40);
  assert.equal(decodeValue(decoded.response.returnValue, 'f32'), 7.25);
});

test('Runtime events decode producer, event id and argument buffer', () => {
  const args = encodeArguments([3], [{ name: 'count', type: 'u32' }]);
  const writer = new SenBinaryWriter();
  writer.writeUInt8(5);
  writer.writeUInt32(100);
  writer.writeUInt32(200);
  writer.writeInt64(300n);
  writer.writeUInt32(args.length);
  writer.chunks.push(args);

  const decoded = decodeBusMessage(writer.toBuffer());

  assert.equal(decoded.categoryName, 'runtimeEvents');
  assert.equal(decoded.events.length, 1);
  assert.equal(decoded.events[0].producerId, 100);
  assert.equal(decoded.events[0].eventId, 200);
  assert.deepEqual(decodeArguments(decoded.events[0].argumentsBuffer, [{ name: 'count', type: 'u32' }]), [3]);
});

test('SEN Buffer values round-trip as Node buffers', () => {
  const encoded = encodeValue(Buffer.from([1, 2, 3]), 'Buffer');
  const decoded = decodeValue(encoded, 'Buffer');

  assert.deepEqual([...decoded], [1, 2, 3]);
});

test('SEN VariantTypeSpec round-trips with explicit field type', () => {
  const typeRegistry = new Map([[
    'test.Payload',
    {
      qualifiedName: 'test.Payload',
      data: {
        type: 'VariantTypeSpec',
        value: {
          fields: [
            { key: 10, type: 'string', description: '' },
            { key: 20, type: 'u32', description: '' }
          ]
        }
      }
    }
  ]]);

  const encoded = encodeValue({ type: 'u32', value: 42 }, 'test.Payload', typeRegistry);
  const decoded = decodeValue(encoded, 'test.Payload', typeRegistry);

  assert.deepEqual(decoded, { key: 20, type: 'u32', value: 42 });
});
