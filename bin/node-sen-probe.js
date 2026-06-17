#!/usr/bin/env node
import { once } from 'node:events';
import { EtherClient } from '../lib/client.js';
import { scan, scanTcpDiscoveryHub } from '../lib/discovery.js';
import { decodePropertyValues } from '../lib/values.js';

function parseArgs(argv) {
  const options = {
    timeout: 3000,
    listen: 10000,
    bus: 'scenario.control'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--timeout') {
      options.timeout = Number(argv[++i]);
    } else if (arg === '--listen') {
      options.listen = Number(argv[++i]);
    } else if (arg === '--group') {
      options.group = argv[++i];
    } else if (arg === '--port') {
      options.port = Number(argv[++i]);
    } else if (arg === '--interface') {
      options.interfaceAddress = argv[++i];
    } else if (arg === '--tcp-hub') {
      options.tcpHub = argv[++i];
    } else if (arg === '--session') {
      options.session = argv[++i];
    } else if (arg === '--app') {
      options.app = argv[++i];
    } else if (arg === '--bus') {
      options.bus = argv[++i];
    } else if (arg === '--query') {
      options.query = argv[++i];
    } else if (arg === '--force-bus') {
      options.forceBus = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: sen-ether-probe [options]

Options:
  --timeout <ms>      Discovery timeout. Default: 3000
  --listen <ms>       Time to listen after starting the interest. Default: 10000
  --group <address>   Discovery multicast group. Default: 239.255.0.44
  --port <port>       Discovery multicast port. Default: 60543
  --interface <addr>  Local interface address or interface name for multicast membership
  --tcp-hub <host:port>
                      Use SEN TcpDiscoveryHub instead of multicast discovery
  --session <name>    SEN session name filter
  --app <name>        SEN appName substring filter
  --bus <name>        Bus to join. Default: scenario.control
  --query <query>     Interest query. Default: SELECT * FROM <bus>
  --force-bus         Join even if the remote process has not announced the bus
  -h, --help          Show this help

Examples:
  sen-ether-probe --bus scenario.control
  sen-ether-probe --tcp-hub 127.0.0.1:64222 --bus scenario.control
  sen-ether-probe --bus world1.environment --query "SELECT * FROM world1.environment"

Environment:
  SEN_ETHER_DISCOVERY_PORT       Default multicast discovery port
`);
}

function parseHostPort(value) {
  const text = String(value || '').trim();
  const idx = text.lastIndexOf(':');
  if (idx <= 0) {
    throw new Error(`invalid --tcp-hub value, expected host:port: ${text}`);
  }
  const host = text.slice(0, idx);
  const port = Number(text.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid --tcp-hub value, expected host:port: ${text}`);
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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForEvent(emitter, event, timeoutMs) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
  });
  return await Promise.race([once(emitter, event), timeout]);
}

async function waitForRemoteBus(emitter, remoteBuses, busName, timeoutMs) {
  if (remoteBuses.has(busName)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off('busJoined', onBusJoined);
      const announced = [...remoteBuses].sort().join(', ') || '<none>';
      reject(new Error(`remote process did not announce bus "${busName}" within ${timeoutMs}ms; announced: ${announced}`));
    }, timeoutMs);

    const onBusJoined = value => {
      if (value.busName !== busName) {
        return;
      }
      clearTimeout(timeout);
      emitter.off('busJoined', onBusJoined);
      resolve();
    };

    emitter.on('busJoined', onBusJoined);
  });
}

function printProcess(item, prefix = '-') {
  console.log(`${prefix} session=${item.session?.name || '<empty>'} app=${item.process?.appName || '<unknown>'} host=${item.process?.hostName || '<unknown>'}`);
  for (const endpoint of item.endpoints ?? []) {
    console.log(`  endpoint=${endpoint.host}:${endpoint.port}`);
  }
}

function printTypeSpec(response) {
  const spec = response.spec;
  const data = spec.data;
  console.log(`[types] ${response.type} hash=${response.classHash ?? '<non-class>'} type=${spec.qualifiedName} kind=${data.type}`);

  if (data.type !== 'ClassTypeSpec') {
    return;
  }

  const classSpec = data.value;
  console.log(`  properties=${classSpec.properties.length} methods=${classSpec.methods.length} events=${classSpec.events.length} parents=${classSpec.parents.length}`);
  for (const property of classSpec.properties) {
    console.log(`  property ${property.name}: ${property.type} ${property.category} ${property.transportMode}${property.checkedSet ? ' checkedSet' : ''}`);
  }
  for (const method of classSpec.methods) {
    const args = method.args.map(arg => `${arg.name}: ${arg.type}`).join(', ');
    console.log(`  method ${method.name}(${args}) -> ${method.returnType || 'void'} ${method.constness} ${method.transportMode} ${method.propertyRelation}`);
  }
  for (const event of classSpec.events) {
    const args = event.args.map(arg => `${arg.name}: ${arg.type}`).join(', ');
    console.log(`  event ${event.name}(${args}) ${event.transportMode}`);
  }
}

