'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _api } = require('./ipc/codex-data');
const { selectCodexResultBootstrap } = require('./codex-result-bootstrap');
const { findMatchingClaudePromptTurn, promptFingerprint } = require('./claude-prompt-carriers');
const { codexUserMessageAuditText, codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText, isCodexProjectInstructionsUserText,
  isCodexTurnAbortedUserText, isCodexGoalContinuationUserText } = require('./codex-prompt-audit');

const T0 = '2026-09-14T10:00:00Z', T1 = '2026-09-14T10:01:00Z', T2 = '2026-09-14T10:02:00Z';
const event = (type, extra = {}, timestamp = T0) => ({ type: 'event_msg', timestamp, payload: { type, ...extra } });
const user = (text, timestamp = T0) => event('user_message', { message: text }, timestamp);
const message = (role, text, timestamp = T0) => ({ type: 'response_item', timestamp,
  payload: { type: 'message', role, phase: role === 'assistant' ? 'final_answer' : undefined,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const turn = (id, text, answer, timestamp = T0) => [event('task_started', { turn_id: id }, timestamp),
  user(text, timestamp), message('assistant', answer, timestamp),
  event('task_complete', { turn_id: id, last_agent_message: answer }, timestamp)];

// Synthetic fixtures only. The oracle is the existing History -> shared
// matcher adapter used by main; production selection never builds it.
function fixture(input, sessionId = 'S') {
  let offset = 0;
  const records = input.map((record, index) => {
    const size = Buffer.byteLength(JSON.stringify(record) + '\n');
    const decorated = { __line: index, __byteOffset: offset, __physicalSessionId: sessionId, ...record };
    offset += size;
    return decorated;
  });
  const bodies = new Map(), reads = [];
  const rows = records.map((record, index) => {
    const audit = codexUserMessageAuditText(record);
    const assistant = record.type === 'response_item' && record.payload?.role === 'assistant';
    const row = { record: { ...record, payload: { ...record.payload } },
      locator: { filePath: '/synthetic/' + record.__physicalSessionId, fromByte: record.__byteOffset,
        toByte: record.__byteOffset + 1, startLine: record.__line },
      kind: audit !== null ? 'user' : assistant ? 'assistant' : 'structural',
      length: assistant ? _api.extractTextContent(record.payload.content).trim().length : 0 };
    if (audit !== null) {
      const presented = codexUserMessagePresentationText(record);
      row.user = { ..._api.getCodexUserRecordIdentity(record, sessionId),
        timestamp: record.timestamp || record.time || record.created_at || null,
        auditHash: promptFingerprint(audit), presentationHash: promptFingerprint(presented),
        service: !presented.trim() || presented.includes('<subagent_notification>')
          || isCodexEnvironmentContextUserText(presented) || isCodexProjectInstructionsUserText(presented)
          || isCodexTurnAbortedUserText(presented) || isCodexGoalContinuationUserText(presented) };
      bodies.set(row, audit);
    }
    delete row.record.payload.message;
    delete row.record.payload.content;
    delete row.record.payload.replacement_history;
    row.fixtureIndex = index;
    return row;
  });
  const coordinates = _api.buildCodexTimeline(records, sessionId).map(({ content, ...coordinate }) => coordinate);
  const select = (proof, extra = {}) => selectCodexResultBootstrap({ rows, coordinates, sessionId, proof,
    findExecutionContext: _api.findCodexPromptExecutionContext,
    readBody: async row => { assert.equal(row.kind, 'user'); reads.push(row.fixtureIndex); return bodies.get(row); },
    ...extra });
  const batch = (selection, options = {}) => _api.buildCodexProviderTurnAssistantResult(records, sessionId, {
    promptUserUuid: selection.selectedPrompt.userUuid,
    promptSourceIdentity: selection.selectedPrompt.sourceIdentity,
    targetExecutionContext: selection.targetExecutionContext,
  }, 100000, { allowHistoricalGenerationUnknown: true, ...options });
  const oldMatch = proof => {
    const turns = [], recordMap = new Map();
    let current = null;
    for (const entry of _api.buildCodexFullHistory(records, sessionId)) {
      if (entry.role === 'user') {
        current = { kind: 'user', userUuid: entry.uuid, userTimestamp: entry.timestamp, assistantUuids: [] };
        turns.push(current);
        recordMap.set(entry.uuid, { type: 'user', message: { content: entry.content } });
      } else if (entry.role === 'compact') current = null;
      else if (entry.role === 'assistant' && current) current.assistantUuids.push(entry.uuid);
    }
    return findMatchingClaudePromptTurn({ turns, recordMap, ...proof });
  };
  return { rows, records, coordinates, reads, bodies, select, batch, oldMatch };
}

test('modern unbound Retry matches the old bounded hash selector and enables only private historical proof', async () => {
  const f = fixture([...turn('OLD', 'nonce: old', 'old'), ...turn('RETRY', 'nonce: retry', 'repaired', T1)]);
  const proof = { promptHash: promptFingerprint('nonce: retry'), requestedAt: Date.parse(T1) };
  const result = await f.select(proof);
  assert.equal(result.selectedPrompt.userUuid, f.oldMatch(proof).turn.userUuid);
  assert.equal(result.targetExecutionContext.turnId, 'RETRY');
  assert.equal(result.targetExecutionContext.generation, null);
  assert.equal(result.legacy, false);
  assert.deepEqual(f.reads, [5], 'metadata prunes the unrelated nonce before body I/O');
  const strict = f.batch(result, { allowHistoricalGenerationUnknown: false });
  assert.equal(strict.errorCode, 'execution_identity_incomplete');
  const historical = f.batch(result);
  assert.equal(historical.complete, true);
  assert.equal(historical.assistantText, 'repaired');
  assert.equal(historical.proofMode, 'historical-provider-turn');
  assert.equal(historical.providerGeneration, null);
});

test('restart uses durable UUID/source and never substitutes a same-text prompt for missing identity', async () => {
  const f = fixture([...turn('A', 'same', 'first'), ...turn('B', 'same', 'second', T1)]);
  for (const proof of [{ promptUserUuid: f.rows[1].user.uuid }, { promptSourceIdentity: f.rows[1].user.sourceIdentity }]) {
    const result = await f.select({ ...proof, promptHash: promptFingerprint('same'), resultAfterAt: Date.parse(T2) });
    assert.equal(result.targetExecutionContext.turnId, 'A', 'exact identity wins over time/hash hints');
    assert.equal(f.batch(result).assistantText, 'first');
  }
  f.reads.length = 0;
  assert.equal((await f.select({ promptUserUuid: 'absent', promptHash: promptFingerprint('same') })).selectedPrompt, null);
  assert.equal((await f.select({ promptUserUuid: f.rows[1].user.uuid,
    promptSourceIdentity: f.rows[5].user.sourceIdentity })).selectedPrompt, null);
  assert.deepEqual(f.reads, []);
});

test('prestart response identity canonicalizes through existing coordinates without inventing generation', async () => {
  const f = fixture([message('user', 'run'), event('task_started', { turn_id: 'T', started_at: 1789370400 }),
    message('assistant', 'before alias'), user('run'), message('assistant', 'final'),
    event('task_complete', { turn_id: 'T', last_agent_message: 'final' })]);
  for (const proof of [{ promptUserUuid: f.rows[0].user.uuid }, { promptSourceIdentity: f.rows[0].user.sourceIdentity }]) {
    const result = await f.select(proof);
    assert.equal(result.selectedPrompt.userUuid, f.rows[3].user.uuid);
    assert.deepEqual(result.selectedPrompt.userUuidAliases, [f.rows[0].user.uuid]);
    assert.deepEqual(result.selectedPrompt.sourceIdentityAliases, [f.rows[0].user.sourceIdentity]);
    assert.equal(result.targetExecutionContext.turnId, 'T');
    assert.equal(result.targetExecutionContext.startedAt, 1789370400000);
    assert.equal(result.targetExecutionContext.generation, null);
    assert.equal(f.batch(result).assistantText, 'before alias\n\nfinal');
  }
  assert.equal((await f.select({ promptHash: promptFingerprint('run') })).selectedPrompt.userUuid, f.rows[3].user.uuid);
});

test('an open previous start owns a response carrier before a different next start', async () => {
  const f = fixture([event('task_started', { turn_id: 'A' }), message('user', 'still A'),
    event('task_started', { turn_id: 'B' }), user('now B'), message('assistant', 'B answer')]);
  const result = await f.select({ promptUserUuid: f.rows[1].user.uuid });
  assert.equal(result.targetExecutionContext.turnId, 'A');
  assert.equal(f.batch(result).complete, undefined);
  assert.equal(f.batch(result).boundaryReason, 'next-task-started');
});

test('hash ambiguity and inclusive lower/upper bounds match the existing matcher before body reads', async () => {
  const f = fixture([...turn('A', 'same', 'A', T0), ...turn('B', 'same', 'B', T1)]);
  const ambiguous = { promptHash: promptFingerprint('same'), requestedAt: Date.parse(T1) };
  assert.equal(f.oldMatch(ambiguous), null);
  assert.equal((await f.select(ambiguous)).reason, 'prompt-ambiguous');
  f.reads.length = 0;
  const bounded = { ...ambiguous, requestedAt: Date.parse(T0) + 5 * 60 * 1000, resultBeforeAt: Date.parse(T0) };
  const result = await f.select(bounded);
  assert.equal(result.selectedPrompt.userUuid, f.oldMatch(bounded).turn.userUuid);
  assert.deepEqual(f.reads, [1]);
});

test('resultAfterAt selects the latest real prompt with assistant evidence, including partial work', async () => {
  const f = fixture([...turn('A', 'first', 'A'), event('task_started', { turn_id: 'B' }, T1),
    user('second', T1), message('assistant', 'partial B', T1),
    user('<subagent_notification>done</subagent_notification>', T1),
    event('task_started', { turn_id: 'C' }, T2), user('unanswered', T2)]);
  const proof = { resultAfterAt: Date.parse(T0), resultBeforeAt: Date.parse(T2) };
  const result = await f.select(proof);
  assert.equal(result.selectedPrompt.userUuid, f.oldMatch(proof).turn.userUuid);
  assert.equal(result.targetExecutionContext.turnId, 'B');
  assert.deepEqual(f.reads, [5]);
});

test('timestamp aliases survive restart; missing timestamp never becomes current time', async () => {
  const rows = [...turn('A', 'timed', 'A'), ...turn('B', 'no timestamp', 'B')];
  rows[1] = { ...rows[1], timestamp: undefined, created_at: T1 };
  rows[5] = { ...rows[5], timestamp: undefined };
  const f = fixture(rows);
  const result = await f.select({ resultAfterAt: Date.parse(T1) });
  assert.equal(result.selectedPrompt.userUuid, f.rows[1].user.uuid);
  assert.equal(result.selectedPrompt.timestamp, T1);
  assert.deepEqual(f.reads, [1]);
});

test('late terminal changes provider proof while selection and unknown generation remain stable', async () => {
  const records = [event('task_started', { turn_id: 'T' }), user('run'), message('assistant', 'answer')];
  const open = fixture(records), proof = { promptUserUuid: open.rows[1].user.uuid };
  const before = await open.select(proof);
  assert.equal(open.batch(before).complete, false);
  const closed = fixture([...records, event('task_complete', { turn_id: 'T', last_agent_message: 'answer' })]);
  const after = await closed.select(proof);
  assert.deepEqual(after.targetExecutionContext, before.targetExecutionContext);
  assert.equal(after.selectedPrompt.userUuid, before.selectedPrompt.userUuid);
  assert.equal(closed.batch(after).complete, true);
});

test('no lifecycle generation is inferred from the callback, proof hint, or source ordinal', async () => {
  const f = fixture(turn('T', 'run', 'answer'));
  const proof = { promptUserUuid: f.rows[1].user.uuid,
    targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 999 } };
  const result = await f.select(proof, { findExecutionContext: (...args) => ({
    ..._api.findCodexPromptExecutionContext(...args), generation: 0, processId: 1234,
  }) });
  assert.equal(result.targetExecutionContext.generation, null);
  assert.equal(result.targetExecutionContext.processId, null);
  assert.equal((await f.select({ ...proof, targetExecutionContext: { ...proof.targetExecutionContext, turnId: 'other' } })).reason,
    'bootstrap-execution-mismatch');
});

test('old transcript without provider start returns a legacy selection, not a forged exact execution', async () => {
  const f = fixture([user('legacy'), message('assistant', 'legacy answer'), event('task_complete')]);
  const result = await f.select({ promptHash: promptFingerprint('legacy') });
  assert.equal(result.legacy, true);
  assert.equal(result.targetExecutionContext, null);
  assert.equal(_api.buildCodexTurnAssistantResult(f.records, 'S', result.selectedPrompt.userUuid).assistantText, 'legacy answer');
});

test('provider classifier remains authoritative for abort, no-final and typed error after bootstrap', async t => {
  for (const [name, terminal] of [
    ['abort', event('turn_aborted', { turn_id: 'T' })],
    ['no-final', event('task_complete', { turn_id: 'T', last_agent_message: '' })],
    ['provider error', event('task_complete', { turn_id: 'T', error: { codex_error_info: 'server_overloaded', message: 'overloaded' } })],
  ]) await t.test(name, async () => {
    const f = fixture([event('task_started', { turn_id: 'T' }), user('run'), terminal]);
    const result = await f.select({ promptUserUuid: f.rows[1].user.uuid });
    const outcome = f.batch(result);
    const strict = _api.buildCodexProviderTurnAssistantResult(f.records, 'S', {
      promptUserUuid: result.selectedPrompt.userUuid,
      targetExecutionContext: { ...result.targetExecutionContext, generation: 3 },
    }, 100000);
    assert.equal(outcome.complete, false);
    assert.equal(outcome.terminalEvent, terminal.payload.type);
    assert.equal(outcome.terminalOutcomeReason, strict.terminalOutcomeReason);
    assert.equal(outcome.hasFinalResult, false);
    if (name === 'provider error') assert.equal(outcome.terminalOutcomeReason, 'provider_error');
    assert.equal('complete' in result, false, 'selector does not decide completion');
  });
});

test('legacy user-bound and exact provider-bound composition differ on an in-turn clarification', async () => {
  const f = fixture([event('task_started', { turn_id: 'T' }), user('original'), message('assistant', 'before'),
    user('clarification'), message('assistant', 'after'), event('task_complete', { turn_id: 'T', last_agent_message: 'after' })]);
  const result = await f.select({ promptUserUuid: f.rows[1].user.uuid });
  const legacy = _api.buildCodexTurnAssistantResult(f.records, 'S', result.selectedPrompt.userUuid);
  const provider = f.batch(result);
  assert.equal(legacy.assistantText, 'before');
  assert.equal(legacy.complete, false);
  assert.equal(provider.assistantText, 'before\n\nafter');
  assert.equal(provider.complete, true);
});

test('compact and subagent notification preserve result composition under the shared provider classifier', async () => {
  const f = fixture([event('task_started', { turn_id: 'T' }), user('original'), message('assistant', 'before'),
    { type: 'compacted', payload: { replacement_history: [] } },
    user('<subagent_notification>done</subagent_notification>'), message('assistant', 'after'),
    event('task_complete', { turn_id: 'T', last_agent_message: 'after' })]);
  const result = await f.select({ promptUserUuid: f.rows[1].user.uuid });
  const legacy = _api.buildCodexTurnAssistantResult(f.records, 'S', result.selectedPrompt.userUuid);
  assert.equal(f.batch(result).assistantText, legacy.assistantText);
  assert.equal(f.batch(result).complete, legacy.complete);
});

test('existing retained coordinate lookup excludes rolled-back prompts without reading them', async () => {
  const f = fixture([...turn('A', 'kept', 'A'), ...turn('B', 'removed', 'B'),
    event('thread_rolled_back', { num_turns: 1 }), ...turn('C', 'new', 'C', T2)]);
  assert.equal((await f.select({ promptHash: promptFingerprint('removed') })).selectedPrompt, null);
  assert.deepEqual(f.reads, []);
  const kept = await f.select({ promptHash: promptFingerprint('kept') });
  assert.equal(kept.targetExecutionContext.turnId, 'A');
});

test('changed prompt body fails explicitly instead of trusting stale hash metadata', async () => {
  const f = fixture(turn('T', 'original', 'answer'));
  f.bodies.set(f.rows[1], 'rewritten');
  await assert.rejects(f.select({ promptUserUuid: f.rows[1].user.uuid }), /bootstrap-prompt-metadata-changed/);
});

test('parent compact control clears legacy assistant attribution for canonical compact variants', async () => {
  const compactRecord = event('compact_completed');
  assert.equal(_api.isCompactPayload(compactRecord.payload), true);
  const f = fixture([event('task_started', { turn_id: 'T' }), user('before compact'), compactRecord,
    message('assistant', 'only after compact'),
    event('task_complete', { turn_id: 'T', last_agent_message: 'only after compact' })]);
  f.rows[2].control = 'compact';
  const proof = { resultAfterAt: Date.parse(T0) };
  assert.equal(f.oldMatch(proof), null);
  assert.equal((await f.select(proof)).selectedPrompt, null);
  assert.deepEqual(f.reads, [], 'a post-compact orphan is not evidence for the earlier prompt');
  const exact = await f.select({ promptUserUuid: f.rows[1].user.uuid });
  assert.equal(exact.targetExecutionContext.turnId, 'T', 'the control does not create a provider turn');
  assert.equal(exact.targetExecutionContext.generation, null);
});

test('canonical hasAssistant metadata admits tool/thinking evidence and overrides fallback text observation', async () => {
  const f = fixture([...turn('A', 'first', 'old answer'),
    event('task_started', { turn_id: 'B' }, T1), user('tool work', T1),
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
      call_id: 'call', arguments: '{"cmd":"pwd"}' } }]);
  const latest = f.coordinates.find(row => row.uuid === f.rows[5].user.uuid);
  latest.hasAssistant = true;
  const proof = { resultAfterAt: Date.parse(T0) };
  assert.equal((await f.select(proof)).targetExecutionContext.turnId, 'B');
  assert.deepEqual(f.reads, [5]);
  latest.hasAssistant = false;
  f.coordinates.find(row => row.uuid === f.rows[1].user.uuid).hasAssistant = false;
  f.reads.length = 0;
  assert.equal((await f.select(proof)).selectedPrompt, null);
  assert.deepEqual(f.reads, []);
});

