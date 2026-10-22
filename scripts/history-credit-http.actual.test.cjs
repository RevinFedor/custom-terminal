'use strict';

// Actual Web route, exact worker projection block, actual byte-credit codec,
// sender/receiver and HTTP envelope. Process IPC is a microtask link, the
// source result is finite synthetic data, and Writable substitutes the socket.
// No Electron, provider, app startup, SQLite, native client or installed claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createReadControl, currentReadControl, isHistoryReadCancelled } = require('../src/main/history-read-control');
const { runHttpHistoryRead, assertHttpHistoryCurrent, rethrowHistoryTerminal } = require('../src/main/history-http-consumer');
const { sendHistoryJson, sendHistoryNdjson } = require('../src/main/history-json-stream');
const { sendHistoryEntriesStream } = require('../src/main/history-credit-http');
const { HistoryByteSender, HistoryByteReceiver } = require('../src/main/history-byte-stream');
const { encodeHistoryStream, streamLimits } = require('../src/main/history-stream-codec');
const { HistoryReadClient } = require('../src/main/history-read-client');

const tick = () => new Promise(resolve => setImmediate(resolve));
function barrier() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function source(name) { return fs.readFileSync(path.join(__dirname, '../src/main', name), 'utf8'); }
function exactSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker), end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'actual source delimiters exist: ' + startMarker);
  return text.slice(start, end);
}
function request(target = '/api/terminal-tabs/A/history?view=history') {
  return Object.assign(new EventEmitter(), { url: target, method: 'GET', headers: {}, aborted: false });
}
class Response extends Writable {
  constructor(req, options = {}) {
    super({ highWaterMark: options.highWaterMark || 1024 });
    this.req = req; this.parts = []; this.maxQueued = 0; this.writeCount = 0;
    this.gate = options.gate; this.started = options.started; this.onChunk = options.onChunk;
  }
  writeHead(status, headers) {
    assert.equal(this.headersSent, undefined, 'one HTTP header block');
    this.statusCode = status; this.headers = headers; this.headersSent = true;
  }
  _write(chunk, _encoding, done) {
    this.writeCount++; this.maxQueued = Math.max(this.maxQueued, this.writableLength);
    this.parts.push(Buffer.from(chunk)); this.started?.resolve(); this.onChunk?.(chunk, this);
    if (this.gate) this.gate.promise.then(() => done()); else done();
  }
  body() { return Buffer.concat(this.parts); }
}

// Bootstrap only the real pure window block. Presentation helpers unrelated to
// this route are not mocked as business logic; they are outside this fixture.
const windowContext = vm.createContext({
  historyEntryHasExactIdentity: require('../src/shared/history-entry-identity.cjs').historyEntryHasExactIdentity,
});
vm.runInContext(exactSlice(source('history-entry-window.js'), 'function normalizePositiveInt(',
  '/**\n * Row-level windowing:'), windowContext);
const applyHistoryEntryWindow = windowContext.applyHistoryEntryWindow;
const payloadContext = vm.createContext({});
vm.runInContext(exactSlice(source('history-payload-dehydrate.js'), "const HISTORY_PAYLOAD_ON_DEMAND =",
  'const formatHiddenSuffix ='), payloadContext);
vm.runInContext(exactSlice(source('public-history-read.js'), 'const historyPayloadCapability =',
  'const MAX_EVENT_TABS ='), payloadContext);
const historyPayloadCapability = vm.runInContext('historyPayloadCapability', payloadContext);
const historyPayloadQuery = payloadContext.historyPayloadQuery;
const headerVersion = vm.runInContext('HISTORY_PAYLOAD_HEADER_VERSION', payloadContext);

const projectionContext = vm.createContext({ crypto, applyHistoryEntryWindow, streamLimits,
  HISTORY_PAYLOAD_HEADER_VERSION: headerVersion });
