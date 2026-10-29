'use strict';
// Finite SOURCE acceptance. No app/process/provider/SDK/native/MCP/build.
// node --max-old-space-size=80 --max-semi-space-size=4 --expose-gc --test <this file>
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), v8 = require('node:v8'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createHistoryIpcDemands } = require('./history-ipc-demand');
const { createHistoryRootIpcBridge } = require('./history-root-ipc');
const { HistoryPagedStore, materializeHistoryCursorSync } = require('./history-root-engine/main/history-paged-store');
const { HistoryProjectionArena } = require('./history-root-engine/main/history-projection-arena');
const { createTimelineLogicalRoot } = require('./history-root-engine/main/timeline-root-logical');
const { createTimelineRootView } = require('./history-root-engine/main/timeline-root-view');
const { HistoryRootReadPlane } = require('./history-root-engine/main/history-root-read-plane');
const { openTimelineRootOutlineReader, readTimelineOutlineItem } = require('./timeline-root-outline-reader');
const { currentReadControl } = require('./history-read-control');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'TOTAL V8 <=128MiB; run with --old80 --semi4');

// Only the Electron-ABI SQLite binding is substituted. Arenas, logical view,
// signed descriptors, generic pages, read-demand ownership and IPC are real.
class SQLite {
  constructor(file) { this.name = file; this.db = new DatabaseSync(file); this.depth = 0; }
  get inTransaction() { return this.db.isTransaction; }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) {
    const q = this.db.prepare(sql), convert = row => row && Object.fromEntries(Object.entries(row)
      .map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v]));
    return { get: (...args) => convert(q.get(...args)), all: (...args) => q.all(...args).map(convert),
      run: (...args) => q.run(...args), *iterate(...args) { for (const row of q.iterate(...args)) yield convert(row); } };
  }
  pragma(sql, options = {}) { const rows = this.prepare('PRAGMA ' + sql).all(); return options.simple ? Object.values(rows[0])[0] : rows; }
  transaction(fn) { return (...args) => {
    if (this.depth) return fn(...args);
    this.exec('BEGIN'); this.depth++;
    try { const result = fn(...args); this.exec('COMMIT'); return result; }
    catch (error) { this.exec('ROLLBACK'); throw error; } finally { this.depth--; }
  }; }
  close() { this.db.close(); }
}
class Sender extends EventEmitter { isDestroyed() { return this.destroyed === true; } }
const nativeLoad = Module._load, handlers = new Map();
let provider, counts = { count: 0, generate: 0 };
Module._load = function(name, ...args) {
  if (name === 'electron') return { ipcMain: { handle(channel, handler) { assert(!handlers.has(channel)); handlers.set(channel, handler); } } };
  if (name === '@google/genai') return { GoogleGenAI: class { constructor() { this.models = {
    countTokens: async request => { counts.count++; return provider.countTokens(request); },
    generateContent: async request => { counts.generate++; return provider.generateContent(request); },
  }; } } };
  return nativeLoad.call(this, name, ...args);
};
const service = require('./timeline-outline-service');
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scope = { toolType: 'codex', sessionId: 'outline-owned', tabId: 'tab-owned', cwd: '/finite/outline' };
const input = [
  { uuid: 'c0', type: 'compact', content: 'do not load compact body', sessionId: scope.sessionId },
  { uuid: 'a', type: 'user', content: 'HEAD\r\n' + '🙂\ud800\udfff\r\n'.repeat(1600) + 'TAIL-A', preview: 'WRONG PREVIEW', sessionId: 's0' },
  { uuid: 'b', type: 'user', content: 'small second prompt', sessionId: 's0' },
  { uuid: 'bridge', type: 'continued', content: 'not a user' },
  { uuid: 'meta', kind: 'user', full: '\uFEFF  Saved workflow\r\nprivate instructions and suffix', sessionId: 's0' },
  { uuid: 'sub', type: 'user', content: 'agent excluded', isSubAgent: true },
  { uuid: 'slash', type: 'user', content: '/compact' },
  { uuid: 'summary', type: 'compact', content: 'summary excluded', isCompactSummary: true },
  { uuid: 'd', type: 'user', content: 'plan work', isPlan: true, sessionId: 's1', timestamp: '2026-10-26T01:00:00Z' },
  { uuid: 'timeout', type: 'user', isSubAgentTimeout: true, content: 'excluded' },
  { uuid: 'e', type: 'user', content: 'after timeout' },
];
const presets = [{ id: 'saved', title: 'Saved workflow', content: 'Saved workflow' }];
const barriers = { notes: [{ entry_uuid: 'd', position: 'after' }], rewindMarkers: [{ entry_uuid: 'b' }],
  forkMarkers: [{ fork_session_id: scope.sessionId, source_session_id: 'older', is_direct: true,
    entry_uuids: ['a', 'b'], created_at: 10, snapshot_complete: true }] };
