'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
let root, api, codexData;
const { HistoryReadClient } = require('./history-read-client');
const { SessionTranscriptService } = require('./session-transcript-service');
const encode = records => records.map(r => JSON.stringify(r) + '\n').join('');
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-rewrite-worker-'));
  process.env.CODEX_HOME = root;
  codexData = require('./ipc/codex-data'); api = codexData._api;
  api.setCodexUsageStateStoreForTests({ db: { transaction: fn => fn }, saveSessionForkEvent: () => ({ eventKey: 'private-cow' }) });
});
test.after(async () => { api.setCodexRewriteProjectionPublisher?.(null); api.invalidateCodexHistoryProjectors(); await fs.rm(root, { recursive: true, force: true }); });

async function fixture(t) {
  const sid = randomUUID(), cwd = '/fixture', directory = path.join(root, sid), sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const records = [{ type: 'session_meta', timestamp: '2026-10-15T00:00:00Z', payload: { id: sid, cwd } }];
  for (let i = 0; i < 780; i++) {
    const timestamp = new Date(Date.UTC(2026, 9, 15) + i * 1000).toISOString();
    records.push({ type: 'turn_context', timestamp, payload: { model: 'fixture-model', effort: 'high' } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'question ' + i } });
    if (i === 20) records.push({ type: 'response_item', timestamp, payload: { type: 'function_call',
      name: 'exec_command', call_id: 'retained-call', arguments: '{"command":"pwd"}' } },
    { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'retained-call', output: 'RETAINED\n' + 'x'.repeat(70000) } });
    records.push({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer ' + i }] } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete' } });
  }
  const file = path.join(sessionsDir, 'rollout-' + sid + '.jsonl');
  // Blank physical lines distinguish record-index checkpoints from __line.
  const sourceBytes = Buffer.from(records.map((r, i) => JSON.stringify(r) + (i % 19 === 0 ? '\n\n' : '\n')).join(''));
  await fs.writeFile(file, sourceBytes);
  const config = { codexData, sessionsDir, cacheDirectory: path.join(directory, 'cache'), memoryBudgetMb: 64 };
  let client = new HistoryReadClient(config), prepared;
  api.setCodexRewriteProjectionPublisher?.(async request => { prepared = await client.prepareCodexRewrite(request); return prepared; });
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData });
  service.historyReader = client;
  t.after(async () => { await client.close(); api.setCodexRewriteProjectionPublisher?.(null); api.invalidateCodexHistoryProjectors(); });
  const owner = { sessionId: sid, toolType: 'codex', cwd, tabId: 'private-tab', dehydrate: true };
  const first = await service.getHistory(owner);
  assert.equal(first.success, true, first.error);
  const loaded = await api.loadSessionRecords(sid, cwd);
  const target = api.buildCodexTimeline(loaded.records, sid).filter(r => r.type === 'user').at(-1);
  return { sid, cwd, file, sourceBytes, owner, first, service, get client() { return client; }, get prepared() { return prepared; },
    rewrite: (kind = 'tail') => {
      const selected = kind === 'tail' ? target : api.buildCodexTimeline(loaded.records, sid).find(r => r.content === 'question 600');
      const args = { sessionId: sid, cwd, startUuid: selected.uuid, endUuid: selected.uuid };
      return kind === 'edit' ? api.editCodexRange({ ...args, compactText: 'replacement 600' })
        : api.deleteCodexRange({ ...args, toPhysicalEnd: kind === 'tail' });
    },
    async restart() { await client.close(); client = new HistoryReadClient(config); service.historyReader = client; } };
}

test('actual configured worker reuses exact prefix; Main does not replay a second graph; child payload and restart/append stay canonical', async t => {
  const f = await fixture(t);
  assert.equal(api.getCodexHistoryProjectorStats().sessions, 0);
  const before = await f.client.call('stats');
  const rewrite = await f.rewrite(); assert.equal(rewrite.success, true, rewrite.error);
  const after = await f.client.call('stats');
  const childBytes = await fs.readFile(rewrite.filePath);
  assert.equal(api.getCodexHistoryProjectorStats().sessions, 0, 'no duplicate Main paired replay');
  assert.ok(f.prepared.reusedRecords >= 2048, JSON.stringify(f.prepared));
  assert.ok(after.sourceBytes - before.sourceBytes < childBytes.length / 2, 'worker reads the remaining physical tail only');
  const childOwner = { ...f.owner, sessionId: rewrite.newSessionId };
  const child = await f.service.getHistory({ ...childOwner, rewriteFrom: { sessionId: f.sid, revision: f.first.revision } });
  assert.equal(child.success, true, child.error);
  assert.equal(child.rewriteReceipt?.headerRecord, undefined, 'no private provider header in public DTO');
  assert.equal(child.rewriteReceipt?.sourceProof, undefined);
  assert.equal((await f.client.call('stats')).sourceBytes, after.sourceBytes, 'next real configured History does not read/replay child again');
  const loaded = await api.loadSessionRecords(rewrite.newSessionId, f.cwd);
  const timeline = await f.service.getTimeline(childOwner);
  assert.deepEqual(timeline.entries, api.buildCodexTimeline(loaded.records, rewrite.newSessionId));
  const full = await f.service.getHistory({ ...childOwner, dehydrate: false });
  assert.equal(full.entries.some(r => r.content === 'question 779'), false);
  assert.equal(full.entries.some(r => r.content === 'answer 779'), false);
  const dehydrate = await f.service.getHistory(childOwner);
  const ref = dehydrate.entries.flatMap(r => r.actions || []).map(a => a.rawTool?.resultRef).find(Boolean);
  assert.ok(ref);
  const payload = await f.service.getToolPayload({ ...childOwner, payloadId: ref.payloadId });
  assert.equal(payload.payload, 'RETAINED\n' + 'x'.repeat(70000));
  assert.deepEqual(await fs.readFile(f.file), f.sourceBytes);
  const writtenHash = createHash('sha256').update(childBytes).digest('hex');
  assert.equal(api.getCodexRewriteReceipt(rewrite.newSessionId, f.sid).sourceProof[0].hash, writtenHash);
  await f.restart();
  const suffix = encode([{ type: 'event_msg', timestamp: '2026-10-15T01:00:00Z', payload: { type: 'user_message', message: 'new real child input' } }]);
  await fs.appendFile(rewrite.filePath, suffix);
  const append = await f.service.getHistory(childOwner);
  assert.equal(append.entries.at(-1).content, 'new real child input');
  const restartStats = await f.client.call('stats');
  assert.equal(restartStats.sourceBytes, Buffer.byteLength(suffix));
  assert.equal(restartStats.sourceVerificationBytes, childBytes.length, 'writer proof covers complete prefix, not just replay tail');
});