const projectActual = vm.runInContext('(async ({result,streamOptions,message,payload,control}) => {'
  + exactSlice(source('history-read-worker.js'), '      const limits = streamLimits(message.stream);',
    '      control.assertCurrent(); processEpochs.refresh(); assertContextSource(context);')
  + ' return {value,metadata}; })', projectionContext);

const serviceSource = source('session-transcript-service.js');
const serviceContext = vm.createContext({});
vm.runInContext(exactSlice(serviceSource, 'function historyWirePayload(', '\nfunction decoratePromptSnapshot(')
  + exactSlice(serviceSource, 'function normalizeToolType(', '\nfunction transcriptKey('), serviceContext);
const ActualStreamService = vm.runInContext('(class { '
  + exactSlice(serviceSource, '  async openHistoryStream(', '\n  async getHistory(') + ' })', serviceContext);

async function linkedStream(result, payload, options, fixture = {}) {
  const control = currentReadControl() || createReadControl();
  const limits = streamLimits({ frameBytes: fixture.frameBytes || 1024, credits: 2 });
  const projection = await projectActual({ result, streamOptions: fixture.streamOptions,
    message: { stream: { ...options, ...limits } }, payload, control });
  let sender; const stats = fixture.stats || {};
  const receiver = new HistoryByteReceiver({ id: 1, ...limits, stats: stats.receiver = {},
    assertCurrent: () => control.assertCurrent(),
    send(message) { queueMicrotask(() => {
      if (message.event === 'stream-credit') sender.credit(message);
      else if (message.event === 'cancel') sender.cancel(Object.assign(new Error('fixture consumer closed'),
        { code: 'HISTORY_READ_CONSUMER_REVOKED' }));
    }); },
  });
  receiver.assertCurrent = () => control.assertCurrent();
  sender = new HistoryByteSender({ id: 1, ...limits, control, stats: stats.sender = {},
    send(message) { queueMicrotask(() => receiver.accept(message)); } });
  async function* rows() {
    let emitted = 0;
    for await (const frame of encodeHistoryStream(projection.value, { ...limits, control })) {
      if (fixture.failAfter != null && emitted++ >= fixture.failAfter) {
        throw Object.assign(new Error('synthetic partial stream'), { code: fixture.failCode || 'HISTORY_READER_TRANSPORT_UNKNOWN' });
      }
      yield frame;
    }
  }
  stats.closed = 0;
  const close = receiver.close.bind(receiver);
  receiver.close = () => { stats.closed++; close(); };
  const pump = sender.pump(rows(), projection.metadata, []);
  pump.catch(error => { stats.terminalError = error.code; });
  stats.pump = pump;
  await receiver.ready;
  return receiver;
}

