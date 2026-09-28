/**
 * @fileoverview Direct Sen Ether process client and connection-aware router.
 *
 * The class owns sockets and connection generations. Focused collaborators own
 * local buses, publications and pending owner-scoped requests.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import process from 'node:process';
import { compileInterestQuery } from './interest-query.js';
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
    decodeSessionPresenceBeam,
    encodeEtherControlMessage,
    encodeProcessTcpFrame,
    encodeSessionPresenceBeam,
    ETHER_PROTOCOL_VERSION,
    KERNEL_PROTOCOL_VERSION,
    PROCESS_MESSAGE_CATEGORY
} from './codec.js';
import { crc32 } from './crc32.js';
import { normalizeResourceLimits, resourceLimitError } from './limits.js';
import { LocalPublications } from './local-publications.js';
import { RemoteRequests } from './remote-requests.js';
import { LocalBuses } from './local-buses.js';
import {
    DEFAULT_BEAM_PERIOD_MS,
    DEFAULT_BUS_MULTICAST_PORT,
    DEFAULT_DISCOVERY_GROUP,
    DEFAULT_DISCOVERY_PORT,
    DEFAULT_MULTICAST_RANGE,
    TCP_DISCOVERY_BEAM_SIZE,
    computeBusMulticastGroup,
    createProcessInfo,
    decodeMulticastBusDatagram,
    discoveryPortFromEnv,
    firstAdvertisableAddress,
    isSameProcessInfo,
    multicastInterfaceCandidates,
    normalizeMulticastRange,
    padDiscoveryBeam,
    parseHostPort,
    processKeyFromInfo,
    remoteInterestKey,
    resolveInterfaceAddress,
    validateRemoteHello,
    withCloseTimeout
} from './ether-network.js';
export { createProcessInfo, decodeMulticastBusDatagram, validateRemoteHello };

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
            announceDiscovery: true,
            presenceTimeoutMs: 0,
            presenceCheckIntervalMs: 1000,
            busMulticastPort: DEFAULT_BUS_MULTICAST_PORT,
            busMulticastRange: DEFAULT_MULTICAST_RANGE,
            ...options
        };
        this.limits = normalizeResourceLimits(this.options);
        this.options.resourceLimits = this.limits;
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
        this.connectionPresenceTimer = undefined;
        this.multicastDiscoverySocket = undefined;
        this.multicastDiscoveryTimer = undefined;
        this.connections = new Map();
        this.connectionsByProcessKey = new Map();
        this.nextConnectionId = 1;
        this.nextConnectionGeneration = 1;
        this.listenEndpoint = undefined;
        this.receiveBuffer = Buffer.alloc(0);
        this.remoteProcessInfo = undefined;
        this.ready = false;
        this.buses = new Map();
        this.remoteParticipantsByBusId = new Map();
        this.routingTraceEnabled = options.traceRouting === true || process.env.SEN_TRACE_ROUTING === '1';
        this.localBuses = new LocalBuses({
            buses: this.buses,
            options: () => this.options,
            isStarted: () => Boolean(this.connections.size || this.server),
            openMulticast: bus => this.#openBusMulticastSocket(bus),
            sendProcessControl: message => this.#sendControlPayloadToAll(encodeEtherControlMessage(message)),
            sendBusControl: (bus, connection, message, routing) => (
                this.#sendBusControlToConnection(bus, connection, message, routing)
            ),
            participants: busId => this.#remoteParticipantsForBus(busId),
            emit: (name, detail) => this.emit(name, detail)
        });
        this.localPublications = new LocalPublications({
            emit: (name, detail) => this.emit(name, detail),
            sendControl: (bus, connection, message, routing) => (
                this.#sendBusControlToConnection(bus, connection, message, routing)
            ),
            sendMessage: (bus, connection, payload) => this.#sendBusMessageToConnection(bus, connection, payload),
            sendMulticast: (bus, payload) => this.#sendBusMessageMulticast(bus, payload),
            sendUnicast: (bus, payload) => this.#sendBusMessageUnicast(bus, payload)
        });
        this.remoteRequests = new RemoteRequests({
            limit: () => this.limits.maxPendingRequestsPerBus,
            resolveParticipant: (bus, ownerId, operation) => this.#requireRemoteParticipant(bus, ownerId, operation),
            sendControl: (bus, connection, message, routing) => (
                this.#sendBusControlToConnection(bus, connection, message, routing)
            ),
            trace: record => this.#traceRouting(record),
            emit: (name, detail) => this.emit(name, detail)
        });
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
        this.limits = normalizeResourceLimits(config);
        this.options.resourceLimits = this.limits;
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
        this.#startConnectionPresenceWatchdog(config);
        return this;
    }

    async #startServer(config) {
        const server = net.createServer(socket => {
            try {
                const connection = this.#registerSocket(socket, { incoming: true });
                this.#configureTcpSocket(socket);
                this.#sendHello(connection);
            } catch (error) {
                this.emit('warning', error);
                socket.destroy();
            }
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
                if (config.announceDiscovery !== false) {
                    this.#sendDiscoveryBeam();
                    const period = Math.max(100, Number(config.beamPeriodMs ?? DEFAULT_BEAM_PERIOD_MS));
                    this.discoveryTimer = setInterval(() => this.#sendDiscoveryBeam(), period);
                    this.discoveryTimer.unref?.();
                }
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
                    if (config.announceDiscovery !== false) {
                        this.#sendMulticastDiscoveryBeam();
                        const period = Math.max(100, Number(config.beamPeriodMs ?? DEFAULT_BEAM_PERIOD_MS));
                        this.multicastDiscoveryTimer = setInterval(() => this.#sendMulticastDiscoveryBeam(), period);
                        this.multicastDiscoveryTimer.unref?.();
                    }
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
        if (this.discoveryReceiveBuffer.length + chunk.length > this.limits.maxReceiveBufferSize) {
            const error = resourceLimitError(
                'TCP discovery receive buffer byte length',
                this.limits.maxReceiveBufferSize,
                this.discoveryReceiveBuffer.length + chunk.length
            );
            error.transport = 'tcp-discovery';
            this.discoveryReceiveBuffer = Buffer.alloc(0);
            this.emit('warning', error);
            this.emit('decodeError', error, chunk);
            this.discoverySocket?.destroy();
            return;
        }
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
            beam = decodeSessionPresenceBeam(message, this.limits);
        } catch (error) {
            this.emit('decodeError', error, message);
            return;
        }
        if (beam.info.sessionId !== this.processInfo.sessionId || isSameProcessInfo(beam.info, this.processInfo)) {
            return;
        }
        const key = processKeyFromInfo(beam.info);
        this.emit('beam', beam);
        this.#markConnectionPresence(key);
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
            beam = decodeSessionPresenceBeam(message, this.limits);
        } catch (error) {
            this.emit('decodeError', error, message, remote);
            return;
        }
        if (beam.info.sessionId !== this.processInfo.sessionId || isSameProcessInfo(beam.info, this.processInfo)) {
            return;
        }
        const key = processKeyFromInfo(beam.info);
        this.emit('beam', beam);
        this.#markConnectionPresence(key);
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
        if (this.connections.size >= this.limits.maxConnections) {
            throw resourceLimitError('connection count', this.limits.maxConnections, this.connections.size + 1);
        }

        if (!this.udpSocket) {
            this.udpSocket = dgram.createSocket('udp4');
            this.udpSocket.on('message', (message, remote) => {
                try {
                    this.#onBusFrame(message);
                } catch (error) {
                    error.transport = 'udp';
                    error.remote = remote;
                    this.emit('warning', error);
                    this.emit('decodeError', error, message, remote);
                }
            });
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
        if (this.connections.size >= this.limits.maxConnections) {
            throw resourceLimitError('connection count', this.limits.maxConnections, this.connections.size + 1);
        }
        const connection = {
            id: this.nextConnectionId++,
            generation: this.nextConnectionGeneration++,
            socket,
            incoming: Boolean(metadata.incoming),
            target: metadata.target,
            receiveBuffer: Buffer.alloc(0),
            remoteProcessInfo: metadata.target?.info,
            discoveryLastSeen: metadata.target?.info && this.#hasActiveDiscovery() ? Date.now() : undefined,
            ready: false
        };
        this.connections.set(connection.id, connection);
        if (!this.socket) {
            this.socket = socket;
        }
        socket.on('data', chunk => this.#onTcpData(connection, chunk));
        socket.on('error', error => {
            this.#removeConnection(connection);
            if (!['EPIPE', 'ECONNRESET', 'SEN_PRESENCE_TIMEOUT'].includes(error?.code)) {
                this.emit('error', error);
            }
        });
        socket.on('close', hadError => {
            if (connection.receiveBuffer.length && !connection.protocolViolation) {
                const error = new RangeError(
                    `SEN TCP connection closed with ${connection.receiveBuffer.length} byte(s) of a truncated frame`
                );
                error.code = 'SEN_TRUNCATED_FRAME';
                error.connectionId = connection.id;
                this.emit('warning', error);
            }
            this.#removeConnection(connection);
            this.emit('connectionClose', { connection, hadError });
            if (!this.connections.size) {
                this.ready = false;
                this.emit('close', hadError, connection);
            }
        });
        return connection;
    }

    #removeConnection(connection) {
        this.connections.delete(connection.id);
        if (connection.processKey && this.connectionsByProcessKey.get(connection.processKey) === connection) {
            this.connectionsByProcessKey.delete(connection.processKey);
        }
        const leftParticipants = [];
        for (const [busId, participants] of this.remoteParticipantsByBusId) {
            for (const [participantId, participant] of participants) {
                if (participant.connection === connection) {
                    participants.delete(participantId);
                    leftParticipants.push({
                        participantId,
                        busId,
                        busName: participant.busName,
                        connection,
                        reason: 'connectionClose'
                    });
                }
            }
            if (!participants.size) {
                this.remoteParticipantsByBusId.delete(busId);
            }
        }
        for (const busState of this.buses.values()) {
            for (const key of [...busState.sentInterestGenerations.keys()]) {
                if (key.startsWith(`${connection.generation}:`)) busState.sentInterestGenerations.delete(key);
            }
            for (const [key, interest] of busState.remoteInterests) {
                if (interest.connection === connection) {
                    busState.remoteInterests.delete(key);
                }
            }
            for (const [key, pending] of busState.pendingStateRequests) {
                if (pending.connection === connection) busState.pendingStateRequests.delete(key);
            }
            for (const [key, pending] of busState.pendingTypeRequests) {
                if (pending.connection === connection) busState.pendingTypeRequests.delete(key);
            }
            for (const [key, route] of busState.forwardedObjectRoutes) {
                if (route.connection === connection || route.consumerConnection === connection) {
                    busState.forwardedObjectRoutes.delete(key);
                }
            }
            this.#rebuildForwardedObjectConsumers(busState);
            for (const [key, pending] of busState.pendingTransitCalls) {
                if (pending.connection === connection) busState.pendingTransitCalls.delete(key);
            }
        }
        if (this.socket === connection.socket) {
            this.socket = [...this.connections.values()][0]?.socket;
        }
        for (const participant of leftParticipants) {
            const targets = new Set(
                this.#remoteParticipantsForBus(participant.busId)
                    .map(item => item.connection)
                    .filter(target => target && target !== connection)
            );
            for (const target of targets) {
                this.#sendControlPayloadToConnection(target, encodeEtherControlMessage({
                    type: 'BusLeft',
                    value: {
                        participantId: participant.participantId,
                        busId: participant.busId,
                        busName: participant.busName
                    }
                }));
            }
            this.emit('busLeft', participant);
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

    #markConnectionPresence(processKey) {
        const connection = this.connectionsByProcessKey.get(processKey);
        if (connection) {
            connection.discoveryLastSeen = Date.now();
        }
    }

    #hasActiveDiscovery() {
        return Boolean(this.discoverySocket || this.multicastDiscoverySocket);
    }

    #startConnectionPresenceWatchdog(config) {
        const timeoutMs = Number(config.presenceTimeoutMs ?? this.options.presenceTimeoutMs ?? 0);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return;
        }
        if (this.connectionPresenceTimer) {
            return;
        }

        const intervalMs = Math.max(
            250,
            Number(config.presenceCheckIntervalMs ?? this.options.presenceCheckIntervalMs ?? 1000) || 1000
        );

        this.connectionPresenceTimer = setInterval(() => {
            const now = Date.now();
            for (const connection of this.connections.values()) {
                if (!connection.discoveryLastSeen || !connection.processKey || connection.socket?.destroyed) {
                    continue;
                }
                const elapsedMs = now - connection.discoveryLastSeen;
                if (elapsedMs <= timeoutMs) {
                    continue;
                }
                const error = new Error(`SEN ether presence timeout after ${elapsedMs}ms without beam from ${connection.processKey}`);
                error.code = 'SEN_PRESENCE_TIMEOUT';
                error.connection = connection;
                this.emit('warning', error);
                connection.socket?.destroy();
            }
        }, intervalMs);
        this.connectionPresenceTimer.unref?.();
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
        if (this.connectionPresenceTimer) {
            clearInterval(this.connectionPresenceTimer);
            this.connectionPresenceTimer = undefined;
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
        return await this.localBuses.join(busName, options);
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
        return this.localBuses.start(this.#getBus(bus), query, options);
    }

    /**
   * Stop a previously started interest.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {number} id
   */
    stopInterest(bus, id) {
        this.localBuses.stop(this.#getBus(bus), id);
    }

    /**
   * Request SEN type specs for the given remote object type hashes.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Iterable<number>} typeHashes
   * @param {{ ownerId?: number }} [options] Remote participant that owns the types.
   */
    requestTypes(bus, typeHashes, options = {}) {
        return this.remoteRequests.requestTypes(this.#getBus(bus), typeHashes, options);
    }

    /**
   * Request current dynamic state for already published remote objects.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<{ interestId: number, objectIds: Array<number> }>} requests
   * @param {{ ownerId?: number }} [options] Remote participant that owns the objects.
   */
    requestObjectStates(bus, requests, options = {}) {
        return this.remoteRequests.requestObjectStates(this.#getBus(bus), requests, options);
    }

    /**
   * Publish local JavaScript objects on a joined SEN bus.
   *
   * Objects need at least `{ name, className, properties }`. A `spec` can be
   * supplied for exact SEN typing. If types are configured, className must
   * resolve in that registry; otherwise a simple ClassTypeSpec is inferred.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {object|object[]} objects
   * @param {{ types?: Map<string, object>|Record<string, object>|object[] }} [options]
   */
    publishObjects(bus, objects, options = {}) {
        return this.localPublications.publish(this.#getBus(bus), objects, options);
    }

    /**
   * Update a previously published local object and notify remote interests.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {string | number | object} object Object id, name or published object.
   * @param {object} patch Property values to update.
   */
    updatePublishedObject(bus, object, patch) {
        return this.localPublications.update(this.#getBus(bus), object, patch);
    }

    /**
   * Emit an event declared by a previously published local object's ClassTypeSpec.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {string | number | object} object Object id, name or published object.
   * @param {string} eventName Event name, including inherited events.
   * @param {unknown[]} [args]
   * @param {{ creationTime?: bigint|number }} [options]
   */
    async emitPublishedEvent(bus, object, eventName, args = [], options = {}) {
        return await this.localPublications.emitEvent(this.#getBus(bus), object, eventName, args, options);
    }

    /**
   * Remove previously published local objects from a joined bus.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<string|number>|string|number} objects Object ids or names.
   */
    removePublishedObjects(bus, objects) {
        return this.localPublications.remove(this.#getBus(bus), objects);
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
        this.localBuses.leave(this.#getBus(bus));
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
        if (!socket) return;
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
        if (connection.receiveBuffer.length + chunk.length > this.limits.maxReceiveBufferSize) {
            this.#protocolViolation(connection, resourceLimitError(
                'TCP receive buffer byte length',
                this.limits.maxReceiveBufferSize,
                connection.receiveBuffer.length + chunk.length,
                `connection ${connection.id}`
            ));
            return;
        }
        connection.receiveBuffer = Buffer.concat([connection.receiveBuffer, chunk]);

        while (connection.receiveBuffer.length >= 5) {
            const header = decodeProcessTcpHeader(connection.receiveBuffer);
            if (header.payloadSize > this.limits.maxFrameSize) {
                this.#protocolViolation(connection, resourceLimitError(
                    'TCP frame payload byte length',
                    this.limits.maxFrameSize,
                    header.payloadSize,
                    `connection ${connection.id}`
                ));
                return;
            }
            const frameSize = 5 + header.payloadSize;
            if (connection.receiveBuffer.length < frameSize) {
                return;
            }

            const payload = connection.receiveBuffer.subarray(5, frameSize);
            connection.receiveBuffer = connection.receiveBuffer.subarray(frameSize);
            try {
                this.#onFrame(connection, header.category, payload);
            } catch (error) {
                this.#protocolViolation(connection, error);
                return;
            }
        }
    }

    #onFrame(connection, category, payload) {
        if (category === PROCESS_MESSAGE_CATEGORY.controlMessage) {
            const message = decodeEtherControlMessage(payload, this.limits);
            this.emit('controlMessage', message, connection);
            this.#onControlMessage(connection, message);
            return;
        }

        if (category === PROCESS_MESSAGE_CATEGORY.busMessage) {
            this.#onBusFrame(payload, connection);
            return;
        }

        throw new RangeError(`unknown SEN process frame category: ${category}`);
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
        connection.remoteUdpPort = hello.udpPort;
        connection.processKey = processKeyFromInfo(hello.info);
        const existingConnection = this.connectionsByProcessKey.get(connection.processKey);
        if (existingConnection && existingConnection !== connection) {
            const localKey = processKeyFromInfo(this.processInfo);
            const preferIncoming = localKey.localeCompare(connection.processKey) > 0;
            const keepConnection = existingConnection.incoming === preferIncoming ? existingConnection : connection;
            const discardConnection = keepConnection === existingConnection ? connection : existingConnection;
            this.#traceRouting({
                direction: 'in',
                connection: discardConnection,
                message: 'Hello',
                generation: discardConnection.generation,
                reason: 'duplicate-process-connection',
                discarded: true
            });
            discardConnection.socket?.destroy();
            if (keepConnection !== connection) return;
        }
        if (connection.target?.info && this.#hasActiveDiscovery() && isSameProcessInfo(connection.target.info, hello.info)) {
            connection.discoveryLastSeen ??= Date.now();
        }
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
        const existing = participants.get(participant.id);
        if (existing) {
            if (existing.connection !== connection) {
                this.#traceRouting({
                    direction: 'in',
                    connection,
                    message: 'BusJoined',
                    busId: participant.busId,
                    participantId: participant.id,
                    generation: connection.generation,
                    reason: 'participant-route-already-owned',
                    discarded: true
                });
            }
            return;
        }
        if (participants.size >= this.limits.maxRemoteParticipantsPerBus) {
            this.#protocolViolation(connection, resourceLimitError(
                'remote participant count per bus',
                this.limits.maxRemoteParticipantsPerBus,
                participants.size + 1,
                `bus ${participant.busName}`
            ));
            return;
        }
        const existingParticipants = [...participants.values()];
        participants.set(participant.id, participant);
        this.emit('busJoined', { ...value, connection });

        for (const existingParticipant of existingParticipants) {
            if (existingParticipant.connection === connection) continue;
            this.#sendControlPayloadToConnection(connection, encodeEtherControlMessage({
                type: 'BusJoined',
                value: {
                    participantId: existingParticipant.id,
                    busId: existingParticipant.busId,
                    busName: existingParticipant.busName
                }
            }));
        }
        const targetConnections = new Set(
            existingParticipants
                .map(existingParticipant => existingParticipant.connection)
                .filter(target => target && target !== connection)
        );
        for (const target of targetConnections) {
            this.#sendControlPayloadToConnection(target, encodeEtherControlMessage({ type: 'BusJoined', value }));
        }

        const busState = this.buses.get(participant.busId);
        if (busState) {
            this.#sendBusControlToConnection(busState, connection, {
                type: 'RemoteParticipantReady',
                value: { id: participant.id }
            });
            this.localBuses.restartForConnection(busState, connection);
            this.#forwardRemoteInterestsToConnection(busState, connection);
        }
    }

    #onRemoteBusLeft(connection, value) {
        const busId = value.busId >>> 0;
        const participantId = value.participantId >>> 0;
        const participants = this.remoteParticipantsByBusId.get(busId);
        const participant = participants?.get(participantId);
        if (participant && participant.connection !== connection) return;
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
        if (participant) {
            const targetConnections = new Set(
                [...(participants?.values() ?? [])]
                    .map(item => item.connection)
                    .filter(target => target && target !== connection)
            );
            for (const target of targetConnections) {
                this.#sendControlPayloadToConnection(target, encodeEtherControlMessage({ type: 'BusLeft', value }));
            }
        }
        this.emit('busLeft', { ...value, connection });
    }

    #forwardRemoteInterestsToConnection(busState, connection) {
        for (const interest of busState.remoteInterests.values()) {
            if (interest.connection === connection) continue;
            const busPayload = encodeBusControlMessage({
                type: 'InterestStarted',
                value: { query: interest.query, id: interest.id }
            });
            const payload = encodeConfirmedBusFrame({
                to: interest.participantId,
                busId: busState.busId,
                message: busPayload
            });
            this.#relayBusFrameToConnection(busState, connection, interest.connection, payload, {
                message: 'InterestStarted',
                participantId: interest.participantId,
                interestId: interest.id,
                reason: 'replay-remote-interest'
            });
        }
    }

    #onBusFrame(payload, connection = undefined) {
        const frame = decodeConfirmedBusFrame(payload, this.limits);
        const busMessage = decodeBusMessage(frame.message, this.limits);
        const busState = this.buses.get(frame.busId);
        this.emit('busFrame', { ...frame, busMessage, connection });
        this.#traceRouting({
            direction: 'in',
            connection,
            message: busMessage.categoryName === 'controlMessage'
                ? busMessage.control.type
                : busMessage.categoryName,
            busId: frame.busId,
            participantId: frame.to,
            ownerId: busMessage.control?.value?.ownerId,
            generation: connection?.generation
        });

        if (busState && connection && this.#routeIncomingBusFrame(busState, frame, busMessage, payload, connection)) {
            return;
        }

        if (busMessage.categoryName !== 'controlMessage') {
            this.emit(busMessage.categoryName, { ...frame, ...busMessage, connection });
            if (
                busState
        && (
            busMessage.categoryName === 'runtimeMethodCallBestEffort'
          || busMessage.categoryName === 'runtimeMethodCallConfirmed'
        )
            ) {
                this.localPublications.handleMethodCall(busState, busMessage.call, connection)
                    .catch(error => this.emit('error', error));
            }
            return;
        }

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
                this.emit('objectsPublished', {
                    bus: busState,
                    connection,
                    ...control.value,
                    requestOwnerId: control.value.ownerId,
                    ownerId: frame.to,
                    providerId: frame.to,
                    generation: connection?.generation
                });
                break;
            case 'ObjectsRemoved':
                this.emit('objectsRemoved', {
                    bus: busState,
                    connection,
                    ...control.value,
                    ownerId: frame.to,
                    providerId: frame.to,
                    generation: connection?.generation
                });
                break;
            case 'ObjectsStateResponse':
                this.remoteRequests.acceptObjectStates(busState, frame, control.value, connection);
                break;
            case 'TypesInfoResponse':
                this.remoteRequests.acceptTypes(busState, frame, control.value, connection);
                break;
            case 'TypesInfoRejection':
                this.remoteRequests.acceptTypeRejections(busState, frame, control.value, connection);
                break;
            case 'ObjectsStateRequest':
                this.localPublications.respondToStateRequest(busState, frame, control.value, connection);
                break;
            case 'TypesInfoRequest':
                this.localPublications.respondToTypesRequest(busState, frame, control.value, connection);
                break;
            default:
                break;
        }
    }

    #routeIncomingBusFrame(busState, frame, busMessage, payload, connection) {
        const sourceId = frame.to >>> 0;
        const source = this.#remoteParticipantForBus(busState.busId, sourceId);
        if (source && source.connection !== connection) {
            this.#traceRouting({
                direction: 'in',
                connection,
                message: busMessage.control?.type ?? busMessage.categoryName,
                busId: busState.busId,
                participantId: sourceId,
                generation: connection.generation,
                reason: 'source-connection-mismatch',
                discarded: true
            });
            return true;
        }

        if (busMessage.categoryName !== 'controlMessage') {
            return this.#routeRuntimeBusFrame(busState, frame, busMessage, payload, connection);
        }

        const control = busMessage.control;
        if (control.type === 'InterestStarted' || control.type === 'InterestStopped') {
            this.#relayBusFrameToOthers(busState, connection, payload, {
                message: control.type,
                participantId: sourceId,
                interestId: control.value.id,
                reason: 'remote-interest'
            });
            return false;
        }

        if (control.type === 'ObjectsRemoved') {
            this.#routeObjectsRemoved(busState, sourceId, control.value, connection);
            return false;
        }

        const ownerAddressed = new Set([
            'ObjectsPublished',
            'ObjectsStateRequest',
            'ObjectsStateResponse',
            'TypesInfoRequest',
            'TypesInfoResponse',
            'TypesInfoRejection'
        ]);
        const targetId = control.type === 'RemoteParticipantReady'
            ? control.value.id >>> 0
            : ownerAddressed.has(control.type)
                ? control.value.ownerId >>> 0
                : undefined;
        if (targetId === undefined || targetId === busState.participantId) return false;

        const target = this.#remoteParticipantForBus(busState.busId, targetId);
        if (!target?.connection || target.connection === connection) {
            this.#traceRouting({
                direction: 'in',
                connection,
                message: control.type,
                busId: busState.busId,
                participantId: sourceId,
                ownerId: targetId,
                generation: connection.generation,
                reason: target?.connection === connection ? 'target-equals-source-connection' : 'target-route-missing',
                discarded: true
            });
            return true;
        }

        if (control.type === 'ObjectsPublished') {
            for (const discovery of control.value.discoveries ?? []) {
                for (const object of discovery.objects ?? []) {
                    const key = `${targetId}:${discovery.interestId >>> 0}:${object.id >>> 0}`;
                    if (!busState.forwardedObjectRoutes.has(key)
              && busState.forwardedObjectRoutes.size >= this.limits.maxForwardedObjectRoutesPerBus) {
                        this.#protocolViolation(connection, resourceLimitError(
                            'forwarded object route count per bus',
                            this.limits.maxForwardedObjectRoutesPerBus,
                            busState.forwardedObjectRoutes.size + 1,
                            `bus ${busState.busName}`
                        ));
                        return true;
                    }
                    busState.forwardedObjectRoutes.set(key, {
                        providerId: sourceId,
                        connection,
                        consumerId: targetId,
                        consumerConnection: target.connection,
                        generation: connection.generation
                    });
                    const consumerKey = `${sourceId}:${object.id >>> 0}`;
                    const consumers = busState.forwardedObjectConsumers.get(consumerKey) ?? new Set();
                    consumers.add(targetId);
                    busState.forwardedObjectConsumers.set(consumerKey, consumers);
                }
            }
        }

        this.#relayBusFrameToConnection(busState, target.connection, connection, payload, {
            message: control.type,
            participantId: sourceId,
            ownerId: targetId,
            reason: 'explicit-owner-route'
        });
        return true;
    }

    #routeObjectsRemoved(busState, providerId, value, sourceConnection) {
        const byConnection = new Map();
        for (const removal of value.removals ?? []) {
            for (const objectId of removal.ids ?? []) {
                for (const [key, route] of busState.forwardedObjectRoutes) {
                    if (
                        route.providerId !== providerId
            || !key.endsWith(`:${removal.interestId >>> 0}:${objectId >>> 0}`)
                    ) continue;
                    const list = byConnection.get(route.consumerConnection) ?? [];
                    list.push({ interestId: removal.interestId, ids: [objectId] });
                    byConnection.set(route.consumerConnection, list);
                    busState.forwardedObjectRoutes.delete(key);
                }
            }
        }
        this.#rebuildForwardedObjectConsumers(busState);
        for (const [connection, removals] of byConnection) {
            const busPayload = encodeBusControlMessage({ type: 'ObjectsRemoved', value: { removals } });
            const payload = encodeConfirmedBusFrame({ to: providerId, busId: busState.busId, message: busPayload });
            this.#relayBusFrameToConnection(busState, connection, sourceConnection, payload, {
                message: 'ObjectsRemoved',
                participantId: providerId,
                reason: 'published-object-consumer'
            });
        }
    }

    #routeRuntimeBusFrame(busState, frame, busMessage, payload, connection) {
        const sourceId = frame.to >>> 0;
        if (
            busMessage.categoryName === 'runtimeMethodCallBestEffort'
      || busMessage.categoryName === 'runtimeMethodCallConfirmed'
        ) {
            const call = busMessage.call;
            const objectSuffix = `:${call.objectId >>> 0}`;
            const route = [...busState.forwardedObjectRoutes]
                .find(([key, candidate]) => (
                    key.endsWith(objectSuffix)
          && candidate.consumerId === sourceId
          && candidate.providerId !== sourceId
                ))?.[1];
            if (!route) return false;
            if (busState.pendingTransitCalls.size >= this.limits.maxPendingTransitCallsPerBus) {
                this.#protocolViolation(connection, resourceLimitError(
                    'pending transit method call count per bus',
                    this.limits.maxPendingTransitCallsPerBus,
                    busState.pendingTransitCalls.size + 1,
                    `bus ${busState.busName}`
                ));
                return true;
            }
            busState.pendingTransitCalls.set(`${route.providerId}:${call.objectId >>> 0}:${call.ticketId >>> 0}`, {
                consumerId: sourceId,
                connection,
                generation: connection.generation
            });
            this.#relayBusFrameToConnection(busState, route.connection, connection, payload, {
                message: busMessage.categoryName,
                participantId: sourceId,
                ownerId: route.providerId,
                reason: 'object-provider-route'
            });
            return true;
        }
        if (busMessage.categoryName === 'runtimeMethodResponse') {
            const response = busMessage.response;
            const key = `${sourceId}:${response.objectId >>> 0}:${response.ticketId >>> 0}`;
            const pending = busState.pendingTransitCalls.get(key);
            if (!pending) return false;
            busState.pendingTransitCalls.delete(key);
            this.#relayBusFrameToConnection(busState, pending.connection, connection, payload, {
                message: busMessage.categoryName,
                participantId: sourceId,
                ownerId: pending.consumerId,
                reason: 'method-caller-route'
            });
            return true;
        }

        const objectIds = busMessage.categoryName === 'runtimeObjectUpdate'
            ? [busMessage.update.objectId]
            : busMessage.categoryName === 'runtimeEvents'
                ? (busMessage.events ?? []).map(event => event.producerId)
                : [];
        const targetConnections = new Set();
        for (const objectId of objectIds) {
            for (const consumerId of busState.forwardedObjectConsumers.get(`${sourceId}:${objectId >>> 0}`) ?? []) {
                const target = this.#remoteParticipantForBus(busState.busId, consumerId);
                if (target?.connection && target.connection !== connection) targetConnections.add(target.connection);
            }
        }
        for (const target of targetConnections) {
            this.#relayBusFrameToConnection(busState, target, connection, payload, {
                message: busMessage.categoryName,
                participantId: sourceId,
                reason: 'published-object-consumer'
            });
        }
        return false;
    }

    #rebuildForwardedObjectConsumers(busState) {
        busState.forwardedObjectConsumers.clear();
        for (const [key, route] of busState.forwardedObjectRoutes) {
            const objectId = Number(key.slice(key.lastIndexOf(':') + 1)) >>> 0;
            const consumerKey = `${route.providerId}:${objectId}`;
            const consumers = busState.forwardedObjectConsumers.get(consumerKey) ?? new Set();
            consumers.add(route.consumerId);
            busState.forwardedObjectConsumers.set(consumerKey, consumers);
        }
    }

    #onMulticastBusDatagram(busState, message, remote) {
        try {
            const frame = decodeMulticastBusDatagram(message, this.limits);
            if (frame.processId === this.processInfo.processId) {
                return;
            }
            const ownerId = this.#remoteParticipantsForBus(busState.busId)
                .find(participant => participant.connection?.remoteProcessInfo?.processId === frame.processId)?.id;
            const busMessage = decodeBusMessage(frame.message, this.limits);
            this.emit('busFrame', { ...frame, busId: busState.busId, busMessage, remote, multicast: true });
            if (busMessage.categoryName === 'controlMessage') {
                const control = busMessage.control;
                this.emit('busControlMessage', { ...frame, busId: busState.busId, control, remote, multicast: true });
                switch (control.type) {
                    case 'ObjectsPublished':
                        this.emit('objectsPublished', { bus: busState, remote, multicast: true, ...control.value });
                        break;
                    case 'ObjectsRemoved':
                        this.emit('objectsRemoved', { bus: busState, remote, multicast: true, ...control.value });
                        break;
                    case 'ObjectsStateResponse':
                        this.emit('objectsStateResponse', { bus: busState, remote, multicast: true, ...control.value });
                        break;
                    case 'TypesInfoResponse':
                        this.emit('typesInfoResponse', { bus: busState, remote, multicast: true, ...control.value });
                        break;
                    case 'TypesInfoRejection':
                        this.emit('typesInfoRejection', { bus: busState, remote, multicast: true, ...control.value });
                        break;
                    default:
                        break;
                }
                return;
            }
            this.emit(busMessage.categoryName, {
                ...frame,
                busId: busState.busId,
                ownerId,
                ...busMessage,
                remote,
                multicast: true
            });
        } catch (error) {
            error.transport = 'multicast';
            error.remote = remote;
            this.emit('warning', error);
            this.emit('decodeError', error, message, remote);
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
            this.localBuses.restartForConnection(busState, connection);
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
        const key = remoteInterestKey(remoteParticipantId, id);
        const existing = busState.remoteInterests.get(key);
        if (existing?.query === value.query) {
            return;
        }
        if (!existing && busState.remoteInterests.size >= this.limits.maxRemoteInterestsPerBus) {
            this.#protocolViolation(connection, resourceLimitError(
                'remote interest count per bus',
                this.limits.maxRemoteInterestsPerBus,
                busState.remoteInterests.size + 1,
                `bus ${busState.busName}`
            ));
            return;
        }
        let matches;
        try {
            matches = compileInterestQuery(value.query);
        } catch (error) {
            this.emit('warning', error);
            return;
        }
        busState.remoteInterests.set(key, {
            participantId: remoteParticipantId,
            connection,
            id,
            query: value.query,
            matches,
            objectIds: new Set()
        });
        this.emit('remoteInterestStarted', {
            busName: busState.busName,
            busId: busState.busId,
            participantId: remoteParticipantId,
            connection,
            id,
            query: value.query
        });
        this.localPublications.publishForInterests(busState, [...busState.publishedObjects.values()], [key]);
    }

    #onRemoteInterestStopped(busState, frame, value, connection) {
        const remoteParticipantId = frame.to >>> 0;
        const id = value.id >>> 0;
        busState.remoteInterests.delete(remoteInterestKey(remoteParticipantId, id));
        this.emit('remoteInterestStopped', {
            busName: busState.busName,
            busId: busState.busId,
            participantId: remoteParticipantId,
            connection,
            id
        });
    }

    #sendBusControlToRemoteParticipants(busState, message, routing = {}) {
        const connections = new Set(this.#remoteParticipantsForBus(busState.busId).map(participant => participant.connection));
        for (const connection of connections) {
            if (routing.interest) this.localBuses.sendInterest(busState, connection, routing.interest);
            else this.#sendBusControlToConnection(busState, connection, message, routing);
        }
    }

    #sendBusControlToConnection(busState, connection, message, routing = {}) {
        const busPayload = encodeBusControlMessage(message);
        this.#traceRouting({
            direction: 'out',
            connection,
            message: message.type,
            busId: busState.busId,
            participantId: busState.participantId,
            ownerId: message.value?.ownerId,
            interestId: routing.interestId ?? message.value?.id,
            objectIds: message.value?.requests?.flatMap(request => request.objectIds ?? []),
            typeHashes: routing.typeHashes ?? (message.type === 'TypesInfoRequest' ? message.value?.requests : undefined),
            reason: routing.reason,
            generation: routing.generation ?? connection?.generation
        });
        this.#sendBusMessageToConnection(busState, connection, busPayload);
    }

    #traceRouting(record) {
        if (!this.routingTraceEnabled) return;
        const entry = {
            timestamp: Date.now(),
            direction: record.direction,
            connectionId: record.connection?.id === undefined ? undefined : `tcp-${record.connection.id}`,
            sourceConnectionId: record.sourceConnection?.id === undefined
                ? undefined
                : `tcp-${record.sourceConnection.id}`,
            message: record.message,
            busId: record.busId,
            participantId: record.participantId,
            ownerId: record.ownerId,
            interestId: record.interestId,
            objectIds: record.objectIds,
            typeHashes: record.typeHashes,
            generation: record.generation,
            reason: record.reason,
            discarded: record.discarded
        };
        this.emit('routingTrace', entry);
        if (process.env.SEN_TRACE_ROUTING === '1') process.stderr.write(`${JSON.stringify(entry)}\n`);
    }

    #relayBusFrameToOthers(busState, incomingConnection, payload, routing = {}) {
        const connections = new Set(
            this.#remoteParticipantsForBus(busState.busId)
                .map(participant => participant.connection)
                .filter(connection => connection && connection !== incomingConnection)
        );
        for (const connection of connections) {
            this.#relayBusFrameToConnection(busState, connection, incomingConnection, payload, routing);
        }
    }

    #relayBusFrameToConnection(busState, connection, incomingConnection, payload, routing = {}) {
        const socket = this.#writableConnectionSocket(connection);
        if (!socket) return;
        this.#traceRouting({
            direction: 'relay',
            connection,
            sourceConnection: incomingConnection,
            message: routing.message,
            busId: busState.busId,
            participantId: routing.participantId,
            ownerId: routing.ownerId,
            interestId: routing.interestId,
            generation: connection.generation,
            reason: routing.reason
        });
        try {
            socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, payload));
        } catch {
            this.#removeConnection(connection);
        }
    }

    #sendBusMessageMulticast(busState, busPayload) {
        const datagram = Buffer.allocUnsafe(8 + busPayload.length);
        datagram.writeUInt32LE(this.processInfo.processId >>> 0, 0);
        datagram.writeUInt32LE(busPayload.length, 4);
        busPayload.copy(datagram, 8);
        return new Promise((resolve, reject) => {
            busState.multicastSocket.send(
                datagram,
                this.options.busMulticastPort,
                busState.multicastGroup,
                error => error ? reject(error) : resolve()
            );
        });
    }

    async #sendBusMessageUnicast(busState, busPayload) {
        const frame = encodeConfirmedBusFrame({
            to: busState.participantId,
            busId: busState.busId,
            message: busPayload
        });
        const targets = new Map();
        for (const participant of this.#remoteParticipantsForBus(busState.busId)) {
            const connection = participant.connection;
            const port = connection?.remoteUdpPort;
            let host = connection?.socket?.remoteAddress;
            if (!port || !host) continue;
            if (host.startsWith('::ffff:')) host = host.slice(7);
            if (host.includes(':')) continue;
            targets.set(`${host}:${port}`, { host, port });
        }
        await Promise.all([...targets.values()].map(({ host, port }) => new Promise((resolve, reject) => {
            busState.multicastSocket.send(frame, port, host, error => error ? reject(error) : resolve());
        })));
        return targets.size;
    }

    #sendBusMessageToConnection(busState, connection, busPayload) {
        if (!connection) {
            for (const participant of this.#remoteParticipantsForBus(busState.busId)) {
                this.#sendBusMessageToConnection(busState, participant.connection, busPayload);
            }
            return;
        }
        const socket = this.#writableConnectionSocket(connection);
        if (!socket) {
            return;
        }
        const processBusPayload = encodeConfirmedBusFrame({
            to: busState.participantId,
            busId: busState.busId,
            message: busPayload
        });
        try {
            socket.write(encodeProcessTcpFrame(PROCESS_MESSAGE_CATEGORY.busMessage, processBusPayload));
        } catch {
            this.#removeConnection(connection);
        }
    }

    #writableConnectionSocket(connection) {
        const socket = connection?.socket;
        if (!socket || socket.destroyed || !socket.writable) {
            this.#removeConnection(connection);
            return undefined;
        }
        return socket;
    }

    #remoteParticipantsForBus(busId) {
        return [...(this.remoteParticipantsByBusId.get(busId >>> 0)?.values() ?? [])];
    }

    #remoteParticipantForBus(busId, participantId) {
        return this.remoteParticipantsByBusId.get(busId >>> 0)?.get(participantId >>> 0);
    }

    #requireRemoteParticipant(busState, participantId, operation) {
        if (participantId !== undefined && participantId !== null) {
            const participant = this.#remoteParticipantForBus(busState.busId, participantId);
            if (participant?.connection) return participant;
            const error = new Error(`cannot route SEN ${operation}: participant ${participantId >>> 0} is unavailable`);
            error.code = 'SEN_ROUTE_NOT_FOUND';
            throw error;
        }
        const participants = this.#remoteParticipantsForBus(busState.busId);
        const byConnection = new Map(participants.map(participant => [participant.connection, participant]));
        if (byConnection.size === 1) return byConnection.values().next().value;
        const error = new Error(`cannot route SEN ${operation}: ownerId is required with ${byConnection.size} connections`);
        error.code = 'SEN_ROUTE_REQUIRED';
        throw error;
    }

    #protocolViolation(connection, cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.code ??= 'SEN_PROTOCOL_VIOLATION';
        error.connectionId = connection?.id;
        error.remoteAddress = connection?.socket?.remoteAddress;
        error.remotePort = connection?.socket?.remotePort;
        if (connection) {
            connection.protocolViolation = true;
            connection.receiveBuffer = Buffer.alloc(0);
        }
        this.emit('warning', error);
        this.emit('decodeError', error, undefined, connection);
        connection?.socket?.destroy();
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
