import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { decodePropertyValues, decodeValue, encodeArguments, decodeArguments } from './values.js';
import { EtherClient } from './client.js';
import { EtherDiscoveryScanner, TcpDiscoveryHubScanner, scan, scanTcpDiscoveryHub } from './discovery.js';
import { methodHash } from './hash32.js';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const STATE_RESYNC_DELAYS_MS = [250, 1000, 3000, 8000];
const STATE_RESYNC_INTERVAL_MS = 1000;

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

function classSpecData(spec) {
  return spec?.data?.type === 'ClassTypeSpec' ? spec.data.value : undefined;
}

function findTypeSpec(typeRegistry, typeName) {
  return typeRegistry?.get?.(typeName) ?? typeRegistry?.[typeName];
}

function collectClassMembers(spec, typeRegistry, member, seen = new Set()) {
  const data = classSpecData(spec);
  const key = spec?.qualifiedName ?? spec?.name;
  if (!data || seen.has(key)) {
    return [];
  }
  seen.add(key);

  return [
    ...(data.parents ?? []).flatMap(parent => collectClassMembers(findTypeSpec(typeRegistry, parent), typeRegistry, member, seen)),
    ...(data[member] ?? [])
  ];
}

function findByName(items, name) {
  return items.find(item => item.name === name);
}

