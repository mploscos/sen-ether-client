import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { DEFAULT_DISCOVERY_GROUP, DEFAULT_DISCOVERY_PORT, TCP_DISCOVERY_BEAM_SIZE } from './ether-network.js';
export { DEFAULT_DISCOVERY_GROUP, DEFAULT_DISCOVERY_PORT, TCP_DISCOVERY_BEAM_SIZE };
export declare const DEFAULT_SCAN_TIMEOUT_MS = 3000;
/**
 * Passive SEN ether multicast discovery scanner.
 *
 * It listens for sen.components.ether.SessionPresenceBeam messages. It does
 * not join SEN buses or create interests.
 */
export declare class EtherDiscoveryScanner extends EventEmitter {
    group: string;
    port: number;
    interfaceAddress: string | undefined;
    bindAddress: string | undefined;
    socket: dgram.Socket | null;
    processes: Map<any, any>;
    limits: Readonly<{
        [k: string]: number;
    }>;
    /**
     * @param {object} [options]
     * @param {string} [options.group]
     * @param {number} [options.port]
     * @param {string} [options.interfaceAddress]
     * @param {string} [options.bindAddress]
     */
    constructor(options?: {
        group?: string;
        port?: number;
        interfaceAddress?: string;
        bindAddress?: string;
    });
    start(): Promise<this>;
    stop(): Promise<void>;
    listProcesses(): any[];
}
/**
 * Passive SEN ether TCP discovery-hub scanner.
 *
 * SEN's TcpDiscoveryHub forwards fixed-size beam buffers between connected
 * clients. This scanner does not announce itself; it only listens for beams.
 */
export declare class TcpDiscoveryHubScanner extends EventEmitter {
    #private;
    host: string;
    port: number;
    socket: net.Socket | null;
    receiveBuffer: Buffer<ArrayBuffer>;
    processes: Map<any, any>;
    limits: Readonly<{
        [k: string]: number;
    }>;
    /**
     * @param {object} [options]
     * @param {string} [options.host]
     * @param {number} [options.port]
     */
    constructor(options?: {
        host?: string;
        port?: number;
    });
    start(): Promise<this>;
    stop(): Promise<void>;
    listProcesses(): any[];
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
export declare function scan(options?: {
    timeout?: number;
    settleMs?: number;
    signal?: AbortSignal;
}): Promise<Array<object>>;
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
export declare function scanTcpDiscoveryHub(options?: {
    host?: string;
    port?: number;
    timeout?: number;
    settleMs?: number;
    signal?: AbortSignal;
}): Promise<Array<object>>;
