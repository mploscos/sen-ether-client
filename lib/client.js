import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import process from 'node:process';
import {
  decodeBusMessage,
  decodeConfirmedBusFrame,
  encodeBusControlMessage,
  encodeConfirmedBusFrame,
  encodeRuntimeMethodCall
} from './bus.js';
import { encodePropertyUpdateBuffer } from './values.js';
import {
  decodeEtherControlMessage,
  decodeProcessTcpHeader,
  decodeSessionPresenceBeam,
  encodeEtherControlMessage,
  encodeProcessTcpFrame,
  encodeSessionPresenceBeam,
  ETHER_PROTOCOL_VERSION,
  KERNEL_PROTOCOL_VERSION,
  PROCESS_MESSAGE_CATEGORY
} from './codec.js';
import { crc32 } from './crc32.js';

const LINUX_OS_KIND = 1;
const X64_CPU_ARCH = 1;
const DEFAULT_DISCOVERY_GROUP = '239.255.0.44';
const DEFAULT_DISCOVERY_PORT = 60543;
const DEFAULT_BUS_MULTICAST_PORT = 50985;
const TCP_DISCOVERY_BEAM_SIZE = 508;
const DEFAULT_BEAM_PERIOD_MS = 1000;
const BUS_HASH_SEED = 15071983;
const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;
const HASH_COMBINE_MAGIC = 0x9e3779b9;
const DEFAULT_MULTICAST_RANGE = Object.freeze([
  { min: 224, max: 239 },
  { min: 0, max: 255 },
  { min: 0, max: 255 },
  { min: 0, max: 255 }
]);

function randomUInt32() {
  return randomBytes(4).readUInt32LE(0);
}

function detectOsKind() {
  switch (process.platform) {
    case 'win32':
      return 0;
    case 'linux':
      return 1;
    case 'android':
      return 2;
    case 'darwin':
      return 3;
    default:
      return LINUX_OS_KIND;
  }
}

function detectCpuArch() {
  switch (process.arch) {
    case 'x64':
      return 1;
    case 'arm64':
      return 12;
    case 'arm':
      return 8;
    default:
      return X64_CPU_ARCH;
  }
}