let fixtureBytes = 0, peakHeap = 0, passed = 0;
function sample(dir) {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapTotal);
  assert(process.memoryUsage().heapTotal <= 128 * 1024 ** 2);
  let bytes = 0; for (const name of fs.readdirSync(dir)) { const stat = fs.lstatSync(path.join(dir, name)); assert(!stat.isSymbolicLink()); bytes += stat.size; }
  fixtureBytes = Math.max(fixtureBytes, bytes); assert(bytes <= 64 * 1024 ** 2);
}
function publish(store, value) { const a = new HistoryProjectionArena(store); try { return a.step(() => a.publish(value)); } finally { a.close(); } }
async function fixture(t, rows = input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-outline-root-'));
  // Install cleanup before the first schema/build await, including failures.
  let initialized = false; const initializationCleanup = [];
  t.after(() => {
    if (initialized) return;
    try { for (const close of initializationCleanup.reverse()) close(); }
    finally { fs.rmSync(dir, { recursive: true }); }
  });
  const store = new HistoryPagedStore({ filename: path.join(dir, 'pages.sqlite'), Database: SQLite, diskBytes: 48 * 1024 ** 2 });
  initializationCleanup.push(() => store.close());
  const source = publish(store, { entries: rows });
  initializationCleanup.push(() => source.release());
  const canonical = { success: true, semanticSnapshotComplete: true, representation: 'codex-timeline-root-v1',
    root: source, entries: source.cursor().field('entries') };
  const logical = await createTimelineLogicalRoot(store, canonical);
  initializationCleanup.push(() => logical.release());
  const options = publish(store, { toolType: 'codex' });
  initializationCleanup.push(() => options.release());
  const view = await createTimelineRootView({ store, logicalRoot: logical, optionsRoot: options });
  initializationCleanup.push(() => view.release());
  const oracle = Array.from({ length: logical.entries.length }, (_, i) => materializeHistoryCursorSync(view.actualRow(i)));
  logical.release(); options.release(); source.release();
  const plane = new HistoryRootReadPlane({ store, projectHistory() { throw Error('NO SOURCE READ'); } });
  initializationCleanup.push(() => plane.close());
  const demands = createHistoryIpcDemands(), sender = new Sender(), event = { sender }, calls = [];
  let fault = null;
  const reader = {
    async call(method, request) {
      calls.push({ method, ...request });
      const consumerKey = request._historyRootConsumerKey, control = currentReadControl();
      if (method === 'openHistoryRoot') {
        const held = view.fork(), presentation = { view: held, closed: false };
        const result = { root: held.lease, timelinePresentation: presentation,
          release() { presentation.closed = true; held.release(); } };
        const ownerKey = hash(JSON.stringify(['codex', request.sessionId, request.cwd || '', request.tabId || '', consumerKey]));
        const installed = plane.install(result, held.atoms, { consumerKey, ownerKey, revision: held.revision,
          source: { sessionId: scope.sessionId }, canonicalSource: canonical });
        return { success: true, ...plane.identity(installed.state), root: installed.descriptor };
      }
      if (method === 'releaseHistoryRoot') return plane.release(request, { consumerKey });
      assert.equal(method, 'readHistoryRootPage');
      if (fault) { const value = await fault(request); if (value !== undefined) return value; }
      // EXACT remaining parent hook. All other signed pages use the real plane.
      if (request.kind === 'timeline-query' && request.operation === 'outline-item') {
        return readTimelineOutlineItem(plane, plane.state(request, consumerKey), request, { consumerKey, control });
      }
      return plane.readPage(request, { consumerKey, control });
    },
    postWorkerEvent(message) {
      if (message.event === 'release-root-consumer') plane.releaseConsumer(message.consumerKey);
    },
  };
  const bridge = createHistoryRootIpcBridge({ reader, demands });
  initializationCleanup.push(() => bridge.close());
  const open = (target = scope, from = event) => bridge.run(from, target, 'openHistoryRoot');
  const ui = await open(), action = await open();
  const payload = { ...scope, resultMode: 'root-status-v1', timelineParentLease: action };
  const release = cap => bridge.run(event, cap, 'releaseHistoryRoot');
  const manager = {
    saved: [], logs: [],
    getAIPromptById(id) { assert.equal(id, 'timeline-grouping'); return { content: 'Original system prompt', model: 'gemini-3-fixture', thinkingLevel: 'LOW' }; },
    getPrompts() { return presets; }, getTimelineGroupingBarriers() { return barriers; },
    saveTimelineOutline(record) { this.saved.push(record); return true; },
    logAIPromptCall(record) { this.logs.push(record); },
  };
  t.after(() => {
    try {
      bridge.close(); plane.close(); view.release();
      assert.equal(store.stats().leases, 0); assert.equal(store.stats().activeBuilders, 0);
      assert.equal(store.db.prepare('SELECT count(*) n FROM hp_pins').get().n, 0);
      sample(dir); assert.deepEqual(demands.stats(), { owners: 0, reads: 0 }); passed++;
    } finally { store.close(); fs.rmSync(dir, { recursive: true }); global.gc?.(); }
  });
  initialized = true;
  return { dir, plane, store, event, sender, bridge, open, ui, action, payload, release, manager, calls, oracle,
    setFault(fn) { fault = fn; } };
}
let active;
const managerProxy = new Proxy({}, { get(_target, key) { const value = active.manager[key]; return typeof value === 'function' ? value.bind(active.manager) : value; } });
const transcript = { get historyRootIpc() { return active.bridge; }, async getTimeline() { active.legacyReads++; return { success: true, entries: active.oracle }; } };
service.register({ projectManager: managerProxy, transcriptService: transcript });
const generate = (payload, event = active.event) => handlers.get('timeline-outline:generate')(event, payload);
const use = async (t, rows) => { active = await fixture(t, rows); active.legacyReads = 0; counts = { count: 0, generate: 0 }; return active; };
function providerFor(groupMode = 'singletons') {
  return {
    countTokens(request) { assert(!Object.hasOwn(request, 'config')); return { totalTokens: 123 }; },
    generateContent(request) {
      const doc = JSON.parse(request.contents[0].parts[0].text);
      assert.deepEqual(request.config.responseJsonSchema, service.buildOutlineResponseSchema());
      assert.equal(request.config.temperature, 0.1); assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: 'LOW' });
      const member = p => ({ uuid: p.uuid, description: 'Do the requested work', role: 'implementation' });
      const groups = groupMode === 'pair' ? [{ title: 'Together', description: 'Related work', members: doc.prompts.map(member) }]
        : doc.prompts.map(p => ({ title: 'Work', description: 'Requested work', members: [member(p)] }));
      return { text: JSON.stringify({ groups }), usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 7,
        thoughtsTokenCount: 2, totalTokenCount: 22, arbitraryBody: 'MUST NOT LEAK' } };
    },
  };
}
function receipt(result, groupCount = 0) {
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.resultMode, 'root-status-v1'); assert.equal(result.groupCount, groupCount);
  assert(!Object.hasOwn(result, 'data')); assert(!Object.hasOwn(result, 'outline')); assert(!Object.hasOwn(result, 'sourceUuids'));
  for (const value of Object.values(result)) assert(['string', 'boolean', 'number'].includes(typeof value));
  assert(Buffer.byteLength(JSON.stringify(result)) < 512);
}

const oldKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'finite-stub-not-a-key';
test.after(() => { Module._load = nativeLoad; if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });

test('actual signed full-content read equals native prepareGroupingInput; UI lease release leaves job frozen', async t => {
  const f = await use(t);
  const reader = await openTimelineRootOutlineReader(f.event, f.payload, f.bridge);
  await f.release(f.ui);
  const before = f.store.stats().leases;
  const result = await reader.readTimeline();
  assert.deepEqual(service.prepareGroupingInput(result.entries, presets), service.prepareGroupingInput(f.oracle, presets));
  assert.equal(result.entries.find(e => e.uuid === 'a').content, input[1].content);
  assert(!Object.hasOwn(result.entries[0], 'content')); assert(!JSON.stringify(result).includes('WRONG PREVIEW'));
  await assert.rejects(reader.readTimeline(), { code: 'TIMELINE_OUTLINE_ALREADY_READ' });
  await reader.close(); await reader.close();
  await assert.rejects(reader.check(), { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(f.store.stats().leases, before); // Decoder close does not release the action cap.
  assert(f.plane.state(f.action, f.calls[0]._historyRootConsumerKey));
  assert(f.calls.filter(c => c.kind === 'leaf').length > 1);
  assert(!f.calls.some(c => ['range', 'fields', 'find', 'rowWindow'].includes(c.kind)));
  assert.deepEqual(f.calls.filter(c => c.operation === 'outline-item').map(c => c.offset), f.oracle.map((_, i) => i));
});

test('actual IPC generates once, preserves native source hashes/config/barriers/DB record; legacy still returns full data', async t => {
  const f = await use(t); provider = providerFor();
  const expected = service.prepareGroupingInput(f.oracle, presets,
    { boundaryBeforeUuids: ['b'], boundaryAfterUuids: ['b', 'd'] });
  const refs = service.buildAiPromptReferences(expected.entries);
  const original = provider.generateContent;
  provider.generateContent = request => {
    assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), {
      schemaVersion: 2, session: { toolType: 'codex', sessionId: scope.sessionId }, compactCount: expected.compactCount, prompts: refs.prompts,
    });
    return original(request);
  };
  const root = await generate(f.payload); receipt(root); assert.deepEqual(counts, { count: 1, generate: 1 });
  assert.equal(f.legacyReads, 0); assert.equal(f.manager.saved.length, 1);
  const record = f.manager.saved[0];
  assert.equal(record.sourceHash, expected.sourceHash); assert.deepEqual(record.sourceUuids, expected.eligibleUuids);
  assert.equal(record.sourceEntryCount, expected.sourceEntryCount); assert.equal(record.outline.compactCount, expected.compactCount);
  assert.equal(record.countedInputTokens, 123); assert.equal(record.outline.metaPrompts[0].presetId, 'saved');
  assert(record.outline.turns.length === expected.sourceEntryCount); assert.equal(f.manager.logs[0].status, 'success');
  const legacy = await generate(scope); assert(legacy.data.outline); assert(legacy.data.sourceUuids.length > 0);
  assert.equal(f.legacyReads, 1); assert.deepEqual(counts, { count: 2, generate: 2 });
});