function setterName(propertyName) {
  return `setNext${propertyName.slice(0, 1).toUpperCase()}${propertyName.slice(1)}`;
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

function selectorDescription(selector) {
  return typeof selector === 'function' ? '<predicate>' : String(selector);
}

function normalizePropertyNames(properties) {
  if (!properties) {
    return undefined;
  }
  const values = Array.isArray(properties)
    ? properties
    : String(properties).split(',');
  const names = values.map(value => String(value).trim()).filter(Boolean);
  return names.length ? new Set(names) : undefined;
}

function normalizeTimestampNs(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'bigint' ? value : BigInt(value);
}

function stateRequestKey(interestId, ownerId, objectId) {
  return `${interestId >>> 0}:${remoteObjectKey(ownerId, objectId)}`;
}

function remoteObjectKey(ownerId, objectId) {
  const owner = ownerId === undefined || ownerId === null ? 'unknown' : String(ownerId >>> 0);
  return `${owner}:${objectId >>> 0}`;
}

function eventOwnerId(event) {
  if (event?.ownerId !== undefined) {
    return event.ownerId;
  }
  return event?.multicast ? undefined : event?.to;
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

class ChangeBatcher {
  constructor(interest, options = {}) {
    this.interest = interest;
    this.intervalMs = options.batchIntervalMs ?? options.batch?.intervalMs ?? 16;
    this.maxSize = options.batchMaxSize ?? options.batch?.maxSize ?? 1000;
    this.maxQueued = options.maxQueuedChanges ?? options.batch?.maxQueued ?? 10000;
    this.backpressure = options.backpressure ?? options.batch?.backpressure ?? 'drop-oldest';
    this.coalesce = Boolean(options.coalesce ?? options.batch?.coalesce ?? false);
    this.queue = [];
    this.coalesced = new Map();
    this.timer = undefined;
    this.dropped = 0;
  }

  push(change) {
    if (this.coalesce) {
      const key = `${change.object.id}:${change.name}`;
      if (!this.coalesced.has(key)) {
        this.queue.push(key);
      }
      this.coalesced.set(key, change);
    } else {
      this.queue.push(change);
    }

    while (this.queue.length > this.maxQueued) {
      if (this.backpressure === 'error') {
        const error = new Error(`SEN change queue exceeded ${this.maxQueued} item(s)`);
        error.code = 'SEN_CHANGE_BACKPRESSURE';
        this.interest.emit('backpressure', error);
        this.interest.bus.emit('warning', error);
        this.interest.bus.sen.emit('warning', error);
        const newest = this.queue.pop();
        if (this.coalesce) {
          this.coalesced.delete(newest);
        }
        this.dropped += 1;
        continue;
      }
      if (this.backpressure === 'drop-newest') {
        const newest = this.queue.pop();
        if (this.coalesce) {
          this.coalesced.delete(newest);
        }
      } else {
        const oldest = this.queue.shift();
        if (this.coalesce) {
          this.coalesced.delete(oldest);
        }
      }
      this.dropped += 1;
    }

    if (this.queue.length >= this.maxSize) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.queue.length) {
      return;
    }

    const items = this.coalesce
      ? this.queue.map(key => this.coalesced.get(key)).filter(Boolean)
      : this.queue;
    this.queue = [];
    this.coalesced.clear();

    const batch = {
      interest: this.interest,
      bus: this.interest.bus,
      changes: items,
      dropped: this.dropped
    };
    this.dropped = 0;

    this.interest.emit('changes', batch);
    this.interest.bus.emit('changes', batch);
    this.interest.bus.sen.emit('changes', batch);
  }

  close() {
    this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.coalesced.clear();
  }
}

/**
 * High-level pure JavaScript SEN ether client.
 *
 * It connects to an existing SEN kernel/process over ether and exposes remote
 * objects discovered through native SEN interests. It does not load `.so`
 * packages; type information comes from `TypesInfoResponse`.
 */
export class Sen extends EventEmitter {
  /**
   * Create, connect and return a SEN ether client.
   *
   * @param {object} [options]
   * @returns {Promise<Sen>}
   */
  static async connect(options = {}) {
    const sen = new Sen(options);
    return await sen.connect(options);
  }

  /**
   * Discover visible SEN buses without creating interests or joining buses.
   *
   * SEN discovery beams expose sessions/processes. Bus names are announced only
   * after a lightweight process connection, so this method connects to each
   * discovered session long enough to read its remote bus announcements.
   *
   * @param {object} [options]
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

  constructor(options = {}) {
    super();
    this.options = {
      appName: 'sen-ether-client',
      reconnect: true,
      reconnectDelayMs: 500,
      maxReconnectAttempts: 0,
      timeout: 3000,
      discoverySettleMs: 100,
      participantReadyTimeoutMs: 1000,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: 1000,
      socketIdleTimeoutMs: 0,
      presenceTimeoutMs: 5000,
      presenceCheckIntervalMs: 1000,
      ...options
    };
    this.target = undefined;
    this.client = undefined;
    this.connectOptions = undefined;
    this.manualClose = false;
    this.reconnecting = false;
    this.presenceScanner = undefined;
    this.presenceTimer = undefined;
    this.presenceLastSeen = 0;
    this.remoteBuses = new Set();
    this.buses = new Map();
    this.sessions = new Map();
    this.targets = [];
    this.targetsBySession = new Map();
  }

  /**
   * Discover and connect to one existing SEN ether process.
   *
   * @param {object} [options]
   * @param {string} [options.tcpHub] Discovery hub as `host:port`.
   * @param {string} [options.session] Session filter.
   * @param {string} [options.app] Remote appName substring filter.
   * @param {number} [options.timeout] Discovery and ready timeout in ms.
   * @param {number} [options.discoverySettleMs] TCP discovery settle time after the first process is found.
   * @param {{host:string, port:number}|object} [options.target] Direct target.
   */
  async connect(options = {}) {
    const config = { ...this.options, ...options };
    this.connectOptions = config;
    this.manualClose = false;

    if (!config.session && !config.target) {
      const targets = await this.#discoverTargets(config);
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
    const target = config.target ?? await this.#discoverTarget(config);
    const activeNode = Boolean(config.session && (config.tcpHub || config.multicastDiscovery !== false));
    if (!target && !activeNode) {
      throw new Error('no SEN ether process matches the requested filters');
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
      socketKeepAlive: config.socketKeepAlive,
      socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
      socketIdleTimeoutMs: config.socketIdleTimeoutMs,
      interfaceAddress: config.interfaceAddress,
      group: config.group,
      bindAddress: config.bindAddress,
      discoveryPort: config.port,
      busMulticast: config.busMulticast,
      busMulticastPort: config.busMulticastPort,
      busMulticastRange: config.busMulticastRange
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
   * @param {object} [options]
   * @param {string} [options.query]
   * @param {boolean} [options.forceBus]
   * @param {number} [options.timeout]
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

    let senBus = this.buses.get(bus);
    if (!senBus) {
      const joined = await this.client.joinBus(bus);
      const participantReadyTimeoutMs = this.#participantReadyTimeout(options, timeout);
      await waitForEvent(this.client, 'busParticipantReady', participantReadyTimeoutMs).catch(error => {
        this.emit('warning', error);
      });
      senBus = new SenBus(this, bus, joined.busId);
      this.buses.set(bus, senBus);
    }

    senBus.startInterest(query, options);
    return senBus;
  }

  /**
   * Start a native SEN interest and return a live object collection.
   *
   * @param {string} query Native SEN interest query, for example `SELECT * FROM hmi.hud`.
   * @param {object} [options]
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

    let senBus = this.buses.get(bus);
    if (!senBus) {
      const joined = await this.client.joinBus(bus);
      const participantReadyTimeoutMs = this.#participantReadyTimeout(options, timeout);
      await waitForEvent(this.client, 'busParticipantReady', participantReadyTimeoutMs).catch(error => {
        this.emit('warning', error);
      });
      senBus = new SenBus(this, bus, joined.busId);
      this.buses.set(bus, senBus);
    }

    return senBus.startInterest(query, options);
  }

  async bus(name, options = {}) {
    return await this.subscribe(name, options);
  }

  /**
   * Publish local JavaScript objects on a SEN bus.
   *
   * @param {string} busName Session-qualified or ether-local bus name.
   * @param {object|object[]} objects
   * @param {object} [options]
   */
  async publishObjects(busName, objects, options = {}) {
    if (!this.client) {
      const sessionName = this.#sessionNameForBus(busName, options);
      const session = await this.session(sessionName);
      return await session.publishObjects(busName, objects, options);
    }

    if (!this.client || !this.target) {
      throw new Error('Sen is not connected');
    }

    const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
    this.#assertBusBelongsToSession(busName, sessionName);
    const bus = etherBusName(sessionName, busName);

    if (!this.buses.has(bus)) {
      const joined = await this.client.joinBus(bus, options);
      this.buses.set(bus, new SenBus(this, bus, joined.busId));
    }

    return this.client.publishObjects(bus, objects, options);
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
      return await session.removePublishedObjects(busName, objects, options);
    }

    if (!this.client || !this.target) {
      throw new Error('Sen is not connected');
    }

    const sessionName = this.target.session?.name ?? this.client.processInfo.sessionName;
    this.#assertBusBelongsToSession(busName, sessionName);
    const bus = etherBusName(sessionName, busName);
    return this.client.removePublishedObjects(bus, objects);
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
      return existing;
    }

    const baseConfig = this.connectOptions ?? this.options;
    let target = this.targetsBySession.get(sessionName);
    if (!target) {
      target = await this.#discoverTarget({ ...baseConfig, session: sessionName });
      if (!target) {
        throw new Error(`no SEN ether process found for session "${sessionName}"`);
      }
      this.targetsBySession.set(sessionName, target);
    }

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
        target
      });
    } catch (error) {
      this.sessions.delete(sessionName);
      throw error;
    }

    return session;
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
              reconnect: false
            });
            session.on('warning', error => this.emit('warning', error));
            session.on('error', error => this.emit('warning', error));
            try {
              await session.connect({
                ...config,
                session: sessionName,
                target,
                reconnect: false
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
        discoveredTargets = await this.#discoverTargets(config);
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
        reconnect: false
      });
      session.on('warning', error => this.emit('warning', error));
      session.on('error', error => this.emit('warning', error));
      try {
        await session.connect({
          ...config,
          session: sessionName,
          target,
          reconnect: false
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
    this.buses.clear();
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

    throw new Error(`cannot infer SEN session from bus "${busName}"; use a session-qualified query such as SELECT * FROM hmi.${busName}`);
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
    client.on('busJoined', value => {
      this.remoteBuses.add(value.busName);
      this.emit('busAvailable', value);
    });
    client.on('busLeft', value => {
      this.remoteBuses.delete(value.busName);
      this.emit('busUnavailable', value);
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
      if (this.manualClose || this.reconnecting || this.options.reconnect !== false) {
        this.emit('warning', error);
        return;
      }
      this.emit('error', error);
    });
    client.on('close', hadError => {
      this.#stopPresenceWatchdog();
      this.emit('close', hadError);
      if (!this.manualClose && this.options.reconnect !== false) {
        this.#reconnect().catch(error => this.emit('warning', error));
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
        if (!target) {
          throw new Error('no SEN ether process matches the requested filters');
        }

        const sessionName = target.session?.name ?? target.info?.sessionName ?? config.session;
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
          socketKeepAlive: config.socketKeepAlive,
          socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
          socketIdleTimeoutMs: config.socketIdleTimeoutMs,
          interfaceAddress: config.interfaceAddress,
          group: config.group,
          bindAddress: config.bindAddress,
          discoveryPort: config.port,
          busMulticast: config.busMulticast,
          busMulticastPort: config.busMulticastPort,
          busMulticastRange: config.busMulticastRange
        });
        this.client = client;
        this.target = target;
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
      this.client.socket?.destroy(error);
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

  async #waitForRemoteBus(busName, timeoutMs) {
    if (this.remoteBuses.has(busName)) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('busAvailable', onBusAvailable);
        const announced = [...this.remoteBuses].sort().join(', ') || '<none>';
        reject(new Error(`remote process did not announce bus "${busName}" within ${timeoutMs}ms; announced: ${announced}`));
      }, timeoutMs);
      const onBusAvailable = value => {
        if (value.busName !== busName) {
          return;
        }
        clearTimeout(timeout);
        this.off('busAvailable', onBusAvailable);
        resolve();
      };
      this.on('busAvailable', onBusAvailable);
    });
  }
}

