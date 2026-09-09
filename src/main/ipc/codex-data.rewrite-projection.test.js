'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// No user's CLI home or rollout is ever mutated by these file/commit tests.
let api, root;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rewrite-projection-'));
  process.env.CODEX_HOME = root;
  api = require('./codex-data')._api;
  api.setCodexUsageStateStoreForTests({
    db: { transaction: (fn) => fn },
    saveSessionForkEvent: (event) => {
      assert.equal(api.getCodexRewriteReceipt(event.childSessionId, event.sourceSessionId), null,
        'projection must not publish before lineage commits');
      return { eventKey: 'test:' + event.childSessionId };
    },
  });
});
test.after(async () => { api?.invalidateCodexHistoryProjectors(); await fs.rm(root, { recursive: true, force: true }); });

async function fixture(turns = 850, longOutput = null, redundantHeader = false) {
  const sessionId = randomUUID();
  const directory = path.join(root, 'sessions', '2026', '09', '09');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'rollout-2026-09-09T00-00-00-' + sessionId + '.jsonl');
  const records = [{ type: 'session_meta', payload: { id: sessionId, cwd: '/fixture' }, timestamp: '2026-09-08T00:00:00Z' }];
  if (redundantHeader) records.push({ type: 'session_meta', payload: { id: 'native-ancestor', cwd: '/ignored' }, timestamp: '2026-09-07T00:00:00Z' });
  for (let i = 0; i < turns; i += 1) {
    const add = (type, payload) => records.push({ type, payload, timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString() });
    add('turn_context', { model: 'gpt-5.6-sol', effort: 'high' });
    add('event_msg', { type: 'task_started' });
    add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ask ' + i }] });
    add('event_msg', { type: 'user_message', message: 'ask ' + i });
    add('response_item', { type: 'function_call', call_id: 'call-' + i, name: 'exec_command', arguments: '{"command":"pwd"}' });
    add('response_item', { type: 'function_call_output', call_id: 'call-' + i, output: i === 0 && longOutput ? longOutput : '/fixture' });
    add('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer ' + i }] });
    add('event_msg', { type: 'task_complete' });
    if (i === turns - 3) add('compacted', { message: 'saved compact' });
  }
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await api.projectCodexFullHistoryFromFile(sessionId, '/fixture');
  const before = await api.projectCodexTimelineFromFile(sessionId, '/fixture');
  return { sessionId, filePath, before };
}

for (const kind of ['delete-tail', 'edit-middle', 'delete-compact']) {
  test(kind + ': committed child reuses paired projection, exact cold parity, append and reopen', async () => {
    const source = await fixture();
    const sourceBytes = await fs.readFile(source.filePath);
    const target = kind === 'delete-compact'
      ? source.before.entries.find((entry) => entry.type === 'compact')
      : source.before.entries.find((entry) => entry.content === (kind === 'edit-middle' ? 'ask 780' : 'ask 849'));
    const params = { sessionId: source.sessionId, cwd: '/fixture', startUuid: target.uuid, endUuid: target.uuid };
    const result = kind === 'edit-middle'
      ? await api.editCodexRange({ ...params, compactText: 'edited prompt' }) : await api.deleteCodexRange(params);
    assert.equal(result.success, true, result.error);
    const receipt = api.getCodexRewriteReceipt(result.newSessionId, source.sessionId);
    assert.ok(receipt?.records.length > 6000, 'exact unchanged prefix receipt');
    assert.ok(receipt.reusedRecords >= 6144, 'not merely moving a full projection before paint');
    const warm = await api.projectCodexFullHistoryFromFile(result.newSessionId, '/fixture');
    const timeline = await api.projectCodexTimelineFromFile(result.newSessionId, '/fixture');
    assert.equal(warm.mode, 'unchanged');
    assert.equal(warm.fedRecords, 0, 'no post-commit re-read or replay');
    assert.equal(timeline.mode, 'unchanged');
    const loaded = await api.loadSessionRecords(result.newSessionId, '/fixture');
    assert.deepEqual(warm.entries, api.buildCodexFullHistory(loaded.records, result.newSessionId));
    assert.deepEqual(timeline.entries, api.buildCodexTimeline(loaded.records, result.newSessionId));
    assert.deepEqual(await fs.readFile(source.filePath), sourceBytes, 'ancestor unchanged');
    if (kind === 'delete-tail') {
      const tail = timeline.entries.filter((entry) => entry.type === 'user').at(-1);
      const again = await api.deleteCodexRange({ sessionId: result.newSessionId, cwd: '/fixture', startUuid: tail.uuid, endUuid: tail.uuid });
      assert.equal(again.success, true, again.error);
      assert.ok(api.getCodexRewriteReceipt(again.newSessionId, result.newSessionId)?.reusedRecords >= 6144,
        'the child inherits a reusable checkpoint for the next Rewind');
      const againWarm = await api.projectCodexFullHistoryFromFile(again.newSessionId, '/fixture');
      const againCold = await api.loadSessionRecords(again.newSessionId, '/fixture');
      assert.deepEqual(againWarm.entries, api.buildCodexFullHistory(againCold.records, again.newSessionId));
    }
    await fs.appendFile(result.filePath, JSON.stringify({ type: 'event_msg', timestamp: '2026-09-09T01:00:00Z', payload: { type: 'user_message', message: 'new child turn' } }) + '\n');
    const appended = await api.projectCodexFullHistoryFromFile(result.newSessionId, '/fixture');
    assert.equal(appended.mode, 'append');
    assert.equal(appended.fedRecords, 1);
    assert.equal(api.getCodexRewriteReceipt(result.newSessionId, source.sessionId), null, 'receipt cannot describe a newer revision');
    api.invalidateCodexHistoryProjectors(result.filePath);
    const reopened = await api.projectCodexFullHistoryFromFile(result.newSessionId, '/fixture');
    assert.deepEqual(reopened.entries, appended.entries, 'reload reconstructs the same branch without a receipt');
  });
}

