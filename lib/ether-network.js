/**
 * @fileoverview Pure Ether network configuration and identity helpers.
 *
 * The module derives process metadata, validates remote hello messages,
 * computes multicast groups and validates native multicast datagrams. It opens
 * no sockets and therefore remains independently testable.
 */

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { crc32 } from './crc32.js';
import {
    FNV1A_OFFSET_BASIS,
    FNV1A_PRIME,
    HASH_COMBINE_MAGIC
} from './hash32.js';
import { normalizeResourceLimits, resourceLimitError } from './limits.js';

const LINUX_OS_KIND = 1;
const X64_CPU_ARCH = 1;
export const DEFAULT_DISCOVERY_GROUP = '239.255.0.44';
export const DEFAULT_DISCOVERY_PORT = 60543;
export const DEFAULT_BUS_MULTICAST_PORT = 50985;
export const TCP_DISCOVERY_BEAM_SIZE = 508;
export const TCP_DISCOVERY_LENGTH_SIZE = 4;
export const DEFAULT_BEAM_PERIOD_MS = 1000;
const BUS_HASH_SEED = 15071983;
export const DEFAULT_MULTICAST_RANGE = Object.freeze([
    { min: 224, max: 239 },
    { min: 0, max: 255 },
    { min: 0, max: 255 },
    { min: 0, max: 255 }
]);