export class SenBus extends EventEmitter {
  constructor(sen, name, id) {
    super();
    this.sen = sen;
    this.name = name;
    this.id = id;
    this.objectsById = new Map();
    this.typeRegistry = new Map();
    this.requestedTypeHashes = new Set();
    this.stateRequestedObjectIds = new Set();
    this.stateResyncTimers = new Set();
    this.stateResyncInterval = undefined;
    this.interests = new Map();
    this.pendingCalls = new Map();
    this.nextTicketId = 1;
  }

  startInterest(query, options = {}) {
    const started = this.sen.client.startInterest(this.name, query);
    const interest = new SenInterest(this, started.id, query, options);
    this.interests.set(interest.id, interest);
    return interest;
  }

  stopInterest(id) {
    const interestId = typeof id === 'object' ? id.id : id;
    this.sen.client?.stopInterest(this.name, interestId);
    const interest = this.interests.get(interestId);
    this.#detachInterestObjects(interestId, interest);
    this.interests.delete(interestId);
    if (!this.interests.size) {
      this.#clearStateResyncTimers();
    }
    interest?.closeLocal();
    interest?.emit('close');
  }

  close() {
    for (const interest of [...this.interests.values()]) {
      try {
        this.stopInterest(interest.id);
      } catch (error) {
        this.#detachInterestObjects(interest.id, interest);
        this.interests.delete(interest.id);
        interest.closeLocal();
        interest.emit('close');
        this.sen.emit('warning', error);
      }
    }
    try {
      this.sen.client?.leaveBus(this.name);
    } catch (error) {
      this.sen.emit('warning', error);
    }
  }