for (const miss of ['evicted', 'source-changed']) test('configured worker ' + miss + ' falls back once, never duplicates Main replay', async t => {
  const f = await fixture(t);
  if (miss === 'evicted') await f.client.call('releaseMemory');
  else await fs.appendFile(f.file, '\n');
  const before = await f.client.call('stats');
  const rewrite = await f.rewrite(); assert.equal(rewrite.success, true, rewrite.error);
  const after = await f.client.call('stats');
  assert.equal(api.getCodexHistoryProjectorStats().sessions, 0);
  assert.equal(f.prepared.reusedRecords, 0);
  assert.equal(after.sourceBytes - before.sourceBytes, (await fs.stat(rewrite.filePath)).size);
  assert.equal(api.getCodexHistoryProjectorStats().sessions, 0);
  const child = await f.service.getHistory({ ...f.owner, sessionId: rewrite.newSessionId });
  assert.equal(child.success, true);
  assert.equal((await f.client.call('stats')).sourceBytes, after.sourceBytes);
});

for (const kind of ['middle', 'edit']) test('worker checkpoint preserves canonical ' + kind + ' semantics and repeat COW', async t => {
  const f = await fixture(t), result = await f.rewrite(kind);
  assert.equal(result.success, true, result.error);
  assert.ok(f.prepared.reusedRecords >= 2048);
  const owner = { ...f.owner, sessionId: result.newSessionId };
  const loaded = await api.loadSessionRecords(result.newSessionId, f.cwd);
  const timeline = await f.service.getTimeline(owner);
  assert.deepEqual(timeline.entries, api.buildCodexTimeline(loaded.records, result.newSessionId));
  assert.equal(timeline.entries.some(r => r.content === 'question 779'), true);
  assert.equal(timeline.entries.some(r => r.content === 'replacement 600'), kind === 'edit');
  const tail = timeline.entries.filter(r => r.type === 'user').at(-1);
  const again = await api.deleteCodexRange({ sessionId: result.newSessionId, cwd: f.cwd, startUuid: tail.uuid, endUuid: tail.uuid, toPhysicalEnd: true });
  assert.equal(again.success, true, again.error);
  assert.ok(f.prepared.reusedRecords >= 2048, 'the child keeps its own bounded reusable checkpoint');
  const againLoaded = await api.loadSessionRecords(again.newSessionId, f.cwd);
  const againTimeline = await f.service.getTimeline({ ...owner, sessionId: again.newSessionId });
  assert.deepEqual(againTimeline.entries, api.buildCodexTimeline(againLoaded.records, again.newSessionId));
  assert.deepEqual(await fs.readFile(f.file), f.sourceBytes);
});

test('worker preparation failure cannot discard a committed COW or force Main replay', async t => {
  const f = await fixture(t);
  api.setCodexRewriteProjectionPublisher(async () => { throw Error('controlled unavailable reader'); });
  const result = await f.rewrite();
  assert.equal(result.success, true, result.error);
  assert.equal(api.getCodexHistoryProjectorStats().sessions, 0);
  const source = await api.loadResumeSource(result.newSessionId, f.cwd);
  assert.equal(source.mode, 'unchanged');
  const child = await f.service.getHistory({ ...f.owner, sessionId: result.newSessionId });
  assert.equal(child.success, true, child.error);
  assert.deepEqual(await fs.readFile(f.file), f.sourceBytes);
});

test('coordinate retention shares the existing budget; eviction cannot remove worker/canonical capability', async t => {
  const previous = api.getCodexHistoryProjectorStats().budgetBytes;
  t.after(() => api.setCodexProjectionRuntimeBudgetBytes(previous));
  api.setCodexProjectionRuntimeBudgetBytes(1024 * 1024);
  const f = await fixture(t), result = await f.rewrite();
  assert.equal(result.success, true, result.error);
  assert.ok(f.prepared.reusedRecords >= 2048, 'private transport does not depend on retained renderer receipt');
  assert.equal(api.getCodexRewriteReceipt(result.newSessionId, f.sid), null);
  assert.ok(api.getCodexHistoryProjectorStats().approxBytes <= 1024 * 1024);
  const before = await f.client.call('stats');
  assert.equal((await f.service.getHistory({ ...f.owner, sessionId: result.newSessionId })).success, true);
  assert.equal((await f.client.call('stats')).sourceBytes, before.sourceBytes);
});
