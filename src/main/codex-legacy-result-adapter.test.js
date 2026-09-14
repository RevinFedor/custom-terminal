'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _api } = require('./ipc/codex-data');
const { materializeCodexLegacyResult } = require('./codex-legacy-result-adapter');
const { codexUserMessageAuditText, codexUserMessagePresentationText } = require('./codex-prompt-audit');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { summarizeResultText, projectResultText, MAX_RESULT_CHARS } = require('./codex-result-text');

const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: '2026-09-14T10:00:00Z', payload: { type, ...extra } });
const user = text => event('user_message', { message: text });
const message = (role, text) => ({ type: 'response_item', timestamp: '2026-09-14T10:00:00Z',
  payload: { type: 'message', role, content: [{ type: 'output_text', text }] } });
const answer = text => message('assistant', text);

function fixture(input, selectedLine) {
  let offset = 0;
  const records = input.map((record, __line) => {
    const decorated = { ...record, __line, __byteOffset: offset, __physicalSessionId: 'S' };
    offset += Buffer.byteLength(JSON.stringify(record) + '\n');
    return decorated;
  });
  const coordinates = _api.buildCodexTimeline(records, 'S');
  const identity = _api.getCodexUserRecordIdentity(records[selectedLine], 'S');
  const target = coordinates.find(row => row.uuid === identity.uuid);
  assert.ok(target);
  const reads = [], collected = [];
  const rows = records.map((record, index) => {
    const audit = codexUserMessageAuditText(record);
    const assistant = record.type === 'response_item' && record.payload?.role === 'assistant';
    const row = { record: { ...record, payload: { ...record.payload } }, index,
      locator: { filePath: '/synthetic/S', fromByte: record.__byteOffset, startLine: record.__line },
      kind: audit !== null ? 'user' : assistant ? 'assistant' : 'control',
      length: assistant ? _api.extractTextContent(record.payload.content).trim().length : 0 };
    if (audit !== null) row.user = { ..._api.getCodexUserRecordIdentity(record, 'S'),
      auditHash: promptFingerprint(audit), presentationHash: promptFingerprint(codexUserMessagePresentationText(record)),
      service: audit.includes('<subagent_notification>') };
    delete row.record.payload.message;
    delete row.record.payload.content;
    delete row.record.payload.replacement_history;
    delete row.record.payload.output;
    return row;
  });
  const run = options => materializeCodexLegacyResult({ rows, coordinates,
    selectedPrompt: { userUuid: target.uuid, sourceIdentity: target.sourceIdentity,
      sourceIdentityAliases: target.sourceIdentityAliases || [] }, sessionId: 'S',
    readBody: async row => {
      reads.push(row.index);
      assert.ok(row.kind === 'user' || row.kind === 'assistant');
      return row.kind === 'user' ? codexUserMessageAuditText(records[row.index])
        : summarizeResultText(_api.extractTextContent(records[row.index].payload.content));
    },
    collectLegacy: (window, sessionId, uuid) => {
      collected.push(window);
      return _api.collectCodexTurnAssistantBlocks(window, sessionId, uuid);
    }, ...options });
  const expectBatch = async options => {
    const actual = await run(options);
    const expected = _api.buildCodexTurnAssistantResult(records, 'S', target.uuid, options?.maxChars ?? 100000);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
    assert.equal(actual.executionContext, null);
    assert.equal(actual.providerGeneration, null);
    return actual;
  };
  return { records, rows, coordinates, target, reads, collected, run, expectBatch };
}

test('ID-less task_complete matches legacy batch using only the selected user window', async () => {
  const f = fixture([user('old'), answer('old answer'), event('task_complete'),
    user('selected'), answer('ours'), event('task_complete'), user('next'), answer('not ours')], 3);
  const result = await f.expectBatch();
  assert.equal(result.complete, true);
  assert.equal(result.turnIndex, 1);
  assert.equal(result.proofMode, 'legacy-user-turn');
  assert.deepEqual(f.reads, [3, 4]);
  assert.deepEqual([...new Set(f.collected[0].map(record => record.__line))], [3, 4, 5]);
  assert.equal(f.collected[0][1].payload.content[0].text, 'noted-legacy-assistant:4');
});

test('a clarification ends the old user-bound answer without borrowing its completion', async () => {
  const f = fixture([user('selected'), answer('before'), user('clarification'), answer('after'), event('task_complete')], 0);
  const result = await f.expectBatch();
  assert.equal(result.assistantText, 'before');
  assert.equal(result.complete, false);
  assert.deepEqual(f.reads, [0, 1]);
});

