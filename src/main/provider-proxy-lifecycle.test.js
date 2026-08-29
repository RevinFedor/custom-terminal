'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const test = require('node:test');

const {
  CODEX_METADATA_HEADER_TIMEOUT_MS,
  CODEX_RESPONSE_HEADER_TIMEOUT_MS,
  codexResponseHeaderTimeoutMs,
  createProviderProxyHttpLifecycle,
  providerProxyAgentLoad,
  startProviderProxyWebSocketHeartbeat,
} = require('./provider-proxy-lifecycle');

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.destroyError = null;
    this.reusedSocket = false;
  }

  destroy(error) {
    this.destroyed = true;
    this.destroyError = error;
  }
}

class FakeResponse extends EventEmitter {
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
    this.destroyed = false;
    this.destroyError = null;
    this.writableEnded = false;
  }

  destroy(error) {
    this.destroyed = true;
    this.destroyError = error;
  }
}

function fakeTimerHarness() {
  let callback = null;
  let cleared = false;
  return {
    setTimer(fn) {
      callback = fn;
      return { unref() {} };
    },
    clearTimer() {
      cleared = true;
    },
    fire() {
      callback?.();
    },
    get cleared() {
      return cleared;
    },
    get scheduled() {
      return callback !== null;
    },
  };
}

test('Codex responses have no proxy header deadline while metadata polls stay bounded', () => {
  assert.equal(codexResponseHeaderTimeoutMs('/backend-api/codex/responses'), CODEX_RESPONSE_HEADER_TIMEOUT_MS);
  assert.equal(CODEX_RESPONSE_HEADER_TIMEOUT_MS, null);
  assert.equal(codexResponseHeaderTimeoutMs('/backend-api/codex/models?client_version=1'), CODEX_METADATA_HEADER_TIMEOUT_MS);
});

