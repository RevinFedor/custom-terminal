'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _api } = require('./ipc/codex-data');
const { createCodexResultReader } = require('./codex-result-reader');

const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const start = (turn_id, extra = {}) => event('task_started', { turn_id, ...extra });
const user = message => event('user_message', { message });
const goal = () => user('<codex_internal_context source="goal">continue</codex_internal_context>');
const answer = text => ({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', content: [{ type: 'output_text', text }],
} });
const done = (turn_id, last_agent_message) => event('task_complete', { turn_id, last_agent_message });
const oldTurn = () => [start('A'), user('original'), answer('OLD'), done('A', 'OLD')];
const latestTurn = () => [start('B'), goal(), answer('LATEST'), done('B', 'LATEST')];
const encode = records => records.map(record => JSON.stringify(record) + '\n').join('');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function reader() {
  return createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector,
    buildResult: _api.buildCodexProviderTurnAssistantResult, extractText: _api.extractTextContent,
    userIdentity: _api.getCodexUserRecordIdentity, isCompactPayload: _api.isCompactPayload,
    extractReasoning: _api.extractReasoning, findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy() { throw new Error('historical observation cannot fall back to raw History'); },
    log: { log() {}, warn() {} } });
}

function fixture(t, records, { parent = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-historical-observation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child.jsonl');
  fs.writeFileSync(file, encode(records));
  const parentFile = parent && path.join(dir, 'parent.jsonl');
  const parentBytes = parent && Buffer.from(encode(parent));
  if (parent) fs.writeFileSync(parentFile, parentBytes);
  const prefixHash = parent && digest(parentBytes);
  const instance = reader();
  const resolveSource = async ({ verifyDigests = false } = {}) => {
    const stat = await fs.promises.stat(file);
    const parentValid = !parent || !verifyDigests
      || digest((await fs.promises.readFile(parentFile)).subarray(0, parentBytes.length)) === prefixHash;
    return { success: true, sessionId: 'S', viewOwnerSessionId: 'S', revisionKey: file,
      digestsVerified: parentValid,
      sourceVerificationBytes: parent && verifyDigests ? parentBytes.length : 0,
      sourceSnapshot: { filePath: file, sessionId: 'S', size: stat.size, mtimeMs: stat.mtimeMs },
      segments: [
        ...(parent ? [{ filePath: parentFile, physicalSessionId: 'P', segmentId: 'frozen-parent',
          fromByte: 0, toByte: parentBytes.length, startLine: 0, endLine: parent.length, frozen: true }] : []),
        { filePath: file, physicalSessionId: 'S', segmentId: 'child',
          fromByte: 0, toByte: stat.size, startLine: 0, frozen: false },
      ] };
  };
  const request = { sessionId: 'S', cwd: dir, resolveSource, maxChars: 100000 };
  return { file, parentFile, parentBytes, reader: instance, resolveSource, request,
    latest: options => instance.loadLatestObservedExecution({ ...request, ...options }),
    historical: (targetExecutionContext, options) => instance.loadHistoricalObservedExecution({ ...request, targetExecutionContext, ...options }),
    append: rows => fs.appendFileSync(file, encode(rows)),
    records: async () => (await _api.readJsonlRange(file, 0, fs.statSync(file).size - 1)).records };
}

function assertHistorical(result, turnId, physicalSessionId = 'S') {
  assert.equal(result.success, true);
  assert.equal(result.anchorFound, true);
  assert.equal(result.proofMode, 'historical-observed-execution');
  assert.equal(result.viewOwnerSessionId, 'S');
  assert.equal(result.providerTurnId, turnId);
  assert.equal(result.providerGeneration, null);
  assert.equal(result.executionContext.provider, 'codex');
  assert.equal(result.executionContext.sessionId, physicalSessionId);
  assert.equal(result.executionContext.turnId, turnId);
  assert.equal(result.executionContext.generation, null);
  assert.equal(result.executionContext.processId, null);
}

test('actual History latest user is A but latest observed Goal execution is B', async t => {
  const f = fixture(t, [...oldTurn(), ...latestTurn()]);
  const records = await f.records();
  const history = _api.buildCodexFullHistory(records, 'S');
  const users = history.filter(entry => entry.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(history.filter(entry => entry.role === 'goal').length, 1);
  assert.equal(_api.findCodexPromptExecutionContext(records, 'S', users[0].uuid).turnId, 'A');
  const normal = await f.reader.load({ ...f.request, proof: { promptUserUuid: users[0].uuid } });
  assert.equal(normal.assistantText, 'OLD');
  const latest = await f.latest();
  assertHistorical(latest, 'B');
  assert.equal(latest.complete, true);
  assert.equal(latest.sourceVerified, true);
  assert.equal(latest.assistantText, 'LATEST');
  assert.equal(latest.userUuid, null);
  assert.equal(latest.sourceIdentity, null);
  assert.equal(latest.executionContext.startedAt, null);
});

test('private latest and captured historical APIs share bounded read proof without raw cache', async t => {
  const f = fixture(t, [...oldTurn(), ...latestTurn()]);
  const before = _api.getCodexJsonlCacheStats();
  const latest = await _api.loadLatestCodexObservedExecution({ ...f.request, resultReadMode: 'observe' });
  assertHistorical(latest, 'B');
  assert.equal(latest.sourceVerified, false);
  const captured = await _api.loadCodexHistoricalObservedExecution({ ...f.request, targetExecutionContext: latest.executionContext });
  assertHistorical(captured, 'B');
  assert.equal(captured.sourceVerified, true);
  assert.equal(captured.assistantText, 'LATEST');
  assert.deepEqual(_api.getCodexJsonlCacheStats(), before);
});

test('historical capture neither acquires live generation nor weakens normal/current readers', async t => {
  const f = fixture(t, [...oldTurn(), ...latestTurn()]);
  const context = (await f.latest({ targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'A', generation: 99 } })).executionContext;
  assert.equal(context.turnId, 'B');
  assert.equal(context.generation, null);
  const strict = await f.reader.loadObservedExecution({ ...f.request, targetExecutionContext: context,
    historicalExecutionOnly: true, selectionMode: 'historical-execution' });
  assert.equal(strict.success, false);
  assert.equal(strict.errorCode, 'execution_identity_incomplete');
  const normal = await f.reader.load({ ...f.request, proof: { targetExecutionContext: context },
    historicalExecutionOnly: true, selectionMode: 'latest-execution' });
  assert.equal(normal.success, false);
  assert.equal(normal.errorCode, 'execution_identity_incomplete');
  const strictLive = await f.reader.loadObservedExecution({ ...f.request,
    targetExecutionContext: { ...context, generation: 8 } });
  assert.equal(strictLive.complete, true);
  assert.equal(strictLive.proofMode, 'observed-provider-execution');
  assert.equal(strictLive.executionContext.generation, 8);
  for (const extra of [{ generation: 8 }, { processId: '1234' }]) {
    const wrongHistorical = await f.historical({ ...context, ...extra });
    assert.equal(wrongHistorical.success, false);
    assert.equal(wrongHistorical.errorCode, 'execution_identity_incomplete');
  }
});

for (const [name, tail, complete, code] of [
  ['no user or answer', [start('B')], false, null],
  ['Goal without answer', [start('B'), goal()], false, null],
  ['partial', [start('B'), goal(), answer('PARTIAL')], false, null],
  ['abort', [start('B'), goal(), answer('PARTIAL'), event('turn_aborted', { turn_id: 'B' })], false, 'turn_aborted'],
  ['typed error', [start('B'), goal(), answer('PARTIAL'), event('task_complete', {
    turn_id: 'B', last_agent_message: 'PARTIAL', error: { message: 'provider failed' } })], false, 'provider_error'],
  ['empty final', [start('B'), goal(), done('B', '')], false, 'no_final_result'],
  ['explicit compact', [start('B'), { type: 'compacted', payload: {} }, done('B', '')], false, 'no_final_result'],
  ['service continuation', [start('B'), user('<subagent_notification>done</subagent_notification>'),
    answer('SERVICE FINAL'), done('B', 'SERVICE FINAL')], true, null],
]) test('latest keeps the actual B execution instead of older success: ' + name, async t => {
  const f = fixture(t, [...oldTurn(), ...tail]);
  const result = await f.latest();
  assertHistorical(result, 'B');
  assert.equal(result.complete, complete);
  assert.equal(result.errorCode, code);
  assert.equal(result.sourceVerified, true);
  assert.doesNotMatch(result.assistantText, /OLD/);
  assert.equal(result.userUuid, null);
  assert.equal(result.sourceIdentity, null);
});

test('Goal execution retains response blocks across repeated compact and service carriers', async t => {
  const f = fixture(t, [...oldTurn(), start('B'), goal(), answer('before'),
    { type: 'compacted', payload: { replacement_history: [] } },
    user('<subagent_notification>done</subagent_notification>'), answer('middle'),
    event('context_compacted'), answer('after'), done('B', 'after')]);
  const result = await f.latest();
  assertHistorical(result, 'B');
  assert.equal(result.assistantText, 'before\n\nmiddle\n\nafter');
  assert.equal(result.complete, true);
});

test('captured historical B stays fixed while latest advances to incomplete C', async t => {
  const f = fixture(t, [...oldTurn(), ...latestTurn()]);
  const captured = (await f.latest()).executionContext;
  f.append([start('C'), goal()]);
  const latest = await f.latest();
  assertHistorical(latest, 'C');
  assert.equal(latest.complete, false);
  assert.equal(latest.assistantText, '');
  const exact = await f.historical(captured);
  assertHistorical(exact, 'B');
  assert.equal(exact.complete, true);
  assert.equal(exact.assistantText, 'LATEST');
});

for (const extra of [{ provider: 'claude' }, { sessionId: 'foreign' }, { turnId: 'missing' }]) {
  test('historical reread rejects changed capture identity: ' + JSON.stringify(extra), async t => {
    const f = fixture(t, latestTurn());
    const captured = (await f.latest()).executionContext;
    const result = await f.historical({ ...captured, ...extra });
    assert.equal(result.success, false);
    assert.equal(result.assistantText, undefined);
  });
}

test('historical startedAt comes only from indexed records, not current time or supplied context', async t => {
  const f = fixture(t, [{ ...start('B', { started_at: null }), timestamp: '2026-09-14T02:00:00Z' }, goal(), done('B', 'LATEST')]);
  const latest = await f.latest();
  assert.equal(latest.executionContext.startedAt, Date.parse('2026-09-14T02:00:00Z'));
  const captured = await f.historical({ ...latest.executionContext, startedAt: 999999 });
  assert.equal(captured.executionContext.startedAt, latest.executionContext.startedAt);
});

test('duplicate latest task_started stays ambiguous, never falls back to A', async t => {
  const f = fixture(t, [...oldTurn(), ...latestTurn(), start('B')]);
  const result = await f.latest();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'task_started_ambiguous');
  assert.equal(result.providerTurnId, 'B');
  assert.equal(result.proofMode, 'historical-observed-execution');
  assert.equal(result.sourceVerified, true);
  assert.equal(result.assistantText, undefined);
});

