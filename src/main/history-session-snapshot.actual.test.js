'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { HistoryReadClient } = require('./history-read-client');
const codexData = require('./ipc/codex-data');
const { readSessionSnapshot, normalizeSessionSnapshotRequest } = require('./history-session-snapshot');
const { SessionTranscriptService } = require('./session-transcript-service');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { createHash } = require('node:crypto');
const event = (type, rest = {}) => ({ type: 'event_msg', payload: { type, ...rest } });
const answer = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const encode = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const sid = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-snapshot-worker-'));
  const file = path.join(directory, 'rollout-' + sid + '.jsonl');
  fs.writeFileSync(file, encode([{ type: 'session_meta', payload: { id: sid, cwd: directory } },
    event('task_started', { turn_id: 'open' }), event('user_message', { message: 'latest real task' }), answer('partial') ]));
  const diagnostics = [];
  const client = new HistoryReadClient({ codexData, sessionsDir: directory, cacheDirectory: path.join(directory, 'cache'),
    memoryBudgetMb: 64, onDiagnostic: event => diagnostics.push(event) });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { file, directory, client, diagnostics, read: () => client.call('readSessionSnapshot', { sessionId: sid, cwd: directory }) };
}

test('actual worker/service snapshot returns busy data and accepts append at Main publication without retry', async t => {
  const f = fixture(t), request = f.client.request.bind(f.client);
  let calls = 0;
  f.client.request = async (...args) => {
    const value = await request(...args);
    if (++calls === 1) {
      fs.appendFileSync(f.file, encode([answer('later'), event('task_complete', { turn_id: 'open' })]));
      f.client.invalidate({ filePath: f.file, sourceAppend: true });
    }
    return value;
  };
  const before = codexData._api.getCodexJsonlCacheStats();
  const first = await f.read();
  assert.equal(first.entries[0].user.text, 'latest real task');
  assert.equal(first.entries[0].assistant.text, 'partial');
  assert.equal(first.entries[0].status, 'in_progress');
  assert.equal(calls, 1);
  assert.equal(f.client.diagnosticCounters.retries, 0);
  f.client.assertSnapshotCurrent(first);
  const second = await f.read();
  assert.equal(second.entries[0].responseComplete, true);
  assert.equal(second.entries[0].assistant.text, 'partial\n\nlater');
  assert.ok(second.cutoff[0].toByte > first.cutoff[0].toByte);
  assert.deepEqual(codexData._api.getCodexJsonlCacheStats(), before, 'snapshot never materializes a Main raw graph');
});

