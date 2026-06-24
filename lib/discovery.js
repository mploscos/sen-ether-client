import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import { decodeSessionPresenceBeam } from './codec.js';

export const DEFAULT_DISCOVERY_GROUP = '239.255.0.44';
export const DEFAULT_DISCOVERY_PORT = 60543;
export const DEFAULT_SCAN_TIMEOUT_MS = 3000;
export const TCP_DISCOVERY_BEAM_SIZE = 508;

function processKey(beam) {
  const { hostId, processId, sessionId } = beam.info;
  return `${hostId}:${processId}:${sessionId}`;
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
        if ((item.family === 'IPv4' || item.family === 4) && item.address) {
          addresses.push(item.address);
        }
      }
    }
    return [...new Set(addresses)];
  } catch {
    return [];
  }
}

function normalizeTcpRemote(socket) {
  return {
    address: socket.remoteAddress,
    family: socket.remoteFamily,
    port: socket.remotePort,
    transport: 'tcp'
  };
}

function normalizeBeam(beam, remote) {
  return {
    key: processKey(beam),
    protocolVersion: beam.protocolVersion,
    session: {
      id: beam.info.sessionId,
      name: beam.info.sessionName
    },
    process: {
      hostId: beam.info.hostId,
      processId: beam.info.processId,
      appName: beam.info.appName,
      hostName: beam.info.hostName,
      osKind: beam.info.osKind,
      osName: beam.info.osName,
      cpuArch: beam.info.cpuArch
    },
    endpoints: beam.endpoints,
    beamPeriodMs: beam.beamPeriodMs,
    remote,
    firstSeen: Date.now(),
    lastSeen: Date.now()
  };
}

/**
 * Passive SEN ether multicast discovery scanner.
 *
 * It listens for sen.components.ether.SessionPresenceBeam messages. It does
 * not join SEN buses or create interests.
 */
export class EtherDiscoveryScanner extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {number} [options.port]
   * @param {string} [options.interfaceAddress]
   * @param {string} [options.bindAddress]
   */
  constructor(options = {}) {
    super();
    this.group = options.group ?? DEFAULT_DISCOVERY_GROUP;
    this.port = options.port ?? discoveryPortFromEnv() ?? DEFAULT_DISCOVERY_PORT;
    this.interfaceAddress = resolveInterfaceAddress(options.interfaceAddress);
    this.bindAddress = options.bindAddress ?? (process.platform === 'win32' ? undefined : this.group);
    this.socket = null;
    this.processes = new Map();
  }

  async start() {
    if (this.socket) {
      return this;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (message, remote) => {
      try {
        const beam = decodeSessionPresenceBeam(message);
        const key = processKey(beam);
        const current = this.processes.get(key);

        if (current) {
          current.lastSeen = Date.now();
          current.remote = remote;
          current.endpoints = beam.endpoints;
          this.emit('beam', current);
          return;
        }

        const discovered = normalizeBeam(beam, remote);
        this.processes.set(key, discovered);
        this.emit('process', discovered);
        this.emit('beam', discovered);
      } catch (error) {
        this.emit('decodeError', error, message, remote);
      }
    });

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
            /** @type {Error | undefined} */
            let firstError;
            for (const interfaceAddress of interfaces) {
              try {
                socket.addMembership(this.group, interfaceAddress);
                joined += 1;
              } catch (error) {
                firstError ??= /** @type {Error} */ (error);
              }
            }
            if (!joined) {
              throw firstError ?? new Error(`could not join multicast group ${this.group}`);
            }
          } else {
            socket.addMembership(this.group);
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
      socket.bind(this.port, this.bindAddress);
    });

    return this;
  }

  async stop() {
    const socket = this.socket;
    this.socket = null;

    if (!socket) {
      return;
    }

    await new Promise(resolve => {
      socket.close(resolve);
    });
  }

  listProcesses() {
    return [...this.processes.values()].sort((a, b) => {
      const sessionCmp = a.session.name.localeCompare(b.session.name);
      if (sessionCmp !== 0) {
        return sessionCmp;
      }
      return a.process.appName.localeCompare(b.process.appName);
    });
  }
}

/**
 * Passive SEN ether TCP discovery-hub scanner.
 *
 * SEN's TcpDiscoveryHub forwards fixed-size beam buffers between connected
 * clients. This scanner does not announce itself; it only listens for beams.
 */
