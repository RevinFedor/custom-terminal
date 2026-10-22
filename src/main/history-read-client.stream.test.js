'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { HistoryReadClient } = require('./history-read-client');
const { HistoryByteSender } = require('./history-byte-stream');
const { encodeHistoryStream } = require('./history-stream-codec');
const { createReadControl, isHistoryReadCancelled } = require('./history-read-control');
const tick = () => new Promise(resolve => setImmediate(resolve));

class StreamProcess extends EventEmitter {
  constructor() { super(); this.messages = []; this.senders = new Map(); this.pumps = []; this.open = true; this.generation = 'first'; }
  postMessage(message) {
    this.messages.push(message);
    if (message.event === 'stream-credit') this.senders.get(message.id)?.sender.credit(message);
    if (message.event === 'cancel') this.senders.get(message.id)?.controller.abort();
  }
  startReply(request, value, { readProof = [], metadata = { success: true } } = {}) {
    const controller = new AbortController(), control = createReadControl({ signal: controller.signal });
    const sender = new HistoryByteSender({ id: request.id, control, ...request.stream,
      send: value => queueMicrotask(() => this.emit('message', value)) });
    this.senders.set(request.id, { sender, controller });
    const promise = sender.pump(encodeHistoryStream(value, { frameBytes: request.stream.frameBytes, control }), metadata, readProof);
    promise.catch(() => {}); this.pumps.push(promise); return promise;
  }
  ref() {} unref() {}
  async terminate() { if (this.open) { this.open = false; for (const item of this.senders.values()) item.controller.abort(); this.emit('exit', 0); } }
}
function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const children = [];
  const client = new HistoryReadClient({ createTransport: () => { const child = new StreamProcess(); children.push(child); return child; } });
  t.after(async () => { await client.close(); await Promise.allSettled(children.flatMap(child => child.pumps)); });
  return { client, children, get child() { return children.at(-1); } };
}
const options = { frameBytes: 1024, credits: 2 };

test('actual client stream delivers exact bytes with bounded queue and pending lifecycle through final consumer ACK', async t => {
  const f = fixture(t), input = { success: true, entries: [{ uuid: 'one', content: 'x'.repeat(16 * 1024) }] };
  const opening = f.client.openStream('getHistory', { toolType: 'codex', sessionId: 'private' }, options);
  const rpc = f.child.messages.find(message => message.method);
  const producer = f.child.startReply(rpc, input);
  const stream = await opening; assert.equal(stream.metadata.success, true); assert.equal(f.client.pending.size, 1);
  const hash = createHash('sha256');
  for await (const frame of stream) { hash.update(frame); assert.ok(frame.byteLength <= 1024); }
  await producer;
  assert.equal(hash.digest('hex'), createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  assert.equal(f.client.pending.size, 0); assert.ok(stream.stats.maxOutstandingBytes <= 2048);
  assert.equal(f.child.messages.filter(message => message.method).length, 1);
});

test('already aborted actual stream caller cannot spawn a process or post an RPC', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.openStream('getHistory', {}, { ...options, signal: controller.signal }), isHistoryReadCancelled);
  assert.equal(f.children.length, 0); assert.equal(f.client.pending.size, 0);
});

test('actual stream cancellation while paused releases that request without starting a replacement', async t => {
  const f = fixture(t), controller = new AbortController();
  const opening = f.client.openStream('getHistory', {}, { ...options, signal: controller.signal });
  const rpc = f.child.messages.find(message => message.method);
  const producer = f.child.startReply(rpc, { content: 'x'.repeat(256 * 1024) });
  const failed = assert.rejects(producer, isHistoryReadCancelled), stream = await opening;
  await stream.next(); await tick(); controller.abort();
  await assert.rejects(stream.next(), isHistoryReadCancelled); await failed;
  assert.equal(f.client.pending.size, 0); assert.equal(f.children.length, 1);
  assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
});

