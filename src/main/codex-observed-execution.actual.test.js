'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _api } = require('./ipc/codex-data');
const { createCodexResultReader } = require('./codex-result-reader');
const { promptFingerprint } = require('./claude-prompt-carriers');

const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 3 };
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const start = turn_id => event('task_started', { turn_id });
const user = message => event('user_message', { message });
const message = (role, text, extra = {}) => ({ type: 'response_item',
  payload: { type: 'message', role, content: [{ type: 'output_text', text }], ...extra } });
const answer = text => message('assistant', text);
const done = (turn_id, text) => event('task_complete', { turn_id, last_agent_message: text });
const encode = records => records.map(record => JSON.stringify(record) + '\n').join('');

function makeReader() {
  return createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector,
    buildResult: _api.buildCodexProviderTurnAssistantResult, extractText: _api.extractTextContent,
    userIdentity: _api.getCodexUserRecordIdentity, isCompactPayload: _api.isCompactPayload,
    extractReasoning: _api.extractReasoning, findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy() { throw new Error('observation must not use legacy whole-history fallback'); },
    log: { log() {}, warn() {} } });
}

function fixture(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-observed-execution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, encode(records));
  const reader = makeReader();
  const resolveSource = async () => {
    const stat = await fs.promises.stat(file);
    return { success: true, sessionId: 'S', revisionKey: file,
      sourceSnapshot: { filePath: file, sessionId: 'S', size: stat.size, mtimeMs: stat.mtimeMs },
      segments: [{ filePath: file, physicalSessionId: 'S', fromByte: 0,
        toByte: stat.size, startLine: 0, frozen: false }] };
  };
  const request = { sessionId: 'S', cwd: dir, targetExecutionContext: context, resolveSource, maxChars: 100000 };
  return { file, reader, request, resolveSource,
    load: options => reader.loadObservedExecution({ ...request, ...options }),
    append: rows => fs.appendFileSync(file, encode(rows)),
    batch: async (targetExecutionContext = context) => {
      const parsed = await _api.readJsonlRange(file, 0, fs.statSync(file).size - 1);
      return _api.buildCodexProviderTurnAssistantResult(parsed.records, 'S', { targetExecutionContext },
        100000, { executionOnly: true });
    } };
}

const pure = ({ sourceSnapshot, sourceVerified, ...result }) => result;

test('default prompt-proof rejection survives explicit observation and cannot opt in via request fields', async t => {
  const f = fixture(t, [start('T'), user('go'), answer('final'), done('T', 'final')]);
  const proof = { targetExecutionContext: context };
  const request = { ...f.request, proof, executionOnly: true };
  const before = await f.reader.load(request);
  assert.equal(before.errorCode, 'prompt_identity_required');
  assert.equal((await f.load()).complete, true);
  const after = await f.reader.load(request);
  assert.deepEqual(after, before);
  assert.equal(_api.buildCodexProviderTurnAssistantResult([start('T')], 'S', proof).errorCode,
    'prompt_identity_required');
  assert.equal((await _api.loadCodexProviderResult(request)).errorCode, 'prompt_identity_required');
});

test('private API uses the compact reader without loading the raw JSONL cache', async t => {
  const f = fixture(t, [start('T'), user('go'), answer('final'), done('T', 'final')]);
  const before = _api.getCodexJsonlCacheStats();
  const observed = await _api.loadCodexObservedExecution({ ...f.request, resultReadMode: 'observe' });
  assert.equal(observed.complete, true);
  assert.equal(observed.sourceVerified, false);
  const final = await _api.loadCodexObservedExecution(f.request);
  assert.equal(final.assistantText, 'final');
  assert.equal(final.sourceVerified, true);
  assert.deepEqual(_api.getCodexJsonlCacheStats(), before);
});

test('busy execution anchors before user/assistant materialization and adopts only real coordinates', async t => {
  const f = fixture(t, [start('T')]);
  const open = await f.load({ resultReadMode: 'observe' });
  assert.equal(open.success, true);
  assert.equal(open.anchorFound, true);
  assert.deepEqual(open.executionContext, context);
  assert.equal(open.complete, false);
  assert.equal(open.assistantText, '');
  assert.equal(open.userUuid, null);
  assert.equal(open.sourceIdentity, null);
  assert.equal(open.promptCarrierKind, null);
  assert.equal(open.terminalEvent, null);
  assert.equal(open.boundaryReason, 'transcript-end');
  assert.equal(open.sourceVerified, false);
  assert.equal(f.reader.stats().verificationBytes, 0);
  f.append([user('go')]);
  const withPrompt = await f.load({ resultReadMode: 'source-proof' });
  assert.equal(withPrompt.userUuid, 'codex-user-S-1');
  assert.equal(withPrompt.sourceIdentity, 'codex-user-source-S-' + Buffer.byteLength(encode([start('T')])));
  assert.equal(withPrompt.assistantText, '');
  assert.equal(withPrompt.sourceVerified, true);
  assert.deepEqual(pure(withPrompt), await f.batch());
});