function formatValue(value) {
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function classSpecForObject(object, typeRegistry) {
  return object ? typeRegistry.get(object.className) : undefined;
}

function applyPropertyValues(objectState, propertyValues) {
  for (const property of propertyValues) {
    if (property.decoded && property.name) {
      objectState.snapshot[property.name] = property.value;
    }
  }
}

function formatPropertyValues(propertyValues) {
  return propertyValues
    .map(update => {
      if (!update.name) {
        return `0x${update.id.toString(16).padStart(8, '0')}:${update.size}`;
      }
      if (!update.decoded) {
        return `${update.name}<${update.type}>:${update.size}`;
      }
      return `${update.name}=${formatValue(update.value)}`;
    })
    .join(', ');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`[scan] timeout=${options.timeout}ms${options.tcpHub ? ` tcpHub=${options.tcpHub}` : ''}`);
  const processes = options.tcpHub
    ? await scanTcpDiscoveryHub({ ...parseHostPort(options.tcpHub), timeout: options.timeout })
    : await scan(options);
  if (!processes.length) {
    throw new Error('no SEN ether processes discovered');
  }

  console.log(`[scan] discovered ${processes.length} process(es)`);
  for (const item of processes) {
    printProcess(item);
  }

  const target = findTarget(processes, options);
  if (!target) {
    throw new Error('no discovered process matches the requested filters');
  }

  console.log('[target]');
  printProcess(target, '*');

  const bus = etherBusName(target.session.name, options.bus);
  const query = options.query ?? `SELECT * FROM ${queryBusName(target.session.name, options.bus)}`;
  if (bus !== options.bus) {
    console.log(`[bus] normalized ${options.bus} -> ${bus} for ether session=${target.session.name}`);
  }

  const client = new EtherClient({
    sessionName: target.session.name,
    appName: 'sen-ether-probe',
    interfaceAddress: options.interfaceAddress,
    discoveryPort: options.port
  });
  const remoteBuses = new Set();
  const requestedTypeHashes = new Set();
  const objectsById = new Map();
  const typeRegistry = new Map();
  const stateRequestedObjectIds = new Set();

  function requestReadyObjectStates() {
    const requestsByInterest = new Map();
    for (const object of objectsById.values()) {
      if (stateRequestedObjectIds.has(object.id)) {
        continue;
      }
      if (!classSpecForObject(object, typeRegistry)) {
        continue;
      }
      stateRequestedObjectIds.add(object.id);
      const ids = requestsByInterest.get(object.interestId) ?? [];
      ids.push(object.id);
      requestsByInterest.set(object.interestId, ids);
    }

    if (requestsByInterest.size) {
      client.requestObjectStates(bus, [...requestsByInterest].map(([interestId, objectIds]) => ({ interestId, objectIds })));
    }
  }

  client.on('remoteProcess', hello => {
    console.log(`[ether] remote hello app=${hello.info.appName} session=${hello.info.sessionName}`);
  });
  client.on('ready', () => {
    console.log('[ether] ready');
  });
  client.on('busJoined', value => {
    remoteBuses.add(value.busName);
    console.log(`[ether] remote bus joined name=${value.busName} id=${value.busId} participant=${value.participantId}`);
  });
  client.on('busParticipantReady', value => {
    console.log(`[bus] participant ready bus=${value.busName} local=${value.participantId} remote=${value.remoteParticipantId}`);
  });
  client.on('interestStarted', value => {
    console.log(`[bus] interest started id=${value.id} query=${value.query}`);
  });
  client.on('typesInfoRequested', value => {
    console.log(`[types] requested ${value.requests.length} type spec(s): ${value.requests.join(', ')}`);
  });
  client.on('typesInfoResponse', event => {
    console.log(`[types] response owner=${event.ownerId} count=${event.types.length}`);
    const dependentTypeHashes = new Set();
    for (const type of event.types) {
      typeRegistry.set(type.spec.qualifiedName, type.spec);
      for (const hash of type.dependentTypes ?? []) {
        if (!requestedTypeHashes.has(hash)) {
          requestedTypeHashes.add(hash);
          dependentTypeHashes.add(hash);
        }
      }
      printTypeSpec(type);
    }
    if (dependentTypeHashes.size) {
      client.requestTypes(bus, dependentTypeHashes);
    }
    requestReadyObjectStates();
  });
  client.on('typesInfoRejection', event => {
    console.warn(`[types] rejection owner=${event.ownerId}: ${event.rejections.join('; ')}`);
  });
  client.on('objectsPublished', event => {
    let total = 0;
    const newTypeHashes = new Set();
    for (const discovery of event.discoveries ?? []) {
      total += discovery.objects?.length ?? 0;
    }
    console.log(`[objects] published owner=${event.ownerId} discoveries=${event.discoveries?.length ?? 0} objects=${total}`);
    for (const discovery of event.discoveries ?? []) {
      for (const object of discovery.objects ?? []) {
        objectsById.set(object.id, {
          ...object,
          interestId: discovery.interestId,
          snapshot: {}
        });
        console.log(`  interest=${discovery.interestId} id=${object.id} class=${object.className} name=${object.name} stateBytes=${object.state.length}`);
        if (!requestedTypeHashes.has(object.typeHash)) {
          requestedTypeHashes.add(object.typeHash);
          newTypeHashes.add(object.typeHash);
        }
      }
    }
    if (newTypeHashes.size) {
      client.requestTypes(bus, newTypeHashes);
    }
    requestReadyObjectStates();
  });
  client.on('objectsRemoved', event => {
    console.log(`[objects] removed groups=${event.removals?.length ?? 0}`);
    for (const removal of event.removals ?? []) {
      for (const id of removal.ids ?? []) {
        objectsById.delete(id);
        stateRequestedObjectIds.delete(id);
      }
    }
  });
  client.on('objectsStateRequested', event => {
    const count = event.requests.reduce((acc, request) => acc + request.objectIds.length, 0);
    console.log(`[state] requested objects=${count}`);
  });
  client.on('objectsStateResponse', event => {
    let count = 0;
    for (const response of event.responses ?? []) {
      for (const objectState of response.objectStates ?? []) {
        count += 1;
        const object = objectsById.get(objectState.id);
        const classSpec = classSpecForObject(object, typeRegistry);
        const values = decodePropertyValues(objectState.state, classSpec, typeRegistry);
        if (object) {
          object.lastStateTimestamp = objectState.timestamp;
          applyPropertyValues(object, values);
        }
        console.log(`[state] object id=${objectState.id} properties=${values.length}${values.length ? ` [${formatPropertyValues(values)}]` : ''}`);
      }
    }
    console.log(`[state] response owner=${event.ownerId} objects=${count}`);
  });
  client.on('runtimeObjectUpdate', event => {
    const object = objectsById.get(event.update.objectId);
    const classSpec = classSpecForObject(object, typeRegistry);
    const values = decodePropertyValues(event.update.properties, classSpec, typeRegistry);
    if (object) {
      object.lastUpdateTimestamp = event.update.time;
      applyPropertyValues(object, values);
    }
    const ids = formatPropertyValues(values);
    console.log(`[runtime] object update id=${event.update.objectId} properties=${event.update.propertyUpdates.length} bytes=${event.update.properties.length}${ids ? ` [${ids}]` : ''}`);
  });
  client.on('runtimeEvents', event => {
    console.log(`[runtime] events bytes=${event.payload.length}`);
  });
  client.on('error', error => {
    console.error(`[error] ${error?.stack ?? error}`);
  });

  await client.connect(target);
  await waitForEvent(client, 'ready', 3000);
  if (!options.forceBus) {
    await waitForRemoteBus(client, remoteBuses, bus, 3000).catch(error => {
      client.close();
      throw error;
    });
  }

  await client.joinBus(bus);
  await waitForEvent(client, 'busParticipantReady', 5000).catch(error => {
    console.warn(`[warn] ${error.message}; starting interest anyway`);
  });
  const interest = client.startInterest(bus, query);

  console.log(`[listen] ${options.listen}ms`);
  await wait(options.listen);
  console.log(`[bus] stopping interest id=${interest.id}`);
  client.stopInterest(bus, interest.id);
  await wait(500);
  console.log(`[bus] leaving bus=${bus}`);
  client.leaveBus(bus);
  await wait(500);
  client.close();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