function discoveryPortFromEnv() {
  const value = process.env.SEN_ETHER_DISCOVERY_PORT;
  if (!value) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid SEN discovery port in environment: ${value}`);
  }
  return port;
}

function resolveInterfaceAddress(value) {
  const text = String(value || '').trim();
  if (!text) {
    return undefined;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    return text;
  }

  const interfaces = os.networkInterfaces();
  const candidates = interfaces[text];
  if (!candidates) {
    return text;
  }

  const ipv4 = candidates.find(item => (item.family === 'IPv4' || item.family === 4) && !item.internal);
  if (!ipv4) {
    throw new Error(`network interface "${text}" has no non-internal IPv4 address`);
  }
  return ipv4.address;
}

function multicastInterfaceCandidates(interfaceAddress) {
  if (interfaceAddress) {
    return [interfaceAddress];
  }
  try {
    const addresses = [];
    for (const candidates of Object.values(os.networkInterfaces())) {
      for (const item of candidates ?? []) {
        if ((item.family === 'IPv4' || item.family === 4) && !item.internal && item.address) {
          addresses.push(item.address);
        }
      }
    }
    return [...new Set(addresses)];
  } catch {
    return [];
  }
}

function normalizeMulticastRange(value) {
  const ranges = Array.isArray(value) && value.length === 4 ? value : DEFAULT_MULTICAST_RANGE;
  return ranges.map((range, index) => {
    const fallback = DEFAULT_MULTICAST_RANGE[index];
    const min = Number(range?.min ?? fallback.min);
    const max = Number(range?.max ?? fallback.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 255 || min > max) {
      throw new Error(`invalid SEN bus multicast range at byte ${index}`);
    }
    return { min, max };
  });
}

function computeByte(range, hashByte) {
  const length = range.max - range.min;
  return length !== 0 ? range.min + (hashByte % length) : range.min;
}

function hashIntegral(value, byteSize) {
  let hash = FNV1A_OFFSET_BASIS;
  for (let shift = (byteSize - 1) * 8; shift >= 0; shift -= 8) {
    hash ^= (value >>> shift) & 0xff;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function combineHashed(seed, hashed) {
  return (seed ^ (
    (hashed + HASH_COMBINE_MAGIC + ((seed << 6) >>> 0) + (seed >>> 2)) >>> 0
  )) >>> 0;
}

function computeBusMulticastGroup(sessionId, busId, discoveryPort, ranges) {
  let hash = BUS_HASH_SEED;
  hash = combineHashed(hash, hashIntegral(sessionId >>> 0, 4));
  hash = combineHashed(hash, hashIntegral(busId >>> 0, 4));
  hash = combineHashed(hash, hashIntegral(discoveryPort >>> 0, 2));
  const bytes = [
    computeByte(ranges[0], hash & 0xff),
    computeByte(ranges[1], (hash >>> 8) & 0xff),
    computeByte(ranges[2], (hash >>> 16) & 0xff),
    computeByte(ranges[3], (hash >>> 24) & 0xff)
  ];
  return bytes.map((byte, index) => Math.min(Math.max(byte, ranges[index].min), ranges[index].max)).join('.');
}

function classSpecData(spec) {
  return spec?.data?.type === 'ClassTypeSpec' ? spec.data.value : undefined;
}

function localTypeSpec(typeRegistry, typeName) {
  return typeRegistry?.get?.(typeName) ?? typeRegistry?.[typeName];
}

function collectClassProperties(spec, typeRegistry, seen = new Set()) {
  const data = classSpecData(spec);
  const key = spec?.qualifiedName ?? spec?.name;
  if (!data || seen.has(key)) {
    return [];
  }
  seen.add(key);
  return [
    ...(data.parents ?? []).flatMap(parent => collectClassProperties(localTypeSpec(typeRegistry, parent), typeRegistry, seen)),
    ...(data.properties ?? [])
  ];
}

function inferValueType(value) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'i64' : 'f64';
  if (typeof value === 'bigint') return 'i64';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) return 'Buffer';
  if (typeof value === 'string' || value === null || value === undefined) return 'string';
  throw new TypeError('cannot infer SEN type for structured value; pass an explicit spec and dependent types');
}

function ensureClassSpec(className, state = {}, spec) {
  if (spec) return spec;
  const properties = Object.entries(state || {}).map(([name, value]) => ({
    name,
    description: '',
    category: 'dynamicRO',
    type: inferValueType(value),
    transportMode: 'confirmed',
    tags: [],
    checkedSet: false
  }));
  return {
    name: String(className || '').split('.').pop() || String(className || ''),
    qualifiedName: className,
    description: '',
    data: {
      type: 'ClassTypeSpec',
      value: {
        properties,
        methods: [],
        events: [],
        constructor: { name: '', description: '', args: [], returnType: '' },
        parents: [],
        isInterface: false
      }
    }
  };
}

function normalizeTypeDefinitions(typeDefinitions = []) {
  const values = typeDefinitions instanceof Map
    ? [...typeDefinitions.values()]
    : Array.isArray(typeDefinitions)
      ? typeDefinitions
      : Object.values(typeDefinitions || {});
  return values.filter(Boolean);
}

function processKeyFromInfo(info = {}) {
  return `${info.hostId}:${info.processId}:${info.sessionId}`;
}

function isSameProcessInfo(a = {}, b = {}) {
  return (
    (a.hostId >>> 0) === (b.hostId >>> 0) &&
    (a.processId >>> 0) === (b.processId >>> 0) &&
    (a.sessionId >>> 0) === (b.sessionId >>> 0)
  );
}

function firstAdvertisableAddress(interfaceAddress) {
  if (interfaceAddress && interfaceAddress !== '0.0.0.0') {
    return interfaceAddress;
  }
  for (const candidates of Object.values(os.networkInterfaces())) {
    for (const item of candidates ?? []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && item.address) {
        return item.address;
      }
    }
  }
  return '127.0.0.1';
}

function parseHostPort(value, fallbackPort) {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'object') {
    return { host: value.host ?? '127.0.0.1', port: Number(value.port ?? fallbackPort) };
  }
  const text = String(value).trim();
  const idx = text.lastIndexOf(':');
  if (idx <= 0) {
    return { host: text || '127.0.0.1', port: Number(fallbackPort) };
  }
  return { host: text.slice(0, idx), port: Number(text.slice(idx + 1)) };
}

function padDiscoveryBeam(buffer) {
  if (buffer.length > TCP_DISCOVERY_BEAM_SIZE) {
    throw new Error(`SEN discovery beam is too large: ${buffer.length} > ${TCP_DISCOVERY_BEAM_SIZE}`);
  }
  if (buffer.length === TCP_DISCOVERY_BEAM_SIZE) {
    return buffer;
  }
  const padded = Buffer.alloc(TCP_DISCOVERY_BEAM_SIZE);
  Buffer.from(buffer).copy(padded);
  return padded;
}

function withCloseTimeout(register, timeoutMs = 1000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try {
      register(finish);
    } catch {
      finish();
    }
  });
}

function buildLocalObject(input, typeRegistry) {
  const className = String(input.className ?? input.classname ?? input.type ?? '').trim();
  if (!className) {
    throw new TypeError('SEN published object requires className');
  }
  const name = String(input.name ?? '').trim();
  if (!name) {
    throw new TypeError('SEN published object requires name');
  }
  const id = input.id ?? crc32(name);
  const typeHash = input.typeHash ?? crc32(className);
  const state = input.state ?? input.snapshot ?? input.properties ?? {};
  const spec = ensureClassSpec(className, state, input.spec);
  const registry = new Map(typeRegistry);
  registry.set(spec.qualifiedName, spec);
  const properties = collectClassProperties(spec, registry);
  const stateBuffer = input.stateBuffer
    ? Buffer.from(input.stateBuffer)
    : encodePropertyUpdateBuffer(
      properties
        .filter(property => Object.prototype.hasOwnProperty.call(state, property.name))
        .map(property => ({ name: property.name, type: property.type, value: state[property.name] })),
      registry
    );

  return {
    id: id >>> 0,
    name,
    className,
    typeHash: typeHash >>> 0,
    spec,
    state,
    stateBuffer,
    timestamp: input.timestamp ?? input.time ?? BigInt(Date.now()) * 1_000_000n
  };
}

/**
 * Create a ProcessInfo compatible with sen::kernel::getOwnProcessInfo.
 *
 * @param {object} options
 * @param {string} options.sessionName
 * @param {string} [options.appName]
 * @param {string} [options.hostName]
 * @param {number} [options.hostId]
 * @param {number} [options.processId]
 */
export function createProcessInfo(options) {
  const hostName = options.hostName ?? os.hostname();
  const sessionName = options.sessionName ?? '';
  return {
    hostId: options.hostId ?? crc32(hostName),
    processId: options.processId ?? randomUInt32(),
    sessionId: crc32(sessionName),
    sessionName,
    appName: options.appName ?? 'sen-ether-client',
    hostName,
    osKindCode: options.osKindCode ?? detectOsKind(),
    osName: options.osName ?? `${os.type()} ${os.release()}`,
    cpuArchCode: options.cpuArchCode ?? detectCpuArch()
  };
}

export function validateRemoteHello(hello, options, processInfo) {
  if (hello.info.sessionId !== processInfo.sessionId) {
    throw new Error(
      `remote SEN session mismatch: expected ${processInfo.sessionName} (${processInfo.sessionId}), ` +
      `got ${hello.info.sessionName} (${hello.info.sessionId})`
    );
  }

  if (hello.version.kernel !== options.kernelProtocolVersion) {
    throw new Error(
      `remote SEN kernel protocol ${hello.version.kernel} is incompatible with ${options.kernelProtocolVersion}`
    );
  }

  if (hello.version.ether !== options.etherProtocolVersion) {
    throw new Error(
      `remote SEN ether protocol ${hello.version.ether} is incompatible with ${options.etherProtocolVersion}`
    );
  }
}

/**
 * Minimal SEN ether process connection.
 *
 * Events:
 * - `remoteProcess`: remote Hello received.
 * - `ready`: remote Ready received.
 * - `controlMessage`: decoded ether ControlMessage.
 * - `busJoined` / `busLeft`: remote process joined/left a bus.
 * - `busFrame`: raw process-level bus frame payload, not decoded yet.
 * - `close`, `error`.
 */
export class EtherClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.sessionName SEN session name. Must match the remote kernel.
 * @param {string} [options.appName]
 * @param {number} [options.kernelProtocolVersion]
 * @param {number} [options.etherProtocolVersion]
 * @param {boolean} [options.socketKeepAlive]
 * @param {number} [options.socketKeepAliveInitialDelayMs]
 * @param {number} [options.socketIdleTimeoutMs]
 */
  constructor(options) {
    super();
    if (!options?.sessionName) {
      throw new TypeError('EtherClient requires options.sessionName');
    }

    this.options = {
      appName: 'sen-ether-client',
      kernelProtocolVersion: KERNEL_PROTOCOL_VERSION,
      etherProtocolVersion: ETHER_PROTOCOL_VERSION,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: 1000,
      socketIdleTimeoutMs: 0,
      group: DEFAULT_DISCOVERY_GROUP,
      bindAddress: undefined,
      discoveryPort: discoveryPortFromEnv() ?? DEFAULT_DISCOVERY_PORT,
      tcpHub: undefined,
      listen: true,
      listenHost: '0.0.0.0',
      listenPort: 0,
      advertisedHost: undefined,
      beamPeriodMs: DEFAULT_BEAM_PERIOD_MS,
      busMulticastPort: DEFAULT_BUS_MULTICAST_PORT,
      busMulticastRange: DEFAULT_MULTICAST_RANGE,
      ...options
    };
    this.options.discoveryPort ??= discoveryPortFromEnv() ?? DEFAULT_DISCOVERY_PORT;
    this.options.busMulticastPort ??= DEFAULT_BUS_MULTICAST_PORT;
    this.options.busMulticastRange ??= DEFAULT_MULTICAST_RANGE;
    this.processInfo = createProcessInfo(this.options);
    this.interfaceAddress = resolveInterfaceAddress(this.options.interfaceAddress);
    this.busMulticastRange = normalizeMulticastRange(this.options.busMulticastRange);
    this.socket = undefined;
    this.udpSocket = undefined;
    this.server = undefined;
    this.discoverySocket = undefined;
    this.discoveryReceiveBuffer = Buffer.alloc(0);
    this.discoveryTimer = undefined;
    this.multicastDiscoverySocket = undefined;
    this.multicastDiscoveryTimer = undefined;
    this.connections = new Map();
    this.connectionsByProcessKey = new Map();
    this.nextConnectionId = 1;
    this.listenEndpoint = undefined;
    this.receiveBuffer = Buffer.alloc(0);
    this.remoteProcessInfo = undefined;
    this.ready = false;
    this.buses = new Map();
    this.remoteParticipantsByBusId = new Map();
  }

  /**
   * Start this JS process as an active Ether node.
   *
   * It opens a TCP listener for process-to-process traffic and, when `tcpHub`
   * is configured, beams its presence to the hub while connecting to compatible
   * remote processes announced by the hub.
   */
  async start(options = {}) {
    const config = { ...this.options, ...options };
    this.options = config;
    this.interfaceAddress = resolveInterfaceAddress(this.options.interfaceAddress);
    if (config.listen !== false && !this.server) {
      await this.#startServer(config);
    }
    if (config.tcpHub && !this.discoverySocket) {
      await this.#startTcpDiscovery(config);
    }
    if (!config.tcpHub && config.multicastDiscovery !== false && !this.multicastDiscoverySocket) {
      await this.#startMulticastDiscovery(config);
    }
    return this;
  }

  async #startServer(config) {
    const server = net.createServer(socket => {
      const connection = this.#registerSocket(socket, { incoming: true });
      this.#configureTcpSocket(socket);
      this.#sendHello(connection);
    });
    this.server = server;
    server.on('error', error => this.emit('error', error));

    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : config.listenPort;
        const listenHost = config.listenHost ?? '0.0.0.0';
        this.listenEndpoint = {
          host: config.advertisedHost ?? (listenHost === '0.0.0.0' || listenHost === '::'
            ? firstAdvertisableAddress(this.interfaceAddress)
            : listenHost),
          port
        };
        this.emit('listening', this.listenEndpoint);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.listenPort ?? 0, config.listenHost ?? '0.0.0.0');
    });
  }

  async #startTcpDiscovery(config) {
    const hub = parseHostPort(config.tcpHub, 64222);
    if (!hub?.host || !Number.isInteger(hub.port) || hub.port <= 0) {
      throw new Error(`invalid SEN TCP discovery hub: ${config.tcpHub}`);
    }
    const socket = net.createConnection({ host: hub.host, port: hub.port });
    this.discoverySocket = socket;
    socket.on('data', chunk => this.#onDiscoveryData(chunk));
    socket.on('close', hadError => {
      if (this.discoverySocket === socket) {
        this.discoverySocket = undefined;
      }
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
        this.discoveryTimer = undefined;
      }
      this.emit('discoveryClose', hadError);
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        socket.on('error', error => this.emit('error', error));
        this.#sendDiscoveryBeam();
        const period = Math.max(100, Number(config.beamPeriodMs ?? DEFAULT_BEAM_PERIOD_MS));
        this.discoveryTimer = setInterval(() => this.#sendDiscoveryBeam(), period);
        this.discoveryTimer.unref?.();
        this.emit('discoveryConnect', hub);
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  async #startMulticastDiscovery(config) {
    if (!this.listenEndpoint) {
      return;
    }
    const group = config.group ?? DEFAULT_DISCOVERY_GROUP;
    const port = config.port ?? config.discoveryPort ?? this.options.discoveryPort;
    const bindAddress = config.bindAddress ?? (process.platform === 'win32' ? undefined : group);
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.multicastDiscoverySocket = socket;
    socket.on('message', (message, remote) => this.#onMulticastDiscoveryMessage(message, remote));
    socket.on('error', error => this.emit('error', error));

    await new Promise((resolve, reject) => {
      const onError = error => {
        socket.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        socket.off('error', onError);
        try {
          const interfaces = multicastInterfaceCandidates(this.interfaceAddress);
          if (interfaces.length) {
            let joined = 0;
            let firstError;
            for (const interfaceAddress of interfaces) {
              try {
                socket.addMembership(group, interfaceAddress);
                joined += 1;
              } catch (error) {
                firstError ??= error;
              }
            }
            if (!joined) {
              throw firstError ?? new Error(`could not join multicast group ${group}`);
            }
          } else {
            socket.addMembership(group);
          }
          socket.setMulticastLoopback(true);
          if (this.interfaceAddress) {
            socket.setMulticastInterface(this.interfaceAddress);
          }
          this.#sendMulticastDiscoveryBeam();
          const period = Math.max(100, Number(config.beamPeriodMs ?? DEFAULT_BEAM_PERIOD_MS));
          this.multicastDiscoveryTimer = setInterval(() => this.#sendMulticastDiscoveryBeam(), period);
          this.multicastDiscoveryTimer.unref?.();
          this.emit('multicastDiscoveryStart', { group, port });
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(port, bindAddress);
    });
  }

  #discoveryBeamBuffer({ padded = false } = {}) {
    const beam = encodeSessionPresenceBeam({
      protocolVersion: this.options.etherProtocolVersion,
      info: this.processInfo,
      beamPeriodNs: BigInt(Math.max(100, Number(this.options.beamPeriodMs ?? DEFAULT_BEAM_PERIOD_MS))) * 1_000_000n,
      endpoints: [this.listenEndpoint]
    });
    return padded ? padDiscoveryBeam(beam) : beam;
  }

  #sendDiscoveryBeam() {
    if (!this.discoverySocket || this.discoverySocket.destroyed || !this.listenEndpoint) {
      return;
    }
    this.discoverySocket.write(this.#discoveryBeamBuffer({ padded: true }), error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #sendMulticastDiscoveryBeam() {
    const socket = this.multicastDiscoverySocket;
    if (!socket || !this.listenEndpoint) {
      return;
    }
    const group = this.options.group ?? DEFAULT_DISCOVERY_GROUP;
    const port = this.options.port ?? this.options.discoveryPort;
    const beam = this.#discoveryBeamBuffer();
    socket.send(beam, port, group, error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #onDiscoveryData(chunk) {
    this.discoveryReceiveBuffer = Buffer.concat([this.discoveryReceiveBuffer, chunk]);
    while (this.discoveryReceiveBuffer.length >= TCP_DISCOVERY_BEAM_SIZE) {
      const message = this.discoveryReceiveBuffer.subarray(0, TCP_DISCOVERY_BEAM_SIZE);
      this.discoveryReceiveBuffer = this.discoveryReceiveBuffer.subarray(TCP_DISCOVERY_BEAM_SIZE);
      this.#onDiscoveryBeam(message);
    }
  }

  #onDiscoveryBeam(message) {
    let beam;
    try {
      beam = decodeSessionPresenceBeam(message);
    } catch (error) {
      this.emit('decodeError', error, message);
      return;
    }
    if (beam.info.sessionId !== this.processInfo.sessionId || isSameProcessInfo(beam.info, this.processInfo)) {
      return;
    }
    const key = processKeyFromInfo(beam.info);
    this.emit('beam', beam);
    if (this.connectionsByProcessKey.has(key)) {
      return;
    }
    const endpoint = beam.endpoints?.[0];
    if (!endpoint) {
      return;
    }
    this.connect({ ...beam, info: beam.info, endpoints: beam.endpoints }).catch(error => this.emit('warning', error));
  }

  #onMulticastDiscoveryMessage(message, remote) {
    let beam;
    try {
      beam = decodeSessionPresenceBeam(message);
    } catch (error) {
      this.emit('decodeError', error, message, remote);
      return;
    }
    if (beam.info.sessionId !== this.processInfo.sessionId || isSameProcessInfo(beam.info, this.processInfo)) {
      return;
    }
    const key = processKeyFromInfo(beam.info);
    this.emit('beam', beam);
    if (this.connectionsByProcessKey.has(key)) {
      return;
    }
    if (!beam.endpoints?.length) {
      return;
    }
    this.connect({ ...beam, info: beam.info, endpoints: beam.endpoints }).catch(error => this.emit('warning', error));
  }

  /**
   * Connect to one endpoint from a SessionPresenceBeam process entry.
   *
   * @param {{ endpoints?: Array<{ host: string, port: number }>, info?: object } | { host: string, port: number }} target
   */
  async connect(target) {
    const endpoint = target.host ? target : target.endpoints?.[0];
    if (!endpoint) {
      throw new TypeError('SEN ether target must contain host/port or at least one endpoint');
    }

    if (!this.udpSocket) {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.on('message', message => this.#onBusFrame(message));
      this.udpSocket.on('error', error => this.emit('error', error));
      await new Promise((resolve, reject) => {
        const onError = error => {
          this.udpSocket?.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.udpSocket?.off('error', onError);
          resolve();
        };
        this.udpSocket.once('error', onError);
        this.udpSocket.once('listening', onListening);
        this.udpSocket.bind(0);
      });
    }

    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const connection = this.#registerSocket(socket, { target, incoming: false });

    await new Promise((resolve, reject) => {
      const onError = error => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        socket.on('error', error => this.emit('error', error));
        this.#configureTcpSocket(socket);
        try {
          this.#sendHello(connection);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });

    return this;
  }

  #registerSocket(socket, metadata = {}) {
    const connection = {
      id: this.nextConnectionId++,
      socket,
      incoming: Boolean(metadata.incoming),
      target: metadata.target,
      receiveBuffer: Buffer.alloc(0),
      remoteProcessInfo: metadata.target?.info,
      ready: false
    };
    this.connections.set(connection.id, connection);
    if (!this.socket) {
      this.socket = socket;
    }
    socket.on('data', chunk => this.#onTcpData(connection, chunk));
    socket.on('close', hadError => {
      this.#removeConnection(connection);
      this.emit('connectionClose', { connection, hadError });
      if (!this.connections.size) {
        this.ready = false;
        this.emit('close', hadError);
      }
    });
    return connection;
  }

  #removeConnection(connection) {
    this.connections.delete(connection.id);
    if (connection.processKey) {
      this.connectionsByProcessKey.delete(connection.processKey);
    }
    for (const [busId, participants] of this.remoteParticipantsByBusId) {
      for (const [participantId, participant] of participants) {
        if (participant.connection === connection) {
          participants.delete(participantId);
        }
      }
      if (!participants.size) {
        this.remoteParticipantsByBusId.delete(busId);
      }
    }
    for (const busState of this.buses.values()) {
      for (const [key, interest] of busState.remoteInterests) {
        if (interest.connection === connection) {
          busState.remoteInterests.delete(key);
        }
      }
    }
    if (this.socket === connection.socket) {
      this.socket = [...this.connections.values()][0]?.socket;
    }
  }

  #configureTcpSocket(socket) {
    if (!socket) {
      return;
    }
    if (this.options.socketKeepAlive !== false) {
      socket.setKeepAlive(true, this.options.socketKeepAliveInitialDelayMs ?? 1000);
    }
    if (this.options.socketIdleTimeoutMs > 0) {
      socket.setTimeout(this.options.socketIdleTimeoutMs, () => {
        const error = new Error(`SEN ether TCP socket idle timeout after ${this.options.socketIdleTimeoutMs}ms`);
        error.code = 'SEN_TCP_IDLE_TIMEOUT';
        socket.destroy(error);
      });
    }
  }

  async close() {
    const sockets = [...this.connections.values()].map(connection => connection.socket);
    this.connections.clear();
    this.connectionsByProcessKey.clear();
    this.socket = undefined;
    const udpSocket = this.udpSocket;
    this.udpSocket = undefined;
    const server = this.server;
    this.server = undefined;
    const discoverySocket = this.discoverySocket;
    this.discoverySocket = undefined;
    const multicastDiscoverySocket = this.multicastDiscoverySocket;
    this.multicastDiscoverySocket = undefined;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
    if (this.multicastDiscoveryTimer) {
      clearInterval(this.multicastDiscoveryTimer);
      this.multicastDiscoveryTimer = undefined;
    }

    const closing = [];
    for (const socket of sockets) {
      if (socket && !socket.destroyed) {
        closing.push(withCloseTimeout(resolve => {
          socket.once('close', resolve);
          socket.destroy();
        }));
      }
    }
    if (server) {
      server.closeAllConnections?.();
      closing.push(withCloseTimeout(resolve => {
        server.close(resolve);
      }));
    }
    if (discoverySocket && !discoverySocket.destroyed) {
      closing.push(withCloseTimeout(resolve => {
        discoverySocket.once('close', resolve);
        discoverySocket.destroy();
      }));
    }
    if (multicastDiscoverySocket) {
      closing.push(withCloseTimeout(resolve => {
        multicastDiscoverySocket.close(resolve);
      }));
    }
    if (udpSocket) {
      closing.push(withCloseTimeout(resolve => {
        udpSocket.close(resolve);
      }));
    }
    for (const busState of this.buses.values()) {
      if (busState.multicastSocket) {
        closing.push(withCloseTimeout(resolve => {
          busState.multicastSocket.close(resolve);
        }));
      }
    }
    this.buses.clear();

    await Promise.allSettled(closing);
  }

  /**
   * Announce a JS participant on a SEN bus.
   *
   * @param {string} busName
   * @param {{ participantId?: number }} [options]
   */
  async joinBus(busName, options = {}) {
    if (!this.connections.size && !this.server) {
      throw new Error('EtherClient is not connected or started');
    }

    const busId = crc32(busName);
    const existing = this.buses.get(busId);
    if (existing) {
      return {
        busName: existing.busName,
        busId: existing.busId,
        participantId: existing.participantId,
        multicastGroup: existing.multicastGroup,
        multicastPort: this.options.busMulticastPort
      };
    }
    const participantId = options.participantId ?? randomUInt32();
    const bus = {
      busName,
      busId,
      participantId,
      readyRemoteParticipants: new Set(),
      interests: new Map(),
      remoteInterests: new Map(),
      publishedObjects: new Map(),
      localTypeRegistry: new Map(),
      localTypeResponsesByHash: new Map(),
      multicastSocket: undefined,
      multicastGroup: undefined
    };

    this.buses.set(busId, bus);
    try {
      if (this.options.busMulticast !== false) {
        await this.#openBusMulticastSocket(bus);
      }
    } catch (error) {
      this.buses.delete(busId);
      throw error;
    }

    this.#sendControlPayloadToAll(encodeEtherControlMessage({
      type: 'BusJoined',
      value: {
        participantId,
        busId,
        busName
      }
    }));

    for (const participant of this.#remoteParticipantsForBus(bus.busId)) {
      this.#sendBusControlToConnection(bus, participant.connection, {
        type: 'RemoteParticipantReady',
        value: { id: participant.id }
      });
    }

    this.emit('busJoinedLocal', {
      busName,
      busId,
      participantId,
      multicastGroup: bus.multicastGroup,
      multicastPort: this.options.busMulticastPort
    });
    return {
      busName,
      busId,
      participantId,
      multicastGroup: bus.multicastGroup,
      multicastPort: this.options.busMulticastPort
    };
  }

  /**
   * Start a SEN object interest on a joined bus.
   *
   * The query syntax is SEN's native Interest query string. Returned object
   * state buffers are intentionally left raw until type-spec decoding is added.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {string} query
   * @param {{ id?: number }} [options]
   */
  startInterest(bus, query, options = {}) {
    const busState = this.#getBus(bus);
    const id = options.id ?? crc32(query);
    this.#sendBusControlToRemoteParticipants(busState, {
      type: 'InterestStarted',
      value: { query, id }
    });
    busState.interests.set(id, { id, query });
    this.emit('interestStarted', { busName: busState.busName, busId: busState.busId, id, query });
    return { busName: busState.busName, busId: busState.busId, id, query };
  }

  #restartInterestForRemote(busState) {
    for (const participant of this.#remoteParticipantsForBus(busState.busId)) {
      for (const interest of busState.interests.values()) {
        this.#sendBusControlToConnection(busState, participant.connection, {
          type: 'InterestStarted',
          value: { query: interest.query, id: interest.id }
        });
      }
    }
  }

  #restartInterestForConnection(busState, connection) {
    for (const interest of busState.interests.values()) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'InterestStarted',
        value: { query: interest.query, id: interest.id }
      });
    }
  }

  /**
   * Stop a previously started interest.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {number} id
   */
  stopInterest(bus, id) {
    const busState = this.#getBus(bus);
    busState.interests.delete(id);
    this.#sendBusControlToRemoteParticipants(busState, {
      type: 'InterestStopped',
      value: { id }
    });
  }

  /**
   * Request SEN type specs for the given remote object type hashes.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Iterable<number>} typeHashes
   */
  requestTypes(bus, typeHashes) {
    const busState = this.#getBus(bus);
    const requests = [...new Set([...typeHashes].map(value => value >>> 0))];
    if (!requests.length) {
      return { busName: busState.busName, busId: busState.busId, requests };
    }

    this.#sendBusControlToRemoteParticipants(busState, {
      type: 'TypesInfoRequest',
      value: {
        ownerId: busState.participantId,
        requests
      }
    });
    this.emit('typesInfoRequested', { busName: busState.busName, busId: busState.busId, requests });
    return { busName: busState.busName, busId: busState.busId, requests };
  }

  /**
   * Request current dynamic state for already published remote objects.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<{ interestId: number, objectIds: Array<number> }>} requests
   */
  requestObjectStates(bus, requests) {
    const busState = this.#getBus(bus);
    const normalized = requests
      .map(request => ({
        interestId: request.interestId >>> 0,
        objectIds: [...new Set((request.objectIds ?? []).map(value => value >>> 0))]
      }))
      .filter(request => request.objectIds.length);

    if (!normalized.length) {
      return { busName: busState.busName, busId: busState.busId, requests: normalized };
    }

    this.#sendBusControlToRemoteParticipants(busState, {
      type: 'ObjectsStateRequest',
      value: {
        ownerId: busState.participantId,
        requests: normalized
      }
    });
    this.emit('objectsStateRequested', { busName: busState.busName, busId: busState.busId, requests: normalized });
    return { busName: busState.busName, busId: busState.busId, requests: normalized };
  }

  /**
   * Publish local JavaScript objects on a joined SEN bus.
   *
   * Objects need at least `{ name, className, properties }`. A `spec` can be
   * supplied for exact SEN typing; otherwise a simple ClassTypeSpec is inferred
   * from the current property values.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {object|object[]} objects
   * @param {{ types?: Map<string, object>|Record<string, object>|object[] }} [options]
   */
  publishObjects(bus, objects, options = {}) {
    const busState = this.#getBus(bus);
    const list = Array.isArray(objects) ? objects : [objects];
    const externalTypes = normalizeTypeDefinitions(options.types);
    for (const type of externalTypes) {
      this.#registerLocalType(busState, type);
    }

    const published = [];
    for (const item of list) {
      const localObject = buildLocalObject(item, busState.localTypeRegistry);
      busState.publishedObjects.set(localObject.id, localObject);
      this.#registerLocalType(busState, localObject.spec, localObject.typeHash);
      published.push(localObject);
    }

    if (published.length) {
      this.#publishObjectsToRemoteInterests(busState, published);
    }

    this.emit('objectsPublishedLocal', {
      busName: busState.busName,
      busId: busState.busId,
      objects: published
    });
    return published;
  }

  /**
   * Remove previously published local objects from a joined bus.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<string|number>|string|number} objects Object ids or names.
   */
  removePublishedObjects(bus, objects) {
    const busState = this.#getBus(bus);
    const selectors = Array.isArray(objects) ? objects : [objects];
    const removed = [];
    for (const selector of selectors) {
      const id = typeof selector === 'number'
        ? selector >>> 0
        : [...busState.publishedObjects.values()].find(object => object.name === selector)?.id;
      if (id === undefined) continue;
      if (busState.publishedObjects.delete(id)) removed.push(id);
    }

    if (removed.length) {
      this.#removeObjectsFromRemoteInterests(busState, removed);
    }

    this.emit('objectsRemovedLocal', {
      busName: busState.busName,
      busId: busState.busId,
      objectIds: removed
    });
    return removed;
  }

  /**
   * Send a runtime method call to a remote participant on a joined bus.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {object} call
   * @param {number} call.to Remote participant/object owner id.
   * @param {number} call.objectId Remote object id.
   * @param {number} call.methodId SEN method member hash.
   * @param {number} call.ticketId Local call id.
   * @param {boolean} [call.confirmed]
   * @param {Buffer | Uint8Array | ArrayBuffer} [call.argumentsBuffer]
   */
  sendRuntimeMethodCall(bus, call) {
    const busState = this.#getBus(bus);
    const remote = this.#remoteParticipantForBus(busState.busId, call.to);
    const message = encodeRuntimeMethodCall({
      ownerId: busState.participantId,
      objectId: call.objectId,
      methodId: call.methodId,
      ticketId: call.ticketId,
      confirmed: call.confirmed,
      argumentsBuffer: call.argumentsBuffer
    });
    this.#sendBusMessageToConnection(busState, remote?.connection, message);
    this.emit('runtimeMethodCallSent', {
      busName: busState.busName,
      busId: busState.busId,
      to: call.to,
      objectId: call.objectId,
      methodId: call.methodId,
      ticketId: call.ticketId,
      confirmed: Boolean(call.confirmed)
    });
  }

  /**
   * Announce that the local JS participant leaves a SEN bus.
   *
   * @param {string | number} bus Bus name or bus id.
   */
  leaveBus(bus) {
    const busState = this.#getBus(bus);
    for (const id of Array.from(busState.interests.keys())) {
      this.stopInterest(busState.busId, id);
    }

    this.#sendControlPayloadToAll(encodeEtherControlMessage({
      type: 'BusLeft',
      value: {
        participantId: busState.participantId,
        busId: busState.busId,
        busName: busState.busName
      }
    }));
    this.buses.delete(busState.busId);
    if (busState.multicastSocket) {
      busState.multicastSocket.close();
      busState.multicastSocket = undefined;
    }
    this.emit('busLeftLocal', {
      busName: busState.busName,
      busId: busState.busId,
      participantId: busState.participantId
    });
  }

  #sendHello(connection) {
    const udpPort = this.udpSocket?.address()?.port;
    const payload = encodeEtherControlMessage({
      type: 'Hello',
      value: {
        info: this.processInfo,
        udpPort,
        version: {
          kernel: this.options.kernelProtocolVersion,
          ether: this.options.etherProtocolVersion
        }
      }
    });
    this.#sendControlPayloadToConnection(connection, payload);
  }

  #sendReady(connection) {
    this.#sendControlPayloadToConnection(connection, encodeEtherControlMessage({ type: 'Ready' }));
  }

  #sendControlPayloadToConnection(connection, payload) {
    const socket = this.#writableConnectionSocket(connection);
    socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.controlMessage, payload), error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #sendControlPayloadToAll(payload) {
    for (const connection of this.connections.values()) {
      this.#sendControlPayloadToConnection(connection, payload);
    }
  }

  #onTcpData(connection, chunk) {
    connection.receiveBuffer = Buffer.concat([connection.receiveBuffer, chunk]);

    while (connection.receiveBuffer.length >= 5) {
      const header = decodeProcessTcpHeader(connection.receiveBuffer);
      const frameSize = 5 + header.payloadSize;
      if (connection.receiveBuffer.length < frameSize) {
        return;
      }

      const payload = connection.receiveBuffer.subarray(5, frameSize);
      connection.receiveBuffer = connection.receiveBuffer.subarray(frameSize);
      this.#onFrame(connection, header.category, payload);
    }
  }

  #onFrame(connection, category, payload) {
    if (category === PROCESS_MESSAGE_CATEGORY.controlMessage) {
      const message = decodeEtherControlMessage(payload);
      this.emit('controlMessage', message, connection);
      this.#onControlMessage(connection, message);
      return;
    }

    if (category === PROCESS_MESSAGE_CATEGORY.busMessage) {
      this.#onBusFrame(payload, connection);
      return;
    }

    this.emit('error', new RangeError(`unknown SEN process frame category: ${category}`));
  }

  #onControlMessage(connection, message) {
    switch (message.type) {
      case 'Hello':
        this.#onHello(connection, message.value);
        break;
      case 'Ready':
        connection.ready = true;
        this.ready = true;
        this.emit('ready', connection.remoteProcessInfo);
        this.emit('connectionReady', { connection, remoteProcessInfo: connection.remoteProcessInfo });
        break;
      case 'BusJoined':
        this.#onRemoteBusJoined(connection, message.value);
        break;
      case 'BusLeft':
        this.#onRemoteBusLeft(connection, message.value);
        break;
      default:
        this.emit('error', new RangeError(`unknown SEN ether control message: ${message.type}`));
    }
  }

  #onHello(connection, hello) {
    try {
      validateRemoteHello(hello, this.options, this.processInfo);
    } catch (error) {
      connection.socket?.destroy(error);
      return;
    }

    connection.remoteProcessInfo = hello.info;
    connection.processKey = processKeyFromInfo(hello.info);
    this.connectionsByProcessKey.set(connection.processKey, connection);
    this.remoteProcessInfo ??= hello.info;
    this.emit('remoteProcess', hello);
    try {
      this.#sendReady(connection);
      this.#announceLocalBusesToConnection(connection);
    } catch (error) {
      this.emit('error', error);
    }
  }

  #announceLocalBusesToConnection(connection) {
    for (const busState of this.buses.values()) {
      this.#sendControlPayloadToConnection(connection, encodeEtherControlMessage({
        type: 'BusJoined',
        value: {
          participantId: busState.participantId,
          busId: busState.busId,
          busName: busState.busName
        }
      }));
    }
  }

  #onRemoteBusJoined(connection, value) {
    const participant = {
      id: value.participantId >>> 0,
      busId: value.busId >>> 0,
      busName: value.busName,
      connection
    };
    let participants = this.remoteParticipantsByBusId.get(participant.busId);
    if (!participants) {
      participants = new Map();
      this.remoteParticipantsByBusId.set(participant.busId, participants);
    }
    participants.set(participant.id, participant);
    this.emit('busJoined', { ...value, connection });

    const busState = this.buses.get(participant.busId);
    if (busState) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'RemoteParticipantReady',
        value: { id: participant.id }
      });
      this.#restartInterestForConnection(busState, connection);
      this.#publishObjectsToRemoteInterests(busState, [...busState.publishedObjects.values()]);
    }
  }

  #onRemoteBusLeft(connection, value) {
    const busId = value.busId >>> 0;
    const participantId = value.participantId >>> 0;
    const participants = this.remoteParticipantsByBusId.get(busId);
    participants?.delete(participantId);
    if (participants && !participants.size) {
      this.remoteParticipantsByBusId.delete(busId);
    }
    const busState = this.buses.get(busId);
    if (busState) {
      for (const [key, interest] of busState.remoteInterests) {
        if (interest.connection === connection && interest.participantId === participantId) {
          busState.remoteInterests.delete(key);
        }
      }
    }
    this.emit('busLeft', { ...value, connection });
  }

  #onBusFrame(payload, connection = undefined) {
    const frame = decodeConfirmedBusFrame(payload);
    const busMessage = decodeBusMessage(frame.message);
    this.emit('busFrame', { ...frame, busMessage, connection });

    if (busMessage.categoryName !== 'controlMessage') {
      this.emit(busMessage.categoryName, { ...frame, ...busMessage, connection });
      return;
    }

    const busState = this.buses.get(frame.busId);
    const control = busMessage.control;
    this.emit('busControlMessage', { ...frame, control, connection });

    if (!busState) {
      return;
    }

    switch (control.type) {
      case 'RemoteParticipantReady':
        this.#onRemoteParticipantReady(busState, frame, control.value, connection);
        break;
      case 'InterestStarted':
        this.#onRemoteInterestStarted(busState, frame, control.value, connection);
        break;
      case 'InterestStopped':
        this.#onRemoteInterestStopped(busState, frame, control.value, connection);
        break;
      case 'ObjectsPublished':
        this.emit('objectsPublished', { bus: busState, connection, ...control.value });
        break;
      case 'ObjectsRemoved':
        this.emit('objectsRemoved', { bus: busState, connection, ...control.value });
        break;
      case 'ObjectsStateResponse':
        this.emit('objectsStateResponse', { bus: busState, connection, ...control.value });
        break;
      case 'TypesInfoResponse':
        this.emit('typesInfoResponse', { bus: busState, connection, ...control.value });
        break;
      case 'TypesInfoRejection':
        this.emit('typesInfoRejection', { bus: busState, connection, ...control.value });
        break;
      case 'ObjectsStateRequest':
        this.#onObjectsStateRequest(busState, frame, control.value, connection);
        break;
      case 'TypesInfoRequest':
        this.#onTypesInfoRequest(busState, frame, control.value, connection);
        break;
      default:
        break;
    }
  }

  #onMulticastBusDatagram(busState, message, remote) {
    try {
      if (message.length < 9) {
        throw new RangeError(`SEN multicast bus datagram too small: ${message.length}`);
      }
      const frame = decodeConfirmedBusFrame(message);
      if (frame.to !== busState.participantId) {
        return;
      }
      const busMessage = decodeBusMessage(frame.message);
      this.emit('busFrame', { ...frame, busMessage, remote, multicast: true });
      if (busMessage.categoryName === 'controlMessage') {
        this.emit('busControlMessage', { ...frame, control: busMessage.control, remote, multicast: true });
        return;
      }
      this.emit(busMessage.categoryName, { ...frame, ...busMessage, remote, multicast: true });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async #openBusMulticastSocket(busState) {
    const group = computeBusMulticastGroup(
      this.processInfo.sessionId,
      busState.busId,
      this.options.discoveryPort,
      this.busMulticastRange
    );
    const port = this.options.busMulticastPort;
    const bindAddress = process.platform === 'win32' ? undefined : group;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    busState.multicastSocket = socket;
    busState.multicastGroup = group;

    socket.on('message', (message, remote) => this.#onMulticastBusDatagram(busState, message, remote));
    socket.on('error', error => this.emit('error', error));

    await new Promise((resolve, reject) => {
      const onError = error => {
        socket.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        socket.off('error', onError);
        try {
          const interfaces = multicastInterfaceCandidates(this.interfaceAddress);
          if (interfaces.length) {
            for (const interfaceAddress of interfaces) {
              socket.addMembership(group, interfaceAddress);
            }
          } else {
            socket.addMembership(group);
          }
          socket.setMulticastLoopback(true);
          if (this.interfaceAddress) {
            socket.setMulticastInterface(this.interfaceAddress);
          }
        } catch (error) {
          reject(error);
          return;
        }
        resolve();
      };

      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(port, bindAddress);
    });
  }

  #onRemoteParticipantReady(busState, frame, value, connection) {
    if (value.id !== busState.participantId) {
      return;
    }

    const remoteParticipantId = frame.to >>> 0;
    if (!busState.readyRemoteParticipants.has(remoteParticipantId)) {
      busState.readyRemoteParticipants.add(remoteParticipantId);
      this.#sendBusControlToConnection(busState, connection, {
        type: 'RemoteParticipantReady',
        value: { id: remoteParticipantId }
      });
      this.#restartInterestForConnection(busState, connection);
      this.emit('busParticipantReady', {
        busName: busState.busName,
        busId: busState.busId,
        participantId: busState.participantId,
        remoteParticipantId,
        connection
      });
    }
  }

  #onRemoteInterestStarted(busState, frame, value, connection) {
    const remoteParticipantId = frame.to >>> 0;
    const id = value.id >>> 0;
    const key = `${connection?.id ?? 0}:${remoteParticipantId}:${id}`;
    busState.remoteInterests.set(key, {
      participantId: remoteParticipantId,
      connection,
      id,
      query: value.query
    });
    this.emit('remoteInterestStarted', {
      busName: busState.busName,
      busId: busState.busId,
      participantId: remoteParticipantId,
      connection,
      id,
      query: value.query
    });
    this.#publishObjectsToRemoteInterests(busState, [...busState.publishedObjects.values()], [key]);
  }

  #onRemoteInterestStopped(busState, frame, value, connection) {
    const remoteParticipantId = frame.to >>> 0;
    const id = value.id >>> 0;
    busState.remoteInterests.delete(`${connection?.id ?? 0}:${remoteParticipantId}:${id}`);
    this.emit('remoteInterestStopped', {
      busName: busState.busName,
      busId: busState.busId,
      participantId: remoteParticipantId,
      connection,
      id
    });
  }

  #onObjectsStateRequest(busState, frame, value, connection) {
    const remoteParticipantId = frame.to >>> 0;
    const responses = [];
    for (const request of value.requests ?? []) {
      const objectStates = [];
      for (const objectId of request.objectIds ?? []) {
        const object = busState.publishedObjects.get(objectId >>> 0);
        if (!object) continue;
        objectStates.push({
          id: object.id,
          timestamp: object.timestamp,
          state: object.stateBuffer
        });
      }
      if (objectStates.length) {
        responses.push({ interestId: request.interestId, objectStates });
      }
    }
    if (!responses.length) return;
    this.#sendBusControlToConnection(busState, connection, {
      type: 'ObjectsStateResponse',
      value: {
        ownerId: busState.participantId,
        responses
      }
    });
  }

  #onTypesInfoRequest(busState, frame, value, connection) {
    const remoteParticipantId = frame.to >>> 0;
    const types = [];
    const rejections = [];
    for (const request of value.requests ?? []) {
      const type = busState.localTypeResponsesByHash.get(request >>> 0);
      if (type) {
        types.push(type);
      } else {
        rejections.push(String(request));
      }
    }
    if (types.length) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'TypesInfoResponse',
        value: {
          ownerId: busState.participantId,
          types
        }
      });
    }
    if (rejections.length) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'TypesInfoRejection',
        value: {
          ownerId: busState.participantId,
          rejections
        }
      });
    }
  }

  #registerLocalType(busState, spec, hash = crc32(spec?.qualifiedName ?? spec?.name ?? '')) {
    if (!spec?.qualifiedName) return;
    busState.localTypeRegistry.set(spec.qualifiedName, spec);
    const response = spec.data?.type === 'ClassTypeSpec'
      ? {
        type: 'ClassSpecResponse',
        classHash: hash >>> 0,
        spec,
        dependentTypes: []
      }
      : {
        type: 'NonClassSpecResponse',
        spec
      };
    busState.localTypeResponsesByHash.set((hash >>> 0), response);
  }

  #publishObjectsToRemoteInterests(busState, objects, keys = undefined) {
    if (!objects.length) return;
    const targets = (keys ?? [...busState.remoteInterests.keys()])
      .map(key => busState.remoteInterests.get(key))
      .filter(Boolean);
    if (!targets.length) return;

    const byConnection = new Map();
    for (const interest of targets) {
      const connection = interest.connection;
      if (!connection) continue;
      const list = byConnection.get(connection) ?? [];
      list.push({
        interestId: interest.id,
        objects: objects.map(object => ({
          className: object.className,
          typeHash: object.typeHash,
          name: object.name,
          id: object.id,
          state: object.stateBuffer,
          time: object.timestamp
        }))
      });
      byConnection.set(connection, list);
    }

    for (const [connection, discoveries] of byConnection) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'ObjectsPublished',
        value: {
          ownerId: busState.participantId,
          discoveries
        }
      });
    }
  }

  #removeObjectsFromRemoteInterests(busState, objectIds) {
    const targets = [...busState.remoteInterests.values()];
    if (!targets.length || !objectIds.length) return;
    const byConnection = new Map();
    for (const interest of targets) {
      const connection = interest.connection;
      if (!connection) continue;
      const removals = byConnection.get(connection) ?? [];
      removals.push({ interestId: interest.id, ids: objectIds });
      byConnection.set(connection, removals);
    }
    for (const [connection, removals] of byConnection) {
      this.#sendBusControlToConnection(busState, connection, {
        type: 'ObjectsRemoved',
        value: { removals }
      });
    }
  }

  #sendBusControlToRemoteParticipants(busState, message) {
    const connections = new Set(this.#remoteParticipantsForBus(busState.busId).map(participant => participant.connection));
    for (const connection of connections) {
      this.#sendBusControlToConnection(busState, connection, message);
    }
  }

  #sendBusControlToConnection(busState, connection, message) {
    const busPayload = encodeBusControlMessage(message);
    this.#sendBusMessageToConnection(busState, connection, busPayload);
  }

  #sendBusMessageToConnection(busState, connection, busPayload) {
    if (!connection) {
      for (const participant of this.#remoteParticipantsForBus(busState.busId)) {
        this.#sendBusMessageToConnection(busState, participant.connection, busPayload);
      }
      return;
    }
    const socket = this.#writableConnectionSocket(connection);
    const processBusPayload = encodeConfirmedBusFrame({
      to: busState.participantId,
      busId: busState.busId,
      message: busPayload
    });
    socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, processBusPayload), error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #writableConnectionSocket(connection) {
    const socket = connection?.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      const error = new Error('SEN ether TCP socket is not writable');
      error.code = 'SEN_TCP_NOT_WRITABLE';
      this.emit('error', error);
      throw error;
    }
    return socket;
  }

  #remoteParticipantsForBus(busId) {
    return [...(this.remoteParticipantsByBusId.get(busId >>> 0)?.values() ?? [])];
  }

  #remoteParticipantForBus(busId, participantId) {
    return this.remoteParticipantsByBusId.get(busId >>> 0)?.get(participantId >>> 0);
  }

  #getBus(bus) {
    const busId = typeof bus === 'number' ? bus : crc32(bus);
    const busState = this.buses.get(busId);
    if (!busState) {
      throw new Error(`SEN bus is not joined: ${bus}`);
    }
    return busState;
  }
}