test('legacy assistant owner locators from the existing coordinate reducer match the batch collector', async t => {
  for (const [name, records, selectedLine] of [
    ['compact keeps result owner', [user('kept'), message('assistant', 'before'),
      { type: 'compacted', payload: { replacement_history: [] } },
      user('<subagent_notification>done</subagent_notification>'), message('assistant', 'after'),
      event('task_complete'), user('next'), message('assistant', 'not ours')], 0],
    ['canonical alias upgrades the same owner', [message('user', 'kept'), message('assistant', 'before'),
      user('kept'), message('assistant', 'after'), event('task_complete')], 2],
    ['rollback reuses a coordinate number without reusing the removed owner', [user('kept'), message('assistant', 'before'),
      event('task_complete'), user('removed'), message('assistant', 'discarded'), event('task_complete'),
      event('thread_rolled_back', { num_turns: 1 }), message('assistant', 'continued'),
      user('new'), message('assistant', 'not ours'), event('task_complete')], 0],
  ]) await t.test(name, () => {
    const f = fixture(records);
    const projector = _api.createCodexTimelineProjector('S');
    const sources = [];
    for (const [index, record] of f.records.entries()) {
      projector.feed(record);
      if (record.type === 'response_item' && record.payload?.role === 'assistant') {
        sources.push({ rowIndex: index, owner: projector.exportState().currentUser });
      }
    }
    const identity = _api.getCodexUserRecordIdentity(f.records[selectedLine], 'S');
    const target = projector.peekEntries().find(row => row.uuid === identity.uuid);
    assert.ok(target);
    const assistantBlocks = sources.filter(source => source.owner === target)
      .map(source => _api.extractTextContent(f.records[source.rowIndex].payload.content).trim()).filter(Boolean);
    const expected = _api.buildCodexTurnAssistantResult(f.records, 'S', identity.uuid);
    assert.equal(assistantBlocks.join('\n\n'), expected.assistantText);
    assert.equal(target.responseComplete === true, expected.complete);
    assert.equal(assistantBlocks.length, expected.assistantBlockCount);
  });
});