test('ID-less latest start cannot select an earlier named success', async t => {
  const f = fixture(t, [...oldTurn(), start(undefined), goal()]);
  const result = await f.latest();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'execution_identity_incomplete');
  assert.equal(result.assistantText, undefined);
});

test('orphan terminal after an older completed execution cannot return its success', async t => {
  const f = fixture(t, [...oldTurn(), done('B', 'LATEST WITHOUT START')]);
  const result = await f.latest();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'task_started_not_found');
  assert.equal(result.providerTurnId, 'B');
  assert.equal(result.assistantText, undefined);
});

test('no provider start remains explicitly unavailable without legacy/user fallback', async t => {
  const f = fixture(t, [user('old legacy input'), answer('OLD')]);
  const result = await f.latest();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'task_started_not_found');
  assert.equal(result.sourceVerified, true);
});

test('appends stay indexed and observe mode grants no source authority', async t => {
  const f = fixture(t, oldTurn());
  assertHistorical(await f.latest({ resultReadMode: 'observe' }), 'A');
  const before = f.reader.stats();
  f.append([start('B'), goal()]);
  for (let index = 0; index < 20; index++) {
    f.append([{ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1000) } }]);
    const result = await f.latest({ resultReadMode: 'observe' });
    assertHistorical(result, 'B');
    assert.equal(result.complete, false);
    assert.equal(result.sourceVerified, false);
  }
  assert.equal(f.reader.stats().bootstraps, before.bootstraps);
  assert.equal(f.reader.stats().verificationBytes, 0);
  f.append([answer('LATEST'), done('B', 'LATEST')]);
  assert.equal((await f.latest()).assistantText, 'LATEST');
  assert.ok(f.reader.stats().verificationBytes > 0);
});

