import { EtherDiscoveryScanner, TcpDiscoveryHubScanner } from './discovery.js';

// One passive scanner serves all pending sessions. No per-interest scans or
// settling windows: a matching beam immediately releases its waiters.
export class LiveDiscovery {
  constructor(options, onTarget, onWarning, makeScanner) {
    if (options.tcpHub) {
      const split = options.tcpHub.lastIndexOf(':');
      const port = Number(options.tcpHub.slice(split + 1));
      if (split <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('invalid SEN tcp hub, expected host:port');
      }
    }
    this.options = options;
    this.onTarget = onTarget;
    this.onWarning = onWarning;
    this.makeScanner = makeScanner ?? (() => {
      if (!options.tcpHub) return new EtherDiscoveryScanner(options);
      const split = options.tcpHub.lastIndexOf(':');
      return new TcpDiscoveryHubScanner({
        host: options.tcpHub.slice(0, split), port: Number(options.tcpHub.slice(split + 1))
      });
    });
    this.targets = new Map();
    this.waiters = new Set();
    this.closed = false;
  }

  async start(recovering = false) {
    if (this.closed) throw new Error('SEN discovery closed');
    const scanner = this.makeScanner();
    this.scanner = scanner;
    scanner.on('beam', target => {
      if (this.closed || this.scanner !== scanner) return;
      if (this.options.app && !String(target.process?.appName || '').toLowerCase()
        .includes(String(this.options.app).toLowerCase())) return;
      this.targets.set(target.key, target);
      this.onTarget(target);
      for (const waiter of [...this.waiters]) {
        if (target.session?.name === waiter.session) waiter.finish(null, target);
      }
    });
    scanner.on('error', error => this.onWarning(error));
    scanner.on('close', () => {
      if (this.scanner !== scanner || this.closed) return;
      this.targets.clear();
      if (this.started) this.scheduleRestart();
    });
    let startTimer;
    try {
      await Promise.race([
        scanner.start(),
        new Promise((_, reject) => { this.cancelStart = reject; }),
        new Promise((_, reject) => {
          startTimer = setTimeout(() => reject(new Error('SEN discovery scanner connection timeout')),
            this.options.timeout ?? 3000);
        })
      ]);
      if (this.closed) throw new Error('SEN discovery closed');
      this.started = true;
    } catch (error) {
      await scanner.stop().catch(() => {});
      if (!recovering || this.closed) throw error;
      this.onWarning(error);
      this.scheduleRestart();
    } finally {
      clearTimeout(startTimer);
      this.cancelStart = undefined;
    }
    if (this.closed) await scanner.stop().catch(() => {});
  }

  scheduleRestart() {
    if (this.closed || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start(true).catch(error => {
        if (!this.closed) this.onWarning(error);
      });
    }, this.options.reconnectDelayMs ?? 500);
    this.restartTimer.unref?.();
  }

  waitFor(session, timeout) {
    if (this.closed) return Promise.reject(new Error('SEN discovery closed'));
    const now = Date.now();
    const target = [...this.targets.values()].find(value => value.session?.name === session
      && now - value.lastSeen <= Math.max(1000, (value.beamPeriodMs || 1000) * 3));
    if (target) return Promise.resolve(target);
    return new Promise((resolve, reject) => {
      const waiter = { session, finish: (error, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        if (error) reject(error); else resolve(value);
      } };
      const timer = timeout > 0
        ? setTimeout(() => waiter.finish(new Error(`timeout discovering SEN session "${session}"`)), timeout)
        : undefined;
      this.waiters.add(waiter);
    });
  }

  async close() {
    this.closed = true;
    this.cancelStart?.(new Error('SEN discovery closed'));
    clearTimeout(this.restartTimer);
    for (const waiter of [...this.waiters]) waiter.finish(new Error('SEN discovery closed'));
    this.targets.clear();
    await this.scanner?.stop().catch(() => {});
  }
}