function actualRoute({ result, readInfo, open, legacy = false, fixture = {}, freshness } = {}) {
  const web = source('web-server.js');
  const branch = exactSlice(web, '  // Load JSONL session history.', "  return sendJson(res, 404, { error: 'not found' });");
  const owner = exactSlice(web, 'function finishConversationOwnerRead(', '\nfunction registerBridgeReplyHandler(');
  const info = { toolType: 'codex', sessionId: 'synthetic', cwd: '/synthetic',
    writerSessionId: null, writerConfirmed: false };
  const calls = []; let identityChecks = 0;
  const service = {
    getHistory: async payload => { calls.push(['history', payload]); return result?.(payload); },
    getMessages: async payload => { calls.push(['messages', payload]); throw new Error('unexpected messages'); },
    getToolPayload: async payload => { calls.push(['payload', payload]); throw new Error('unexpected payload'); },
  };
  if (!legacy) service.openHistoryStream = async (payload, options) => {
    calls.push(['stream', payload, options]);
    return open ? open(payload, options) : linkedStream(await result(payload), payload, options, fixture);
  };
  const scope = vm.createContext({ console: { log() {}, warn() {}, error() {} }, crypto,
    sendJson: sendHistoryJson, sendHistoryNdjson, sendHistoryEntriesStream,
    decId: decodeURIComponent, applyHistoryEntryWindow,
    beginHttpReadDependency: () => () => {}, historyPayloadCapability, historyPayloadQuery,
    conversationOwners: null, publicHistoryFreshness: freshness ? {} : null,
    readHistoryFreshnessWindow: async payload => { calls.push(['freshness', payload]); return freshness(payload); },
    publicHistoryRevisions: { lookup: token => token == null ? null : { token }, remember: () => 'a'.repeat(64) },
    transcriptService: service,
    resolveHistorySessionInfo: async () => { identityChecks++; return readInfo ? readInfo(identityChecks, info) : info; },
    resolveAgentSessionInfo: async () => info,
    publishTabTiming() {}, currentReadControl, assertHttpHistoryCurrent, rethrowHistoryTerminal,
    bridgeRequest: async action => { calls.push(['fallback', action]); throw new Error('unexpected compatibility fallback'); },
  });
  vm.runInContext(owner, scope);
  const handler = vm.runInContext('(async (req,res,parsed) => { let m; ' + branch + '})', scope);
  return { calls, get identityChecks() { return identityChecks; }, read(req, res = new Response(req)) {
    return { res, promise: runHttpHistoryRead(req, res, () => handler(req, res, url.parse(req.url, true))) };
  } };
}
const fullEntries = () => [
  { uuid: 'u0', role: 'user', content: 'input😀', sourceIdentityAliases: ['alias0'] },
  { uuid: 'a1', role: 'assistant', content: 'complete answer\n"\\😀\ud800'.repeat(1400), queueStatus: 'sent' },
  { uuid: 'a2', role: 'assistant', content: 'middle', deliveryStatus: 'confirmed', sourceUuidAliases: ['alias2'] },
  { uuid: 'u3', role: 'user', content: 'later' },
  { uuid: 'a4', role: 'assistant', content: 'tail' },
];
const projected = (entries, payload) => ({ success: true, entries, revision: { source: 'exact-revision' },
  sessionId: payload.sessionId, ...applyHistoryEntryWindow(entries, payload.bounds) });
const assertNoReplay = route => {
  assert.equal(route.calls.filter(call => call[0] === 'stream').length, 1);
  assert.equal(route.calls.filter(call => call[0] === 'history' || call[0] === 'fallback').length, 0);
};

test('H01 actual Web + worker + credit bytes preserve complete JSON, bounds, aliases and legacy etag', async () => {
  const entries = fullEntries();
  for (const query of ['', '&last=2', '&after=u0&before=u3', '&around=alias2&radius=1', '&from=a2', '&around=absent']) {
    const reqA = request('/api/terminal-tabs/A/history?view=history' + query);
    const reqB = request(reqA.url);
    const result = payload => projected(entries, payload);
    const route = actualRoute({ result }), legacy = actualRoute({ result, legacy: true });
    const next = route.read(reqA), old = legacy.read(reqB);
    await Promise.all([next.promise, old.promise]);
    assert.equal(next.res.statusCode, 200);
    assert.deepEqual(JSON.parse(next.res.body()), JSON.parse(old.res.body()), query || 'complete response');
    assert.equal(route.calls[0][2].projection, 'history-entries');
    assert.equal(route.calls[0][1].dehydrate, undefined, 'ordinary full request remains full');
    assertNoReplay(route);
  }
});

test('H02 explicit payload policy keeps original ref/header fields and etag prefix; no implicit dehydration', async () => {
  const entries = [{ uuid: 'a', role: 'assistant', content: 'small label',
    thinkingRef: { payloadId: 'opaque', totalChars: 123456, contentHash: 'b'.repeat(64), payloadGeneration: 'g' } }];
  const result = payload => projected(entries, payload);
  const target = '/api/terminal-tabs/A/history?view=history&payloads=on-demand-v1';
  const route = actualRoute({ result }), legacy = actualRoute({ result, legacy: true });
  const next = route.read(request(target)), old = legacy.read(request(target));
  await Promise.all([next.promise, old.promise]);
  assert.deepEqual(JSON.parse(next.res.body()), JSON.parse(old.res.body()));
  assert.equal(route.calls[0][1].dehydrate, true);
  assert.equal(route.calls[0][1].payloadPolicy, 'on-demand-v1');
  assert.equal(route.calls[0][1].payloadHeaderVersion, headerVersion);
});