test('partial new task_started invalidates cached latest while exact historical A remains readable', async t => {
  const f = fixture(t, oldTurn());
  const captured = (await f.latest()).executionContext;
  const next = encode(latestTurn());
  const split = Math.floor(JSON.stringify(start('B')).length / 2);
  fs.appendFileSync(f.file, next.slice(0, split));
  const partial = await f.latest();
  assert.equal(partial.success, false);
  assert.equal(partial.error, 'latest-execution-tail-incomplete');
  assert.equal(partial.proofDefinitive, false);
  assert.equal(partial.assistantText, undefined);
  assert.equal((await f.historical(captured)).assistantText, 'OLD');
  fs.appendFileSync(f.file, next.slice(split));
  const result = await f.latest();
  assertHistorical(result, 'B');
  assert.equal(result.assistantText, 'LATEST');
});

test('finishing a nonstructural partial tail releases latest without rebuilding the index', async t => {
  const f = fixture(t, latestTurn());
  await f.latest();
  const before = f.reader.stats();
  const tail = encode([{ type: 'response_item', payload: { type: 'function_call_output', output: 'tool result' } }]);
  fs.appendFileSync(f.file, tail.slice(0, 20));
  assert.equal((await f.latest()).error, 'latest-execution-tail-incomplete');
  fs.appendFileSync(f.file, tail.slice(20));
  const final = await f.latest();
  assertHistorical(final, 'B');
  assert.equal(final.complete, true);
  assert.equal(f.reader.stats().records, before.records);
  assert.equal(f.reader.stats().bootstraps, before.bootstraps);
});