test('explicit inPlace invalidates an already-warm old projection', async () => {
  const source = await fixture(4);
  const target = source.before.entries.at(-1);
  const result = await api.deleteCodexRangeInPlace({ sessionId: source.sessionId, cwd: '/fixture', startUuid: target.uuid, endUuid: target.uuid });
  assert.equal(result.success, true, result.error);
  const next = await api.projectCodexTimelineFromFile(source.sessionId, '/fixture');
  assert.equal(next.mode, 'rebuild');
  assert.ok(!next.entries.some((entry) => entry.content === target.content));
});

test('a subscribed hidden consumer observes inPlace replacement and subsequent append', async (t) => {
  const { SessionTranscriptService } = require('../session-transcript-service');
  const source = await fixture(4);
  const changes = [];
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: require('./codex-data'), onChanged: (event) => changes.push(event) });
  t.after(() => { for (const state of service.sessions.values()) service._closeState(state, 'test-complete'); });
  const owner = { toolType: 'codex', sessionId: source.sessionId, cwd: '/fixture', tabId: 'hidden-repair', consumerId: 'hidden-repair' };
  assert.equal((await service.subscribe(owner)).success, true);
  const before = await service.getHistory({ ...owner, dehydrate: true });
  const tail = source.before.entries.filter((entry) => entry.type === 'user').at(-1);
  const repair = await api.deleteCodexRangeInPlace({ sessionId: source.sessionId, cwd: '/fixture', startUuid: tail.uuid, endUuid: tail.uuid });
  assert.equal(repair.success, true, repair.error);
  const waitForSize = async (size) => {
    const end = Date.now() + 1500;
    while (Date.now() < end && !changes.some((change) => change.size === size)) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(changes.some((change) => change.size === size), 'watcher must observe exact new size before the 10s reconcile fallback');
  };
  await waitForSize(repair.size);
  const after = await service.getHistory({ ...owner, dehydrate: true, ifRevision: before.revision });
  assert.notEqual(after.unchanged, true);
  assert.ok(!after.entries.some((row) => row.content === tail.content));
  await fs.appendFile(source.filePath, JSON.stringify({ type: 'event_msg', timestamp: '2026-09-09T00:00:00Z', payload: { type: 'user_message', message: 'after repair' } }) + '\n');
  await waitForSize((await fs.stat(source.filePath)).size);
});

test('materializing virtual source records strips read-only provenance; file and prepared reader agree', async () => {
  const filePath = path.join(root, 'materialized-child.jsonl');
  const written = await api.writeCodexJsonlExclusive(filePath, [
    { type: 'session_meta', timestamp: '2026-09-09T00:00:00Z', payload: { id: 'new-physical' }, __physicalSessionId: 'old-physical', __segmentId: 'prefix', __segmentIndex: 0 },
    { type: 'event_msg', timestamp: '2026-09-09T00:00:01Z', payload: { type: 'user_message', message: 'preserved' }, __physicalSessionId: 'old-physical', __segmentId: 'prefix', __segmentIndex: 0, __line: 7, __byteOffset: 44 },
  ]);
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /__physicalSessionId|__segmentId|__segmentIndex|__line|__byteOffset/);
  const read = await api.readJsonlRange(filePath, 0, written.size - 1);
  assert.deepEqual(written.records, read.records);
  assert.equal(api.buildCodexFullHistory(read.records, 'new-physical')[0].sessionId, 'new-physical');
});

