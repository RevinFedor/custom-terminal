'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto'), zlib = require('node:zlib');
const { execFileSync, fork } = require('node:child_process');
// Configure only this synthetic test process, never the user's Codex home.
const fixtureCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compressed-integration-'));
process.env.CODEX_HOME = fixtureCodexHome;
const { _api: api } = require('./ipc/codex-data');
const { closeCodexRolloutReadViews } = require('./codex-rollout-read-views');
const { scanTranscriptFile } = require('./transcript-grep');
const { HistoryReadClient } = require('./history-read-client');
const { HistoryProcessTransport } = require('./history-read-process-transport');
const { SessionTranscriptService } = require('./session-transcript-service');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { createHash } = require('node:crypto');
const encode = records => Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
const compress = bytes => zlib.zstdCompressSync ? zlib.zstdCompressSync(bytes)
  : execFileSync('zstd', ['-q', '-c'], { input: bytes });
function records(id) {
  return [
    { type: 'session_meta', payload: { id, session_id: id, cwd: fixtureCodexHome, originator: 'codex-tui', source: 'cli' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'max' } },
    { type: 'compacted', payload: { message: 'compact witness', replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-preserved-exact' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Проверка 😀 compressed-input' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'compressed-answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}
async function source(id = randomUUID(), archive = false) {
  const directory = archive ? path.join(fixtureCodexHome, 'archived_sessions') : path.join(fixtureCodexHome, 'sessions', '2026', '10', '25');
  await fsp.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'rollout-' + id + '.jsonl.zst'), value = records(id), bytes = compress(encode(value));
  await fsp.writeFile(filePath, bytes);
  return { id, directory, filePath, records: value, bytes };
}
test.after(async () => { await closeCodexRolloutReadViews(); await fsp.rm(fixtureCodexHome, { recursive: true, force: true }); });

test('actual Codex source loader reads compressed records, retains opaque compaction and logical offsets', async () => {
  const f = await source(), loaded = await api.loadSessionRecords(f.id, fixtureCodexHome);
  assert.equal(loaded.success, true, loaded.error);
  assert.equal(loaded.records.length, f.records.length);
  assert.equal(loaded.records[2].payload.replacement_history[0].encrypted_content, 'opaque-preserved-exact');
  assert.equal(loaded.records[3].payload.message, f.records[3].payload.message);
  assert.equal((await fsp.stat(loaded.filePath)).size, encode(f.records).length);
  const timeline = api.buildCodexTimeline(loaded.records, f.id);
  assert.ok(timeline.some(r => r.content === f.records[3].payload.message));
  assert.deepEqual(await fsp.readFile(f.filePath), f.bytes);
  await assert.rejects(fsp.stat(f.filePath.slice(0, -4)), { code: 'ENOENT' });
});

test('archived compressed source can be read without restoring or changing the archive', async () => {
  const f = await source(randomUUID(), true), loaded = await api.loadSessionRecords(f.id, fixtureCodexHome);
  assert.equal(loaded.success, true, loaded.error);
  assert.equal(loaded.records.at(-1).payload.type, 'task_complete');
  assert.deepEqual(await fsp.readFile(f.filePath), f.bytes);
});

test('compressed resume source preserves the saved model/effort without a model call', async () => {
  const f = await source();
  const result = await api.loadResumeSource(f.id, fixtureCodexHome, { purpose: 'launch' });
  assert.equal(result.success, true, result.error);
  assert.equal(result.sourceSettingsProof.model, 'gpt-6.1-sol');
  assert.equal(result.sourceSettingsProof.effort, 'max');
  assert.deepEqual(await fsp.readFile(f.filePath), f.bytes);
});

test('literal transcript search never silently treats zstd binary bytes as an empty transcript', async () => {
  const f = await source();
  const result = await scanTranscriptFile({ filePath: f.filePath, needle: 'compressed-answer', maxMatches: 1 });
  assert.equal(result.error, null); assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].snippet.includes('compressed-answer'));
});

test('COW compact fork leaves the compressed parent untouched and writes a native plain child', async () => {
  const f = await source();
  // Only the SQLite commit boundary is controlled here. File IO/parser/COW
  // construction and provider namespace are the real implementation.
  api.setCodexUsageStateStoreForTests({ db: { transaction: fn => fn },
    saveSessionForkEvent: event => ({ ...event, eventKey: 'compressed-test-event' }) });
  try {
    const result = await api.forkCodexFromLatestCompact({ sessionId: f.id, cwd: fixtureCodexHome });
    assert.equal(result.success, true, result.error);
    assert.ok(result.filePath.startsWith(path.join(fixtureCodexHome, 'sessions')));
    assert.ok(result.filePath.endsWith('.jsonl'));
    assert.notEqual(result.newSessionId, f.id);
    assert.deepEqual(await fsp.readFile(f.filePath), f.bytes);
    const child = await api.loadSessionRecords(result.newSessionId, fixtureCodexHome);
    assert.equal(child.records[0].payload.id, result.newSessionId);
    assert.ok(child.records.some(r => r.payload?.replacement_history?.[0]?.encrypted_content === 'opaque-preserved-exact'));
  } finally { api.setCodexUsageStateStoreForTests(null); }
});

test('explicit in-place rewrite commits to the native source, not just its temporary read view', async () => {
  const f = await source(), loaded = await api.loadSessionRecords(f.id, fixtureCodexHome);
  const next = structuredClone(f.records); next[4].payload.content[0].text = 'rewritten-native-answer';
  const result = await api.replaceCodexSessionFileInPlace({ filePath: loaded.filePath, records: next, sourceSnapshot: loaded.sourceSnapshot, sessionId: f.id });
  assert.equal(result.filePath, f.filePath.slice(0, -4));
  assert.deepEqual(await fsp.readFile(result.backupPath), encode(f.records));
  const reread = await api.loadSessionRecords(f.id, fixtureCodexHome);
  assert.equal(reread.records[4].payload.content[0].text, 'rewritten-native-answer');
  await assert.rejects(fsp.stat(f.filePath), { code: 'ENOENT' });
});

test('thin app fork verifies a compressed parent against its original logical byte prefix', async () => {
  const parent = await source(), id = randomUUID();
  const prelude = [{ type: 'session_meta', payload: { id, cwd: fixtureCodexHome, forked_from_id: parent.id } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied' } }];
  const childRecords = [...prelude, { type: 'event_msg', payload: { type: 'user_message', message: 'child-tail' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child-answer' }] } }];
  const childPath = path.join(parent.directory, 'rollout-' + id + '.jsonl');
  await fsp.writeFile(childPath, encode(childRecords));
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: parent.id, childSessionId: id,
    sourceSegments: [{ physicalSessionId: parent.id, fromByte: 0, toByte: encode(parent.records).length,
      startLine: 0, endLine: parent.records.length, prefixDigest: createHash('sha256').update(encode(parent.records)).digest('hex') }],
    childTailStart: { byteOffset: encode(prelude).length, line: prelude.length, prefixDigest: createHash('sha256').update(encode(prelude)).digest('hex') } });
  const event = { eventKey: 'fork:codex:' + parent.id + ':' + id, eventType: 'fork', provider: 'codex',
    sessionId: id, sourceSessionId: parent.id, childSessionId: id, snapshotComplete: true, isDirect: true, origin: 'app', lineageManifest: manifest };
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: api },
    sessionHistoryStore: { getSessionHistoryEvents: sid => sid === id ? [event] : [] } });
  const result = await service.getTimeline({ toolType: 'codex', sessionId: id, cwd: fixtureCodexHome });
  assert.equal(result.success, true, result.error + ':' + result.lineageReason);
  assert.equal(result.composite, true);
  assert.equal(result.entries.filter(e => e.type === 'user').length, 2);
  assert.deepEqual(await fsp.readFile(parent.filePath), parent.bytes);
});

test('actual isolated reader process publishes cold History from compressed source and fences native-path invalidations', async t => {
  const f = await source(), events = [];
  const client = new HistoryReadClient({ cacheDirectory: path.join(fixtureCodexHome, 'worker-cache'),
    sessionsDir: path.join(fixtureCodexHome, 'sessions'), memoryBudgetMb: 64,
    onDiagnostic: event => events.push(event),
    createTransport: workerData => {
      const child = fork(path.join(__dirname, 'history-read-process.js'), [], { serialization: 'advanced',
        env: { ...process.env, NOTED_HISTORY_READER_PROCESS: '1', NOTED_HISTORY_READER_NODE_TEST: '1' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      return new HistoryProcessTransport(child, workerData, { node: true });
    } });
  t.after(async () => { client.worker?.ref(); await client.close(); });
  const payload = { toolType: 'codex', sessionId: f.id, cwd: fixtureCodexHome, tabId: 'own-compressed-fixture', dehydrate: false };
  const result = await client.call('getHistory', payload);
  assert.equal(result.success, true, result.error);
  assert.ok(result.entries.some(r => r.content === 'compressed-answer'));
  const aliases = client.sourceReadAliases.get(f.filePath.slice(0, -4));
  assert.ok(aliases?.size, 'Main must know the native counterpart of its worker read view');
  const view = [...aliases][0], slot = client.sourceEpochSlots.get(view), before = Atomics.load(client.sourceEpochs, slot);
  client.invalidate({ filePath: f.filePath.slice(0, -4), sourceAppend: true });
  assert.equal(Atomics.load(client.sourceEpochs, slot), before + 1, 'native source changes fence the decoded view synchronously');
  assert.deepEqual(await fsp.readFile(f.filePath), f.bytes);
});
