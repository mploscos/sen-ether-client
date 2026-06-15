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
import {
  decodeEtherControlMessage,
  decodeProcessTcpHeader,
  encodeEtherControlMessage,
  encodeProcessTcpFrame,
  ETHER_PROTOCOL_VERSION,
  KERNEL_PROTOCOL_VERSION,
  PROCESS_MESSAGE_CATEGORY
} from './codec.js';
import { crc32 } from './crc32.js';

const LINUX_OS_KIND = 1;
const X64_CPU_ARCH = 1;

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
      ...options
    };
    this.processInfo = createProcessInfo(this.options);
    this.socket = undefined;
    this.udpSocket = undefined;
    this.receiveBuffer = Buffer.alloc(0);
    this.remoteProcessInfo = undefined;
    this.ready = false;
    this.buses = new Map();
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

    this.socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    this.socket.on('data', chunk => this.#onTcpData(chunk));
    this.socket.on('close', hadError => {
      this.ready = false;
      this.emit('close', hadError);
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        this.socket?.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        this.socket?.off('error', onError);
        this.socket?.on('error', error => this.emit('error', error));
        this.#configureTcpSocket();
        try {
          this.#sendHello();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      this.socket.once('error', onError);
      this.socket.once('connect', onConnect);
    });

    return this;
  }

  #configureTcpSocket() {
    if (!this.socket) {
      return;
    }
    if (this.options.socketKeepAlive !== false) {
      this.socket.setKeepAlive(true, this.options.socketKeepAliveInitialDelayMs ?? 1000);
    }
    if (this.options.socketIdleTimeoutMs > 0) {
      this.socket.setTimeout(this.options.socketIdleTimeoutMs, () => {
        const error = new Error(`SEN ether TCP socket idle timeout after ${this.options.socketIdleTimeoutMs}ms`);
        error.code = 'SEN_TCP_IDLE_TIMEOUT';
        this.socket?.destroy(error);
      });
    }
  }

  async close() {
    const socket = this.socket;
    this.socket = undefined;
    const udpSocket = this.udpSocket;
    this.udpSocket = undefined;

    const closing = [];
    if (socket && !socket.destroyed) {
      closing.push(new Promise(resolve => {
        socket.once('close', resolve);
        socket.destroy();
      }));
    }
    if (udpSocket) {
      closing.push(new Promise(resolve => {
        udpSocket.close(resolve);
      }));
    }

    await Promise.allSettled(closing);
  }

  /**
   * Announce a JS participant on a SEN bus.
   *
   * @param {string} busName
   * @param {{ participantId?: number }} [options]
   */
  joinBus(busName, options = {}) {
    if (!this.socket) {
      throw new Error('EtherClient is not connected');
    }

    const busId = crc32(busName);
    const participantId = options.participantId ?? randomUInt32();
    const bus = {
      busName,
      busId,
      participantId,
      readyRemoteParticipants: new Set(),
      interests: new Map()
    };

    this.buses.set(busId, bus);
    this.#sendControlPayload(encodeEtherControlMessage({
      type: 'BusJoined',
      value: {
        participantId,
        busId,
        busName
      }
    }));

    this.emit('busJoinedLocal', { busName, busId, participantId });
    return { busName, busId, participantId };
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
    this.#sendBusControl(busState, busState.participantId, {
      type: 'InterestStarted',
      value: { query, id }
    });
    busState.interests.set(id, { id, query });
    this.emit('interestStarted', { busName: busState.busName, busId: busState.busId, id, query });
    return { busName: busState.busName, busId: busState.busId, id, query };
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
    this.#sendBusControl(busState, busState.participantId, {
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

    this.#sendBusControl(busState, busState.participantId, {
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

    this.#sendBusControl(busState, busState.participantId, {
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
    const message = encodeRuntimeMethodCall({
      ownerId: busState.participantId,
      objectId: call.objectId,
      methodId: call.methodId,
      ticketId: call.ticketId,
      confirmed: call.confirmed,
      argumentsBuffer: call.argumentsBuffer
    });
    this.#sendBusMessage(busState, call.to, message);
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

    this.#sendControlPayload(encodeEtherControlMessage({
      type: 'BusLeft',
      value: {
        participantId: busState.participantId,
        busId: busState.busId,
        busName: busState.busName
      }
    }));
    this.buses.delete(busState.busId);
    this.emit('busLeftLocal', {
      busName: busState.busName,
      busId: busState.busId,
      participantId: busState.participantId
    });
  }

  #sendHello() {
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
    this.#sendControlPayload(payload);
  }

  #sendReady() {
    this.#sendControlPayload(encodeEtherControlMessage({ type: 'Ready' }));
  }

  #sendControlPayload(payload) {
    const socket = this.#writableSocket();
    socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.controlMessage, payload), error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #onTcpData(chunk) {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (this.receiveBuffer.length >= 5) {
      const header = decodeProcessTcpHeader(this.receiveBuffer);
      const frameSize = 5 + header.payloadSize;
      if (this.receiveBuffer.length < frameSize) {
        return;
      }

      const payload = this.receiveBuffer.subarray(5, frameSize);
      this.receiveBuffer = this.receiveBuffer.subarray(frameSize);
      this.#onFrame(header.category, payload);
    }
  }

  #onFrame(category, payload) {
    if (category === PROCESS_MESSAGE_CATEGORY.controlMessage) {
      const message = decodeEtherControlMessage(payload);
      this.emit('controlMessage', message);
      this.#onControlMessage(message);
      return;
    }

    if (category === PROCESS_MESSAGE_CATEGORY.busMessage) {
      this.#onBusFrame(payload);
      return;
    }

    this.emit('error', new RangeError(`unknown SEN process frame category: ${category}`));
  }

  #onControlMessage(message) {
    switch (message.type) {
      case 'Hello':
        this.#onHello(message.value);
        break;
      case 'Ready':
        this.ready = true;
        this.emit('ready', this.remoteProcessInfo);
        break;
      case 'BusJoined':
        this.emit('busJoined', message.value);
        break;
      case 'BusLeft':
        this.emit('busLeft', message.value);
        break;
      default:
        this.emit('error', new RangeError(`unknown SEN ether control message: ${message.type}`));
    }
  }

  #onHello(hello) {
    try {
      validateRemoteHello(hello, this.options, this.processInfo);
    } catch (error) {
      this.socket?.destroy(error);
      return;
    }

    this.remoteProcessInfo = hello.info;
    this.emit('remoteProcess', hello);
    try {
      this.#sendReady();
    } catch (error) {
      this.emit('error', error);
    }
  }

  #onBusFrame(payload) {
    const frame = decodeConfirmedBusFrame(payload);
    const busMessage = decodeBusMessage(frame.message);
    this.emit('busFrame', { ...frame, busMessage });

    if (busMessage.categoryName !== 'controlMessage') {
      this.emit(busMessage.categoryName, { ...frame, ...busMessage });
      return;
    }

    const busState = this.buses.get(frame.busId);
    const control = busMessage.control;
    this.emit('busControlMessage', { ...frame, control });

    if (!busState) {
      return;
    }

    switch (control.type) {
      case 'RemoteParticipantReady':
        this.#onRemoteParticipantReady(busState, frame, control.value);
        break;
      case 'ObjectsPublished':
        this.emit('objectsPublished', { bus: busState, ...control.value });
        break;
      case 'ObjectsRemoved':
        this.emit('objectsRemoved', { bus: busState, ...control.value });
        break;
      case 'ObjectsStateResponse':
        this.emit('objectsStateResponse', { bus: busState, ...control.value });
        break;
      case 'TypesInfoResponse':
        this.emit('typesInfoResponse', { bus: busState, ...control.value });
        break;
      case 'TypesInfoRejection':
        this.emit('typesInfoRejection', { bus: busState, ...control.value });
        break;
      default:
        break;
    }
  }

  #onRemoteParticipantReady(busState, frame, value) {
    if (value.id !== busState.participantId) {
      return;
    }

    const remoteParticipantId = frame.to;
    if (!busState.readyRemoteParticipants.has(remoteParticipantId)) {
      busState.readyRemoteParticipants.add(remoteParticipantId);
      this.#sendBusControl(busState, busState.participantId, {
        type: 'RemoteParticipantReady',
        value: { id: remoteParticipantId }
      });
      this.emit('busParticipantReady', {
        busName: busState.busName,
        busId: busState.busId,
        participantId: busState.participantId,
        remoteParticipantId
      });
    }
  }

  #sendBusControl(busState, to, message) {
    const busPayload = encodeBusControlMessage(message);
    this.#sendBusMessage(busState, to, busPayload);
  }

  #sendBusMessage(busState, to, busPayload) {
    const socket = this.#writableSocket();
    const processBusPayload = encodeConfirmedBusFrame({
      to,
      busId: busState.busId,
      message: busPayload
    });
    socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, processBusPayload), error => {
      if (error) {
        this.emit('error', error);
      }
    });
  }

  #writableSocket() {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      const error = new Error('SEN ether TCP socket is not writable');
      error.code = 'SEN_TCP_NOT_WRITABLE';
      this.emit('error', error);
      throw error;
    }
    return this.socket;
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
