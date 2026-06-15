#!/usr/bin/env node
import { scan, scanTcpDiscoveryHub } from '../lib/discovery.js';

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--timeout') {
      options.timeout = Number(argv[++i]);
    } else if (arg === '--group') {
      options.group = argv[++i];
    } else if (arg === '--port') {
      options.port = Number(argv[++i]);
    } else if (arg === '--interface') {
      options.interfaceAddress = argv[++i];
    } else if (arg === '--bind') {
      options.bindAddress = argv[++i];
    } else if (arg === '--tcp-hub') {
      options.tcpHub = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: sen-ether-scan [options]

Options:
  --timeout <ms>      Scan duration. Default: 3000
  --group <address>   Discovery multicast group. Default: 239.255.0.44
  --port <port>       Discovery multicast port. Default: 60543
  --interface <addr>  Local interface address or interface name for multicast membership
  --bind <addr>       Local bind address. Default: multicast group on POSIX
  --tcp-hub <host:port>
                      Use SEN TcpDiscoveryHub instead of multicast discovery
  -h, --help          Show this help

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

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const processes = options.tcpHub
    ? await scanTcpDiscoveryHub({ ...parseHostPort(options.tcpHub), timeout: options.timeout })
    : await scan(options);
  console.log(JSON.stringify(processes, null, 2));
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