test('one-flight hit authenticates its own cap and returns only scalars; legacy joining same job receives full result', async t => {
  const f = await use(t, [{ uuid: 'a', type: 'user', content: 'one' }, { uuid: 'b', type: 'user', content: 'two' }]);
  f.manager.getTimelineGroupingBarriers = () => null;
  const started = pending(), finish = pending(); provider = providerFor('pair');
  const original = provider.generateContent; provider.generateContent = async request => { started.resolve(); await finish.promise; return original(request); };
  const a = generate(f.payload); await started.promise;
  const foreign = await generate({ ...f.payload, timelineParentLease: { ...f.action, ownerKey: 'foreign' } });
  assert.equal(foreign.success, false); assert(!Object.hasOwn(foreign, 'data'));
  const secondCap = await f.open(), b = generate({ ...f.payload, timelineParentLease: secondCap });
  // Queue a legacy join without changing the global session/cwd one-flight.
  const legacy = generate(scope);
  finish.resolve(); const [ra, rb, rl] = await Promise.all([a, b, legacy]); receipt(ra, 1); receipt(rb, 1);
  assert(rl.data.outline.groups.length === 1); assert.deepEqual(counts, { count: 1, generate: 1 }); assert.equal(f.legacyReads, 0);
});

test('wrong sender/session/cwd/tab, stale generation/revision and unknown read never fall back or invoke provider', async t => {
  const f = await use(t); provider = providerFor();
  const variants = [
    [{ ...f.payload, sessionId: 'other' }], [{ ...f.payload, cwd: '/other' }], [{ ...f.payload, tabId: 'other' }],
    [{ ...f.payload, timelineParentLease: { ...f.action, generation: 'old' } }],
    [{ ...f.payload, timelineParentLease: { ...f.action, revision: 'old' } }],
    [f.payload, { sender: new Sender() }], [{ ...scope, resultMode: 'root-status-v1' }],
  ];
  for (const [payload, event] of variants) { const result = await generate(payload, event); assert.equal(result.success, false); assert(!Object.hasOwn(result, 'data')); }
  f.setFault(() => { throw Object.assign(Error('unknown transport'), { code: 'OWN_UNKNOWN' }); });
  const result = await generate(f.payload); assert.equal(result.code, 'OWN_UNKNOWN');
  assert.deepEqual(counts, { count: 0, generate: 0 }); assert.equal(f.legacyReads, 0);
});