export class TcpDiscoveryHubScanner extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.host]
   * @param {number} [options.port]
   */
  constructor(options = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 64222;
    this.socket = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.processes = new Map();
  }

  async start() {
    if (this.socket) {
      return this;
    }

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;

    socket.on('data', chunk => this.#onData(chunk));
    socket.on('close', hadError => {
      this.socket = null;
      this.emit('close', hadError);
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        socket.on('error', error => this.emit('error', error));
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });

    return this;
  }

  async stop() {
    const socket = this.socket;
    this.socket = null;

    if (!socket) {
      return;
    }

    await new Promise(resolve => {
      socket.once('close', resolve);
      socket.destroy();
    });
  }

  listProcesses() {
    return [...this.processes.values()].sort((a, b) => {
      const sessionCmp = a.session.name.localeCompare(b.session.name);
      if (sessionCmp !== 0) {
        return sessionCmp;
      }
      return a.process.appName.localeCompare(b.process.appName);
    });
  }

  #onData(chunk) {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (this.receiveBuffer.length >= TCP_DISCOVERY_BEAM_SIZE) {
      const message = this.receiveBuffer.subarray(0, TCP_DISCOVERY_BEAM_SIZE);
      this.receiveBuffer = this.receiveBuffer.subarray(TCP_DISCOVERY_BEAM_SIZE);
      this.#onBeamBuffer(message);
    }
  }

  #onBeamBuffer(message) {
    try {
      const beam = decodeSessionPresenceBeam(message);
      const key = processKey(beam);
      const current = this.processes.get(key);

      if (current) {
        current.lastSeen = Date.now();
        current.remote = normalizeTcpRemote(this.socket);
        current.endpoints = beam.endpoints;
        this.emit('beam', current);
        return;
      }

      const discovered = normalizeBeam(beam, normalizeTcpRemote(this.socket));
      this.processes.set(key, discovered);
      this.emit('process', discovered);
      this.emit('beam', discovered);
    } catch (error) {
      this.emit('decodeError', error, message, normalizeTcpRemote(this.socket));
    }
  }
}

/**
 * Scan visible SEN ether multicast presence beams.
 *
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {number} [options.settleMs] Time to keep collecting beams after the first discovered process.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<object>>}
 */
export async function scan(options = {}) {
  const timeout = options.timeout ?? DEFAULT_SCAN_TIMEOUT_MS;
  const settleMs = options.settleMs ?? 100;
  const scanner = new EtherDiscoveryScanner(options);

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('scan aborted');
  }

  let timeoutId;
  let settleTimeoutId;
  let onScannerError;
  let onProcess;
  const abortPromise = new Promise((_, reject) => {
    if (!options.signal) {
      return;
    }
    options.signal.addEventListener(
      'abort',
      () => reject(options.signal.reason ?? new Error('scan aborted')),
      { once: true }
    );
  });

  try {
    await scanner.start();
    const scannerErrorPromise = new Promise((_, reject) => {
      onScannerError = error => reject(error);
      scanner.on('error', onScannerError);
    });
    const discoveryPromise = new Promise(resolve => {
      timeoutId = setTimeout(resolve, timeout);
      onProcess = () => {
        if (settleTimeoutId) {
          return;
        }
        settleTimeoutId = setTimeout(resolve, settleMs);
      };
      scanner.on('process', onProcess);
    });
    await Promise.race([
      discoveryPromise,
      scannerErrorPromise,
      abortPromise
    ]);
    return scanner.listProcesses();
  } finally {
    if (onScannerError) {
      scanner.off('error', onScannerError);
    }
    if (onProcess) {
      scanner.off('process', onProcess);
    }
    clearTimeout(timeoutId);
    clearTimeout(settleTimeoutId);
    await scanner.stop();
  }
}

/**
 * Scan visible SEN ether TCP discovery hub beams.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {number} [options.timeout]
 * @param {number} [options.settleMs] Time to keep collecting beams after the first discovered process.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<object>>}
 */
export async function scanTcpDiscoveryHub(options = {}) {
  const timeout = options.timeout ?? DEFAULT_SCAN_TIMEOUT_MS;
  const settleMs = options.settleMs ?? 100;
  const scanner = new TcpDiscoveryHubScanner(options);

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error('scan aborted');
  }

  let timeoutId;
  let settleTimeoutId;
  let onScannerError;
  let onProcess;
  const abortPromise = new Promise((_, reject) => {
    if (!options.signal) {
      return;
    }
    options.signal.addEventListener(
      'abort',
      () => reject(options.signal.reason ?? new Error('scan aborted')),
      { once: true }
    );
  });

  try {
    await scanner.start();
    const scannerErrorPromise = new Promise((_, reject) => {
      onScannerError = error => reject(error);
      scanner.on('error', onScannerError);
    });
    const discoveryPromise = new Promise(resolve => {
      timeoutId = setTimeout(resolve, timeout);
      onProcess = () => {
        if (settleTimeoutId) {
          return;
        }
        settleTimeoutId = setTimeout(resolve, settleMs);
      };
      scanner.on('process', onProcess);
    });
    await Promise.race([
      discoveryPromise,
      scannerErrorPromise,
      abortPromise
    ]);
    return scanner.listProcesses();
  } finally {
    if (onScannerError) {
      scanner.off('error', onScannerError);
    }
    if (onProcess) {
      scanner.off('process', onProcess);
    }
    clearTimeout(timeoutId);
    clearTimeout(settleTimeoutId);
    await scanner.stop();
  }
}
