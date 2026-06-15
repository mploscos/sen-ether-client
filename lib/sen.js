import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { decodePropertyValues, decodeValue, encodeArguments, decodeArguments } from './values.js';
import { EtherClient } from './client.js';
import { scan, scanTcpDiscoveryHub } from './discovery.js';
import { methodHash } from './hash32.js';

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

function findTarget(processes, options) {
  let candidates = processes;
  if (options.session) {
    candidates = candidates.filter(item => item.session?.name === options.session);
  }
  if (options.app) {
    const app = String(options.app).toLowerCase();
    candidates = candidates.filter(item => String(item.process?.appName || '').toLowerCase().includes(app));
  }
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

  constructor(options = {}) {
    super();
    this.options = {
      appName: 'sen-ether-client',
      reconnect: true,
      reconnectDelayMs: 500,
      maxReconnectAttempts: 10,
      timeout: 3000,
      discoverySettleMs: 100,
      participantReadyTimeoutMs: 1000,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: 1000,
      socketIdleTimeoutMs: 0,
      ...options
    };
    this.target = undefined;
    this.client = undefined;
    this.connectOptions = undefined;
    this.manualClose = false;
    this.reconnecting = false;
    this.remoteBuses = new Set();
    this.buses = new Map();
    this.sessions = new Map();
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
      for (const target of targets) {
        const sessionName = target.session?.name ?? target.info?.sessionName;
        if (sessionName && !this.targetsBySession.has(sessionName)) {
          this.targetsBySession.set(sessionName, target);
        }
      }
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
    if (!target) {
      throw new Error('no SEN ether process matches the requested filters');
    }

    const sessionName = target.session?.name ?? target.info?.sessionName ?? config.session;
    if (!sessionName) {
      throw new Error('cannot connect without a SEN session name');
    }

    const client = new EtherClient({
      sessionName,
      appName: config.appName,
      socketKeepAlive: config.socketKeepAlive,
      socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
      socketIdleTimeoutMs: config.socketIdleTimeoutMs
    });
    this.client = client;
    this.target = target;
    this.#wireClient(client);

    await client.connect(target);
    await waitForEvent(client, 'ready', config.timeout ?? 3000);
    this.emit('connect', { target, sessionName });
    return this;
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
      const joined = this.client.joinBus(bus);
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
      const joined = this.client.joinBus(bus);
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
      ...this.targetsBySession.keys(),
      ...this.sessions.keys()
    ])].sort();
  }

  listBuses(options = {}) {
    if (!this.client) {
      return [...this.sessions.values()]
        .flatMap(session => session.listBuses({ qualified: true }))
        .sort();
    }

    const sessionName = this.target?.session?.name ?? this.client.processInfo.sessionName;
    return [...this.remoteBuses]
      .sort()
      .map(busName => options.qualified ? queryBusName(sessionName, busName) : busName);
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
      await session.close();
    }
    for (const bus of this.buses.values()) {
      bus.close();
    }
    await wait(50);
    await this.client?.close();
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
      this.emit('close', hadError);
      if (!this.manualClose && this.options.reconnect !== false) {
        this.#reconnect().catch(error => this.emit('error', error));
      }
    });
  }

  async #reconnect() {
    if (this.manualClose || this.reconnecting || !this.connectOptions) {
      return;
    }

    this.reconnecting = true;
    await this.client?.close().catch(error => this.emit('warning', error));
    this.emit('reconnecting');
    const maxAttempts = this.connectOptions.maxReconnectAttempts ?? this.options.maxReconnectAttempts ?? 10;
    const delayMs = this.connectOptions.reconnectDelayMs ?? this.options.reconnectDelayMs ?? 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        const target = config.target ?? await this.#discoverTarget(config);
        if (!target) {
          throw new Error('no SEN ether process matches the requested filters');
        }

        const sessionName = target.session?.name ?? target.info?.sessionName ?? config.session;
        client = new EtherClient({
          sessionName,
          appName: config.appName,
          socketKeepAlive: config.socketKeepAlive,
          socketKeepAliveInitialDelayMs: config.socketKeepAliveInitialDelayMs,
          socketIdleTimeoutMs: config.socketIdleTimeoutMs
        });
        this.client = client;
        this.target = target;
        this.#wireClient(client);

        await client.connect(target);
        await waitForEvent(client, 'ready', config.timeout ?? 3000);

        for (const bus of this.buses.values()) {
          await bus.rejoin(config.timeout ?? 3000);
        }

        this.reconnecting = false;
        this.emit('reconnect', { attempt, target, sessionName });
        return;
      } catch (error) {
        await client?.close().catch(closeError => this.emit('warning', closeError));
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
    this.sen.client.stopInterest(this.name, interestId);
    const interest = this.interests.get(interestId);
    this.interests.delete(interestId);
    interest?.closeLocal();
    interest?.emit('close');
  }

  close() {
    for (const interest of this.interests.values()) {
      interest.closeLocal();
      this.sen.client.stopInterest(this.name, interest.id);
    }
    this.interests.clear();
    this.sen.client.leaveBus(this.name);
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
    const joined = this.sen.client.joinBus(this.name);
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
    const newTypeHashes = new Set();
    for (const discovery of event.discoveries ?? []) {
      for (const info of discovery.objects ?? []) {
        const object = new SenRemoteObject(this, {
          ...info,
          ownerId: event.ownerId,
          interestId: discovery.interestId
        });
        this.objectsById.set(object.id, object);
        const interest = this.interests.get(discovery.interestId);
        interest?.objectsById.set(object.id, object);
        if (info.state?.length) {
          object.applyState(info.state, 'state', info.time);
        }
        if (!this.requestedTypeHashes.has(info.typeHash)) {
          this.requestedTypeHashes.add(info.typeHash);
          newTypeHashes.add(info.typeHash);
        }
        interest?.emit('object', object);
        this.emit('object', object);
        this.sen.emit('object', object);
      }
    }
    if (newTypeHashes.size) {
      this.sen.client.requestTypes(this.name, newTypeHashes);
    }
    this.#requestReadyObjectStates();
  }

  handleObjectsRemoved(event) {
    for (const removal of event.removals ?? []) {
      for (const id of removal.ids ?? []) {
        const object = this.objectsById.get(id);
        this.objectsById.delete(id);
        this.stateRequestedObjectIds.delete(id);
        const interest = this.interests.get(removal.interestId);
        interest?.objectsById.delete(id);
        if (object) {
          object.emit('remove');
          interest?.emit('remove', object);
          this.emit('remove', object);
          this.sen.emit('remove', object);
        }
      }
    }
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
  }

  handleObjectsStateResponse(event) {
    for (const response of event.responses ?? []) {
      for (const state of response.objectStates ?? []) {
        const object = this.objectsById.get(state.id);
        if (!object) {
          continue;
        }
        object.applyState(state.state, 'state', state.timestamp);
      }
    }
  }

  handleRuntimeObjectUpdate(event) {
    const object = this.objectsById.get(event.update.objectId);
    if (!object) {
      return;
    }
    object.applyState(event.update.properties, 'update', event.update.time);
  }

  handleRuntimeEvents(event) {
    for (const item of event.events ?? []) {
      const object = this.objectsById.get(item.producerId);
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

  #requestReadyObjectStates() {
    const requestsByInterest = new Map();
    for (const object of this.objectsById.values()) {
      if (this.stateRequestedObjectIds.has(object.id) || !object.spec) {
        continue;
      }
      this.stateRequestedObjectIds.add(object.id);
      const ids = requestsByInterest.get(object.interestId) ?? [];
      ids.push(object.id);
      requestsByInterest.set(object.interestId, ids);
    }

    if (requestsByInterest.size) {
      this.sen.client.requestObjectStates(this.name, [...requestsByInterest].map(([interestId, objectIds]) => ({
        interestId,
        objectIds
      })));
    }
  }

  #retryPendingStates() {
    for (const object of this.objectsById.values()) {
      if (object.pendingState) {
        object.applyState(
          object.pendingState.buffer,
          object.pendingState.source,
          object.pendingState.timestampNs
        );
      }
    }
  }
}