test('early alias, compact and internal notification reuse canonical legacy grouping', async () => {
  const f = fixture([message('user', 'selected'), answer('before'),
    { type: 'compacted', payload: { replacement_history: [{ secret: 'do not materialize this history' }] } },
    user('<subagent_notification>done</subagent_notification>'), user('selected'), answer('after'), event('task_complete')], 4);
  const result = await f.expectBatch();
  assert.equal(result.assistantText, 'before\n\nafter');
  assert.equal(result.userUuid, f.rows[4].user.uuid);
  assert.deepEqual(f.reads, [0, 3, 4, 1, 5]);
  assert.equal('replacement_history' in f.collected[0][2].payload, false);
});

test('removed users inside the window are processed by the existing rollback collector', async () => {
  const f = fixture([user('selected'), answer('before'), event('task_complete'),
    user('removed'), answer('discarded'), event('task_complete'),
    event('thread_rolled_back', { num_turns: 1 }), answer('continued'), event('task_complete'),
    user('next'), answer('not ours')], 0);
  const result = await f.expectBatch();
  assert.equal(result.assistantText, 'before\n\ncontinued');
  assert.equal(f.reads.includes(4), false, 'removed assistant bodies are not read');
  assert.equal(f.reads.includes(9), false, 'next retained user stays outside the window');
});

test('a canonical event beyond the next user preserves the first physical alias window', async () => {
  const f = fixture([message('user', 'selected'), answer('before'), message('user', 'next'), answer('next answer'),
    user('selected'), answer('later answer'), event('task_complete')], 4);
  const result = await f.expectBatch();
  assert.equal(result.assistantText, 'before');
  assert.equal(result.userUuid, f.rows[4].user.uuid);
  assert.deepEqual(f.reads, [0, 1]);
});

test('bounded projection reads first/final samples and skips the middle body', async () => {
  const f = fixture([user('selected'), answer('first '.repeat(60000)), answer('middle '.repeat(80000)),
    answer('last '.repeat(70000)), event('task_complete'), user('next'), answer('not ours')], 0);
  const result = await f.expectBatch({ maxChars: 500 });
  assert.equal(result.truncated, true);
  assert.equal(result.assistantBlockCount, 3);
  assert.deepEqual(f.reads, [0, 1, 3]);
  assert.ok(JSON.stringify(f.collected[0]).length < 3000, 'collector sees metadata and short locators');
});

test('legacy terminal-only text does not replace the existing assistant collector', async () => {
  const f = fixture([user('selected'), event('task_complete', { last_agent_message: 'inline only' })], 0);
  const result = await f.expectBatch();
  assert.equal(result.success, false);
  assert.deepEqual(f.reads, [0]);
});

test('any existing provider ID keeps a missing modern start pending before body or collector I/O', async t => {
  for (const [name, marker] of [
    ['previous start', event('task_started', { turn_id: 'older' })],
    ['late terminal', event('task_complete', { turn_id: 'awaited' })],
    ['assistant provider metadata', { type: 'response_item', payload: { type: 'message', role: 'assistant', metadata: { turn_id: 'awaited' } } }],
    ['top-level provider ID', { ...event('task_complete'), turn_id: 'awaited' }],
  ]) await t.test(name, async () => {
    const f = fixture([user('selected'), answer('partial'), marker], 0);
    const result = await f.run();
    assert.equal(result.pending, true);
    assert.equal(result.complete, false);
    assert.equal(result.proofDefinitive, false);
    assert.equal(result.executionContext, null);
    assert.equal(result.providerGeneration, null);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.collected, []);
  });
});

test('body metadata mismatch propagates so parent can discard the source generation', async () => {
  const f = fixture([user('selected'), answer('ours'), event('task_complete')], 0);
  await assert.rejects(f.run({ readBody: async () => 'changed user text' }), /legacy-user-body-source-changed/);
});

test('explicit legacy abort, typed error and empty final cannot promote retained answer text', async t => {
  for (const [name, terminal, terminalEvent, code] of [
    ['abort', event('turn_aborted'), 'turn_aborted', 'turn_aborted'],
    ['typed error', event('task_complete', { error: { codex_error_info: 'server_overloaded', message: 'overloaded' } }), 'provider_error', 'server_overloaded'],
    ['explicit empty final', event('task_complete', { last_agent_message: '' }), 'task_complete', 'no_final_result'],
  ]) await t.test(name, async () => {
    const f = fixture([user('selected'), answer('partial'), terminal], 0);
    const result = await f.run();
    assert.equal(result.success, true);
    assert.equal(result.complete, false);
    assert.equal(result.proofDefinitive, true);
    assert.equal(result.assistantText, 'partial');
    assert.equal(result.terminalEvent, terminalEvent);
    assert.equal(result.errorCode, code);
    assert.equal(result.hasFinalResult, false);
    assert.equal(result.executionContext, null);
    assert.equal(result.providerGeneration, null);
  });
});