test('COW frozen parent A plus child Goal B returns child execution with no parent prompt', async t => {
  const f = fixture(t, latestTurn(), { parent: oldTurn() });
  const result = await f.latest();
  assertHistorical(result, 'B');
  assert.equal(result.assistantText, 'LATEST');
  assert.equal(result.userUuid, null);
  assert.equal(result.sourceIdentity, null);
  assert.ok(f.reader.stats().sourceVerificationBytes > 0);
});

test('COW ancestor-only execution reports physical parent separately from read-view owner', async t => {
  const f = fixture(t, [user('<environment_context>child startup</environment_context>')], { parent: oldTurn() });
  const result = await f.latest();
  assertHistorical(result, 'A', 'P');
  assert.equal(result.assistantText, 'OLD');
  assert.match(result.userUuid, /^codex-user-P-/);
  const exact = await f.historical(result.executionContext);
  assertHistorical(exact, 'A', 'P');
  assert.equal(exact.assistantText, 'OLD');
});

test('COW frozen-prefix rewrite cannot authorize a latest result on warm or cold reads', async t => {
  for (const warm of [false, true]) {
    const f = fixture(t, latestTurn(), { parent: oldTurn() });
    if (warm) await f.latest({ resultReadMode: 'observe' });
    fs.writeFileSync(f.parentFile, encode(oldTurn()).replaceAll('OLD', 'BAD'));
    const result = await f.latest();
    assert.equal(result.success, false);
    assert.equal(result.sourceVerified, false);
    assert.equal(result.error, 'result-source-digests-unverified');
  }
});

test('COW source growth beyond the frozen slice does not change the selected child execution', async t => {
  const f = fixture(t, latestTurn(), { parent: oldTurn() });
  await f.latest();
  fs.appendFileSync(f.parentFile, encode([start('foreign-new'), done('foreign-new', 'NOT IN VIEW')]));
  const result = await f.latest();
  assertHistorical(result, 'B');
  assert.equal(result.assistantText, 'LATEST');
});

for (const change of ['same-size', 'inode', 'rewrite-growth']) {
  test('latest reselects actual execution after source replacement: ' + change, async t => {
    const f = fixture(t, [...oldTurn(), ...latestTurn()]);
    const old = await f.latest({ resultReadMode: 'observe' });
    const next = encode([...oldTurn(), ...latestTurn()]).replaceAll('"B"', '"C"').replaceAll('LATEST', 'UPDATE');
    if (change === 'inode') {
      fs.writeFileSync(f.file + '.next', next); fs.renameSync(f.file + '.next', f.file);
    } else {
      const stat = fs.statSync(f.file);
      fs.writeFileSync(f.file, next + (change === 'rewrite-growth'
        ? encode([{ type: 'response_item', payload: { type: 'function_call_output', output: 'growth' } }]) : ''));
      fs.utimesSync(f.file, stat.atime, stat.mtime);
    }
    const result = await f.latest();
    assertHistorical(result, 'C');
    assert.equal(result.assistantText, 'UPDATE');
    assert.equal(result.sourceVerified, true);
    const captured = await f.historical(old.executionContext);
    assert.equal(captured.success, false);
    assert.equal(captured.errorCode, 'task_started_not_found');
  });
}

test('latest rereads a newly appended execution before authorizing an older final', async t => {
  const f = fixture(t, oldTurn());
  let resolves = 0;
  const result = await f.latest({ resolveSource: async request => {
    if (++resolves === 2) f.append(latestTurn());
    return f.resolveSource(request);
  } });
  assertHistorical(result, 'B');
  assert.equal(result.assistantText, 'LATEST');
  assert.equal(result.sourceVerified, true);
});

test('descriptor ownership change during final verification cannot publish a stale latest result', async t => {
  const f = fixture(t, latestTurn());
  let calls = 0;
  const result = await f.latest({ resolveSource: async request => ({ ...await f.resolveSource(request),
    viewOwnerSessionId: ++calls === 1 ? 'S' : 'foreign' }) });
  assert.equal(result.success, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.error, 'result-source-session-mismatch');
});
