'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const sourcePath = process.env.NOTED_PROXY_MAIN_SOURCE || path.join(__dirname, 'main.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const first = source.indexOf('function rejectProviderProxyUpgrade(');
const last = source.indexOf('async function proxyGracefulShutdown()', first);
assert.ok(first >= 0 && last > first);
const actualUpgradeSource = source.slice(first, last);

function install({ server = new EventEmitter(), supported = true, auth = null, webSocketServer } = {}) {
  const upstreams = [];
  const logs = [];
  let accepted = 0;
  class Upstream extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { super(); this.readyState = 0; this.terminations = 0; upstreams.push(this); }
    terminate() {
      if (this.readyState === 3) return;
      this.terminations++;
      this.readyState = 3;
      this.emit('close', 1006, Buffer.alloc(0));
    }
    close() { this.terminate(); }
    send() {}
  }
  const activeConnections = new Set();
  const activeWebSockets = new Set();
  const acceptedClients = [];
  const realHandleUpgrade = webSocketServer?.handleUpgrade.bind(webSocketServer);
  const context = {
    Buffer,
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    providerProxy: server,
    parseProviderProxyRoute: () => ({ provider: supported ? 'codex' : 'other', tabId: 'owned-probe', forwardUrl: '/responses' }),
    codexAuthProfileRoute: auth,
    providerProxyWebSocketSeq: 0,
    proxyActiveConnections: activeConnections,
    proxyActiveWebSockets: activeWebSockets,
    resolveCodexUpstream: () => ({ hostname: 'never-contacted.invalid', path: '/responses' }),
    forwardProviderProxyHeaders: () => ({}),
    codexAgent: null,
    ProviderProxyWebSocket: Upstream,
    safelyObserveProviderSemantic: () => null,
    providerProxyWebSocketServer: {
      handleUpgrade(req, socket, head, callback) {
        assert.ok(realHandleUpgrade, 'this test must not accept a fake WebSocket');
        realHandleUpgrade(req, socket, head, client => {
          accepted++;
          acceptedClients.push(client);
          callback(client);
        });
      },
    },
    startProviderProxyWebSocketHeartbeat: () => ({ stop() {} }),
  };
  vm.runInNewContext(actualUpgradeSource, context, { filename: sourcePath });
  return { server, upstreams, logs, activeConnections, activeWebSockets, acceptedClients,
    get accepted() { return accepted; } };
}

class ControlledSocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.replies = []; }
  write(data) { this.replies.push(data); }
  destroy() { this.destroyed = true; }
  closeEvent() { this.emit('close'); }
}
const request = () => ({ url: '/codex/t/owned-probe/responses', headers: {} });
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

async function tcpChild(mode) {
  const { WebSocketServer } = require('ws');
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const h = install({ server, webSocketServer: wss });
  let client;
  let raw;
  let completion = false;
  let beforeListenerCount;
  let temporaryAfterHandoff = null;
  const deadline = setTimeout(() => {
    console.error('private TCP control deadline');
    process.exit(2);
  }, 4000);
  server.on('upgrade', (_req, socket) => {
    raw = socket;
    beforeListenerCount = socket.listenerCount('error');
    socket.once('close', () => setImmediate(() => {
      assert.equal(h.accepted, mode === 'accepted' ? 1 : 0);
      assert.equal(h.upstreams.length, 1);
      assert.equal(h.upstreams[0].terminations, 1);
      assert.equal(h.activeConnections.size, 0);
      assert.equal(h.activeWebSockets.size, 0);
      assert.equal(raw.listeners('error').some(fn => fn.name === 'onPendingSocketError'), false);
      if (mode === 'accepted') assert.equal(temporaryAfterHandoff, false);
      completion = true;
      wss.close();
      server.close(() => {
        clearTimeout(deadline);
        console.log(JSON.stringify({ mode, accepted: h.accepted, upstreamTerminations: 1,
          beforeListenerCount, temporaryAfterHandoff, closed: true, runtime: process.version }));
      });
    }));
    if (mode === 'accepted') {
      setImmediate(() => {
        h.upstreams[0].readyState = 1;
        h.upstreams[0].emit('open');
        temporaryAfterHandoff = socket.listeners('error').some(fn => fn.name === 'onPendingSocketError');
      });
    } else setImmediate(() => client.resetAndDestroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  client = net.connect(server.address().port, '127.0.0.1');
  client.on('error', () => {});
  client.once('connect', () => client.write('GET /codex/t/owned-probe/responses HTTP/1.1\r\n'
    + 'Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
    + 'Sec-WebSocket-Key: eHl6eHl6eHl6eHl6eHl6eA==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  if (mode === 'accepted') client.once('data', data => {
    assert.match(data.toString(), /^HTTP\/1\.1 101/);
    client.resetAndDestroy();
  });
  process.once('exit', () => { if (!completion) process.exitCode = 1; });
}

if (process.argv[2] === '--tcp-child') {
  // The real TCP child intentionally has no uncaughtException/error suppressor.
  // Missing raw socket ownership must fail exactly as in normal Node/Electron.
  tcpChild(process.argv[3]).catch(error => { console.error(error); process.exit(1); });
} else {
  const test = require('node:test');
  for (const mode of ['pending', 'accepted']) {
    test(`actual Main upgrade: real TCP reset while ${mode} stays inside the connection`, () => {
      const result = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--tcp-child', mode], {
        env: process.env, encoding: 'utf8', timeout: 7000, maxBuffer: 64 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const evidence = JSON.parse(result.stdout.trim());
      assert.equal(evidence.closed, true);
      assert.equal(evidence.upstreamTerminations, 1);
    });
  }
  test('pending error preserves the close owner and cannot admit a late upstream open', () => {
    const h = install(); const socket = new ControlledSocket();
    h.server.emit('upgrade', request(), socket, Buffer.alloc(0));
    assert.doesNotThrow(() => socket.emit('error', reset()));
    assert.equal(socket.destroyed, true);
    socket.closeEvent();
    h.upstreams[0].emit('open');
    assert.equal(h.accepted, 0);
    assert.equal(h.upstreams[0].terminations, 1);
    assert.equal(h.activeConnections.size, 0);
    assert.equal(h.activeWebSockets.size, 0);
    assert.equal(socket.listenerCount('error'), 0);
    assert.ok(h.logs.some(s => s.includes('event=downstream-error-before-upgrade') && s.includes('code=ECONNRESET')));
  });
  for (const mode of ['route', 'auth']) {
    test(`early ${mode} rejection covers a socket error before close without an upstream`, () => {
      const h = install({ supported: mode !== 'route', auth: mode === 'auth' ? {
        authorizeRequest() { throw Object.assign(new Error('refused'), { code: 'profile_changed', statusCode: 409 }); },
      } : null });
      const socket = new ControlledSocket();
      h.server.emit('upgrade', request(), socket, Buffer.alloc(0));
      assert.match(socket.replies.join(''), mode === 'route' ? /^HTTP\/1\.1 404/ : /^HTTP\/1\.1 409/);
      assert.doesNotThrow(() => socket.emit('error', reset()));
      socket.closeEvent();
      assert.equal(h.upstreams.length, 0);
      assert.equal(h.accepted, 0);
      assert.equal(socket.listenerCount('error'), 0);
    });
  }
}