  prepareReconnect() {
    for (const call of this.pendingCalls.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error('SEN connection closed before method response'));
    }
    this.pendingCalls.clear();
    for (const object of this.objectsById.values()) {
      object.stale = true;
      object.emit('stale');
    }
    this.objectsById.clear();
    this.typeRegistry.clear();
    this.requestedTypeHashes.clear();
    this.stateRequestedObjectIds.clear();
    this.#clearStateResyncTimers();
    for (const interest of this.interests.values()) {
      interest.closeLocal();
      interest.objectsById.clear();
      interest.emit('stale');
    }
  }

  async rejoin(timeoutMs) {
    const busReadyTimeoutMs = Math.min(timeoutMs, this.sen.options.participantReadyTimeoutMs ?? 1000);
    await this.sen.waitForRemoteBus(this.name, busReadyTimeoutMs).catch(error => {
      this.sen.emit('warning', error);
    });
    const joined = await this.sen.client.joinBus(this.name);
    this.id = joined.busId;
    const participantReadyTimeoutMs = Math.min(timeoutMs, this.sen.options.participantReadyTimeoutMs ?? 1000);
    await waitForEvent(this.sen.client, 'busParticipantReady', participantReadyTimeoutMs).catch(error => {
      this.sen.emit('warning', error);
    });

    const interests = [...this.interests.values()];
    this.interests.clear();
    for (const interest of interests) {
      const started = this.sen.client.startInterest(this.name, interest.query);
      interest.id = started.id;
      interest.resetLocal();
      this.interests.set(interest.id, interest);
      interest.emit('restart', interest);
    }
  }

  objects() {
    return [...this.objectsById.values()];
  }

  getObject(selector) {
    return this.objects().find(object => object.matches(selector));
  }

  handleObjectsPublished(event) {
    const ownerId = eventOwnerId(event);
    const newTypeHashes = new Set();
    for (const discovery of event.discoveries ?? []) {
      const interest = this.interests.get(discovery.interestId);
      if (!interest) {
        continue;
      }
      if (ownerId !== undefined) {
        interest.ownerId ??= ownerId;
        interest.ownerIds.add(ownerId >>> 0);
      }

      for (const info of discovery.objects ?? []) {
        let object = this.#objectByOwnerAndId(ownerId, info.id);
        const isNewObject = !object;
        if (!object) {
          object = new SenRemoteObject(this, {
            ...info,
            ownerId,
            interestId: discovery.interestId
          });
          this.objectsById.set(object.key, object);
        } else {
          object.attachInterest(discovery.interestId);
          object.updateDiscoveryInfo({
            ...info,
            ownerId
          });
        }
        interest?.objectsById.set(object.key, object);
        if (info.state?.length) {
          object.applyState(info.state, 'published', info.time, { interestId: discovery.interestId });
        }
        if (!this.requestedTypeHashes.has(info.typeHash)) {
          this.requestedTypeHashes.add(info.typeHash);
          newTypeHashes.add(info.typeHash);
        }
        this.#emitObjectWhenReady(interest, object, isNewObject);
      }
    }
    if (newTypeHashes.size) {
      this.sen.client.requestTypes(this.name, newTypeHashes);
    }
    this.#requestReadyObjectStates();
    this.#scheduleStateResyncs();
  }

  handleObjectsRemoved(event) {
    const ownerId = eventOwnerId(event);
    for (const removal of event.removals ?? []) {
      const interest = this.interests.get(removal.interestId);
      if (!interest) {
        continue;
      }
      for (const id of removal.ids ?? []) {
        const object = this.#objectByOwnerAndId(ownerId, id);
        if (object) {
          this.#removeObjectFromInterest(object, removal.interestId, interest);
        }
      }
    }
  }

  #detachInterestObjects(interestId, interest) {
    const normalizedInterestId = interestId >>> 0;
    const keyPrefix = `${normalizedInterestId}:`;
    for (const key of [...this.stateRequestedObjectIds]) {
      if (key.startsWith(keyPrefix)) {
        this.stateRequestedObjectIds.delete(key);
      }
    }

    if (!interest) {
      return;
    }

    for (const object of interest.objectsById.values()) {
      this.#removeObjectFromInterest(object, normalizedInterestId, interest);
    }
    interest.objectsById.clear();
  }

  #resetInterestForOwner(interest, ownerId) {
    const previousOwnerId = interest.ownerId;
    const detail = { reason: 'ownerChanged', ownerId, previousOwnerId };
    for (const object of [...interest.objectsById.values()]) {
      this.#removeObjectFromAllInterests(object, detail);
    }
    interest.objectsById.clear();
    interest.ownerId = ownerId;
    interest.resetLocal();
    interest.emit('stale', detail);
    this.emit('stale', { interest, ...detail });
    this.sen.emit('stale', { bus: this, interest, ...detail });
  }

  #removeObjectFromAllInterests(object, detail = {}) {
    for (const interestId of [...object.interestIds]) {
      this.#removeObjectFromInterest(object, interestId, this.interests.get(interestId), detail);
    }
  }

  #removeObjectFromInterest(object, interestId, interest, detail = {}) {
    const normalizedInterestId = interestId >>> 0;
    this.stateRequestedObjectIds.delete(stateRequestKey(normalizedInterestId, object.ownerId, object.id));
    interest?.objectsById.delete(object.key);
    object.detachInterest(normalizedInterestId);
    object.emit('remove', { interestId: normalizedInterestId, ...detail });
    interest?.emit('remove', object);
    if (object.interestIds.size === 0) {
      this.objectsById.delete(object.key);
      if (![...this.objectsById.values()].some(item => item.typeHash === object.typeHash)) {
        this.requestedTypeHashes.delete(object.typeHash);
      }
      this.emit('remove', object);
      this.sen.emit('remove', object);
    }
  }

  #emitObjectWhenReady(interest, object, emitGlobal) {
    if (!interest) {
      return;
    }
    const publish = () => {
      if (!object.isReadyForInterest(interest.id)) {
        return false;
      }
      if (object.markInterestObjectEmitted(interest.id)) {
        interest.emit('object', object);
      }
      if (emitGlobal && object.markGlobalObjectEmitted()) {
        this.emit('object', object);
        this.sen.emit('object', object);
      }
      return true;
    };

    if (publish()) {
      return;
    }

    const onReady = () => {
      if (publish()) {
        object.off('ready', onReady);
      }
    };
    object.on('ready', onReady);
  }

  handleTypesInfoResponse(event) {
    const dependentTypeHashes = new Set();
    for (const type of event.types ?? []) {
      this.typeRegistry.set(type.spec.qualifiedName, type.spec);
      if (type.classHash !== undefined) {
        for (const object of this.objectsById.values()) {
          if (object.typeHash === type.classHash) {
            object.spec = type.spec;
            object.emit('type', type.spec);
          }
        }
      }
      for (const hash of type.dependentTypes ?? []) {
        if (!this.requestedTypeHashes.has(hash)) {
          this.requestedTypeHashes.add(hash);
          dependentTypeHashes.add(hash);
        }
      }
      this.emit('type', type);
    }
    if (dependentTypeHashes.size) {
      this.sen.client.requestTypes(this.name, dependentTypeHashes);
    }
    this.#retryPendingStates();
    this.#requestReadyObjectStates();
    this.#scheduleStateResyncs();
  }

  handleObjectsStateResponse(event) {
    const ownerId = eventOwnerId(event);
    for (const response of event.responses ?? []) {
      const interest = this.interests.get(response.interestId);
      if (!interest) {
        continue;
      }
      for (const state of response.objectStates ?? []) {
        const object = this.#objectByOwnerAndId(ownerId, state.id);
        if (!object || !interest.objectsById.has(object.key)) {
          continue;
        }
        object.applyState(state.state, 'state', state.timestamp, { interestId: response.interestId });
      }
    }
  }

  handleRuntimeObjectUpdate(event) {
    const object = this.#objectByOwnerAndId(eventOwnerId(event), event.update.objectId);
    if (!object) {
      return;
    }
    object.applyState(event.update.properties, 'update', event.update.time);
  }

  handleRuntimeEvents(event) {
    const ownerId = eventOwnerId(event);
    for (const item of event.events ?? []) {
      const object = this.#objectByOwnerAndId(ownerId, item.producerId);
      if (!object) {
        continue;
      }
      object.emitRuntimeEvent(item);
    }
  }

  handleRuntimeMethodResponse(event) {
    const response = event.response;
    const pending = this.pendingCalls.get(response.ticketId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingCalls.delete(response.ticketId);

    if (response.result !== 'success') {
      const error = new Error(response.error || response.result);
      error.code = `SEN_${response.result}`;
      pending.reject(error);
      return;
    }

    try {
      if (!pending.method.returnType || pending.method.returnType === 'void') {
        pending.resolve(undefined);
        return;
      }
      pending.resolve(decodeValue(response.returnValue, pending.method.returnType, this.typeRegistry));
    } catch (error) {
      pending.reject(error);
    }
  }

  callObjectMethod(object, method, args, options = {}) {
    const ticketId = this.nextTicketId++ >>> 0;
    const timeoutMs = options.timeout ?? 5000;
    const argumentsBuffer = encodeArguments(args, method.args, this.typeRegistry);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(ticketId);
        reject(new Error(`timeout waiting for SEN method ${method.name} response`));
      }, timeoutMs);
      this.pendingCalls.set(ticketId, { resolve, reject, timeout, method });
      try {
        this.sen.client.sendRuntimeMethodCall(this.name, {
          to: object.ownerId,
          objectId: object.id,
          methodId: method.id,
          ticketId,
          confirmed: method.transportMode === 'confirmed' || options.confirmed,
          argumentsBuffer
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCalls.delete(ticketId);
        reject(error);
      }
    });
  }

  #requestReadyObjectStates(options = {}) {
    const force = options.force === true;
    const requestsByInterest = new Map();
    for (const interest of this.interests.values()) {
      for (const object of interest.objectsById.values()) {
        if (!object.spec) {
          continue;
        }
        const key = stateRequestKey(interest.id, object.ownerId, object.id);
        if (!force && this.stateRequestedObjectIds.has(key)) {
          continue;
        }
        this.stateRequestedObjectIds.add(key);
        const ids = requestsByInterest.get(interest.id) ?? [];
        ids.push(object.id);
        requestsByInterest.set(interest.id, ids);
      }
    }

    if (requestsByInterest.size && this.sen.client) {
      try {
        this.sen.client.requestObjectStates(this.name, [...requestsByInterest].map(([interestId, objectIds]) => ({
          interestId,
          objectIds
        })));
      } catch (error) {
        this.sen.emit('warning', error);
      }
    }
  }

  #scheduleStateResyncs() {
    if (!this.interests.size || this.stateResyncTimers.size) {
      return;
    }

    for (const delayMs of STATE_RESYNC_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.stateResyncTimers.delete(timer);
        try {
          this.#requestReadyObjectStates({ force: true });
        } catch (error) {
          this.sen.emit('warning', error);
        }
      }, delayMs);
      timer.unref?.();
      this.stateResyncTimers.add(timer);
    }
    const interval = setInterval(() => {
      try {
        this.#requestReadyObjectStates({ force: true });
      } catch (error) {
        this.sen.emit('warning', error);
      }
    }, STATE_RESYNC_INTERVAL_MS);
    interval.unref?.();
    this.stateResyncInterval = interval;
    this.stateResyncTimers.add(interval);
  }

  #clearStateResyncTimers() {
    for (const timer of this.stateResyncTimers) {
      clearTimeout(timer);
    }
    this.stateResyncTimers.clear();
    this.stateResyncInterval = undefined;
  }

  #retryPendingStates() {
    for (const object of this.objectsById.values()) {
      const pendingStates = object.pendingStates.splice(0);
      for (const pendingState of pendingStates) {
        object.applyState(
          pendingState.buffer,
          pendingState.source,
          pendingState.timestampNs,
          { interestId: pendingState.interestId }
        );
      }
    }
  }

  #objectByOwnerAndId(ownerId, objectId) {
    if (ownerId !== undefined && ownerId !== null) {
      return this.objectsById.get(remoteObjectKey(ownerId, objectId));
    }
    const id = objectId >>> 0;
    return [...this.objectsById.values()].find(object => object.id === id);
  }
}