test('first real prompt owns metadata across aliases, repeated inputs, clarification and compaction', async t => {
  const f = fixture(t, [start('T'), user('<environment_context>context</environment_context>'),
    message('user', 'same'), answer('first'), user('same'),
    { type: 'compacted', payload: { replacement_history: [] } },
    user('<subagent_notification>service</subagent_notification>'),
    user('<codex_internal_context source="goal">continue</codex_internal_context>'),
    user('same'), answer('final'), done('T', 'final')]);
  const result = await f.load();
  assert.equal(result.complete, true);
  assert.equal(result.userUuid, 'codex-user-S-4');
  assert.equal(result.sourceIdentityAliases.length, 1);
  assert.equal(result.assistantText, 'first\n\nfinal');
  assert.deepEqual(pure(result), await f.batch());
  const normal = await f.reader.load({ ...f.request,
    proof: { targetExecutionContext: context, promptHash: promptFingerprint('same') } });
  assert.equal(normal.errorCode, 'prompt_ambiguous');
});

test('late canonical alias preserves the captured prompt while a completed successor stays outside the result', async t => {
  const f = fixture(t, [start('T'), message('user', 'same'), answer('first')]);
  const captured = await f.load({ resultReadMode: 'observe' });
  assert.equal(captured.userUuid, 'codex-user-S-1');
  f.append([user('same'), answer('final'), done('T', 'final'),
    start('next'), user('same'), answer('not ours'), done('next', 'not ours')]);
  const result = await f.load();
  assert.equal(result.complete, true);
  assert.deepEqual(result.executionContext, captured.executionContext);
  assert.equal(result.userUuid, 'codex-user-S-3');
  assert.deepEqual(result.sourceIdentityAliases, [captured.sourceIdentity]);
  assert.equal(result.assistantText, 'first\n\nfinal');
  assert.deepEqual(pure(result), await f.batch());
});

test('legal pre-start response aliases attach structurally without including pre-start assistant text', async t => {
  const f = fixture(t, [start('old'), user('old'), done('old', 'old'),
    message('user', 'go'), answer('outside bracket'), start('T'), answer('first'),
    user('go'), answer('final'), done('T', 'final')]);
  const result = await f.load();
  assert.equal(result.userUuid, 'codex-user-S-7');
  assert.equal(result.sourceIdentityAliases.length, 1);
  assert.equal(result.assistantText, 'first\n\nfinal');
  assert.deepEqual(pure(result), await f.batch());
});

test('an open earlier turn cannot donate its prompt to a later start', async t => {
  const f = fixture(t, [start('old'), message('user', 'same'), start('T'),
    user('same'), answer('ours'), done('T', 'ours')]);
  const result = await f.load();
  assert.equal(result.userUuid, 'codex-user-S-3');
  assert.deepEqual(result.sourceIdentityAliases, []);
  assert.deepEqual(pure(result), await f.batch());
});

test('event-first pre-start and later same-text response are not fabricated aliases', async t => {
  const f = fixture(t, [user('same'), start('T'), message('user', 'same'), answer('ours'), done('T', 'ours')]);
  const result = await f.load();
  assert.equal(result.userUuid, 'codex-user-S-0');
  assert.deepEqual(result.sourceIdentityAliases, []);
});

test('missing physical coordinates remain null, never synthetic undefined or minus-one identities', () => {
  const result = _api.buildCodexProviderTurnAssistantResult(
    [start('T'), user('go'), answer('final'), done('T', 'final')], 'S',
    { targetExecutionContext: context }, 100000, { executionOnly: true });
  assert.equal(result.complete, true);
  assert.equal(result.userUuid, null);
  assert.equal(result.sourceIdentity, null);
  assert.equal(result.turnIndex, null);
  assert.deepEqual(result.sourceIdentityAliases, []);
});

for (const [label, override, code] of [
  ['provider', { provider: 'claude' }, 'provider_mismatch'],
  ['session', { sessionId: 'other' }, 'session_mismatch'],
  ['unknown turn', { turnId: 'other' }, 'task_started_not_found'],
  ['missing turn', { turnId: null }, 'execution_identity_incomplete'],
  ...[null, undefined, 0, -1, 0.5, NaN, Infinity, '3', Number.MAX_SAFE_INTEGER + 1]
    .map(generation => ['generation ' + String(generation), { generation }, 'execution_identity_incomplete']),
]) test('observation rejects invalid identity: ' + label, async t => {
  const f = fixture(t, [start('T'), user('go'), answer('final'), done('T', 'final')]);
  const result = await f.load({ targetExecutionContext: { ...context, ...override } });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, code);
  assert.equal(result.assistantText, undefined);
});