test('borrowed close and malformed page proof do not release another owner or retry', async t => {
  const f = await use(t); provider = providerFor();
  const before = f.store.stats().leases;
  f.setFault(request => {
    if (request.operation !== 'outline-item') return;
    const c = f.calls[0]._historyRootConsumerKey;
    const packet = readTimelineOutlineItem(f.plane, f.plane.state(request, c), request, { consumerKey: c });
    packet.nextOffset++; return packet;
  });
  const result = await generate(f.payload); assert.equal(result.code, 'TIMELINE_OUTLINE_PAGE_IDENTITY');
  assert.equal(f.store.stats().leases, before);
  assert.equal(f.calls.filter(c => c.operation === 'outline-item').length, 1);
  assert.deepEqual(counts, { count: 0, generate: 0 });
});

test('preview-only prompt is refused before generation', async t => {
  const f = await use(t, [{ uuid: 'preview', kind: 'user', preview: 'DO NOT GENERATE THIS' }]); provider = providerFor();
  const result = await generate(f.payload); assert.equal(result.code, 'TIMELINE_OUTLINE_FULL_CONTENT_REQUIRED');
  assert.deepEqual(counts, { count: 0, generate: 0 });
});

test('text tampering fails full UTF16 digest with zero provider calls and no implicit release or retry', async t => {
  const f = await use(t, [{ uuid: 'text', type: 'user', content: 'exact full '.repeat(100) }]); provider = providerFor();
  let corrupted = 0;
  f.setFault(async request => {
    if (request.kind !== 'leaf') return;
    const packet = await f.plane.readPage(request, { consumerKey: request._historyRootConsumerKey });
    packet.text = 'X' + packet.text.slice(1); corrupted++;
    let old; do { old = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); } while (old !== packet.creditBytesUsed);
    return packet;
  });
  const before = f.store.stats().leases, result = await generate(f.payload);
  assert.equal(result.code, 'TIMELINE_OUTLINE_TEXT_DIGEST'); assert.equal(corrupted, 1);
  assert.deepEqual(counts, { count: 0, generate: 0 }); assert.equal(f.legacyReads, 0);
  assert.equal(f.store.stats().leases, before);
});

test('an in-flight legacy source cannot stand in for the caller retained logical root', async t => {
  const f = await use(t, [{ uuid: 'a', type: 'user', content: 'owned' }]), started = pending(), finish = pending();
  provider = providerFor(); const original = provider.generateContent;
  provider.generateContent = async request => { started.resolve(); await finish.promise; return original(request); };
  const legacy = generate(scope); await started.promise;
  const root = await generate(f.payload); assert.equal(root.code, 'generation_source_conflict');
  finish.resolve(); assert((await legacy).data.outline); assert.deepEqual(counts, { count: 1, generate: 1 });
});