export class SenInterest extends EventEmitter {
  constructor(bus, id, query, options = {}) {
    super();
    this.bus = bus;
    this.id = id;
    this.query = query;
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
    this.snapshot = {};
    this.spec = undefined;
    this.pendingState = undefined;
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
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('type', onType);
        reject(new Error(`timeout waiting for SEN type ${this.className}`));
      }, timeoutMs);
      const onType = spec => {
        clearTimeout(timeout);
        this.off('type', onType);
        resolve(spec);
      };
      this.on('type', onType);
    });
  }

  async get(name) {
    return this.snapshot[name];
  }

  getPropertyTimestamp(name) {
    return this.propertyTimestamps.get(name);
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

  applyState(buffer, source, timestamp) {
    const timestampNs = normalizeTimestampNs(timestamp);
    this.#rememberObjectTimestamp(source, timestampNs);

    if (!this.spec) {
      this.pendingState = { buffer, source, timestampNs };
      return;
    }

    const interest = this.bus.interests.get(this.interestId);
    const values = decodePropertyValues(buffer, this.spec, this.bus.typeRegistry, interest?.decodeOptions());
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
      if (interest) {
        interest.publishChange(change);
      } else {
        this.emit('change', change);
        this.emit(`change:${value.name}`, change);
        this.bus.emit('change', change);
        this.bus.sen.emit('change', change);
      }
    }

    this.pendingState = complete ? undefined : { buffer, source, timestampNs };
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