export class SenInterest extends EventEmitter {
  constructor(bus, id, query, options = {}) {
    super();
    this.bus = bus;
    this.id = id;
    this.query = query;
    this.ownerId = undefined;
    this.ownerIds = new Set();
    this.options = { ...options };
    this.propertyNames = normalizePropertyNames(options.properties ?? options.propertyNames);
    this.changeMode = options.changeMode ?? (options.batch ? 'batch' : 'individual');
    if (!['individual', 'batch', 'both'].includes(this.changeMode)) {
      throw new Error(`invalid SEN interest changeMode: ${this.changeMode}`);
    }
    this.batcher = this.changeMode === 'individual' ? undefined : new ChangeBatcher(this, options);
    this.objectsById = new Map();
  }

  objects() {
    return [...this.objectsById.values()];
  }

  get(selector) {
    return this.objects().find(object => object.matches(selector));
  }

  async waitFor(selector, options = {}) {
    const existing = this.get(selector);
    if (existing) {
      return existing;
    }

    const timeoutMs = options.timeout ?? this.bus.sen.options.timeout ?? 3000;
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

  close() {
    this.bus.stopInterest(this.id);
  }

  closeLocal() {
    this.batcher?.close();
  }

  resetLocal() {
    this.batcher?.close();
    this.batcher = this.changeMode === 'individual' ? undefined : new ChangeBatcher(this, this.options);
  }

  decodeOptions() {
    return {
      propertyNames: this.propertyNames
    };
  }

  publishChange(change) {
    if (this.changeMode === 'individual' || this.changeMode === 'both') {
      change.object.emit('change', change);
      change.object.emit(`change:${change.name}`, change);
      this.emit('change', change);
      this.bus.emit('change', change);
      this.bus.sen.emit('change', change);
    }
    if (this.batcher) {
      this.batcher.push(change);
    }
  }
}

export class SenRemoteObject extends EventEmitter {
  constructor(bus, info) {
    super();
    this.bus = bus;
    this.id = info.id;
    this.name = info.name;
    this.className = info.className;
    this.typeHash = info.typeHash;
    this.ownerId = info.ownerId;
    this.interestId = info.interestId;
    this.interestIds = new Set();
    if (info.interestId !== undefined) {
      this.interestIds.add(info.interestId);
    }
    this.snapshot = {};
    this.spec = undefined;
    this.typePromise = undefined;
    this.pendingState = undefined;
    this.pendingStates = [];
    this.readyInterestIds = new Set();
    this.emittedInterestObjectIds = new Set();
    this.emittedGlobalObject = false;
    this.timestamp = undefined;
    this.timestampNs = undefined;
    this.lastStateTimestamp = undefined;
    this.lastStateTimestampNs = undefined;
    this.lastUpdateTimestamp = undefined;
    this.lastUpdateTimestampNs = undefined;
    this.propertyTimestamps = new Map();
  }