for (const mode of ['rewrite', 'lineage', 'global', 'unrelated']) test('actual worker reply admission: ' + mode, async t => {
  const f = fixture(t), request = f.client.request.bind(f.client);
  let calls = 0;
  f.client.request = async (...args) => {
    const result = await request(...args); calls++;
    if (mode === 'lineage') f.client.lineageCommitted(sid);
    else f.client.invalidate({ filePath: mode === 'global' ? null : mode === 'unrelated' ? f.file + '.other' : f.file });
    return result;
  };
  if (mode === 'unrelated') assert.equal((await f.read()).success, true);
  else await assert.rejects(f.read(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(calls, 1, 'a snapshot is one cut; do not silently retry another cut after revocation');
  assert.equal(f.client.diagnosticCounters.retries, 0);
});

test('late final diagnostic invalidation is rejected and a retained admission is revoked', async t => {
  const f = fixture(t);
  const value = await f.read();
  f.client.lineageCommitted(sid);
  assert.throws(() => f.client.assertSnapshotCurrent(value), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  f.client.diagnosticSlowMs = 0;
  f.client.onDiagnostic = event => {
    if (event.side === 'main' && event.event === 'call-complete' && event.outcome === 'success') {
      f.client.invalidate({ filePath: f.file });
    }
  };
  await assert.rejects(f.read(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('request bounds and unsupported fields fail before any source access', () => {
  for (const extra of [{ limit: 0 }, { limit: 9 }, { maxChars: -1 }, { maxChars: 20001 }, { maxChars: NaN }, { sourcePath: '/foreign' }]) {
    assert.throws(() => normalizeSessionSnapshotRequest({ sessionId: sid, ...extra }), { code: 'invalid_session_snapshot_request' });
  }
});

for (const mode of ['busy-append', 'stop', 'input', 'replacement', 'foreign', 'binding']) {
  test('actual read-only wrapper owner boundary: ' + mode, async () => {
    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const start = main.indexOf('function _captureSessionSnapshotOwner(request)'), end = main.indexOf('\nasync function _readSessionSnapshot', start);
    const state = { sessionId: sid, terminalId: 'physical', input: 0, stop: 0, busy: true };
    let readCalls = 0;
    const context = vm.createContext({
      _historyReadBindings: () => [{ provider: 'codex', tabId: 'own', source: 'tabs', sessionId: state.sessionId }],
      captureConversationOwner: () => ({ known: true, provider: 'codex', sessionId: state.sessionId,
        terminalId: state.terminalId, runSeq: 1, cwd: '/fixture' }),
      conversationOwners: { stored: () => ({ epoch: 'boot', revision: 1 }) },
      getTerminalLifecycleGeneration: () => 'physical:1', getTerminalStopRevision: () => state.stop,
      getTerminalInputRevision: () => state.input,
    });
    vm.runInContext(main.slice(start, end), context);
    const result = await readSessionSnapshot({ sessionId: sid, tabId: 'own' }, {
      resolve: async () => ({ provider: 'codex' }), captureOwner: context._captureSessionSnapshotOwner,
      captureRuntime: () => ({ known: true, sessionId: sid, turnId: 'open', busy: true, status: 'busy', liveLifecycle: true }),
      read: async () => { readCalls++;
        if (mode === 'busy-append') state.busy = false;
        else if (mode === 'input') state.input++;
        else if (mode === 'stop') state.stop++;
        else if (mode === 'replacement') state.terminalId = 'successor';
        else state.sessionId = 'foreign';
        return { success: true, totalIterations: 1, coverage: { trailingPartialBytes: 0 },
          entries: [{ iterationIndex: 0, turnId: 'open', responseComplete: false }] }; }, assertCurrent: () => {},
    }).catch(error => error);
    if (mode === 'busy-append') { assert.equal(result.entries[0].isCurrent, true); assert.equal(result.runtime.busy, true); }
    else assert.equal(result.code, 'CODEX_SOURCE_READ_INVALIDATED');
    assert.equal(readCalls, 1);
  });
}

test('actual Main route dispatches snapshot before strict full-turn reader and advertises capability', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = text.indexOf('async function handleOverseerRequest(rawUrl)'), end = text.indexOf('\nfunction ', start);
  const calls = [];
  const context = vm.createContext({ URL, require, path, srcMainDir: __dirname,
    _readSessionSnapshot: async value => { calls.push(value); return { success: true, asOf: 'cut', entries: [] }; },
    _loadSessionTurns: () => assert.fail('snapshot must not enter strict turns preparation'),
  });
  vm.runInContext(text.slice(start, end), context);
  const caps = await context.handleOverseerRequest('/overseer/capabilities');
  assert.equal(caps.body.sessionSnapshot.version, 1);
  const value = await context.handleOverseerRequest('/overseer/session/' + sid + '/snapshot?tabId=own&limit=2&maxChars=500');
  assert.equal(value.body.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ sessionId: sid, tabId: 'own', limit: 2, maxChars: 500 }]);
});

test('actual service resolves a virtual manifest, preserves parent+child coordinates and partial child', async t => {
  const f = fixture(t), parentId = '22222222-2222-4222-8222-222222222222';
  const parentFile = path.join(f.directory, 'parent.jsonl');
  const parentText = encode([{ type: 'session_meta', payload: { id: parentId, cwd: f.directory } },
    event('task_started', { turn_id: 'parent-turn' }), event('user_message', { message: 'parent task' }),
    answer('parent answer'), event('task_complete', { turn_id: 'parent-turn' })]);
  fs.writeFileSync(parentFile, parentText);
  const childPrefix = encode([{ type: 'session_meta', payload: { id: sid, forked_from_id: parentId, cwd: f.directory } }]);
  fs.writeFileSync(f.file, childPrefix + encode([event('task_started', { turn_id: 'child-turn' }),
    event('user_message', { message: 'child task' }), answer('partial child')]) + '{"type":"response_item"');
  const digest = text => createHash('sha256').update(text).digest('hex');
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: parentId, childSessionId: sid,
    sourceSegments: [{ physicalSessionId: parentId, fromByte: 0, toByte: Buffer.byteLength(parentText),
      startLine: 0, endLine: 5, prefixDigest: digest(parentText) }],
    childTailStart: { byteOffset: Buffer.byteLength(childPrefix), line: 1, prefixDigest: digest(childPrefix) } });
  const fork = { eventKey: 'fork-fixture', eventType: 'fork', provider: 'codex', sessionId: sid,
    childSessionId: sid, sourceSessionId: parentId, snapshotComplete: true, isDirect: true, origin: 'app', lineageManifest: manifest };
  let mutate = false;
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    codexData: { _api: { ...codexData._api, findCodexSessionFile: async id => ({ filePath: id === parentId ? parentFile : f.file }) } },
    sessionHistoryStore: { getSessionHistoryEvents: id => id === sid ? [fork] : [] },
    catalogSearchHooks: { onRead({ phase }) { if (mutate && phase === 'hydrate') { mutate = false; fork.occurredAt = 123; } } },
  });
  service.ensureCodexProviderForkLineage = () => assert.fail('read-only snapshot must not bootstrap a full/raw lineage graph');
  const value = await service.readSessionSnapshot({ sessionId: sid, cwd: f.directory });
  assert.deepEqual(value.entries.map(entry => [entry.iterationIndex, entry.turnIndex, entry.user.text]), [[0, 0, 'parent task'], [1, 1, 'child task']]);
  assert.equal(value.viewOwnerSessionId, sid);
  assert.equal(value.entries[0].physicalSessionId, parentId);
  assert.equal(value.entries[1].status, 'in_progress');
  assert.ok(value.coverage.trailingPartialBytes > 0);
  mutate = true;
  await assert.rejects(service.readSessionSnapshot({ sessionId: sid, cwd: f.directory }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  fs.unlinkSync(parentFile);
  await assert.rejects(service.readSessionSnapshot({ sessionId: sid, cwd: f.directory }));
});

test('cold paginated lineage is explicit unavailable without a full-history bootstrap or parent substitution', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, encode([{ type: 'session_meta', payload: { id: sid, cwd: f.directory, history_mode: 'paginated' } },
    event('task_started', { turn_id: 'open' }), event('user_message', { message: 'thin child' })]));
  await assert.rejects(f.read(), { code: 'history_lineage_unresolved' });
  assert.equal(f.client.diagnosticCounters.retries, 0);
});