test('Main synchronous source invalidation rejects already queued frames from the old proof', async t => {
  const f = fixture(t), filePath = '/private/own-synthetic-source.jsonl';
  const opening = f.client.openStream('getHistory', { sessionId: 'private' }, options);
  const rpc = f.child.messages.find(message => message.method);
  const producer = f.child.startReply(rpc, { content: 'x'.repeat(16 * 1024) }, { readProof: [{ filePath, slot: 0, epoch: 0 }] });
  const producerCancelled = assert.rejects(producer, isHistoryReadCancelled);
  const stream = await opening; await stream.next(); await tick();
  f.client.invalidate({ filePath });
  await assert.rejects(stream.next(), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); await producerCancelled;
  assert.equal(f.client.pending.size, 0); assert.equal(f.children.length, 1);
});

test('stream unknown transport is terminal, boot fence survives until exit, explicit next read alone starts boot2', async t => {
  const f = fixture(t), opening = f.client.openStream('getHistory', {}, options);
  const rpc = f.child.messages.find(message => message.method), firstChild = f.child;
  const producer = firstChild.startReply(rpc, { content: 'x'.repeat(16 * 1024) });
  const cancelled = assert.rejects(producer, isHistoryReadCancelled);
  const stream = await opening; await stream.next();
  const unknown = Object.assign(new Error('synthetic disconnect'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  firstChild.emit('error', unknown);
  await assert.rejects(stream.next(), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  await assert.rejects(f.client.openStream('getHistory', {}, options), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  assert.equal(f.children.length, 1); assert.equal(f.client.getReadDiagnosticHealth().processState, 'unknown');
  await firstChild.terminate(); await cancelled;
  const nextOpen = f.client.openStream('getHistory', {}, options);
  assert.equal(f.children.length, 2);
  const secondRpc = f.child.messages.find(message => message.method), nextProducer = f.child.startReply(secondRpc, { exact: 'boot2' });
  const next = await nextOpen;
  for await (const frame of next) assert.ok(frame.byteLength > 0);
  await nextProducer;
  assert.equal(f.client.workerGeneration, 2); assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
});

test('missing stream readProof cannot publish metadata or send first credit', async t => {
  const f = fixture(t), opening = f.client.openStream('getHistory', {}, options);
  const rpc = f.child.messages.find(message => message.method);
  f.child.emit('message', { event: 'stream-open', id: rpc.id, streamToken: 'bad-proof', limits: rpc.stream, metadata: { success: true } });
  await assert.rejects(opening, /history_worker_read_proof_missing/);
  assert.ok(!f.child.messages.some(message => message.event === 'stream-credit'));
  assert.equal(f.client.pending.size, 0);
});

test('external control finish after stream-open cancels before any row bytes are produced', async t => {
  const f = fixture(t), control = createReadControl();
  const opening = f.client.openStream('getHistory', {}, { ...options, control });
  const rpc = f.child.messages.find(message => message.method), producer = f.child.startReply(rpc, { value: 'all' });
  const cancelled = assert.rejects(producer, isHistoryReadCancelled), stream = await opening;
  control.finish();
  await assert.rejects(stream.next(), isHistoryReadCancelled); await cancelled;
  assert.equal(f.child.senders.get(rpc.id).sender.sentBytes, 0); assert.equal(f.client.pending.size, 0);
});

test('actual Main client keeps pending cancellation alive while the final consumed credit is lost', async t => {
  const f = fixture(t), control = createReadControl();
  const opening = f.client.openStream('getHistory', {}, { ...options, control });
  const rpc = f.child.messages.find(message => message.method), post = f.child.postMessage.bind(f.child);
  f.child.postMessage = message => {
    if (message.event === 'stream-credit' && message.consumedBytes > 0) f.child.messages.push(message);
    else post(message);
  };
  const producer = f.child.startReply(rpc, { content: 'one bounded frame' });
  const cancelled = assert.rejects(producer, isHistoryReadCancelled), stream = await opening;
  assert.equal((await stream.next()).done, false);
  const lastPull = stream.next(), revoked = assert.rejects(lastPull, isHistoryReadCancelled);
  await tick(); await tick();
  assert.equal(f.client.pending.size, 1, 'last credit has not reached child; Main must retain its live demand');
  assert.equal(stream.settled, false);
  control.finish(); await cancelled; await revoked;
  assert.equal(f.client.pending.size, 0); assert.equal(f.children.length, 1);
  assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
});