  matches(selector) {
    if (typeof selector === 'function') {
      return Boolean(selector(this));
    }
    if (typeof selector === 'number') {
      return this.id === selector;
    }
    return this.name === selector || this.className === selector || String(this.id) === String(selector);
  }

  attachInterest(interestId) {
    if (interestId !== undefined) {
      this.interestIds.add(interestId);
      this.interestId = interestId;
    }
  }

  detachInterest(interestId) {
    if (interestId !== undefined) {
      const normalizedInterestId = interestId >>> 0;
      this.interestIds.delete(normalizedInterestId);
      this.readyInterestIds.delete(normalizedInterestId);
      this.emittedInterestObjectIds.delete(normalizedInterestId);
      if (this.interestId === interestId) {
        this.interestId = this.interestIds.values().next().value;
      }
    }
  }

  updateDiscoveryInfo(info) {
    this.name = info.name ?? this.name;
    this.className = info.className ?? this.className;
    this.typeHash = info.typeHash ?? this.typeHash;
    this.ownerId = info.ownerId ?? this.ownerId;
  }

  property(name) {
    return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'properties'), name);
  }

  method(name) {
    return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'methods'), name);
  }

  event(name) {
    return findByName(collectClassMembers(this.spec, this.bus.typeRegistry, 'events'), name);
  }

  async waitForType(options = {}) {
    if (this.spec) {
      return this.spec;
    }

    const timeoutMs = options.timeout ?? 3000;
    let timeout;
    try {
      return await Promise.race([
        this.#waitForTypeReady(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`timeout waiting for SEN type ${this.className}`));
          }, timeoutMs);
          timeout.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  #waitForTypeReady() {
    if (this.spec) {
      return Promise.resolve(this.spec);
    }
    if (this.typePromise) {
      return this.typePromise;
    }
    this.typePromise = new Promise(resolve => {
      const onType = spec => {
        this.off('type', onType);
        this.typePromise = undefined;
        resolve(spec);
      };
      this.on('type', onType);
    });
    return this.typePromise;
  }

  async get(name) {
    return this.snapshot[name];
  }

  getPropertyTimestamp(name) {
    return this.propertyTimestamps.get(name);
  }

  get key() {
    return remoteObjectKey(this.ownerId, this.id);
  }

  isReadyForInterest(interestId) {
    return this.readyInterestIds.has(interestId >>> 0);
  }

  markInterestObjectEmitted(interestId) {
    const normalizedInterestId = interestId >>> 0;
    if (this.emittedInterestObjectIds.has(normalizedInterestId)) {
      return false;
    }
    this.emittedInterestObjectIds.add(normalizedInterestId);
    return true;
  }

  markGlobalObjectEmitted() {
    if (this.emittedGlobalObject) {
      return false;
    }
    this.emittedGlobalObject = true;
    return true;
  }

  async set(name, value, options = {}) {
    await this.waitForType(options);
    const property = this.property(name);
    if (!property) {
      throw new Error(`SEN property not found: ${name}`);
    }
    if (!property.category?.endsWith('RW')) {
      throw new Error(`SEN property is read-only: ${this.className}.${name}`);
    }

    const methodName = setterName(property.name);
    await this.bus.callObjectMethod(this, {
      id: methodHash(methodName),
      name: methodName,
      args: [{ name: 'value', type: property.type }],
      returnType: 'void',
      transportMode: property.transportMode
    }, [value], options);
    this.snapshot[name] = value;
  }

  async call(name, args = [], options = {}) {
    await this.waitForType(options);
    const method = this.method(name);
    if (!method) {
      throw new Error(`SEN method not found: ${this.className}.${name}`);
    }
    if (method.localOnly) {
      throw new Error(`SEN method is localOnly and cannot be called remotely: ${this.className}.${name}`);
    }
    return await this.bus.callObjectMethod(this, method, args, options);
  }

  applyState(buffer, source, timestamp, options = {}) {
    const timestampNs = normalizeTimestampNs(timestamp);
    this.#rememberObjectTimestamp(source, timestampNs);

    if (!this.spec) {
      this.#queuePendingState({ buffer, source, timestampNs, interestId: options.interestId });
      return;
    }

    const interests = this.#targetInterests(options.interestId);
    const decodeInterest = options.interestId !== undefined || interests.length === 1 ? interests[0] : undefined;
    const values = decodePropertyValues(buffer, this.spec, this.bus.typeRegistry, decodeInterest?.decodeOptions());
    let complete = true;
    for (const value of values) {
      if (!value.decoded) {
        complete = false;
        continue;
      }
      const previous = this.snapshot[value.name];
      this.snapshot[value.name] = value.value;
      if (timestampNs !== undefined) {
        this.propertyTimestamps.set(value.name, timestampNs);
      }
      const change = {
        object: this,
        source,
        timestamp: timestampNs,
        timestampNs,
        name: value.name,
        type: value.type,
        value: value.value,
        previous,
        property: value.property
      };
      for (const interest of interests) {
        interest.publishChange(change);
      }
      if (!interests.length) {
        this.emit('change', change);
        this.emit(`change:${value.name}`, change);
        this.bus.emit('change', change);
        this.bus.sen.emit('change', change);
      }
    }

    if (complete) {
      if (source === 'state') {
        this.#markReady(options.interestId);
      }
      if (!this.pendingStates.length) this.pendingState = undefined;
    } else {
      this.#queuePendingState({ buffer, source, timestampNs, interestId: options.interestId });
    }
  }

  #markReady(interestId) {
    if (interestId !== undefined) {
      const normalizedInterestId = interestId >>> 0;
      this.readyInterestIds.add(normalizedInterestId);
      this.emit('ready', { interestId: normalizedInterestId });
      return;
    }
    for (const id of this.interestIds) {
      this.readyInterestIds.add(id >>> 0);
      this.emit('ready', { interestId: id >>> 0 });
    }
  }

  #queuePendingState(state) {
    this.pendingStates.push(state);
    this.pendingState = state;
  }

  #targetInterests(interestId) {
    if (interestId !== undefined) {
      const interest = this.bus.interests.get(interestId);
      return interest ? [interest] : [];
    }

    const interests = [];
    for (const interest of this.bus.interests.values()) {
      if (interest.objectsById.has(this.key) || interest.objectsById.has(this.id)) {
        interests.push(interest);
      }
    }
    return interests;
  }

  #rememberObjectTimestamp(source, timestampNs) {
    if (timestampNs === undefined) {
      return;
    }
    this.timestamp = timestampNs;
    this.timestampNs = timestampNs;
    if (source === 'state') {
      this.lastStateTimestamp = timestampNs;
      this.lastStateTimestampNs = timestampNs;
    } else if (source === 'update') {
      this.lastUpdateTimestamp = timestampNs;
      this.lastUpdateTimestampNs = timestampNs;
    }
  }

  emitRuntimeEvent(item) {
    const eventSpec = collectClassMembers(this.spec, this.bus.typeRegistry, 'events')
      .find(candidate => candidate.id === item.eventId);
    const args = eventSpec
      ? decodeArguments(item.argumentsBuffer, eventSpec.args, this.bus.typeRegistry)
      : undefined;
    const event = {
      object: this,
      id: item.eventId,
      name: eventSpec?.name,
      creationTime: item.creationTime,
      creationTimeNs: normalizeTimestampNs(item.creationTime),
      args,
      raw: item.argumentsBuffer
    };
    this.emit('event', event);
    if (event.name) {
      this.emit(event.name, event);
    }
    this.bus.interests.get(this.interestId)?.emit('event', event);
    this.bus.emit('event', event);
    this.bus.sen.emit('event', event);
  }
}