test('H03 ifRevision, delta and freshness retain exact established branches, not a second read', async () => {
  const token = 'c'.repeat(64);
  for (const [query, response] of [
    ['&ifRevision=' + token, { success: true, unchanged: true, revision: { token } }],
    ['&delta=1', { success: true, delta: true, order: ['a'], changed: [{ uuid: 'a', content: 'full delta' }] }],
  ]) {
    const route = actualRoute({ result: () => response });
    const read = route.read(request('/api/terminal-tabs/A/history?view=history' + query));
    await read.promise;
    const parsed = JSON.parse(read.res.body());
    assert.equal(parsed.unchanged ?? parsed.delta, true);
    assert.equal(Object.hasOwn(parsed, 'entries'), false, 'unchanged/delta is not empty History');
    assert.deepEqual(route.calls.map(call => call[0]), ['history']);
  }
  const route = actualRoute({ freshness: () => ({ success: true, entries: [], historyFreshness: { version: 1 } }) });
  const read = route.read(request('/api/terminal-tabs/A/history?view=history&freshness=v1'));
  await read.promise;
  assert.deepEqual(route.calls.map(call => call[0]), ['freshness']);
  assert.equal(JSON.parse(read.res.body()).historyFreshness.version, 1);
});

test('H04 stream-admission UNKNOWN/process/fence and ordinary error never replay full History', async () => {
  for (const code of ['HISTORY_READER_PROCESS_EXITED', 'HISTORY_READER_TRANSPORT_UNKNOWN',
    'HISTORY_READER_FENCE_UNAVAILABLE', 'HISTORY_STREAM_UNAVAILABLE']) {
    const route = actualRoute({ open: async () => { throw Object.assign(new Error(code), { code }); } });
    const read = route.read(request());
    if (code === 'HISTORY_STREAM_UNAVAILABLE') {
      await read.promise; assert.equal(read.res.statusCode, 500);
      assert.equal(JSON.parse(read.res.body()).success, false);
    } else { await assert.rejects(read.promise, error => error.code === code); assert.equal(read.res.headersSent, undefined); }
    assertNoReplay(route);
  }
});

test('H05 authoritative failed metadata preserves lineage error and closes before byte admission', async () => {
  const stats = {};
  const route = actualRoute({ result: () => ({ success: false, error: 'lineage_unresolved', lineageReason: 'missing-parent' }), fixture: { stats } });
  const read = route.read(request()); await read.promise;
  assert.equal(read.res.statusCode, 409);
  assert.equal(JSON.parse(read.res.body()).lineageReason, 'missing-parent');
  assert.equal(stats.sender.frames, 0);
  assert.ok(stats.closed > 0); assertNoReplay(route);
});

test('H06 identity change before headers returns 409, sends zero source frames and never falls back', async () => {
  const stats = {};
  const route = actualRoute({ result: p => projected(fullEntries(), p), fixture: { stats },
    readInfo: (n, info) => n === 1 ? info : { ...info, sessionId: 'new-writer' } });
  const read = route.read(request()); await read.promise;
  assert.equal(read.res.statusCode, 409);
  assert.equal(JSON.parse(read.res.body()).error, 'history_read_identity_changed');
  assert.equal(stats.sender.frames, 0); assertNoReplay(route);
});