test('an omitted legacy final field remains compatible while empty terminal-only proof is a failure', async () => {
  const omitted = fixture([user('selected'), answer('old format answer'), event('task_complete')], 0);
  assert.equal((await omitted.expectBatch()).complete, true);
  const empty = fixture([user('selected'), event('task_complete', { last_agent_message: '' })], 0);
  const failed = await empty.run();
  assert.equal(failed.success, true);
  assert.equal(failed.complete, false);
  assert.equal(failed.errorCode, 'no_final_result');
  assert.equal(failed.assistantBlockCount, 0);
});

test('the shared rollback collector discards a removed user terminal failure', async () => {
  const f = fixture([user('selected'), answer('before'), event('task_complete'),
    user('removed'), answer('discarded'), event('task_complete', { error: { message: 'removed failure' } }),
    event('thread_rolled_back', { num_turns: 1 }), answer('continued'), event('task_complete')], 0);
  const result = await f.expectBatch();
  assert.equal(result.complete, true);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.assistantText, 'before\n\ncontinued');
});

test('parent projectRows receives only selected assistant locators and owns bounded sample reads', async () => {
  const f = fixture([user('selected'), answer('before'), event('task_complete'),
    user('removed'), answer('discarded'), event('task_complete'),
    event('thread_rolled_back', { num_turns: 1 }), answer('continued'), event('task_complete')], 0);
  let calls = 0;
  const result = await f.expectBatch({ maxChars: 500, projectRows: async (rows, maxChars) => {
    calls += 1;
    assert.deepEqual(rows, [f.rows[1], f.rows[7]]);
    assert.equal(maxChars, 500);
    return projectResultText(rows.map(row => summarizeResultText(
      _api.extractTextContent(f.records[row.index].payload.content))), maxChars, MAX_RESULT_CHARS);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(f.reads, [0, 3], 'adapter delegates every assistant body read');
  assert.equal(result.assistantText, 'before\n\ncontinued');
});

test('parent projection errors propagate for source retry, without a success fallback', async () => {
  const f = fixture([user('selected'), answer('ours'), event('task_complete')], 0);
  await assert.rejects(f.run({ projectRows: async () => { throw new Error('parent-source-changed'); } }), /parent-source-changed/);
});

test('the first completion remains successful after a later idle abort in the same legacy user window', async () => {
  const endings = [event('task_complete', { last_agent_message: 'finished' }), event('turn_aborted')];
  const f = fixture([user('selected'), answer('finished'), ...endings], 0);
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(result.assistantText, 'finished');
  assert.equal(result.errorCode, undefined);
  assert.equal(result.executionContext, null);
  assert.equal(result.providerGeneration, null);

  // Independent modern fixture: the exact provider builder stops at the first
  // matching closing event, so the trailing idle abort is outside that turn.
  const modern = [event('task_started', { turn_id: 'T' }), user('selected'), answer('finished'),
    ...endings.map(record => ({ ...record, payload: { ...record.payload, turn_id: 'T' } }))]
    .map((record, __line) => ({ ...record, __line }));
  const exact = _api.buildCodexProviderTurnAssistantResult(modern, 'S', {
    promptUserUuid: 'codex-user-S-1',
    targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 3 },
  });
  assert.equal(exact.terminalEvent, 'task_complete');
  assert.equal(result.complete, exact.complete);
  assert.equal(result.assistantText, exact.assistantText);
});

test('the first abort or typed error cannot become success after a later completion without a new user', async t => {
  for (const [name, first, terminalEvent, code] of [
    ['abort', event('turn_aborted'), 'turn_aborted', 'turn_aborted'],
    ['typed error', event('task_complete', { error: { codex_error_info: 'server_overloaded', message: 'first failure' } }),
      'provider_error', 'server_overloaded'],
  ]) await t.test(name, async () => {
    const later = event('task_complete', { last_agent_message: 'late success' });
    const f = fixture([user('selected'), answer('partial'), first, later], 0);
    assert.equal(f.target.responseComplete, true, 'the Timeline completion flag alone would admit the later event');
    const result = await f.run();
    assert.equal(result.complete, false);
    assert.equal(result.proofDefinitive, true);
    assert.equal(result.hasFinalResult, false);
    assert.equal(result.terminalEvent, terminalEvent);
    assert.equal(result.errorCode, code);
    assert.equal(result.assistantText, 'partial');
    assert.equal(result.executionContext, null);
    assert.equal(result.providerGeneration, null);

    const modern = [event('task_started', { turn_id: 'T' }), user('selected'), answer('partial'),
      ...[first, later].map(record => ({ ...record, payload: { ...record.payload, turn_id: 'T' } }))]
      .map((record, __line) => ({ ...record, __line }));
    const exact = _api.buildCodexProviderTurnAssistantResult(modern, 'S', {
      promptUserUuid: 'codex-user-S-1',
      targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 3 },
    });
    assert.equal(result.complete, exact.complete);
    assert.equal(result.terminalOutcomeReason, exact.terminalOutcomeReason);
    assert.equal(result.assistantText, exact.assistantText);
  });
});