test('a model response can wait for provider headers until downstream cancels it', () => {
  const downstreamRequest = new EventEmitter();
  const upstreamRequest = new FakeRequest();
  const timer = fakeTimerHarness();
  const lifecycle = createProviderProxyHttpLifecycle({
    downstreamRequest,
    downstreamResponse: new FakeResponse(),
    upstreamRequest,
    timeoutMs: codexResponseHeaderTimeoutMs('/backend-api/codex/responses'),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  assert.equal(timer.scheduled, false);
  timer.fire();
  assert.equal(lifecycle.getState(), 'waiting-headers');
  assert.equal(upstreamRequest.destroyed, false);

  downstreamRequest.emit('aborted');
  assert.equal(lifecycle.getState(), 'terminated');
  assert.equal(upstreamRequest.destroyError.code, 'ECLIENTABORT');
});

test('agent load counts active, free and queued sockets independently', () => {
  assert.deepEqual(providerProxyAgentLoad({
    sockets: { a: [{}, {}], b: [{}] },
    freeSockets: { a: [{}] },
    requests: { a: [{}, {}, {}, {}] },
  }), { active: 3, free: 1, queued: 4 });
});

test('downstream abort destroys its upstream request and releases the slot', () => {
  const downstreamRequest = new EventEmitter();
  const downstreamResponse = new FakeResponse();
  const upstreamRequest = new FakeRequest();
  const timer = fakeTimerHarness();
  const events = [];
  const lifecycle = createProviderProxyHttpLifecycle({
    downstreamRequest,
    downstreamResponse,
    upstreamRequest,
    requestId: 'req-1',
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    onEvent: (event) => events.push(event),
  });

  downstreamRequest.emit('aborted');

  assert.equal(lifecycle.getState(), 'terminated');
  assert.equal(upstreamRequest.destroyed, true);
  assert.equal(upstreamRequest.destroyError.code, 'ECLIENTABORT');
  assert.equal(events.at(-1).reason, 'downstream-request-aborted');
});

test('absolute header timeout destroys a request even before it gets a socket', () => {
  const upstreamRequest = new FakeRequest();
  const timer = fakeTimerHarness();
  const lifecycle = createProviderProxyHttpLifecycle({
    downstreamRequest: new EventEmitter(),
    downstreamResponse: new FakeResponse(),
    upstreamRequest,
    timeoutMs: 20,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  timer.fire();

  assert.equal(lifecycle.getState(), 'terminated');
  assert.equal(upstreamRequest.destroyError.code, 'ETIMEDOUT');
  assert.equal(upstreamRequest.destroyError.providerProxyReason, 'upstream-response-header-timeout');
});

test('receiving headers clears the deadline and permits a long stream', () => {
  const upstreamRequest = new FakeRequest();
  const downstreamResponse = new FakeResponse();
  const upstreamResponse = new FakeResponse(200);
  const timer = fakeTimerHarness();
  const lifecycle = createProviderProxyHttpLifecycle({
    downstreamRequest: new EventEmitter(),
    downstreamResponse,
    upstreamRequest,
    timeoutMs: 20,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  assert.equal(lifecycle.attachUpstreamResponse(upstreamResponse), true);
  timer.fire();
  assert.equal(lifecycle.getState(), 'streaming');
  assert.equal(upstreamRequest.destroyed, false);
  assert.equal(timer.cleared, true);

  upstreamResponse.emit('end');
  assert.equal(lifecycle.getState(), 'completed');
});

test('premature upstream response close destroys both upstream objects', () => {
  const upstreamRequest = new FakeRequest();
  const upstreamResponse = new FakeResponse(200);
  const lifecycle = createProviderProxyHttpLifecycle({
    downstreamRequest: new EventEmitter(),
    downstreamResponse: new FakeResponse(),
    upstreamRequest,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  lifecycle.attachUpstreamResponse(upstreamResponse);

  upstreamResponse.emit('close');

  assert.equal(lifecycle.getState(), 'terminated');
  assert.equal(upstreamResponse.destroyed, true);
  assert.equal(upstreamRequest.destroyed, true);
});

test('a real shared Agent can serve the next request after the downstream aborts a hung one', { timeout: 3000 }, async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') return;
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => {
    agent.destroy();
    server.close();
  });

  const downstreamRequest = new EventEmitter();
  const first = http.request({ host: '127.0.0.1', port, path: '/hang', agent });
  first.on('error', () => {});
  const firstSocket = once(first, 'socket');
  createProviderProxyHttpLifecycle({
    downstreamRequest,
    downstreamResponse: new FakeResponse(),
    upstreamRequest: first,
    agent,
    timeoutMs: 1000,
  });
  first.end();
  await firstSocket;

  downstreamRequest.emit('aborted');
  await new Promise((resolve) => setImmediate(resolve));

  const body = await new Promise((resolve, reject) => {
    const second = http.get({ host: '127.0.0.1', port, path: '/ok', agent }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(text));
    });
    second.on('error', reject);
  });

  assert.equal(body, 'ok');
  assert.equal(providerProxyAgentLoad(agent).queued, 0);
});

test('header deadlines on active and queued requests recover a saturated real Agent', { timeout: 3000 }, async (t) => {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => {
    agent.destroy();
    server.close();
  });

  const first = http.request({ host: '127.0.0.1', port, path: '/hold-slot', agent });
  first.on('error', () => {});
  const firstSocket = once(first, 'socket');
  createProviderProxyHttpLifecycle({
    downstreamRequest: new EventEmitter(),
    downstreamResponse: new FakeResponse(),
    upstreamRequest: first,
    agent,
    timeoutMs: 20,
  });
  first.end();
  await firstSocket;

  const second = http.request({ host: '127.0.0.1', port, path: '/queued', agent });
  let secondError = null;
  second.once('error', (error) => { secondError = error; });
  createProviderProxyHttpLifecycle({
    downstreamRequest: new EventEmitter(),
    downstreamResponse: new FakeResponse(),
    upstreamRequest: second,
    agent,
    timeoutMs: 20,
  });
  second.end();
  assert.equal(providerProxyAgentLoad(agent).queued, 1);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(second.destroyed, true);
  assert.equal(providerProxyAgentLoad(agent).active, 0);
  assert.equal(providerProxyAgentLoad(agent).queued, 0);
  if (secondError) assert.equal(secondError.code, 'ETIMEDOUT');
});

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.pings = 0;
    this.terminated = false;
  }

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

test('WebSocket heartbeat terminates a silent upstream on the next tick', () => {
  const upstream = new FakeWebSocket();
  let tick = null;
  let timeoutCount = 0;
  startProviderProxyWebSocketHeartbeat({
    upstream,
    setIntervalFn(fn) {
      tick = fn;
      return { unref() {} };
    },
    clearIntervalFn() {},
    onTimeout() {
      timeoutCount += 1;
    },
  });

  tick();
  assert.equal(upstream.pings, 1);
  assert.equal(upstream.terminated, false);
  tick();
  assert.equal(upstream.terminated, true);
  assert.equal(timeoutCount, 1);
});

test('WebSocket pong keeps the upstream alive across heartbeat ticks', () => {
  const upstream = new FakeWebSocket();
  let tick = null;
  const heartbeat = startProviderProxyWebSocketHeartbeat({
    upstream,
    setIntervalFn(fn) {
      tick = fn;
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  tick();
  upstream.emit('pong');
  tick();
  assert.equal(upstream.pings, 2);
  assert.equal(upstream.terminated, false);
  heartbeat.stop('test-complete');
});