test('checkpoint payloads stay bounded and expand from the child, never a later ancestor result', async () => {
  const { dehydrateHistoryEntries, historyPayloadStash } = require('../history-payload-dehydrate');
  const { SessionTranscriptService } = require('../session-transcript-service');
  const fullOutput = 'EXACT CHILD OUTPUT\n' + 'x'.repeat(120_000);
  const source = await fixture(850, fullOutput);
  const tail = source.before.entries.filter((entry) => entry.type === 'user').at(-1);
  const result = await api.deleteCodexRange({ sessionId: source.sessionId, cwd: '/fixture', startUuid: tail.uuid, endUuid: tail.uuid });
  assert.equal(result.success, true, result.error);
  assert.ok(api.getCodexRewriteReceipt(result.newSessionId, source.sessionId).reusedRecords >= 6144);
  const warm = await api.projectCodexFullHistoryFromFile(result.newSessionId, '/fixture');
  const loaded = await api.loadSessionRecords(result.newSessionId, '/fixture');
  const expected = api.buildCodexFullHistory(loaded.records, result.newSessionId);
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: result.newSessionId, entries: expected });
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: result.newSessionId, entries: warm.entries });
  assert.deepEqual(warm.entries, expected);
  const ref = warm.entries.flatMap((row) => row.actions || []).find((action) => action.rawTool?.resultRef)?.rawTool.resultRef;
  assert.ok(ref);
  historyPayloadStash.set('codex', source.sessionId, ref.payloadId, 'WRONG LATER ANCESTOR VALUE');
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: api } });
  const payload = await service.getToolPayload({ toolType: 'codex', sessionId: result.newSessionId, cwd: '/fixture', payloadId: ref.payloadId });
  assert.equal(payload.success, true, payload.error);
  assert.equal(payload.payload, fullOutput);
  assert.ok(api.getCodexHistoryProjectorStats().approxBytes <= api.getCodexHistoryProjectorStats().budgetBytes);
});

test('service sends a cross-session delta without unchanged prefix bodies and without reading an evicted baseline', async () => {
  const { SessionTranscriptService } = require('../session-transcript-service');
  const source = await fixture();
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: api } });
  const hydrate = { centerUuid: source.before.entries[10].uuid, radius: 20, alwaysHydrateTail: 5 };
  const previous = await service.getHistory({ toolType: 'codex', sessionId: source.sessionId, cwd: '/fixture', tabId: 'delta-tab', dehydrate: true, hydrate, deltaOk: true });
  assert.equal(previous.success, true, previous.error);
  const tail = source.before.entries.filter((entry) => entry.type === 'user').at(-1);
  const result = await api.deleteCodexRange({ sessionId: source.sessionId, cwd: '/fixture', startUuid: tail.uuid, endUuid: tail.uuid });
  const request = { toolType: 'codex', sessionId: result.newSessionId, cwd: '/fixture', tabId: 'delta-tab', dehydrate: true, hydrate,
    rewriteFrom: { sessionId: source.sessionId, revision: previous.revision }, deltaOk: true };
  const delta = await service.getHistory(request);
  assert.equal(delta.success, true, delta.error);
  assert.equal(delta.rewriteDelta, true);
  assert.equal(delta.entries, undefined, 'unchanged row bodies never cross IPC again');
  assert.ok(delta.carriedEntries.length > 2000);
  assert.ok(delta.changedEntries.length < 20);
  const { createProjectionIdentityMap, remapHistoryRowIdentity } = require('../../shared/codex-rewrite-identities.cjs');
  const mapping = createProjectionIdentityMap(source.sessionId, result.newSessionId, delta.rewriteReceipt.records);
  const baseline = new Map(previous.entries.map((row) => [row.uuid, row]));
  const assembled = new Map(delta.carriedEntries.map((pair) => [pair.uuid, remapHistoryRowIdentity(baseline.get(pair.sourceUuid), mapping)]));
  delta.changedEntries.forEach((row) => assembled.set(row.uuid, row));
  const full = await service.getHistory({ ...request, hydrate: delta.hydrationRequest, rewriteFrom: undefined });
  assert.deepEqual(delta.order.map((uuid) => assembled.get(uuid)), full.entries);
  api.invalidateCodexHistoryProjectors(source.filePath);
  const fallback = await service.getHistory(request);
  assert.equal(fallback.rewriteDelta, undefined);
  assert.ok(fallback.entries?.length > 2000);
  const probe = await api.projectCodexFullHistoryFromFile(source.sessionId, '/fixture', { cacheOnly: true });
  assert.equal(probe.error, 'cached_projection_unavailable', 'baseline optimization must not re-read a cold ancestor');
});

