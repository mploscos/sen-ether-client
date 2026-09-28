/**
 * @fileoverview Direct Sen Ether process client and connection-aware router.
 *
 * The class owns sockets and connection generations. Focused collaborators own
 * local buses, publications and pending owner-scoped requests.
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { LocalPublications } from './local-publications.js';
import { RemoteRequests } from './remote-requests.js';
import { LocalBuses } from './local-buses.js';
import { createProcessInfo, decodeMulticastBusDatagram, validateRemoteHello } from './ether-network.js';
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
export declare class EtherClient extends EventEmitter {
    #private;
    options: {
        sessionName: string;
        appName: string;
        kernelProtocolVersion: number;
        etherProtocolVersion: number;
        socketKeepAlive: boolean;
        socketKeepAliveInitialDelayMs: number;
        socketIdleTimeoutMs: number;
        group: string;
        bindAddress: undefined;
        discoveryPort: number;
        tcpHub: undefined;
        listen: boolean;
        listenHost: string;
        listenPort: number;
        advertisedHost: undefined;
        beamPeriodMs: number;
        announceDiscovery: boolean;
        presenceTimeoutMs: number;
        presenceCheckIntervalMs: number;
        busMulticastPort: number;
        busMulticastRange: readonly {
            min: number;
            max: number;
        }[];
    };
    limits: Readonly<{
        [k: string]: number;
    }>;
    processInfo: {
        hostId: any;
        processId: any;
        sessionId: number;
        sessionName: any;
        appName: any;
        hostName: any;
        osKindCode: any;
        osName: any;
        cpuArchCode: any;
    };
    interfaceAddress: string | undefined;
    busMulticastRange: {
        min: number;
        max: number;
    }[];
    socket: any;
    udpSocket: dgram.Socket | undefined;
    server: net.Server | undefined;
    discoverySocket: net.Socket | undefined;
    discoveryReceiveBuffer: Buffer<ArrayBuffer>;
    discoveryTimer: NodeJS.Timeout | undefined;
    connectionPresenceTimer: NodeJS.Timeout | undefined;
    multicastDiscoverySocket: dgram.Socket | undefined;
    multicastDiscoveryTimer: NodeJS.Timeout | undefined;
    connections: Map<any, any>;
    connectionsByProcessKey: Map<any, any>;
    nextConnectionId: number;
    nextConnectionGeneration: number;
    listenEndpoint: {
        host: any;
        port: any;
    } | undefined;
    receiveBuffer: Buffer<ArrayBuffer>;
    remoteProcessInfo: any;
    ready: boolean;
    buses: Map<any, any>;
    remoteParticipantsByBusId: Map<any, any>;
    routingTraceEnabled: boolean;
    localBuses: LocalBuses;
    localPublications: LocalPublications;
    remoteRequests: RemoteRequests;
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
    constructor(options: {
        sessionName: string;
        appName?: string;
        kernelProtocolVersion?: number;
        etherProtocolVersion?: number;
        socketKeepAlive?: boolean;
        socketKeepAliveInitialDelayMs?: number;
        socketIdleTimeoutMs?: number;
    });
    /**
   * Start this JS process as an active Ether node.
   *
   * It opens a TCP listener for process-to-process traffic and, when `tcpHub`
   * is configured, beams its presence to the hub while connecting to compatible
   * remote processes announced by the hub.
   */
    start(options?: {}): Promise<this>;
    /**
   * Connect to one endpoint from a SessionPresenceBeam process entry.
   *
   * @param {{ endpoints?: Array<{ host: string, port: number }>, info?: object } | { host: string, port: number }} target
   */
    connect(target: {
        endpoints?: Array<{
            host: string;
            port: number;
        }>;
        info?: object;
    } | {
        host: string;
        port: number;
    }): Promise<this>;
    close(): Promise<void>;
    /**
   * Announce a JS participant on a SEN bus.
   *
   * @param {string} busName
   * @param {{ participantId?: number }} [options]
   */
    joinBus(busName: string, options?: {
        participantId?: number;
    }): Promise<{
        busName: any;
        busId: any;
        participantId: any;
        multicastGroup: any;
        multicastPort: any;
    }>;
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
    startInterest(bus: string | number, query: string, options?: {
        id?: number;
    }): {
        busName: any;
        busId: any;
        id: any;
        query: any;
    };
    /**
   * Stop a previously started interest.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {number} id
   */
    stopInterest(bus: string | number, id: number): void;
    /**
   * Request SEN type specs for the given remote object type hashes.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Iterable<number>} typeHashes
   * @param {{ ownerId?: number }} [options] Remote participant that owns the types.
   */
    requestTypes(bus: string | number, typeHashes: Iterable<number>, options?: {
        ownerId?: number;
    }): {
        busName: any;
        busId: any;
        requests: number[];
    } | {
        busName: any;
        busId: any;
        ownerId: any;
        requests: number[];
    };
    /**
   * Request current dynamic state for already published remote objects.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<{ interestId: number, objectIds: Array<number> }>} requests
   * @param {{ ownerId?: number }} [options] Remote participant that owns the objects.
   */
    requestObjectStates(bus: string | number, requests: Array<{
        interestId: number;
        objectIds: Array<number>;
    }>, options?: {
        ownerId?: number;
    }): {
        busName: any;
        busId: any;
        requests: any;
    } | {
        busName: any;
        busId: any;
        ownerId: any;
        requests: any;
    };
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
    publishObjects(bus: string | number, objects: object | object[], options?: {
        types?: Map<string, object> | Record<string, object> | object[];
    }): object[];
    /**
   * Update a previously published local object and notify remote interests.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {string | number | object} object Object id, name or published object.
   * @param {object} patch Property values to update.
   */
    updatePublishedObject(bus: string | number, object: string | number | object, patch: object): any;
    /**
   * Emit an event declared by a previously published local object's ClassTypeSpec.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {string | number | object} object Object id, name or published object.
   * @param {string} eventName Event name, including inherited events.
   * @param {unknown[]} [args]
   * @param {{ creationTime?: bigint|number }} [options]
   */
    emitPublishedEvent(bus: string | number, object: string | number | object, eventName: string, args?: unknown[], options?: {
        creationTime?: bigint | number;
    }): Promise<{
        busName: any;
        busId: any;
        object: any;
        event: any;
        args: any[];
        creationTime: any;
        creationTimeNs: bigint;
        transportMode: any;
    }>;
    /**
   * Remove previously published local objects from a joined bus.
   *
   * @param {string | number} bus Bus name or bus id.
   * @param {Array<string|number>|string|number} objects Object ids or names.
   */
    removePublishedObjects(bus: string | number, objects: Array<string | number> | string | number): any[];
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
    sendRuntimeMethodCall(bus: string | number, call: {
        to: number;
        objectId: number;
        methodId: number;
        ticketId: number;
        confirmed?: boolean;
        argumentsBuffer?: Buffer | Uint8Array | ArrayBuffer;
    }): void;
    /**
   * Announce that the local JS participant leaves a SEN bus.
   *
   * @param {string | number} bus Bus name or bus id.
   */
    leaveBus(bus: string | number): void;
}