test('H07 identity change at final fence leaves incomplete JSON and never validates a stale body', async () => {
  const stats = {};
  const route = actualRoute({ result: p => projected(fullEntries(), p), fixture: { stats },
    readInfo: (n, info) => n < 4 ? info : { ...info, sessionId: 'new-owner' } });
  const read = route.read(request());
  await assert.rejects(read.promise, { code: 'HISTORY_READ_IDENTITY_CHANGED' });
  assert.ok(read.res.body().length > 1024); assert.equal(read.res.destroyed, true);
  assert.throws(() => JSON.parse(read.res.body()), SyntaxError);
  assertNoReplay(route);
});

test('H08 partial UNKNOWN/source invalidation keep their error class and cannot replay or finish valid JSON', async () => {
  for (const failCode of ['HISTORY_READER_TRANSPORT_UNKNOWN', 'CODEX_SOURCE_READ_INVALIDATED']) {
    const stats = {};
    const route = actualRoute({ result: p => projected(fullEntries(), p), fixture: { stats, failAfter: 1, failCode } });
    const read = route.read(request());
    await assert.rejects(read.promise, error => error.code === failCode);
    assert.equal(read.res.destroyed, true);
    assert.throws(() => JSON.parse(read.res.body()), SyntaxError);
    assert.ok(stats.closed > 0); assertNoReplay(route);
  }
});

test('H09 actual credited sender stops at fixed transport queues with a blocked inherited-control HTTP sink', async () => {
  const measurements = [];
  for (const scale of [1, 4]) {
    const gate = barrier(), started = barrier(), stats = {}, entries = fullEntries();
    entries[1].content = entries[1].content.repeat(scale); // own fixture, < 256 KiB
    const route = actualRoute({ result: p => projected(entries, p), fixture: { stats } });
    const req = request(), res = new Response(req, { gate, started, highWaterMark: 1024 });
    const read = route.read(req, res); await started.promise;
    for (let i = 0; i < 20; i++) await tick();
    const blockedFrames = stats.sender.frames;
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(stats.sender.frames, blockedFrames, 'no advance while the sink stays blocked');
    assert.ok(stats.sender.maxOutstandingBytes <= 2048);
    assert.ok(stats.receiver.maxQueuedBytes <= 2048);
    assert.ok(blockedFrames <= 20, 'HTTP readable buffer plus 2 credited frames, not the full source');
    gate.resolve(); await read.promise; await stats.pump;
    assert.deepEqual(JSON.parse(res.body()).entries, entries);
    measurements.push({ scale, blockedFrames, senderOutstanding: stats.sender.maxOutstandingBytes,
      receiverQueued: stats.receiver.maxQueuedBytes, writableQueued: res.maxQueued });
  }
  assert.equal(measurements[0].blockedFrames, measurements[1].blockedFrames);
  process.stdout.write('# H09 transport-high-water ' + JSON.stringify({ measurements,
    frameBytes: 1024, credits: 2, sourceGraph: 'synthetic legacy-owned-array; not bounded' }) + '\n');
});

test('H10 disconnected blocked sink rejects its read once and cannot continue source production', async () => {
  const gate = barrier(), started = barrier(), stats = {};
  const route = actualRoute({ result: p => projected(fullEntries(), p), fixture: { stats } });
  const req = request(), res = new Response(req, { gate, started });
  const read = route.read(req, res); let outcomes = 0;
  const observed = read.promise.then(value => { outcomes++; return value; }, error => { outcomes++; throw error; });
  await started.promise;
  for (let i = 0; i < 8; i++) await tick();
  req.aborted = true; req.emit('aborted');
  await assert.rejects(observed, isHistoryReadCancelled);
  const stoppedFrames = stats.sender.frames;
  gate.resolve(); for (let i = 0; i < 8; i++) await tick();
  assert.equal(stats.sender.frames, stoppedFrames);
  assert.equal(res.destroyed, true); assert.equal(req.listenerCount('aborted'), 0);
  // pipeline legitimately has its own listeners on the synthetic Writable;
  // this control verifies only the production HTTP owner's listeners.
  assert.equal(res.listeners('close').some(fn => fn.name === 'closed'), false);
  assert.equal(res.listeners('error').some(fn => fn.name === 'revoke'), false);
  assert.equal(outcomes, 1); assertNoReplay(route);
  assert.throws(() => JSON.parse(res.body()), SyntaxError);
});