/** Generate an unsigned random identifier using Node's cryptographic RNG. */
export function randomUInt32() {
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

/** Read and validate `SEN_ETHER_DISCOVERY_PORT` when it is configured. */
export function discoveryPortFromEnv() {
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

/** Resolve an interface name or IPv4 literal to an advertisable IPv4 address. */
export function resolveInterfaceAddress(value) {
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

/** List the explicit or locally available IPv4 multicast interfaces. */
export function multicastInterfaceCandidates(interfaceAddress) {
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

/** Validate the four octet ranges used for deterministic bus multicast groups. */
export function normalizeMulticastRange(value) {
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

/** Derive the native bus multicast group from session, bus and discovery IDs. */
function ipv4ToUint(value) {
    const bytes = String(value).split('.').map(Number);
    if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error(`invalid IPv4 address: ${value}`);
    }
    return (((bytes[0] * 0x1000000) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0);
}

function uintToIpv4(value) {
    const address = value >>> 0;
    return [address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff].join('.');
}

/** Validate and merge inclusive IPv4 exclusion ranges. */
export function normalizeMulticastExclusions(value = []) {
    const ranges = value.map((range, index) => {
        const min = ipv4ToUint(range?.min);
        const max = ipv4ToUint(range?.max);
        if (min > max) throw new Error(`invalid SEN bus multicast exclusion at index ${index}`);
        return { min, max };
    }).sort((a, b) => a.min - b.min);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.min <= previous.max + 1) previous.max = Math.max(previous.max, range.max);
        else merged.push({ ...range });
    }
    return merged;
}

function countRangeAddressesUpTo(ranges, limit) {
    const limitBytes = [limit >>> 24, (limit >>> 16) & 0xff, (limit >>> 8) & 0xff, limit & 0xff];
    let loose = 0;
    let tight = 1;
    for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        const size = range.max - range.min + 1;
        let nextLoose = loose * size;
        let nextTight = 0;
        for (let byte = range.min; byte <= range.max; byte += 1) {
            if (byte < limitBytes[index]) nextLoose += tight;
            else if (byte === limitBytes[index]) nextTight += tight;
            else break;
        }
        loose = nextLoose;
        tight = nextTight;
    }
    return loose + tight;
}

function countRangeInInterval(ranges, min, max) {
    if (min > max) return 0;
    return countRangeAddressesUpTo(ranges, max) - (min === 0 ? 0 : countRangeAddressesUpTo(ranges, min - 1));
}

function countUsableAddressesUpTo(ranges, exclusions, limit) {
    let count = countRangeAddressesUpTo(ranges, limit);
    for (const exclusion of exclusions) {
        if (exclusion.min > limit) break;
        count -= countRangeInInterval(ranges, exclusion.min, Math.min(exclusion.max, limit));
    }
    return count;
}

function computeUsableAddress(ranges, exclusions, hash) {
    const count = countUsableAddressesUpTo(ranges, exclusions, 0xffffffff);
    if (count === 0) throw new Error('SEN bus multicast range has no usable addresses after exclusions');
    const index = (hash >>> 0) % count;
    let lower = 0;
    let upper = 0xffffffff;
    while (lower < upper) {
        const candidate = lower + Math.floor((upper - lower) / 2);
        if (countUsableAddressesUpTo(ranges, exclusions, candidate) > index) upper = candidate;
        else lower = candidate + 1;
    }
    return uintToIpv4(lower);
}

/** Derive the native bus multicast group from session, bus and discovery IDs. */
export function computeBusMulticastGroup(sessionId, busId, discoveryPort, ranges, options = {}) {
    let hash = BUS_HASH_SEED;
    hash = combineHashed(hash, hashIntegral(sessionId >>> 0, 4));
    hash = combineHashed(hash, hashIntegral(busId >>> 0, 4));
    hash = combineHashed(hash, hashIntegral(discoveryPort >>> 0, 2));
    if (options.allocation === 'usable-address-index') {
        return computeUsableAddress(ranges, normalizeMulticastExclusions(options.exclusions), hash);
    }
    const bytes = [
        computeByte(ranges[0], hash & 0xff),
        computeByte(ranges[1], (hash >>> 8) & 0xff),
        computeByte(ranges[2], (hash >>> 16) & 0xff),
        computeByte(ranges[3], (hash >>> 24) & 0xff)
    ];
    return bytes.map((byte, index) => Math.min(Math.max(byte, ranges[index].min), ranges[index].max)).join('.');
}


/** Build the stable discovery key for one remote process identity. */
export function processKeyFromInfo(info = {}) {
    return `${info.hostId}:${info.processId}:${info.sessionId}`;
}

/** Compare the host, process and session components of two ProcessInfo values. */
export function isSameProcessInfo(a = {}, b = {}) {
    return (
        (a.hostId >>> 0) === (b.hostId >>> 0) &&
    (a.processId >>> 0) === (b.processId >>> 0) &&
    (a.sessionId >>> 0) === (b.sessionId >>> 0)
    );
}

/** Build a collision-free key for an interest owned by a remote participant. */
export function remoteInterestKey(participantId, interestId) {
    return `${participantId >>> 0}:${interestId >>> 0}`;
}

/** Choose an explicit or first non-loopback address for discovery beams. */
export function firstAdvertisableAddress(interfaceAddress) {
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

/** Normalize string or object TCP endpoints to `{host, port}`. */
export function parseHostPort(value, fallbackPort) {
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

/** Pad a discovery beam to the fixed TCP hub record size. */
export function padDiscoveryBeam(buffer) {
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

/** Encode one TCP discovery record using the selected SEN transport framing. */
export function encodeTcpDiscoveryBeam(buffer, framing = 'fixed-508') {
    const beam = Buffer.from(buffer);
    if (beam.length > TCP_DISCOVERY_BEAM_SIZE) {
        throw new Error(`SEN discovery beam is too large: ${beam.length} > ${TCP_DISCOVERY_BEAM_SIZE}`);
    }
    if (framing === 'fixed-508') return padDiscoveryBeam(beam);
    if (framing !== 'length-prefixed') throw new TypeError(`unsupported SEN TCP discovery framing: ${framing}`);
    const header = Buffer.allocUnsafe(TCP_DISCOVERY_LENGTH_SIZE);
    header.writeUInt32LE(beam.length);
    return Buffer.concat([header, beam]);
}

/** Extract complete TCP discovery records and retain the incomplete tail. */
export function extractTcpDiscoveryBeams(buffer, framing = 'fixed-508') {
    const messages = [];
    let remaining = buffer;
    if (framing === 'fixed-508') {
        while (remaining.length >= TCP_DISCOVERY_BEAM_SIZE) {
            messages.push(remaining.subarray(0, TCP_DISCOVERY_BEAM_SIZE));
            remaining = remaining.subarray(TCP_DISCOVERY_BEAM_SIZE);
        }
        return { messages, remaining };
    }
    if (framing !== 'length-prefixed') throw new TypeError(`unsupported SEN TCP discovery framing: ${framing}`);
    while (remaining.length >= TCP_DISCOVERY_LENGTH_SIZE) {
        const length = remaining.readUInt32LE(0);
        if (length === 0 || length > TCP_DISCOVERY_BEAM_SIZE) {
            throw new RangeError(`invalid SEN TCP discovery beam length: ${length}`);
        }
        const recordSize = TCP_DISCOVERY_LENGTH_SIZE + length;
        if (remaining.length < recordSize) break;
        messages.push(remaining.subarray(TCP_DISCOVERY_LENGTH_SIZE, recordSize));
        remaining = remaining.subarray(recordSize);
    }
    return { messages, remaining };
}

/** Resolve when a close callback fires or a bounded fallback timer expires. */
export function withCloseTimeout(register, timeoutMs = 1000) {
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
 * Decode a native SEN multicast bus datagram.
 *
 * Native bus multicast datagrams are already scoped to a bus socket, so the
 * payload does not include the confirmed frame target/bus header.
 *
 * @param {Buffer | Uint8Array | ArrayBuffer} message
 */
export function decodeMulticastBusDatagram(message, limits = {}) {
    const buffer = Buffer.from(message);
    const normalizedLimits = normalizeResourceLimits(limits);
    if (buffer.length < 8) {
        throw new RangeError(`SEN multicast bus datagram too small: ${buffer.length}`);
    }

    const processId = buffer.readUInt32LE(0);
    const payloadSize = buffer.readUInt32LE(4);
    if (payloadSize > normalizedLimits.maxFrameSize) {
        throw resourceLimitError('multicast frame byte length', normalizedLimits.maxFrameSize, payloadSize);
    }
    const end = 8 + payloadSize;
    if (payloadSize > buffer.length - 8) {
        throw new RangeError(`SEN multicast bus datagram payload is truncated: ${payloadSize} > ${buffer.length - 8}`);
    }

    return {
        processId,
        payloadSize,
        message: buffer.subarray(8, end)
    };
}
