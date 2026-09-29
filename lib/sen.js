/**
 * @fileoverview Public high-level Sen API, session discovery and reconnection.
 *
 * Remote object behavior and publication restoration live in dedicated modules;
 * this file coordinates sessions and preserves the package's public API.
 */

import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { EtherClient } from './client.js';
import { EtherDiscoveryScanner, TcpDiscoveryHubScanner, scan, scanTcpDiscoveryHub } from './discovery.js';
import { loadFom, loadStl } from './stl-node.js';
import { LiveDiscovery } from './live-discovery.js';
import { normalizeResourceLimits } from './limits.js';
import { SenBus } from './sen-bus.js';
import { SenInterest } from './sen-interest.js';
import { SenRemoteObject } from './sen-remote-object.js';
import { selectorDescription } from './sen-object-helpers.js';
import { PublicationRegistry, SenPublishedObject } from './sen-publications.js';

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForEvent(emitter, event, timeoutMs) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    });
    try {
        return await Promise.race([once(emitter, event), timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function parseHostPort(value) {
    const text = String(value || '').trim();
    const idx = text.lastIndexOf(':');
    if (idx <= 0) {
        throw new Error(`invalid SEN tcp hub, expected host:port: ${text}`);
    }
    const host = text.slice(0, idx);
    const port = Number(text.slice(idx + 1));
    if (!host || !Number.isInteger(port) || port <= 0) {
        throw new Error(`invalid SEN tcp hub, expected host:port: ${text}`);
    }
    return { host, port };
}

function etherBusName(sessionName, bus) {
    const session = String(sessionName || '').trim();
    const text = String(bus || '').trim();
    const prefix = `${session}.`;
    return session && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function queryBusName(sessionName, bus) {
    const session = String(sessionName || '').trim();
    const text = String(bus || '').trim();
    return text.includes('.') || !session ? text : `${session}.${text}`;
}

function targetSessionName(target) {
    return target?.session?.name ?? target?.info?.sessionName ?? '';
}

function filterTargets(processes, options = {}) {
    let candidates = [...processes];
    if (options.session) {
        candidates = candidates.filter(item => targetSessionName(item) === options.session);
    }
    if (options.app) {
        const app = String(options.app).toLowerCase();
        candidates = candidates.filter(item => String(item.process?.appName || '').toLowerCase().includes(app));
    }
    return candidates;
}

function findTarget(processes, options) {
    const candidates = filterTargets(processes, options);
    if (!candidates.length) {
        return null;
    }
    return candidates[0];
}


function inferBusNameFromInterest(query) {
    const match = String(query || '').match(/\bfrom\s+([^\s;]+)/i);
    if (!match) {
        throw new Error(`cannot infer SEN bus from interest query: ${query}`);
    }
    return match[1];
}

function sessionNameFromBusName(busName) {
    const text = String(busName || '').trim();
    const idx = text.indexOf('.');
    return idx > 0 ? text.slice(0, idx) : '';
}

function busSummary(sessionName, busName) {
    const session = String(sessionName || '').trim();
    const bus = etherBusName(session, busName);
    if (!session || !bus) {
        return null;
    }
    return {
        session,
        bus,
        qualified: queryBusName(session, bus)
    };
}

function knownBusNames(sen) {
    return [...new Set([
        ...sen.remoteBuses,
        ...sen.buses.keys()
    ])].sort();
}


async function waitForSessionBuses(session, timeoutMs) {
    if (timeoutMs <= 0) {
        return session.listBuses();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await wait(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return session.listBuses();
}


export class Sen extends EventEmitter {
    /**
   * Create, connect and return a SEN ether client.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @returns {Promise<Sen>}
   */
    static async connect(options = {}) {
        const sen = new Sen(options);
        return await sen.connect(options);
    }

    /**
   * Load and resolve an STL file or directory into a reusable type registry.
   * This is a Node-only convenience; parsing itself is transport independent.
   *
   * @param {string} sourcePath Entry STL file or directory.
   * @param {{includePaths?: string[]}} [options]
   */
    static async loadStl(sourcePath, options = {}) {
        return await loadStl(sourcePath, options);
    }

    /** Load HLA FOM XML modules into a reusable SEN type registry. */
    static async loadFom(sourcePath, options = {}) {
        return await loadFom(sourcePath, options);
    }

    /**
   * Discover visible SEN buses without creating interests or joining buses.
   *
   * SEN discovery beams expose sessions/processes. Bus names are announced only
   * after a lightweight process connection, so this method connects to each
   * discovered session long enough to read its remote bus announcements.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @returns {Promise<Array<{session:string,bus:string,qualified:string}>>}
   */
    static async discoverBuses(options = {}) {
        const sen = new Sen(options);
        try {
            return await sen.discoverBuses(options);
        } finally {
            await sen.close().catch(() => {});
        }
    }

    /** @param {import('../index.js').SenConnectOptions} [options] */
    constructor(options = {}) {
        super();
        this.options = {
            appName: 'sen-ether-client',
            reconnect: true,
            reconnectDelayMs: 500,
            maxReconnectAttempts: 0,
            announceDiscovery: false,
            targetDiscoverySettleMs: 1000,
            timeout: 3000,
            methodTimeout: 5000,
            discoverySettleMs: 100,
            participantReadyTimeoutMs: 1000,
            socketKeepAlive: true,
            socketKeepAliveInitialDelayMs: 1000,
            socketIdleTimeoutMs: 0,
            presenceTimeoutMs: 5000,
            presenceCheckIntervalMs: 1000,
            ...options
        };
        this.options.resourceLimits = normalizeResourceLimits(this.options);
        this.target = undefined;
        this.client = undefined;
        this.connectOptions = undefined;
        this.manualClose = false;
        this.reconnecting = false;
        this.presenceScanner = undefined;
        this.presenceTimer = undefined;
        this.presenceLastSeen = 0;
        this.remoteBuses = new Set();
        this.remoteBusWaiters = new Map();
        this.busParticipantReadyWaiters = new Map();
        this.buses = new Map();
        this.busJoinPromises = new Map();
        this.sessions = new Map();
        this.sessionConnectPromises = new Map();
        this.targets = [];
        this.targetsBySession = new Map();
        this.publications = new PublicationRegistry(this);
        this.published = this.publications.records;
        this.reconnectPromise = undefined;
        this.localProducer = false;
    }

    /**
   * Discover and connect to one existing SEN ether process.
   *
   * @param {import('../index.js').SenConnectOptions} [options]
   * @param {string} [options.tcpHub] Discovery hub as `host:port`.
   * @param {string} [options.session] Session filter.
   * @param {string} [options.app] Remote appName substring filter.
   * @param {number} [options.timeout] Discovery and ready timeout in ms.
   * @param {number} [options.discoverySettleMs] TCP discovery settle time after the first process is found.
   * @param {{host:string, port:number}|object} [options.target] Direct target.
   */
    async connect(options = {}) {
        const config = { ...this.options, ...options };
        config.resourceLimits = normalizeResourceLimits(config);
        this.options.resourceLimits = config.resourceLimits;
        this.options.methodTimeout = config.methodTimeout;
        this.connectOptions = config;
        this.manualClose = false;
        this.localProducer = false;

        if (!config.session && !config.target && config.announceDiscovery) {
            this.localProducer = true;
            this.emit('connect', { sessions: [], targets: [] });
            return this;
        }

        if (!config.session && !config.target) {
            if (config.progressiveDiscovery !== false) {
                this.liveDiscovery = new LiveDiscovery(config, target => {
                    this.targets = this.targets.filter(value => value.key !== target.key);
                    this.targets.push(target);
                    this.#rememberTargets([target]);
                }, error => this.emit('warning', error));
                await this.liveDiscovery.start();
                if (this.manualClose) throw new Error('SEN client closed');
                this.emit('connect', { sessions: this.listSessions(), targets: this.targets, discovering: true });
                return this;
            }
            // Retain all targets long enough for multi-session consumer discovery.
            const targets = await this.#discoverTargets({
                ...config,
                discoverySettleMs: this.#targetDiscoverySettleMs(config)
            });
            if (!targets.length) {
                throw new Error('no SEN ether processes discovered');
            }
            this.targets = targets;
            this.#rememberTargets(targets, { replace: false });
            this.emit('connect', {
                sessions: [...this.targetsBySession.keys()],
                targets
            });
            return this;
        }

        return await this.#connectSingle(config);
    }

    async #connectSingle(config) {
        const target = config.localSession ? undefined : config.target ?? await this.#discoverTarget(config);
        const activeNode = Boolean(config.session && (
            config.localSession || config.tcpHub || config.multicastDiscovery !== false
        ));
        if (!target && !activeNode) {
            throw new Error('no SEN ether process matches the requested filters');
        }
        if (!target && activeNode) {
            config.localSession = true;
        }

        const sessionName = target?.session?.name ?? target?.info?.sessionName ?? config.session;
        if (!sessionName) {
            throw new Error('cannot connect without a SEN session name');
        }
        if (target && !this.targets.includes(target)) {
            this.targets.push(target);
        }
        if (target && !this.targetsBySession.has(sessionName)) {
            this.targetsBySession.set(sessionName, target);
        }

        const client = new EtherClient({
            sessionName,
            appName: config.appName,
            tcpHub: config.tcpHub,
            multicastDiscovery: config.multicastDiscovery,
            listen: config.listen,
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            advertisedHost: config.advertisedHost,
            beamPeriodMs: config.beamPeriodMs,
            announceDiscovery: config.announceDiscovery,
            socketKeepAlive: config.socketKeepAlive,
            socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
            socketIdleTimeoutMs: config.socketIdleTimeoutMs,
            presenceTimeoutMs: config.presenceTimeoutMs,
            presenceCheckIntervalMs: config.presenceCheckIntervalMs,
            interfaceAddress: config.interfaceAddress,
            group: config.group,
            bindAddress: config.bindAddress,
            discoveryPort: config.port,
            busMulticast: config.busMulticast,
            busMulticastPort: config.busMulticastPort,
            busMulticastRange: config.busMulticastRange,
            resourceLimits: config.resourceLimits
        });
        this.client = client;
        this.target = target ?? { session: { name: sessionName }, process: client.processInfo, info: client.processInfo, local: true };
        this.#wireClient(client);

        try {
            if (config.tcpHub || config.listen !== false) {
                await client.start(config);
            }
            if (target) {
                await client.connect(target);
                await waitForEvent(client, 'ready', config.timeout ?? 3000);
                this.#startPresenceWatchdog(target, config);
            }
            this.emit('connect', { target: this.target, sessionName });
            return this;
        } catch (error) {
            await client.close().catch(closeError => this.emit('warning', closeError));
            if (this.client === client) {
                this.client = undefined;
                this.target = undefined;
            }
            throw error;
        }
    }

    /**
   * Join a bus and start an interest. By default the interest is
   * `SELECT * FROM <session>.<bus>`.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {import('../index.js').SenInterestOptions} [options]
   * @param {string} [options.query]
   * @param {boolean} [options.forceBus]
   * @param {number} [options.timeout]
   * @param {number} [options.id] Optional native interest id. Defaults to CRC32(query).
   * @returns {Promise<SenBus>}
   */
    async subscribe(busName, options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.subscribe(busName, options);
        }

        if (!this.client || !this.target) {
            throw new Error('Sen is not connected');
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        this.#assertBusBelongsToSession(busName, sessionName);
        const bus = etherBusName(sessionName, busName);
        const query = options.query ?? `SELECT * FROM ${queryBusName(sessionName, busName)}`;
        const timeout = options.timeout ?? this.options.timeout ?? 3000;

        if (!options.forceBus) {
            await this.#waitForRemoteBus(bus, timeout);
        }

        const senBus = await this.#getOrJoinBus(bus, options, timeout);

        senBus.startInterest(query, options);
        return senBus;
    }

    /**
   * Start a native SEN interest and return a live object collection.
   *
   * @param {string} query Native SEN interest query, for example `SELECT * FROM session.bus`.
   * @param {import('../index.js').SenInterestOptions} [options]
   * @param {string} [options.bus] Explicit bus when it cannot be inferred from the query.
   * @param {boolean} [options.forceBus]
   * @param {number} [options.timeout]
   * @param {string[]|string} [options.properties] Optional property names to decode and emit.
   * @param {'individual'|'batch'|'both'} [options.changeMode] Defaults to `individual`.
   * @param {number} [options.batchIntervalMs] Batch flush interval in ms.
   * @param {number} [options.batchMaxSize] Batch flush size.
   * @param {number} [options.maxQueuedChanges] Backpressure queue limit for batched changes.
   * @param {'drop-oldest'|'drop-newest'|'error'} [options.backpressure]
   * @param {boolean} [options.coalesce] Keep only the latest queued change per object/property.
   * @returns {Promise<SenInterest>}
   */
    async interest(query, options = {}) {
        const busName = options.bus ?? inferBusNameFromInterest(query);
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.interest(query, options);
        }

        if (!this.client || !this.target) {
            throw new Error('Sen is not connected');
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        if (!options.bus) {
            this.#assertBusBelongsToSession(busName, sessionName);
        }
        const bus = etherBusName(sessionName, busName);
        const timeout = options.timeout ?? this.options.timeout ?? 3000;

        if (!options.forceBus) {
            await this.#waitForRemoteBus(bus, timeout);
        }

        const senBus = await this.#getOrJoinBus(bus, options, timeout);

        return senBus.startInterest(query, options);
    }

    /**
   * @param {string} name
   * @param {import('../index.js').SenInterestOptions} [options]
   * @returns {Promise<SenBus>}
   */
    async bus(name, options = {}) {
        return await this.subscribe(name, options);
    }

    /**
   * Publish local JavaScript objects on a SEN bus.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {import('../index.js').SenPublishedObjectDescriptor|import('../index.js').SenPublishedObjectDescriptor[]} objects
   * @param {import('../index.js').SenPublishOptions} [options]
   * @returns {Promise<object[]>}
   */
    async publishObjects(busName, objects, options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.publishObjects(etherBusName(sessionName, busName), objects, options);
        }

        if (!this.client || !this.target) {
            throw new Error('Sen is not connected');
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        const bus = etherBusName(sessionName, busName);
        return await this.publications.publishObjects(bus, objects, options);
    }

    /**
   * Publish one object and return a persistent handle for updates and removal.
   *
   * @param {string} busName Session-qualified bus name on a root multi-session client, or local bus name on a session client.
   * @param {import('../index.js').SenPublishedObjectDescriptor} object
   * @param {import('../index.js').SenPublishOptions} [options]
   * @returns {Promise<SenPublishedObject>}
   */
    async publish(busName, object, options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.publish(etherBusName(sessionName, busName), object, options);
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        const bus = etherBusName(sessionName, busName);
        return await this.publications.publish(bus, object, options);
    }

    /**
   * Publish one local JavaScript object and return its local publication.
   * `className` is resolved from the configured STL registry when no `spec`
   * is supplied on the object.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {object} object
   * @param {object} [options]
   * @returns {Promise<object>}
   */
    async publishObject(busName, object, options = {}) {
        const [published] = await this.publishObjects(busName, object, options);
        return published;
    }

    /**
   * Update a previously published local JavaScript object.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {string | number | object} object Object id, name or published object.
   * @param {object} patch Property values to update.
   * @param {object} [options]
   * @returns {Promise<object>}
   */
    async updatePublishedObject(busName, object, patch, options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.updatePublishedObject(etherBusName(sessionName, busName), object, patch, options);
        }

        if (!this.client || !this.target) {
            throw new Error('Sen is not connected');
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        const bus = etherBusName(sessionName, busName);
        return await this.publications.update(bus, object, patch, options);
    }

    /**
   * Emit an event from a previously published JavaScript object.
   * Prefer {@link SenPublishedObject#emit} when a publication handle is available.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {string|number|SenPublishedObject} object Published object selector.
   * @param {string} eventName Event declared by the object's ClassTypeSpec.
   * @param {unknown[]} [args]
   * @param {{ creationTime?: bigint|number, session?: string }} [options]
   */
    async emitPublishedEvent(busName, object, eventName, args = [], options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.emitPublishedEvent(etherBusName(sessionName, busName), object, eventName, args, options);
        }

        if (!this.target) {
            throw new Error('Sen is not connected');
        }
        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        const bus = etherBusName(sessionName, busName);
        return await this.publications.emit(bus, object, eventName, args, options);
    }

    /**
   * Remove previously published local JavaScript objects from a SEN bus.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {Array<string|number>|string|number} objects Object ids or names.
   * @param {object} [options]
   */
    async removePublishedObjects(busName, objects, options = {}) {
        if (!this.client) {
            const sessionName = this.#sessionNameForBus(busName, options);
            const session = await this.session(sessionName);
            return await session.removePublishedObjects(etherBusName(sessionName, busName), objects, options);
        }

        if (!this.client || !this.target) {
            throw new Error('Sen is not connected');
        }

        const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
        const bus = etherBusName(sessionName, busName);
        return await this.publications.remove(bus, objects);
    }

    async session(name) {
        const sessionName = String(name || '').trim();
        if (!sessionName) {
            throw new Error('SEN session name is required');
        }

        if (this.client) {
            const current = this.target?.session?.name ?? this.client.processInfo.sessionName;
            if (current !== sessionName) {
                throw new Error(`Sen is connected to session "${current}", not "${sessionName}"`);
            }
            return this;
        }

        const existing = this.sessions.get(sessionName);
        if (existing) {
            const pending = this.sessionConnectPromises.get(sessionName);
            if (pending) {
                await pending;
            }
            return existing;
        }

        const pending = this.sessionConnectPromises.get(sessionName);
        if (pending) {
            return await pending;
        }

        // Each session progresses independently; discovery and connection are both
        // covered by the same promise, including sessions not yet announced.
        const connecting = Promise.resolve().then(async () => {
            const baseConfig = this.connectOptions ?? this.options;
            let target = this.liveDiscovery
                ? await this.liveDiscovery.waitFor(sessionName, baseConfig.sessionDiscoveryTimeoutMs ?? 0)
                : this.targetsBySession.get(sessionName);
            if (!target && !this.localProducer) {
                target = await this.#discoverTarget({ ...baseConfig, session: sessionName });
                if (!target && !baseConfig.announceDiscovery) {
                    throw new Error(`no SEN ether process found for session "${sessionName}"`);
                }
                if (target) {
                    this.targetsBySession.set(sessionName, target);
                }
            }

            if (this.manualClose) throw new Error('SEN client closed');

            const session = new Sen({
                ...baseConfig,
                session: sessionName
            });
            this.#wireSession(session);
            this.sessions.set(sessionName, session);

            try {
                await session.connect({
                    ...baseConfig,
                    session: sessionName,
                    target,
                    localSession: !target,
                    rediscoverTargetOnReconnect: true
                });
            } catch (error) {
                this.sessions.delete(sessionName);
                throw error;
            }
            return session;
        });
        this.sessionConnectPromises.set(sessionName, connecting);
        try {
            return await connecting;
        } finally {
            if (this.sessionConnectPromises.get(sessionName) === connecting) {
                this.sessionConnectPromises.delete(sessionName);
            }
        }
    }

    listSessions() {
        if (this.client) {
            return [this.target?.session?.name ?? this.client.processInfo.sessionName].filter(Boolean);
        }

        return [...new Set([
            ...this.targets.map(targetSessionName),
            ...this.targetsBySession.keys(),
            ...this.sessions.keys()
        ].filter(Boolean))].sort();
    }

    listBuses(options = {}) {
        if (!this.client) {
            return [...this.sessions.values()]
                .flatMap(session => session.listBuses({ qualified: true }))
                .sort();
        }

        const sessionName = this.target?.session?.name ?? this.client.processInfo.sessionName;
        return knownBusNames(this)
            .map(busName => options.qualified ? queryBusName(sessionName, busName) : busName);
    }

    /**
   * Discover visible SEN buses without creating interests or joining buses.
   *
   * @param {object} [options]
   * @param {string} [options.session] Optional session filter.
   * @param {number} [options.busDiscoverySettleMs] Delay after lightweight session connect before reading announced buses.
   * @returns {Promise<Array<{session:string,bus:string,qualified:string}>>}
   */
    async discoverBuses(options = {}) {
        const config = { ...this.options, ...options };
        const settleMs = Math.max(0, Number(config.busDiscoverySettleMs ?? Math.max(config.discoverySettleMs ?? 100, 1000)) || 0);
        // Targets can emit their first discovery beam up to one beam period apart.
        // Keep collecting them for at least that period before probing bus lists.
        const targetDiscoverySettleMs = this.#targetDiscoverySettleMs(config);

        if (this.client) {
            const sessionName = this.target?.session?.name ?? this.client.processInfo.sessionName;
            const summaries = new Map();
            const addBus = busName => {
                const summary = busSummary(sessionName, busName);
                if (summary) {
                    summaries.set(summary.qualified, summary);
                }
            };

            for (const busName of await waitForSessionBuses(this, settleMs)) {
                addBus(busName);
            }

            if (!summaries.size || config.refreshTargets === true) {
                try {
                    const target = await this.#discoverTarget({ ...config, session: sessionName });
                    if (target) {
                        const session = new Sen({
                            ...config,
                            session: sessionName,
                            reconnect: false,
                            // Bus discovery must not advertise a short-lived endpoint that
                            // can later be selected as a producer target.
                            listen: false,
                            announceDiscovery: false
                        });
                        session.on('warning', error => this.emit('warning', error));
                        session.on('error', error => this.emit('warning', error));
                        try {
                            await session.connect({
                                ...config,
                                session: sessionName,
                                target,
                                reconnect: false,
                                listen: false,
                                announceDiscovery: false
                            });
                            for (const busName of await waitForSessionBuses(session, settleMs)) {
                                addBus(busName);
                            }
                        } finally {
                            await session.close().catch(error => this.emit('warning', error));
                        }
                    }
                } catch (error) {
                    this.emit('warning', error);
                }
            }

            return [...summaries.values()].sort((a, b) => a.qualified.localeCompare(b.qualified));
        }

        let discoveredTargets = [];
        if (!this.targets.length || this.sessions.size || config.refreshTargets === true) {
            try {
                discoveredTargets = await this.#discoverTargets({
                    ...config,
                    discoverySettleMs: targetDiscoverySettleMs
                });
            } catch (error) {
                if (!this.targets.length && !this.sessions.size) {
                    throw error;
                }
                this.emit('warning', error);
            }
        }

        if (discoveredTargets.length) {
            this.targets = discoveredTargets;
            this.#rememberTargets(discoveredTargets, { replace: true });
        } else if (!this.targets.length && !this.sessions.size) {
            throw new Error('no SEN ether processes discovered');
        }

        const summaries = new Map();
        const addBus = (sessionName, busName) => {
            const summary = busSummary(sessionName, busName);
            if (summary) {
                summaries.set(summary.qualified, summary);
            }
        };

        for (const session of this.sessions.values()) {
            const sessionName = session.target?.session?.name ?? session.client?.processInfo?.sessionName;
            for (const busName of await waitForSessionBuses(session, settleMs)) {
                addBus(sessionName, busName);
            }
        }

        const targets = filterTargets(this.targets, config);
        const discoveries = targets.map(async target => {
            const sessionName = targetSessionName(target);
            if (!sessionName) {
                return;
            }

            const session = new Sen({
                ...config,
                session: sessionName,
                reconnect: false,
                // This connection exists only to observe bus announcements.
                listen: false,
                announceDiscovery: false
            });
            session.on('warning', error => this.emit('warning', error));
            session.on('error', error => this.emit('warning', error));
            try {
                await session.connect({
                    ...config,
                    session: sessionName,
                    target,
                    reconnect: false,
                    listen: false,
                    announceDiscovery: false
                });
                for (const busName of await waitForSessionBuses(session, settleMs)) {
                    addBus(sessionName, busName);
                }
            } finally {
                await session.close().catch(error => this.emit('warning', error));
            }
        });

        const results = await Promise.allSettled(discoveries);
        const failures = [];
        for (const result of results) {
            if (result.status === 'rejected') {
                failures.push(result.reason);
                this.emit('warning', result.reason);
            }
        }

        if (!summaries.size && targets.length && failures.length === targets.length) {
            const sessions = [...new Set(targets.map(targetSessionName).filter(Boolean))].join(', ');
            const error = new Error(`could not read SEN bus announcements from any discovered target${sessions ? ` in sessions: ${sessions}` : ''}`);
            error.code = 'SEN_BUS_DISCOVERY_FAILED';
            error.cause = failures[0];
            throw error;
        }

        return [...summaries.values()].sort((a, b) => a.qualified.localeCompare(b.qualified));
    }

    objects() {
        if (!this.client) {
            return [...this.sessions.values()].flatMap(session => session.objects());
        }
        return [...this.buses.values()].flatMap(bus => bus.objects());
    }

    getObject(selector) {
        return this.objects().find(object => object.matches(selector));
    }

    async waitForRemoteBus(busName, timeoutMs = this.options.timeout ?? 3000) {
        await this.#waitForRemoteBus(busName, timeoutMs);
    }

    /** @internal Register before joinBus() so an immediate ready event cannot be missed. */
    createBusParticipantReadyWait(busName, timeoutMs) {
        if (this.manualClose) {
            const error = new Error(`SEN client is closed; cannot wait for busParticipantReady on bus "${busName}"`);
            error.code = 'SEN_CLIENT_CLOSED';
            throw error;
        }
        const waiters = this.busParticipantReadyWaiters.get(busName) ?? new Set();
        this.busParticipantReadyWaiters.set(busName, waiters);
        let waiter;
        const promise = new Promise((resolve, reject) => {
            const settle = (callback, value) => {
                if (!waiters.delete(waiter)) return;
                clearTimeout(waiter.timeout);
                if (!waiters.size && this.busParticipantReadyWaiters.get(busName) === waiters) {
                    this.busParticipantReadyWaiters.delete(busName);
                }
                callback(value);
            };
            waiter = {
                timeout: undefined,
                resolve: value => settle(resolve, value),
                reject: error => settle(reject, error)
            };
            waiters.add(waiter);
            waiter.timeout = setTimeout(() => {
                waiter.reject(new Error(`timeout waiting for busParticipantReady on bus "${busName}"`));
            }, timeoutMs);
        });
        return { promise, cancel: () => waiter.resolve(undefined) };
    }

    async waitForObject(selector, options = {}) {
        const existing = this.getObject(selector);
        if (existing) {
            return existing;
        }

        const timeoutMs = options.timeout ?? this.options.timeout ?? 3000;
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.off('object', onObject);
                reject(new Error(`timeout waiting for SEN object ${selectorDescription(selector)}`));
            }, timeoutMs);
            const onObject = object => {
                if (!object.matches(selector)) {
                    return;
                }
                clearTimeout(timeout);
                this.off('object', onObject);
                resolve(object);
            };
            this.on('object', onObject);
        });
    }

    async close() {
        this.manualClose = true;
        this.#rejectRemoteBusWaiters();
        this.#rejectBusParticipantReadyWaiters();
        await this.liveDiscovery?.close();
        await Promise.allSettled([...this.sessionConnectPromises.values()]);
        this.liveDiscovery = undefined;
        for (const session of this.sessions.values()) {
            await session.close().catch(error => this.emit('warning', error));
        }
        for (const bus of this.buses.values()) {
            bus.close();
        }
        this.#stopPresenceWatchdog();
        await wait(50);
        await this.client?.close().catch(error => this.emit('warning', error));
        this.client = undefined;
        this.sessions.clear();
        this.sessionConnectPromises.clear();
        this.buses.clear();
        this.busJoinPromises.clear();
        this.published.clear();
    }

    async #discoverTargets(options) {
        return options.tcpHub
            ? await scanTcpDiscoveryHub({
                ...parseHostPort(options.tcpHub),
                timeout: options.timeout,
                settleMs: options.discoverySettleMs
            })
            : await scan({
                ...options,
                settleMs: options.discoverySettleMs
            });
    }

    #targetDiscoverySettleMs(config) {
        const value = Number(config.targetDiscoverySettleMs ?? this.options.targetDiscoverySettleMs ?? 1000);
        return Number.isFinite(value) ? Math.max(0, value) : 1000;
    }

    async #discoverTarget(options) {
        const processes = await this.#discoverTargets(options);
        const target = findTarget(processes, options);
        if (!target) {
            return null;
        }
        return target;
    }

    #rememberTargets(targets, options = {}) {
        const replace = options.replace !== false;
        for (const target of targets) {
            const sessionName = targetSessionName(target);
            if (sessionName && (replace || !this.targetsBySession.has(sessionName))) {
                this.targetsBySession.set(sessionName, target);
            }
        }
    }

    async #reconnectTarget(options) {
        if (options.localSession) {
            return undefined;
        }
        if (options.rediscoverTargetOnReconnect) {
            return await this.#discoverTarget({ ...options, target: undefined });
        }
        if (options.tcpHub || !options.target) {
            return await this.#discoverTarget(options);
        }
        return options.target;
    }

    #sessionNameForBus(busName, options = {}) {
        const explicit = String(options.session || '').trim();
        if (explicit) {
            return explicit;
        }

        const fromBus = sessionNameFromBusName(busName);
        if (fromBus) {
            return fromBus;
        }

        if (this.sessions.size === 1) {
            return this.sessions.keys().next().value;
        }

        if (this.targetsBySession.size === 1) {
            return this.targetsBySession.keys().next().value;
        }

        throw new Error(`cannot infer SEN session from bus "${busName}"; use a session-qualified query such as SELECT * FROM session.${busName}`);
    }

    #assertBusBelongsToSession(busName, sessionName) {
        const requestedSession = sessionNameFromBusName(busName);
        if (requestedSession && requestedSession !== sessionName) {
            throw new Error(`query targets SEN session "${requestedSession}" but this client is connected to session "${sessionName}"`);
        }
    }

    #participantReadyTimeout(options, timeoutMs) {
        const configured = options.participantReadyTimeoutMs ?? this.options.participantReadyTimeoutMs ?? 1000;
        return Math.min(timeoutMs, configured);
    }

    async #getOrJoinBus(bus, options, timeoutMs) {
        const existing = this.buses.get(bus);
        if (existing) {
            return existing;
        }

        let pending = this.busJoinPromises.get(bus);
        if (!pending) {
            pending = (async () => {
                const participantReadyTimeoutMs = this.#participantReadyTimeout(options, timeoutMs);
                const ready = this.createBusParticipantReadyWait(bus, participantReadyTimeoutMs);
                let joined;
                try {
                    joined = await this.client.joinBus(bus);
                } catch (error) {
                    ready.cancel();
                    await ready.promise;
                    throw error;
                }
                await ready.promise.catch(error => {
                    if (error.code === 'SEN_CLIENT_CLOSED') throw error;
                    this.emit('warning', error);
                });

                const senBus = new SenBus(this, bus, joined.busId);
                this.buses.set(bus, senBus);
                return senBus;
            })().finally(() => {
                this.busJoinPromises.delete(bus);
            });
            this.busJoinPromises.set(bus, pending);
        }
        return await pending;
    }

    #wireSession(session) {
        const forward = type => value => this.emit(type, value);
        for (const type of [
            'connect',
            'close',
            'reconnecting',
            'reconnect',
            'reconnectError',
            'warning',
            'object',
            'remove',
            'change',
            'changes',
            'event'
        ]) {
            session.on(type, forward(type));
        }
    }

    #wireClient(client) {
        client.on('remoteProcess', value => this.emit('remoteProcess', value));
        client.on('ready', value => this.emit('ready', value));
        client.on('busParticipantReady', value => {
            this.#resolveBusParticipantReadyWaiters(value.busName, value);
        });
        client.on('busJoined', value => {
            this.remoteBuses.add(value.busName);
            this.#resolveRemoteBusWaiters(value.busName);
            this.emit('busAvailable', value);
        });
        client.on('busLeft', value => {
            this.#busForEvent(value)?.handleParticipantLeft(value);
            if (!this.#hasRemoteBus(value)) {
                this.remoteBuses.delete(value.busName);
                this.emit('busUnavailable', value);
            }
        });
        client.on('objectsPublished', event => this.#busForEvent(event)?.handleObjectsPublished(event));
        client.on('objectsRemoved', event => this.#busForEvent(event)?.handleObjectsRemoved(event));
        client.on('typesInfoResponse', event => this.#busForEvent(event)?.handleTypesInfoResponse(event));
        client.on('typesInfoRejection', event => this.#busForEvent(event)?.emit('typesInfoRejection', event));
        client.on('objectsStateResponse', event => this.#busForEvent(event)?.handleObjectsStateResponse(event));
        client.on('runtimeObjectUpdate', event => this.#busForEvent(event)?.handleRuntimeObjectUpdate(event));
        client.on('runtimeEvents', event => this.#busForEvent(event)?.handleRuntimeEvents(event));
        client.on('runtimeMethodResponse', event => this.#busForEvent(event)?.handleRuntimeMethodResponse(event));
        client.on('error', error => {
            if (['EPIPE', 'ECONNRESET', 'SEN_TCP_NOT_WRITABLE'].includes(error?.code)) {
                this.emit('warning', error);
                return;
            }
            if (this.manualClose || this.reconnecting || this.options.reconnect !== false) {
                this.emit('warning', error);
                return;
            }
            this.emit('error', error);
        });
        client.on('close', (hadError, connection) => {
            // A locally hosted session remains healthy when its last inbound peer
            // leaves, including an abrupt peer reset. A close without connection
            // context represents a client-level failure and still rebuilds it.
            if (this.target?.local && connection) {
                return;
            }
            for (const bus of this.buses.values()) {
                const error = new Error('SEN connection closed before method response');
                error.code = 'SEN_CONNECTION_CLOSED';
                bus.rejectPendingCalls(error);
            }
            this.#stopPresenceWatchdog();
            this.emit('close', hadError);
            if (!this.manualClose && this.options.reconnect !== false) {
                this.reconnectPromise ??= this.#reconnect()
                    .catch(error => this.emit('warning', error))
                    .finally(() => {
                        this.reconnectPromise = undefined;
                    });
            }
        });
    }

    async #reconnect() {
        if (this.manualClose || this.reconnecting || !this.connectOptions) {
            return;
        }

        this.reconnecting = true;
        this.#stopPresenceWatchdog();
        await this.client?.close().catch(error => this.emit('warning', error));
        this.emit('reconnecting');
        const configuredMaxAttempts = this.connectOptions.maxReconnectAttempts ?? this.options.maxReconnectAttempts ?? 0;
        const maxAttempts = Number(configuredMaxAttempts);
        const unlimited = !Number.isFinite(maxAttempts) || maxAttempts <= 0;
        const delayMs = this.connectOptions.reconnectDelayMs ?? this.options.reconnectDelayMs ?? 500;

        for (let attempt = 1; unlimited || attempt <= maxAttempts; attempt += 1) {
            let client;
            try {
                await wait(delayMs);
                if (this.manualClose) {
                    this.reconnecting = false;
                    return;
                }

                this.remoteBuses.clear();
                for (const bus of this.buses.values()) {
                    bus.prepareReconnect();
                }

                const config = this.connectOptions;
                const target = await this.#reconnectTarget(config);
                if (!target && !config.localSession) {
                    throw new Error('no SEN ether process matches the requested filters');
                }

                const sessionName = target?.session?.name ?? target?.info?.sessionName ?? config.session;
                client = new EtherClient({
                    sessionName,
                    appName: config.appName,
                    tcpHub: config.tcpHub,
                    multicastDiscovery: config.multicastDiscovery,
                    listen: config.listen,
                    listenHost: config.listenHost,
                    listenPort: config.listenPort,
                    advertisedHost: config.advertisedHost,
                    beamPeriodMs: config.beamPeriodMs,
                    announceDiscovery: config.announceDiscovery,
                    socketKeepAlive: config.socketKeepAlive,
                    socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
                    socketIdleTimeoutMs: config.socketIdleTimeoutMs,
                    presenceTimeoutMs: config.presenceTimeoutMs,
                    presenceCheckIntervalMs: config.presenceCheckIntervalMs,
                    interfaceAddress: config.interfaceAddress,
                    group: config.group,
                    bindAddress: config.bindAddress,
                    discoveryPort: config.port,
                    busMulticast: config.busMulticast,
                    busMulticastPort: config.busMulticastPort,
                    busMulticastRange: config.busMulticastRange,
                    resourceLimits: config.resourceLimits
                });
                this.client = client;
                this.target = target ?? { session: { name: sessionName }, process: client.processInfo, info: client.processInfo, local: true };
                this.#wireClient(client);

                if (config.tcpHub || config.listen !== false) {
                    await client.start(config);
                }
                if (target) {
                    await client.connect(target);
                    await waitForEvent(client, 'ready', config.timeout ?? 3000);
                    this.#startPresenceWatchdog(target, config);
                }

                for (const bus of this.buses.values()) {
                    await bus.rejoin(config.timeout ?? 3000);
                }
                await this.publications.restoreAll();

                this.reconnecting = false;
                this.emit('reconnect', { attempt, target, sessionName });
                return;
            } catch (error) {
                await client?.close().catch(closeError => this.emit('warning', closeError));
                if (this.client === client) {
                    this.client = undefined;
                    this.target = undefined;
                }
                if (this.manualClose) {
                    this.reconnecting = false;
                    return;
                }
                this.emit('reconnectError', { attempt, error });
            }
        }

        if (this.manualClose) {
            this.reconnecting = false;
            return;
        }

        this.reconnecting = false;
        throw new Error(`failed to reconnect SEN ether after ${maxAttempts} attempt(s)`);
    }

    #startPresenceWatchdog(target, config) {
        this.#stopPresenceWatchdog();
        const key = target?.key;
        if (!key) {
            return;
        }

        const timeoutMs = Number(config.presenceTimeoutMs ?? this.options.presenceTimeoutMs ?? 0);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return;
        }

        const intervalMs = Math.max(
            250,
            Number(config.presenceCheckIntervalMs ?? this.options.presenceCheckIntervalMs ?? 1000) || 1000
        );

        const scanner = config.tcpHub
            ? new TcpDiscoveryHubScanner(parseHostPort(config.tcpHub))
            : new EtherDiscoveryScanner(config);

        this.presenceScanner = scanner;
        this.presenceLastSeen = Date.now();

        scanner.on('beam', process => {
            if (process.key === key) {
                this.presenceLastSeen = Date.now();
            }
        });
        scanner.on('error', error => this.emit('warning', error));
        scanner.on('close', hadError => {
            if (!this.manualClose && !this.reconnecting) {
                this.emit('warning', new Error(`SEN ether discovery watchdog closed${hadError ? ' with error' : ''}`));
            }
        });
        scanner.start().catch(error => this.emit('warning', error));

        this.presenceTimer = setInterval(() => {
            if (this.manualClose || this.reconnecting || !this.client) {
                return;
            }
            const elapsedMs = Date.now() - this.presenceLastSeen;
            if (elapsedMs <= timeoutMs) {
                return;
            }
            const error = new Error(`SEN ether presence timeout after ${elapsedMs}ms without beam from ${key}`);
            error.code = 'SEN_PRESENCE_TIMEOUT';
            this.emit('warning', error);
            this.client.socket?.destroy();
        }, intervalMs);
        this.presenceTimer.unref?.();
    }

    #stopPresenceWatchdog() {
        if (this.presenceTimer) {
            clearInterval(this.presenceTimer);
            this.presenceTimer = undefined;
        }

        const scanner = this.presenceScanner;
        this.presenceScanner = undefined;
        this.presenceLastSeen = 0;
        if (scanner) {
            scanner.removeAllListeners();
            scanner.stop().catch(error => this.emit('warning', error));
        }
    }

    #busForEvent(event) {
        if (event.bus?.busName) {
            return this.buses.get(event.bus.busName);
        }
        if (event.busId !== undefined) {
            return [...this.buses.values()].find(bus => bus.id === event.busId);
        }
        return undefined;
    }

    #hasRemoteBus(event) {
        const busName = event?.busName;
        if (!busName || !this.client?.remoteParticipantsByBusId) {
            return false;
        }
        if (event.busId !== undefined) {
            return [...(this.client.remoteParticipantsByBusId.get(event.busId >>> 0)?.values() ?? [])]
                .some(participant => participant.busName === busName);
        }
        for (const participants of this.client.remoteParticipantsByBusId.values()) {
            for (const participant of participants.values()) {
                if (participant.busName === busName) {
                    return true;
                }
            }
        }
        return false;
    }

    #resolveRemoteBusWaiters(busName) {
        const waiters = this.remoteBusWaiters.get(busName);
        if (!waiters) return;
        this.remoteBusWaiters.delete(busName);
        for (const waiter of waiters) {
            clearTimeout(waiter.timeout);
            waiter.resolve();
        }
    }

    #rejectRemoteBusWaiters() {
        const waiting = this.remoteBusWaiters;
        this.remoteBusWaiters = new Map();
        for (const [busName, waiters] of waiting) {
            for (const waiter of waiters) {
                clearTimeout(waiter.timeout);
                const error = new Error(`SEN client closed while waiting for remote bus "${busName}"`);
                error.code = 'SEN_CLIENT_CLOSED';
                waiter.reject(error);
            }
        }
    }

    #resolveBusParticipantReadyWaiters(busName, value) {
        const waiters = this.busParticipantReadyWaiters.get(busName);
        if (!waiters) return;
        this.busParticipantReadyWaiters.delete(busName);
        for (const waiter of waiters) waiter.resolve(value);
    }

    #rejectBusParticipantReadyWaiters() {
        const waiting = this.busParticipantReadyWaiters;
        this.busParticipantReadyWaiters = new Map();
        for (const [busName, waiters] of waiting) {
            for (const waiter of waiters) {
                const error = new Error(`SEN client closed while waiting for busParticipantReady on bus "${busName}"`);
                error.code = 'SEN_CLIENT_CLOSED';
                waiter.reject(error);
            }
        }
    }

    async #waitForRemoteBus(busName, timeoutMs) {
        if (this.remoteBuses.has(busName)) {
            return;
        }

        if (this.manualClose) {
            const error = new Error(`SEN client is closed; cannot wait for remote bus "${busName}"`);
            error.code = 'SEN_CLIENT_CLOSED';
            throw error;
        }

        await new Promise((resolve, reject) => {
            const waiters = this.remoteBusWaiters.get(busName) ?? new Set();
            this.remoteBusWaiters.set(busName, waiters);
            const waiter = { resolve, reject, timeout: undefined };
            waiter.timeout = setTimeout(() => {
                waiters.delete(waiter);
                if (!waiters.size) this.remoteBusWaiters.delete(busName);
                const announced = [...this.remoteBuses].sort().join(', ') || '<none>';
                reject(new Error(`remote process did not announce bus "${busName}" within ${timeoutMs}ms; announced: ${announced}`));
            }, timeoutMs);
            waiters.add(waiter);
        });
    }
}


export { SenBus } from './sen-bus.js';

export { SenInterest };

export { SenRemoteObject };

export { SenPublishedObject } from './sen-publications.js';