test('H11 gzip preserves the entire JSON response with unknown Content-Length and no retry', async () => {
  const result = p => projected(fullEntries(), p), route = actualRoute({ result });
  const req = request(); req.headers['accept-encoding'] = 'br, gzip';
  const read = route.read(req); await read.promise;
  assert.equal(read.res.headers['Content-Encoding'], 'gzip');
  assert.equal(read.res.headers['Content-Length'], undefined);
  assert.equal(read.res.headers.Vary, 'Accept-Encoding');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(read.res.body())).entries, fullEntries());
  assertNoReplay(route);
});

test('H12 ref-cursor metadata remains explicit; malformed cursor metadata is rejected without legacy materialization', async () => {
  const control = createReadControl();
  const entries = { async *[Symbol.asyncIterator]() { yield { uuid: 'row', content: 'reachable' }; } };
  const metadata = { result: { success: true, revision: { source: 'proof' } }, entryCount: 1,
    etag: 'opaque', firstUuid: 'row', lastUuid: 'row', sourceGraph: 'ref-cursor' };
  const projected = await projectActual({ result: { entries }, streamOptions: { sourceGraph: 'ref-cursor', metadata },
    message: { stream: { projection: 'history-entries', format: 'json' } }, payload: {}, control });
  assert.equal(projected.value, entries); assert.equal(projected.metadata, metadata);
  await assert.rejects(projectActual({ result: { entries }, streamOptions: { sourceGraph: 'ref-cursor', metadata: {} },
    message: { stream: { projection: 'history-entries', format: 'json' } }, payload: {}, control }), /metadata_required/);
  control.finish();
});

// This second fixture uses the actual Main HistoryReadClient and exact service
// forwarding method. Only the external child process is substituted; actual
// epoch owner files are small sandbox files managed/removed by the client.
class SourceProcessSubstitute extends EventEmitter {
  constructor(result, { admit = true, readProof = [] } = {}) {
    super(); this.result = result; this.admit = admit; this.readProof = readProof;
    this.messages = []; this.senders = new Map(); this.pumps = []; this.open = true;
  }
  postMessage(message) {
    this.messages.push(message);
    if (message.event === 'stream-credit') this.senders.get(message.id)?.sender.credit(message);
    if (message.event === 'cancel') this.senders.get(message.id)?.abort.abort();
    if (!message.method || !this.admit) return;
    const abort = new AbortController(), control = createReadControl({ signal: abort.signal });
    const sender = new HistoryByteSender({ id: message.id, ...message.stream, control,
      send: value => queueMicrotask(() => this.emit('message', value)) });
    this.senders.set(message.id, { sender, abort });
    const run = (async () => {
      const projection = await projectActual({ result: this.result(message.payload),
        streamOptions: undefined, message, payload: message.payload, control });
      return sender.pump(encodeHistoryStream(projection.value, { frameBytes: message.stream.frameBytes, control }),
        projection.metadata, this.readProof);
    })().finally(() => control.finish());
    run.catch(() => {}); this.pumps.push(run);
  }
  ref() {} unref() {}
  async terminate() {
    if (!this.open) return;
    this.open = false;
    for (const owner of this.senders.values()) owner.abort.abort();
    this.emit('exit', 0);
  }
}
function actualClientFixture(t, options = {}) {
  const children = [], openControls = [];
  const client = new HistoryReadClient({ createTransport: () => {
    const child = new SourceProcessSubstitute(p => projected(fullEntries(), p), options);
    children.push(child); return child;
  } });
  client.diagnose = () => {}; // Diagnostic logging only; no business path substituted.
  const actualOpen = client.openStream.bind(client);
  client.openStream = (method, payload, openOptions) => {
    openControls.push({ inherited: currentReadControl(), explicit: openOptions.control });
    return actualOpen(method, payload, openOptions);
  };
  const service = new ActualStreamService(); service.historyReader = client;
  t.after(async () => { await client.close(); await Promise.allSettled(children.flatMap(child => child.pumps)); });
  return { client, service, children, openControls, get child() { return children.at(-1); } };
}