for (const mode of ['unknown', 'inactive']) test('old complete response is historical under ' + mode + ' runtime', async () => {
  const value = await readSessionSnapshot({ sessionId: sid }, { resolve: async () => ({ provider: 'codex' }),
    captureOwner: () => 'same', captureRuntime: () => ({ known: true, status: mode, liveLifecycle: mode === 'unknown' ? null : false,
      sessionId: sid, turnId: 'old', busy: mode === 'unknown' ? null : false }),
    read: async () => ({ success: true, totalIterations: 1, coverage: { trailingPartialBytes: 0 },
      entries: [{ iterationIndex: 0, turnId: 'old', status: 'completed', responseComplete: true }] }), assertCurrent: () => {} });
  assert.equal(value.entries[0].isCurrent, false);
  assert.equal(value.entries[0].responseComplete, true, 'the historical outcome and current runtime remain separate');
});

test('an older completed iteration cannot become current by sharing the current provider turn ID', async () => {
  const value = await readSessionSnapshot({ sessionId: sid }, { resolve: async () => ({ provider: 'codex' }),
    captureOwner: () => 'same', captureRuntime: () => ({ known: true, status: 'busy', liveLifecycle: true,
      sessionId: sid, turnId: 'provider-turn', busy: true }),
    read: async () => ({ success: true, totalIterations: 2, coverage: { trailingPartialBytes: 0 }, entries: [
      { iterationIndex: 0, turnId: 'provider-turn', status: 'completed', responseComplete: true },
      { iterationIndex: 1, turnId: 'provider-turn', status: 'in_progress', responseComplete: false }] }), assertCurrent: () => {} });
  assert.equal(value.entries[0].isCurrent, false);
  assert.equal(value.entries[1].isCurrent, true);
});