test('captured generation is immutable across async I/O and never borrowed from another cached caller', async t => {
  const f = fixture(t, [start('T')]);
  const target = { ...context };
  const first = f.load({ targetExecutionContext: target, resolveSource: async () => {
    target.generation = 4;
    return f.resolveSource();
  } });
  assert.equal((await first).executionContext.generation, 3);
  const second = await f.load({ targetExecutionContext: target });
  assert.equal(second.executionContext.generation, 4);
  assert.equal(second.providerGeneration, 4);
});

test('mutating returned capture metadata cannot change the cached execution identity', async t => {
  const f = fixture(t, [message('user', 'go'), start('T'), user('go')]);
  const result = await f.load();
  const expected = await f.batch();
  result.executionContext.generation = 99;
  result.sourceIdentityAliases.push('not-a-physical-source');
  assert.deepEqual(pure(await f.load()), expected);
});

test('duplicate provider starts never form a valid observation anchor', async t => {
  const f = fixture(t, [start('T'), user('go'), answer('first'), done('T', 'first'), start('T')]);
  const result = await f.load();
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'task_started_ambiguous');
  assert.equal(result.proofDefinitive, true);
});

for (const [label, boundary, reason] of [
  ['next turn', start('next'), 'next-task-started'],
  ['foreign terminal', done('next', 'not ours'), 'mismatched-terminal-turn'],
  ['ID-less terminal', done(undefined, 'not ours'), 'terminal-turn-id-missing'],
]) test('exact execution stops before ' + label, async t => {
  const f = fixture(t, [start('T'), user('go'), answer('partial'), boundary,
    user('later'), answer('not ours'), done('next', 'not ours')]);
  const result = await f.load();
  assert.equal(result.success, true);
  assert.equal(result.complete, false);
  assert.equal(result.assistantText, 'partial');
  assert.equal(result.boundaryReason, reason);
  assert.equal(result.errorCode, 'turn_boundary_closed_without_completion');
  assert.equal(result.sourceVerified, true);
});

for (const [label, terminal, code] of [
  ['abort', event('turn_aborted', { turn_id: 'T' }), 'turn_aborted'],
  ['empty final', done('T', ''), 'no_final_result'],
  ['provider error', event('task_complete', { turn_id: 'T', last_agent_message: 'partial',
    error: { message: 'failed' } }), 'provider_error'],
  ['model capacity', event('task_complete', { turn_id: 'T', last_agent_message: 'partial',
    error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' } }), 'model_capacity'],
]) test('exact negative terminal is explicit and source-verified: ' + label, async t => {
  const f = fixture(t, [start('T'), user('go'), answer('partial'), terminal]);
  const observed = await f.load({ resultReadMode: 'observe' });
  assert.equal(observed.sourceVerified, false);
  const result = await f.load();
  assert.equal(result.complete, false);
  assert.equal(result.hasFinalResult, false);
  assert.equal(result.errorCode, code);
  assert.equal(result.assistantText, 'partial');
  assert.equal(result.sourceVerified, true);
  assert.deepEqual(pure(result), await f.batch());
});

test('exact final-answer phase qualifies an empty terminal, a foreign final-answer does not', async t => {
  for (const turn_id of ['T', 'foreign']) {
    const f = fixture(t, [start('T'), user('go'), message('assistant', 'final', {
      phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id } }), done('T', '')]);
    const result = await f.load();
    assert.equal(result.complete, turn_id === 'T');
    assert.equal(result.hasFinalResult, turn_id === 'T');
  }
});

test('terminal-only final uses existing bounded body projection without fabricating a user carrier', async t => {
  const text = 'start ' + 'body '.repeat(10000) + ' final';
  const f = fixture(t, [start('T'), done('T', text)]);
  const result = await f.load({ maxChars: 500 });
  assert.equal(result.complete, true);
  assert.equal(result.userUuid, null);
  assert.equal(result.sourceIdentity, null);
  assert.equal(result.truncated, true);
  assert.equal(result.assistantChars, text.length);
  assert.ok(result.assistantText.startsWith('start '));
  assert.ok(result.assistantText.endsWith(' final'));
  assert.ok(result.assistantText.length <= 500);
});

test('busy tool-only appends stay incremental without final verification or raw-cache reads', async t => {
  const f = fixture(t, [start('T')]);
  const initial = pure(await f.load({ resultReadMode: 'observe' }));
  const before = f.reader.stats();
  let bytes = 0;
  for (let index = 0; index < 25; index++) {
    const rows = [{ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(8192) } }];
    bytes += Buffer.byteLength(encode(rows));
    f.append(rows);
    assert.deepEqual(pure(await f.load({ resultReadMode: 'observe' })), initial);
  }
  const after = f.reader.stats();
  assert.equal(after.bootstraps, before.bootstraps);
  assert.equal(after.bytesRead - before.bytesRead, bytes);
  assert.equal(after.records, before.records);
  assert.equal(after.verificationBytes, 0);
});

test('rewrite plus growth cannot authorize a cached observation anchor or old final body', async t => {
  for (const rewriteStart of [false, true]) {
    const rows = [start('T'), user('go'), answer('first')];
    const f = fixture(t, rows);
    await f.load({ resultReadMode: 'observe' });
    fs.writeFileSync(f.file, encode([start(rewriteStart ? 'U' : 'T'), user('go'), answer('other'), done('T', 'other')]));
    const result = await f.load({ resultReadMode: 'source-proof' });
    if (rewriteStart) {
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'task_started_not_found');
    } else {
      assert.equal(result.complete, true);
      assert.equal(result.assistantText, 'other');
    }
    assert.equal(result.sourceVerified, true);
    assert.deepEqual(pure(result), await f.batch());
  }
});

