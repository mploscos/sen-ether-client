import {
  CPU_ARCH,
  ETHER_CONTROL_MESSAGE_KEY,
  ETHER_PROTOCOL_VERSION,
  KERNEL_PROTOCOL_VERSION,
  OS_KIND
} from './protocol/generated.js';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export { ETHER_CONTROL_MESSAGE_KEY, ETHER_PROTOCOL_VERSION, KERNEL_PROTOCOL_VERSION };

export const PROCESS_MESSAGE_CATEGORY = Object.freeze({
  busMessage: 0,
  controlMessage: 1
});

function enumCode(name, values, label) {
  const index = values.indexOf(name);
  if (index === -1) {
    throw new TypeError(`unknown SEN ${label}: ${name}`);
  }
  return index;
}

function controlTypeFromKey(key) {
  for (const [type, value] of Object.entries(ETHER_CONTROL_MESSAGE_KEY)) {
    if (value === key) {
      return type;
    }
  }
  return undefined;
}

/**
 * Minimal little-endian reader compatible with SEN InputStream.
 */
export class SenBinaryReader {
  /**
   * @param {Buffer | Uint8Array | ArrayBuffer} buffer
   */
  constructor(buffer) {
    this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.offset = 0;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  ensure(size) {
    if (this.remaining() < size) {
      throw new RangeError(`SEN buffer underflow at ${this.offset}; need ${size} bytes`);
    }
  }

  readUInt8() {
    this.ensure(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt16() {
    this.ensure(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt16() {
    this.ensure(2);
    const value = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt32() {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readInt32() {
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt64() {
    this.ensure(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readInt64() {
    this.ensure(8);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readFloat32() {
    this.ensure(4);
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  readFloat64() {
    this.ensure(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  readBool() {
    return this.readUInt8() !== 0;
  }

  readString() {
    const size = this.readUInt32();
    this.ensure(size);
    const value = textDecoder.decode(this.buffer.subarray(this.offset, this.offset + size));
    this.offset += size;
    return value;
  }

  readBuffer() {
    const size = this.readUInt32();
    this.ensure(size);
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
}

/**
 * Minimal little-endian writer compatible with SEN OutputStream.
 */
export class SenBinaryWriter {
  constructor() {
    this.chunks = [];
  }

  writeUInt8(value) {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value);
    this.chunks.push(buffer);
  }

  writeUInt16(value) {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16LE(value);
    this.chunks.push(buffer);
  }

  writeInt16(value) {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16LE(value);
    this.chunks.push(buffer);
  }

  writeUInt32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value >>> 0);
    this.chunks.push(buffer);
  }

  writeInt32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32LE(value);
    this.chunks.push(buffer);
  }

  writeUInt64(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64LE(BigInt(value));
    this.chunks.push(buffer);
  }

  writeInt64(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigInt64LE(BigInt(value));
    this.chunks.push(buffer);
  }

  writeFloat32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatLE(value);
    this.chunks.push(buffer);
  }

  writeFloat64(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value);
    this.chunks.push(buffer);
  }

  writeBool(value) {
    this.writeUInt8(value ? 1 : 0);
  }

  writeString(value) {
    const encoded = textEncoder.encode(String(value ?? ''));
    this.writeUInt32(encoded.length);
    if (encoded.length !== 0) {
      this.chunks.push(Buffer.from(encoded));
    }
  }

  writeBuffer(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
    this.writeUInt32(buffer.length);
    if (buffer.length !== 0) {
      this.chunks.push(buffer);
    }
  }

  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
export function uint32ToIpString(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join('.');
}

/**
 * @param {string} value
 * @returns {number}
 */
export function ipStringToUint32(value) {
  const parts = String(value).split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new TypeError(`invalid IPv4 address: ${value}`);
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

export function readProcessInfo(reader) {
  const hostId = reader.readUInt32();
  const processId = reader.readUInt32();
  const sessionId = reader.readUInt32();
  const sessionName = reader.readString();
  const appName = reader.readString();
  const hostName = reader.readString();
  const osKindCode = reader.readUInt8();
  const osName = reader.readString();
  const cpuArchCode = reader.readUInt8();

  return {
    hostId,
    processId,
    sessionId,
    sessionName,
    appName,
    hostName,
    osKindCode,
    osKind: OS_KIND[osKindCode] ?? `unknown:${osKindCode}`,
    osName,
    cpuArchCode,
    cpuArch: CPU_ARCH[cpuArchCode] ?? `unknown:${cpuArchCode}`
  };
}

export function writeProcessInfo(writer, info) {
  writer.writeUInt32(info.hostId);
  writer.writeUInt32(info.processId);
  writer.writeUInt32(info.sessionId);
  writer.writeString(info.sessionName);
  writer.writeString(info.appName);
  writer.writeString(info.hostName);
  writer.writeUInt8(info.osKindCode ?? enumCode(info.osKind, OS_KIND, 'OsKind'));
  writer.writeString(info.osName);
  writer.writeUInt8(info.cpuArchCode ?? enumCode(info.cpuArch, CPU_ARCH, 'CpuArch'));
}

function readProtocolVersion(reader) {
  return {
    kernel: reader.readUInt32(),
    ether: reader.readUInt32()
  };
}

function writeProtocolVersion(writer, version) {
  writer.writeUInt32(version.kernel);
  writer.writeUInt32(version.ether);
}

function readHello(reader) {
  return {
    info: readProcessInfo(reader),
    udpPort: reader.readUInt16(),
    version: readProtocolVersion(reader)
  };
}

function writeHello(writer, value) {
  writeProcessInfo(writer, value.info);
  writer.writeUInt16(value.udpPort);
  writeProtocolVersion(writer, value.version);
}

function readBusParticipantMessage(reader) {
  return {
    participantId: reader.readUInt32(),
    busId: reader.readUInt32(),
    busName: reader.readString()
  };
}

function writeBusParticipantMessage(writer, value) {
  writer.writeUInt32(value.participantId);
  writer.writeUInt32(value.busId);
  writer.writeString(value.busName);
}

/**
 * Encode sen.components.ether.ControlMessage.
 *
 * Source schema:
 * components/ether/stl/runtime.stl
 *
 * SEN generated serialization writes a u32 alternative key followed by the
 * selected struct payload.
 *
 * @param {{ type: 'Hello' | 'Ready' | 'BusJoined' | 'BusLeft', value?: object } | { Hello: object } | { Ready: object } | { BusJoined: object } | { BusLeft: object }} message
 */
export function encodeEtherControlMessage(message) {
  const type = message.type ?? Object.keys(message).find(key => key in ETHER_CONTROL_MESSAGE_KEY);
  const value = message.value ?? message[type] ?? {};

  if (!(type in ETHER_CONTROL_MESSAGE_KEY)) {
    throw new TypeError(`unknown SEN ether ControlMessage: ${type}`);
  }

  const writer = new SenBinaryWriter();
  writer.writeUInt32(ETHER_CONTROL_MESSAGE_KEY[type]);

  switch (type) {
    case 'Hello':
      writeHello(writer, value);
      break;
    case 'Ready':
      break;
    case 'BusJoined':
    case 'BusLeft':
      writeBusParticipantMessage(writer, value);
      break;
    default:
      throw new TypeError(`unhandled SEN ether ControlMessage: ${type}`);
  }

  return writer.toBuffer();
}

/**
 * Decode sen.components.ether.ControlMessage.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeEtherControlMessage(buffer) {
  const reader = new SenBinaryReader(buffer);
  const key = reader.readUInt32();
  const type = controlTypeFromKey(key);

  if (!type) {
    throw new RangeError(`unknown SEN ether ControlMessage key: ${key}`);
  }

  let value = {};
  switch (type) {
    case 'Hello':
      value = readHello(reader);
      break;
    case 'Ready':
      break;
    case 'BusJoined':
    case 'BusLeft':
      value = readBusParticipantMessage(reader);
      break;
    default:
      throw new TypeError(`unhandled SEN ether ControlMessage: ${type}`);
  }

  return {
    type,
    value,
    bytesRead: reader.offset
  };
}

/**
 * Encode the 5-byte ProcessHandler TCP frame header plus payload.
 *
 * Source implementation:
 * components/ether/src/process_handler.cpp
 *
 * @param {number} category
 * @param {Buffer | Uint8Array | ArrayBuffer} payload
 */
export function encodeProcessTcpFrame(category, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(category, 0);
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeProcessTcpHeader(buffer) {
  const frame = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (frame.length < 5) {
    throw new RangeError(`SEN TCP frame header needs 5 bytes; got ${frame.length}`);
  }
  return {
    category: frame.readUInt8(0),
    payloadSize: frame.readUInt32LE(1)
  };
}

function readEndpoint(reader) {
  const ip = reader.readUInt32();
  const port = reader.readUInt16();
  return {
    ip,
    host: uint32ToIpString(ip),
    port
  };
}

function writeEndpoint(writer, endpoint) {
  writer.writeUInt32(endpoint.ip ?? ipStringToUint32(endpoint.host));
  writer.writeUInt16(endpoint.port);
}

/**
 * Decode sen.components.ether.SessionPresenceBeam.
 *
 * Source schema:
 * components/ether/stl/discovery.stl
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 */
export function decodeSessionPresenceBeam(buffer) {
  const reader = new SenBinaryReader(buffer);
  const protocolVersion = reader.readUInt16();
  const info = readProcessInfo(reader);
  const beamPeriodNs = reader.readInt64();
  const endpointCount = reader.readUInt32();
  const endpoints = [];

  for (let i = 0; i < endpointCount; i += 1) {
    endpoints.push(readEndpoint(reader));
  }

  return {
    protocolVersion,
    info,
    beamPeriodNs,
    beamPeriodMs: Number(beamPeriodNs) / 1_000_000,
    endpoints,
    bytesRead: reader.offset
  };
}

/**
 * Encode sen.components.ether.SessionPresenceBeam. Mostly used by tests and
 * future active discovery mode.
 *
 * @param {object} beam
 */
export function encodeSessionPresenceBeam(beam) {
  const writer = new SenBinaryWriter();
  writer.writeUInt16(beam.protocolVersion);
  writeProcessInfo(writer, beam.info);
  writer.writeInt64(beam.beamPeriodNs);
  writer.writeUInt32(beam.endpoints?.length ?? 0);

  for (const endpoint of beam.endpoints ?? []) {
    writeEndpoint(writer, endpoint);
  }

  return writer.toBuffer();
}
