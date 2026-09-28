/**
 * @fileoverview Pure Ether network configuration and identity helpers.
 *
 * The module derives process metadata, validates remote hello messages,
 * computes multicast groups and validates native multicast datagrams. It opens
 * no sockets and therefore remains independently testable.
 */
export declare const DEFAULT_DISCOVERY_GROUP = "239.255.0.44";
export declare const DEFAULT_DISCOVERY_PORT = 60543;
export declare const DEFAULT_BUS_MULTICAST_PORT = 50985;
export declare const TCP_DISCOVERY_BEAM_SIZE = 508;
export declare const DEFAULT_BEAM_PERIOD_MS = 1000;
export declare const DEFAULT_MULTICAST_RANGE: readonly {
    min: number;
    max: number;
}[];
/** Generate an unsigned random identifier using Node's cryptographic RNG. */
export declare function randomUInt32(): number;
/** Read and validate `SEN_ETHER_DISCOVERY_PORT` when it is configured. */
export declare function discoveryPortFromEnv(): number | undefined;
/** Resolve an interface name or IPv4 literal to an advertisable IPv4 address. */
export declare function resolveInterfaceAddress(value: any): string | undefined;
/** List the explicit or locally available IPv4 multicast interfaces. */
export declare function multicastInterfaceCandidates(interfaceAddress: any): any[];
/** Validate the four octet ranges used for deterministic bus multicast groups. */
export declare function normalizeMulticastRange(value: any): {
    min: number;
    max: number;
}[];
/** Derive the native bus multicast group from session, bus and discovery IDs. */
export declare function computeBusMulticastGroup(sessionId: any, busId: any, discoveryPort: any, ranges: any): string;
/** Build the stable discovery key for one remote process identity. */
export declare function processKeyFromInfo(info?: {}): string;
/** Compare the host, process and session components of two ProcessInfo values. */
export declare function isSameProcessInfo(a?: {}, b?: {}): boolean;
/** Build a collision-free key for an interest owned by a remote participant. */
export declare function remoteInterestKey(participantId: any, interestId: any): string;
/** Choose an explicit or first non-loopback address for discovery beams. */
export declare function firstAdvertisableAddress(interfaceAddress: any): any;
/** Normalize string or object TCP endpoints to `{host, port}`. */
export declare function parseHostPort(value: any, fallbackPort: any): {
    host: any;
    port: number;
} | undefined;
/** Pad a discovery beam to the fixed TCP hub record size. */
export declare function padDiscoveryBeam(buffer: any): any;
/** Resolve when a close callback fires or a bounded fallback timer expires. */
export declare function withCloseTimeout(register: any, timeoutMs?: number): Promise<any>;
export declare function createProcessInfo(options: any): {
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
export declare function validateRemoteHello(hello: any, options: any, processInfo: any): void;
/**
 * Decode a native SEN multicast bus datagram.
 *
 * Native bus multicast datagrams are already scoped to a bus socket, so the
 * payload does not include the confirmed frame target/bus header.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} message
 */
export declare function decodeMulticastBusDatagram(message: Buffer | Uint8Array | ArrayBuffer, limits?: {}): {
    processId: number;
    payloadSize: number;
    message: Buffer<ArrayBuffer>;
};
