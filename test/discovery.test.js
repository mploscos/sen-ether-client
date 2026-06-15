import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { encodeSessionPresenceBeam } from '../lib/codec.js';
import { EtherDiscoveryScanner } from '../lib/discovery.js';

function makeBeam() {
  return encodeSessionPresenceBeam({
    protocolVersion: 2,
    info: {
      hostId: 11,
      processId: 22,
      sessionId: 33,
      sessionName: 'test-session',
      appName: 'test-app',
      hostName: 'test-host',
      osKind: 'linuxOs',
      osName: 'Linux',
      cpuArch: 'x64'
    },
    beamPeriodNs: 1_000_000_000n,
    endpoints: [{ host: '127.0.0.1', port: 54321 }]
  });
}

test(
  'EtherDiscoveryScanner receives presence beam datagrams',
  { skip: 'manual UDP socket test; use sen-ether-scan against a running SEN instance' },
  async () => {
  const group = '239.255.0.44';
  const port = 46043;
  const scanner = new EtherDiscoveryScanner({ group, port });

  await scanner.start();

  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for beam')), 1000);
    scanner.once('process', process => {
      clearTimeout(timeout);
      resolve(process);
    });
  });

  const sender = dgram.createSocket('udp4');
  try {
    await new Promise(resolve => sender.bind(0, resolve));
    sender.setMulticastTTL(1);
    await new Promise((resolve, reject) => {
      sender.send(makeBeam(), port, '127.0.0.1', error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const process = await received;
    assert.equal(process.session.name, 'test-session');
    assert.equal(process.process.appName, 'test-app');
    assert.equal(process.endpoints[0].host, '127.0.0.1');
  } finally {
    sender.close();
    await scanner.stop();
  }
  }
);

test('EtherDiscoveryScanner reads multicast port from SEN environment', () => {
  const previousPort = process.env.SEN_ETHER_DISCOVERY_PORT;

  try {
    process.env.SEN_ETHER_DISCOVERY_PORT = '46043';

    const scanner = new EtherDiscoveryScanner();

    assert.equal(scanner.port, 46043);
    assert.equal(new EtherDiscoveryScanner({ port: 46044 }).port, 46044);
  } finally {
    if (previousPort === undefined) {
      delete process.env.SEN_ETHER_DISCOVERY_PORT;
    } else {
      process.env.SEN_ETHER_DISCOVERY_PORT = previousPort;
    }
  }
});
