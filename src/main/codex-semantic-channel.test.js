'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCodexSemanticChannelServer,
  defaultSocketRoot,
  validateEnvelope,
} = require('./codex-semantic-channel');

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('wait timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('validateEnvelope rejects unversioned and malformed payloads', () => {
  assert.equal(validateEnvelope({}), null);
  assert.equal(validateEnvelope({ v: 2, instanceId: 'i', seq: 0, event: { type: 'hello' } }), null);
  assert.deepEqual(
    validateEnvelope({
      v: 1,
      instanceId: 'i',
      pid: 42,
      seq: 1,
      droppedBefore: true,
      event: { type: 'assistant_delta', delta: 'hi' },
    }),
    {
      v: 1,
      instanceId: 'i',
      pid: 42,
      seq: 1,
      droppedBefore: true,
      event: { type: 'assistant_delta', delta: 'hi' },
    },
  );
});

test('default macOS socket path leaves room under sockaddr_un limit', () => {
  const socketRoot = defaultSocketRoot('darwin', 12345);
  const fullPath = path.join(socketRoot, 'a'.repeat(20) + '-12345678.sock');
  assert.equal(socketRoot, '/tmp/noted-codex-12345');
  assert.ok(fullPath.length < 104, `socket path is ${fullPath.length} bytes`);
});

test('server frames chunked NDJSON and reports sequence gaps', async (t) => {
  const socketRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-semantic-test-'));
  const events = [];
  const channel = await createCodexSemanticChannelServer({
    tabId: 'tab-a',
    socketRoot,
    onEvent: (event) => events.push(event),
    log: { warn() {} },
  });
  t.after(async () => {
    await channel.close('test');
    await fs.promises.rm(socketRoot, { recursive: true, force: true });
  });
  const socket = await connect(channel.socketPath);
  t.after(() => socket.destroy());
  socket.write('{"v":1,"instanceId":"i","pid":7,"seq":0,"event":{"type":"hello"}}\n');
  socket.write('{"v":1,"instanceId":"i","pid":7,"seq":1,"event":{"type":"assistant_');
  socket.write('delta","delta":"one"}}\n');
  socket.write('{"v":1,"instanceId":"i","pid":7,"seq":3,"event":{"type":"assistant_delta","delta":"three"}}\n');
  await waitFor(() => events.length === 3);
  assert.equal(events[0].event.type, 'hello');
  assert.equal(events[1].event.delta, 'one');
  assert.equal(events[1].gap, false);
  assert.equal(events[2].event.delta, 'three');
  assert.equal(events[2].gap, true);
});

test('closing a superseded socket cannot disconnect the replacement connection', async (t) => {
  const socketRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-semantic-reconnect-'));
  const events = [];
  const channel = await createCodexSemanticChannelServer({
    tabId: 'tab-reconnect',
    socketRoot,
    onEvent: (event) => events.push(event),
    log: { warn() {} },
  });
  t.after(async () => {
    await channel.close('test');
    await fs.promises.rm(socketRoot, { recursive: true, force: true });
  });
  const first = await connect(channel.socketPath);
  first.write('{"v":1,"instanceId":"same","pid":7,"seq":0,"event":{"type":"hello"}}\n');
  await waitFor(() => events.length === 1);
  const second = await connect(channel.socketPath);
  second.write('{"v":1,"instanceId":"same","pid":7,"seq":0,"event":{"type":"hello"}}\n');
  await waitFor(() => events.length === 2);
  first.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((event) => event.event.type === 'disconnect'), false);
  second.destroy();
  await waitFor(() => events.some((event) => event.event.type === 'disconnect'));
});