test('H13 actual route -> service -> client keeps the request control alive through EOF/final identity fence', async t => {
  const f = actualClientFixture(t); let stream, requestControl, finalFences = 0;
  const route = actualRoute({
    open: async (payload, options) => {
      requestControl = currentReadControl(); assert.ok(requestControl);
      stream = await f.service.openHistoryStream(payload, options); return stream;
    },
    readInfo(n, info) {
      if (n === 4) {
        finalFences++;
        assert.equal(f.client.pending.size, 0, 'EOF completed client request ownership');
        assert.doesNotThrow(() => requestControl.assertCurrent(), 'HTTP owner is not finished by client EOF cleanup');
        assert.doesNotThrow(() => stream.assertCurrent(), 'final source fence remains usable after EOF');
      }
      return info;
    },
  });
  const read = route.read(request()); await read.promise;
  assert.equal(finalFences, 1);
  assert.equal(f.openControls.length, 1);
  assert.equal(f.openControls[0].explicit, requestControl, 'the Web route explicitly passes its current request owner');
  assert.equal(f.openControls[0].inherited, requestControl, 'the existing ALS owner is the same lease');
  const rpc = f.child.messages.find(message => message.method);
  assert.equal(Object.hasOwn(rpc.stream, 'control'), false, 'local control never enters process IPC');
  assert.equal(Object.hasOwn(rpc.payload, '_readControl'), false);
  assert.equal(f.client.pending.size, 0);
  assert.deepEqual(JSON.parse(read.res.body()).entries, fullEntries());
  assert.throws(() => requestControl.assertCurrent(), isHistoryReadCancelled, 'HTTP finishes its own owner after full response');
  assertNoReplay(route);
});

test('H14 abort while actual service/client awaits stream-open releases Main pending without creating a replacement read', async t => {
  const f = actualClientFixture(t, { admit: false }), entered = barrier();
  const route = actualRoute({ open(payload, options) {
    const pending = f.service.openHistoryStream(payload, options); entered.resolve(); return pending;
  } });
  const req = request(), read = route.read(req); await entered.promise;
  assert.equal(f.client.pending.size, 1);
  req.aborted = true; req.emit('aborted');
  await assert.rejects(read.promise, isHistoryReadCancelled);
  assert.equal(f.client.pending.size, 0); assert.equal(f.children.length, 1);
  assert.equal(f.child.messages.filter(message => message.method).length, 1);
  assert.equal(f.child.messages.filter(message => message.event === 'cancel').length, 1);
  assert.equal(read.res.headersSent, undefined); assertNoReplay(route);
});

test('H15 actual client checks source epochs after EOF and withholds the final JSON delimiter on late invalidation', async t => {
  const filePath = '/private/own-synthetic-epoch-source.jsonl';
  const f = actualClientFixture(t, { readProof: [{ filePath, slot: 0, epoch: 0 }] });
  let requestControl;
  const route = actualRoute({
    open(payload, options) { requestControl = currentReadControl(); return f.service.openHistoryStream(payload, options); },
    readInfo(n, info) {
      if (n === 4) {
        assert.equal(f.client.pending.size, 0);
        assert.doesNotThrow(() => requestControl.assertCurrent());
        f.client.invalidate({ filePath });
      }
      return info;
    },
  });
  const read = route.read(request());
  await assert.rejects(read.promise, { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.throws(() => JSON.parse(read.res.body()), SyntaxError);
  assert.equal(read.res.destroyed, true); assert.equal(f.client.pending.size, 0);
  assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0); assertNoReplay(route);
});