test('redundant native headers may disappear without throwing away a proven semantic prefix', async () => {
  const source = await fixture(850, null, true);
  const target = source.before.entries.filter((entry) => entry.type === 'user').at(-1);
  const result = await api.deleteCodexRange({ sessionId: source.sessionId, cwd: '/fixture', startUuid: target.uuid, endUuid: target.uuid });
  assert.equal(result.success, true, result.error);
  assert.equal(api.getCodexRewriteReceipt(result.newSessionId, source.sessionId).reusedRecords, 6143,
    'one ignored header is removed from the consumed source checkpoint');
  const warm = await api.projectCodexFullHistoryFromFile(result.newSessionId, '/fixture');
  const loaded = await api.loadSessionRecords(result.newSessionId, '/fixture');
  assert.deepEqual(warm.entries, api.buildCodexFullHistory(loaded.records, result.newSessionId));
  const timeline = await api.projectCodexTimelineFromFile(result.newSessionId, '/fixture');
  assert.deepEqual(timeline.entries, api.buildCodexTimeline(loaded.records, result.newSessionId));
});

test('inPlace cannot serve an old compact payload when the next compact takes its physical line', async () => {
  const { SessionTranscriptService } = require('../session-transcript-service');
  const sessionId = randomUUID();
  const filePath = path.join(root, 'sessions', 'rollout-2026-09-09T00-00-00-' + sessionId + '.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const a = 'A'.repeat(20_000), b = 'B'.repeat(20_000);
  await fs.writeFile(filePath, [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/fixture' }, timestamp: '2026-09-08T00:00:00Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'retained root' }, timestamp: '2026-09-08T00:00:00Z' },
    { type: 'compacted', payload: { message: a }, timestamp: '2026-09-08T00:00:01Z' },
    { type: 'compacted', payload: { message: b }, timestamp: '2026-09-08T00:00:02Z' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: api } });
  const owner = { toolType: 'codex', sessionId, cwd: '/fixture', dehydrate: true };
  const previous = await service.getHistory(owner);
  const compactA = previous.entries.find((entry) => entry.role === 'compact');
  assert.equal(previous.entries.filter((entry) => entry.role === 'compact').length, 2, 'two distinct compact records before repair');
  const previousRef = compactA.compactSummaryRef;
  const beforeRecords = await api.loadSessionRecords(sessionId, '/fixture');
  const plan = api.planCodexRangeRewrite(beforeRecords.records, sessionId, compactA.uuid, compactA.uuid);
  assert.equal(plan.outputRecords.filter((record) => record.type === 'compacted').length, 1, 'repair retains the second compact');
  const repair = await api.deleteCodexRangeInPlace({ sessionId, cwd: '/fixture', startUuid: compactA.uuid, endUuid: compactA.uuid,
    codexSettingsProof: { sessionId, model: 'gpt-5.6-sol', effort: 'high', proofAt: Date.now() } });
  assert.equal(repair.success, true, repair.error);
  // Ask immediately, before another getHistory can overwrite the stale stash.
  const obsolete = await service.getToolPayload({ ...owner, payloadId: previousRef.payloadId, payloadGeneration: previous.payloadGeneration });
  assert.equal(obsolete.error, 'history_payload_generation_changed', 'a request from the old physical file must not read the replacement');
  const payload = await service.getToolPayload({ ...owner, payloadId: previousRef.payloadId });
  assert.equal(payload.success, true, payload.error);
  assert.equal(payload.payload.length, b.length);
  assert.equal(payload.payload[0], 'B');
  assert.ok(payload.payload === b, 'complete payload must come from the replacement file');
  const current = await service.getHistory(owner);
  assert.notEqual(current.payloadGeneration, previous.payloadGeneration);
});