for (const terminal of [event('turn_aborted', { turn_id: 'T' }), done('T', ''),
  event('task_complete', { turn_id: 'T', error: { message: 'failed' } })]) {
  test('negative terminal after prefix rewrite cannot finish a fabricated old anchor: ' + JSON.stringify(terminal.payload), async t => {
    const f = fixture(t, [start('T'), user('go'), answer('partial')]);
    await f.load({ resultReadMode: 'observe' });
    fs.writeFileSync(f.file, encode([start('other'), user('go'), answer('partial'), terminal]));
    const result = await f.load();
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'task_started_not_found');
    assert.equal(result.anchorFound, undefined);
    assert.equal(result.terminalEvent, undefined);
    assert.deepEqual(pure(result), await f.batch());
  });
}

for (const replacement of ['inode', 'same-inode']) test('final descriptor catches source replacement after I/O: ' + replacement, async t => {
  const rows = [start('T'), user('go'), answer('first'), done('T', 'first')];
  const f = fixture(t, rows);
  await f.load({ resultReadMode: 'observe' });
  let reads = 0;
  const result = await f.load({ resolveSource: async () => {
    if (++reads === 2) {
      if (replacement === 'inode') {
        fs.writeFileSync(f.file + '.next', encode(rows).replaceAll('first', 'other'));
        fs.renameSync(f.file + '.next', f.file);
      } else {
        const stat = fs.statSync(f.file);
        fs.writeFileSync(f.file, encode(rows).replaceAll('first', 'other'));
        fs.utimesSync(f.file, stat.atime, stat.mtime);
      }
    }
    return f.resolveSource();
  } });
  assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'other');
  assert.equal(result.sourceVerified, true);
});

test('unverified frozen-source digests cannot authorize observed completion', async t => {
  const f = fixture(t, [start('T'), user('go'), answer('final'), done('T', 'final')]);
  const result = await f.load({ resolveSource: async () => ({ ...await f.resolveSource(), digestsVerified: false }) });
  assert.equal(result.success, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.error, 'result-source-digests-unverified');
});

test('logical view ownership cannot lend a foreign physical session its task_started', async t => {
  const f = fixture(t, [start('T'), user('go'), answer('final'), done('T', 'final')]);
  const result = await f.load({ resolveSource: async () => {
    const source = await f.resolveSource();
    source.segments[0].physicalSessionId = 'ancestor';
    return source;
  } });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'session_mismatch');
  assert.equal(result.assistantText, undefined);
});

test('foreign physical records cannot finish an otherwise exact observation', () => {
  const rows = [start('T'), user('go'), answer('ours'),
    { ...answer('foreign'), __physicalSessionId: 'ancestor' }, done('T', 'foreign')];
  const result = _api.buildCodexProviderTurnAssistantResult(rows, 'S', { targetExecutionContext: context },
    100000, { executionOnly: true });
  assert.equal(result.complete, false);
  assert.equal(result.boundaryReason, 'physical-session-boundary');
  assert.equal(result.assistantText, 'ours');
});

test('source-session substitution is rejected before result selection', async t => {
  const f = fixture(t, [start('T'), done('T', 'final')]);
  const result = await f.load({ resolveSource: async () => ({ ...await f.resolveSource(), sessionId: 'other' }) });
  assert.equal(result.success, false);
  assert.equal(result.error, 'result-source-session-mismatch');
});