test('nonfinite usage and opaque provider error codes cannot expand compact success/error packets', async t => {
  const f = await use(t, [{ uuid: 'a', type: 'user', content: 'owned' }]); provider = providerFor();
  const original = provider.generateContent;
  provider.generateContent = request => ({ ...original(request), usageMetadata: {
    promptTokenCount: Infinity, candidatesTokenCount: -4, thoughtsTokenCount: 1e100, totalTokenCount: 10,
    sourceUuids: ['MUST NOT LEAK'],
  } });
  const success = await generate(f.payload); receipt(success);
  assert(!Object.hasOwn(success, 'promptTokens')); assert(!Object.hasOwn(success, 'candidateTokens'));
  assert(!Object.hasOwn(success, 'thoughtTokens')); assert.equal(success.totalTokens, 10);
  provider.generateContent = () => { throw Object.assign(Error('E'.repeat(2000)), { code: { body: 'PRIVATE' } }); };
  const failure = await generate(f.payload); assert.equal(failure.code, 'timeline_outline_failed');
  assert(failure.error.length <= 700); assert(!JSON.stringify(failure).includes('PRIVATE'));
});

test('empty retained logical root never opens source or calls provider', async t => {
  const f = await use(t, []); provider = providerFor();
  const result = await generate(f.payload); assert.equal(result.code, 'no_eligible_prompts');
  assert.equal(f.legacyReads, 0); assert.deepEqual(counts, { count: 0, generate: 0 });
});

test('navigation while countTokens is pending refuses generation and removes local job listeners', async t => {
  const f = await use(t), started = pending(), finish = pending(); provider = providerFor();
  provider.countTokens = async () => { started.resolve(); await finish.promise; return { totalTokens: 123 }; };
  const resultPromise = generate(f.payload); await started.promise;
  f.sender.emit('did-start-navigation', {}, 'about:blank', false, true); finish.resolve();
  const result = await resultPromise; assert.equal(result.code, 'HISTORY_READ_CANCELLED');
  assert.deepEqual(counts, { count: 1, generate: 0 }); assert.equal(f.manager.saved.length, 0);
  assert.equal(f.sender.listenerCount('did-start-navigation'), 0);
});

test('close/resource release while provider runs prevents stale save, does not repeat provider; error/storage failure settle', async t => {
  const f = await use(t), started = pending(), finish = pending(); provider = providerFor();
  const original = provider.generateContent; provider.generateContent = async request => { started.resolve(); await finish.promise; return original(request); };
  const resultPromise = generate(f.payload); await started.promise; await f.release(f.action); finish.resolve();
  const result = await resultPromise; assert.equal(result.code, 'HISTORY_ROOT_RELEASED');
  assert.equal(f.manager.saved.length, 0); assert.deepEqual(counts, { count: 1, generate: 1 });
  assert.equal(f.manager.logs[0].status, 'error');
});

test('provider/storage errors return bounded errors and one controlled attempt each; no new open/read fallback', async t => {
  const f = await use(t); provider = providerFor();
  provider.generateContent = () => { throw Object.assign(Error('failure?key=private-key'), { code: 'OWN_PROVIDER' }); };
  const failure = await generate(f.payload); assert.equal(failure.code, 'OWN_PROVIDER'); assert(!failure.error.includes('private-key'));
  provider = providerFor(); f.manager.saveTimelineOutline = () => false;
  const storage = await generate(f.payload); assert.equal(storage.code, 'storage_failed');
  assert.deepEqual(counts, { count: 2, generate: 2 }); assert.equal(f.legacyReads, 0);
  assert.equal(f.calls.filter(c => c.method === 'openHistoryRoot').length, 2); // fixture UI + action only
});

test('finite source RESULT (explicit BodyOPEN and remaining production hook)', () => {
  assert.equal(passed, 13);
  const result = { fixturesCleaned: passed, heapLimit: v8.getHeapStatistics().heap_size_limit, peakHeap, peakFixtureBytes: fixtureBytes,
    nativeProvider: false, app: false, globalMemoryBounded: false, generationGraph: 'BodyOPEN',
    hook: 'dispatch timeline-query outline-item to readTimelineOutlineItem before nodeToken check',
    changedFiles: ['src/main/timeline-outline-service.js', 'src/main/timeline-root-outline-reader.js', 'src/main/timeline-root-outline-reader.test.js'] };
  console.log('RESULT ' + JSON.stringify(result));
});
