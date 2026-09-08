'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _api: api } = require('./ipc/codex-data');
const { buildCodexInboxResult } = require('./codex-inbox-result');
const sid = 'historical-audit-session';

function fixture() {
  const records = [];
  const add = (type, payload, extra = {}) => {
    const record = { type, payload, __line: records.length + 1, __byteOffset: (records.length + 1) * 100,
      timestamp: '2026-09-07T00:00:00.000Z', ...extra };
    records.push(record);
    return record;
  };
  const event = (type, fields = {}) => add('event_msg', { type, ...fields });
  const user = (message) => event('user_message', { message });
  const text = (value, turnId) => add('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', turn_id: turnId,
    content: [{ type: 'output_text', text: value }] });
  const thinking = (value) => add('response_item', { type: 'reasoning', summary: [{ text: value }] });
  const result = (record, options = {}) => buildCodexInboxResult({ records, sessionId: sid,
    audit: { entryUuid: `codex-user-${sid}-${record.__line}` }, api, ...options });
  return { records, add, event, user, text, thinking, result };
}
const contents = (result) => result.entries.map((entry) => entry.content).filter(Boolean);

test('exact audited user coordinate selects one same-text turn, including tools after its answer row', () => {
  const f = fixture();
  f.event('task_started', { turn_id: 'turn-A' });
  const a = f.user('same prompt');
  f.add('response_item', { type: 'function_call', call_id: 'call-A', name: 'exec_command', arguments: '{"cmd":"echo A"}' });
  f.text('answer A', 'turn-A');
  f.add('response_item', { type: 'function_call_output', role: 'user', call_id: 'call-A', output: 'output A' });
  f.event('task_complete', { turn_id: 'turn-A', last_agent_message: 'answer A' });
  f.event('task_started', { turn_id: 'turn-B' });
  const b = f.user('same prompt');
  f.text('answer B', 'turn-B');
  f.event('task_complete', { turn_id: 'turn-B', last_agent_message: 'answer B' });
  const resultA = f.result(a);
  const resultB = f.result(b);
  assert.equal(resultA.ok, true);
  assert.equal(resultA.terminal.success, true);
  assert.equal(resultA.identity.turnId, 'turn-A');
  assert.deepEqual(contents(resultA), ['answer A']);
  assert.ok(resultA.entries.some((entry) => entry.actions?.length), 'late tool result belongs to the same canonical user coordinate');
  assert.deepEqual(contents(resultB), ['answer B']);
  assert.equal(resultB.entries.some((entry) => entry.actions?.length), false);
});

test('a cross-user late output keeps its CALL owner and never consumes the next user thinking', () => {
  const f = fixture();
  f.event('task_started', { turn_id: 'A' }); const a = f.user('A');
  f.add('response_item', { type: 'function_call', call_id: 'late-A', name: 'exec_command', arguments: '{"cmd":"echo A"}' });
  f.text('A answer', 'A'); f.event('task_complete', { turn_id: 'A', last_agent_message: 'A answer' });
  f.event('task_started', { turn_id: 'B' }); const b = f.user('B'); f.thinking('B thinking');
  f.add('response_item', { type: 'function_call_output', call_id: 'late-A', output: 'late A output' });
  const resultA = f.result(a); const resultB = f.result(b);
  assert.equal(resultA.entries.filter((entry) => entry.actions?.length).length, 1);
  assert.equal(resultA.entries.some((entry) => entry.thinking === 'B thinking'), false);
  assert.equal(resultB.entries.some((entry) => entry.actions?.length), false);
  assert.equal(resultB.entries.some((entry) => entry.thinking === 'B thinking'), true);
});

test('pending tail keeps the original user coordinate and disappears when rollback removes its owner', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'A' }); const a = f.user('A');
  const call = f.add('response_item', { type: 'function_call', call_id: 'pending-A', name: 'exec_command', arguments: '{"cmd":"echo A"}' });
  f.event('task_complete', { turn_id: 'A', last_agent_message: 'A answer' });
  f.event('task_started', { turn_id: 'B' }); const b = f.user('B');
  assert.equal(f.result(a).entries.filter((entry) => entry.actions?.length).length, 1);
  assert.equal(f.result(b).entries.some((entry) => entry.actions?.length), false);
  // A separate rollback fixture reuses A's numeric index for B; object ownership
  // must prevent the old pending call/output from reappearing under the new user.
  const rolled = fixture(); rolled.event('task_started', { turn_id: 'old' }); rolled.user('old');
  rolled.add('response_item', { ...call.payload });
  rolled.event('thread_rolled_back', { num_turns: 1 });
  rolled.event('task_started', { turn_id: 'new' }); const newUser = rolled.user('new');
  assert.equal(rolled.result(newUser).entries.some((entry) => entry.actions?.length), false);
  rolled.add('response_item', { type: 'function_call_output', call_id: 'pending-A', output: 'output from removed old user' });
  assert.equal(rolled.result(newUser).entries.some((entry) => entry.actions?.length), false);
});

test('CALL owner survives a response carrier being promoted to its paired event user', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'paired' });
  f.add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'paired' }] });
  f.add('response_item', { type: 'function_call', call_id: 'paired-call', name: 'exec_command', arguments: '{"cmd":"echo paired"}' });
  const promoted = f.user('paired');
  f.add('response_item', { type: 'function_call_output', call_id: 'paired-call', output: 'paired output' });
  f.event('task_complete', { turn_id: 'paired', last_agent_message: 'paired done' });
  const result = f.result(promoted);
  assert.equal(result.ok, true);
  assert.equal(result.entries.filter((entry) => entry.actions?.length).length, 1);
  assert.equal(result.entries[0].turnIndex, result.identity.turnIndex);
});

test('pre-start response/event pairing accepts an exact source alias and excludes service carriers', () => {
  const f = fixture();
  f.user('# AGENTS.md instructions for /test\n<INSTRUCTIONS>project rules</INSTRUCTIONS>');
  const response = f.add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'paired prompt' }] });
  f.event('task_started', { turn_id: 'paired-turn' });
  const canonical = f.user('paired prompt');
  f.text('paired answer', 'paired-turn');
  f.event('task_complete', { turn_id: 'paired-turn', last_agent_message: 'paired answer' });
  const alias = `codex-user-source-${sid}-${response.__byteOffset}`;
  const result = f.result(canonical, { audit: { entryUuid: `codex-user-${sid}-${canonical.__line}`, sourceIdentity: alias } });
  assert.equal(result.ok, true);
  assert.ok(result.identity.sourceIdentityAliases.includes(alias));
  assert.equal(result.identity.turnId, 'paired-turn');
  assert.deepEqual(contents(result), ['paired answer']);
  assert.equal(result.entries.some((entry) => entry.serviceCarrier), false);
});

test('both raw response UUID and source alias stay exact through canonical promotion in either carrier order', () => {
  for (const eventFirst of [false, true]) {
    const f = fixture(); f.event('task_started', { turn_id: 'paired' });
    let event;
    if (eventFirst) event = f.user('same');
    const response = f.add('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same' }] });
    if (!eventFirst) event = f.user('same');
    f.text('answer', 'paired'); f.event('task_complete', { turn_id: 'paired', last_agent_message: 'answer' });
    const projector = api.createCodexHistoryProjector(sid); f.records.forEach(projector.feed);
    const normal = projector.finalize();
    const annotated = projector.finalize({ includeTurnCoordinates: true });
    const canonical = annotated.find((entry) => entry.role === 'user');
    const rawUuid = `codex-user-${sid}-${response.__line}`;
    assert.equal(canonical.uuid, `codex-user-${sid}-${event.__line}`);
    assert.deepEqual(canonical.sourceUuidAliases, [rawUuid]);
    assert.equal(normal.some((entry) => 'sourceUuidAliases' in entry), false);
    assert.equal(JSON.stringify(projector.finalize()), JSON.stringify(normal));
    const result = f.result(event, { audit: { entryUuid: rawUuid, sourceIdentity: `codex-user-source-${sid}-${response.__byteOffset}` } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.identity.sourceUuidAliases, [rawUuid]);
    const mismatched = f.result(event, { audit: { entryUuid: 'raw-UUID-of-another-user', sourceIdentity: canonical.sourceIdentity } });
    assert.equal(mismatched.code, 'audit-identity-mismatch');
  }
});

test('both provided identities must agree, even if one independently resolves', () => {
  const f = fixture();
  f.event('task_started', { turn_id: 'A' }); const a = f.user('A');
  f.text('A answer', 'A'); f.event('task_complete', { turn_id: 'A', last_agent_message: 'A answer' });
  f.event('task_started', { turn_id: 'B' }); const b = f.user('B');
  const result = f.result(a, { audit: { entryUuid: `codex-user-${sid}-${a.__line}`, sourceIdentity: `codex-user-source-${sid}-${b.__byteOffset}` } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'audit-identity-mismatch');
  assert.equal(result.terminal.ended, false);
});

test('typed provider failure after final text wins over the presence of that answer', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'error-turn' }); const u = f.user('question');
  f.thinking('reasoning'); f.text('partial final text', 'error-turn');
  f.event('task_complete', { turn_id: 'error-turn', last_agent_message: 'partial final text', error: { message: 'provider failed', codex_error_info: 'other' } });
  const result = f.result(u);
  assert.equal(result.ok, true);
  assert.deepEqual(contents(result), ['partial final text']);
  assert.equal(result.entries[0].thinking, 'reasoning');
  assert.equal(result.terminal.ended, true);
  assert.equal(result.terminal.success, false);
  assert.equal(result.terminal.reason, 'provider_error');
  assert.equal(result.terminal.error.message, 'provider failed');
});

test('final_answer without typed end remains pending; task_complete without a final result is a typed failure', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'pending' }); const u = f.user('question');
  f.text('not a completion signal', 'pending');
  let result = f.result(u);
  assert.equal(result.ok, true);
  assert.deepEqual(result.terminal, { ended: false, success: null, reason: 'awaiting-turn-end', event: null, turnId: 'pending' });
  assert.deepEqual(contents(result), ['not a completion signal']);
  const empty = fixture(); empty.event('task_started', { turn_id: 'empty' }); const emptyUser = empty.user('question');
  empty.event('task_complete', { turn_id: 'empty' });
  result = empty.result(emptyUser);
  assert.equal(result.terminal.reason, 'codex-no-final-result');
  assert.equal(result.terminal.success, false);
});

test('duplicate starts, duplicate ends and mismatched end IDs remain unproven', () => {
  for (const variant of ['duplicate-start', 'duplicate-end', 'wrong-end', 'missing-end-id']) {
    const f = fixture(); f.event('task_started', { turn_id: 'target' }); const u = f.user('question');
    f.text('partial answer', 'target');
    if (variant === 'duplicate-start') f.event('task_started', { turn_id: 'target' });
    f.event('task_complete', { turn_id: variant === 'wrong-end' ? 'other' : variant === 'missing-end-id' ? undefined : 'target', last_agent_message: 'answer' });
    if (variant === 'duplicate-end') f.event('task_complete', { turn_id: 'target', last_agent_message: 'answer' });
    const result = f.result(u);
    assert.equal(result.ok, false, variant);
    assert.equal(result.terminal.ended, false, variant);
    assert.equal(result.terminal.success, null, variant);
    assert.deepEqual(contents(result), ['partial answer']);
  }
});

test('rollback removes the audited target instead of resolving another same-text prompt', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'old' }); const u = f.user('same');
  f.text('old answer', 'old'); f.event('task_complete', { turn_id: 'old', last_agent_message: 'old answer' });
  f.event('thread_rolled_back', { num_turns: 1 });
  f.event('task_started', { turn_id: 'new' }); f.user('same'); f.text('new answer', 'new');
  const result = f.result(u);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'audit-identity-unproven');
  assert.deepEqual(result.entries, []);
});

test('optional thinking-only projection is non-consuming and default finalize output is unchanged', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'think' }); const u = f.user('question'); f.thinking('only thinking');
  const projector = api.createCodexHistoryProjector(sid); f.records.forEach(projector.feed);
  const baseline = JSON.stringify(projector.finalize());
  const projected = projector.finalize({ includeTurnCoordinates: true });
  assert.equal(JSON.stringify(projector.finalize()), baseline);
  const thinking = projected.find((entry) => entry.projection);
  assert.equal(thinking.thinking, 'only thinking');
  assert.equal(thinking.pending, true);
  assert.equal(thinking.sourceIdentity, undefined);
  assert.equal(thinking.turnIndex, projected.find((entry) => entry.role === 'user' && !entry.serviceCarrier).turnIndex);
  const result = f.result(u);
  assert.equal(result.terminal.ended, false);
  assert.equal(result.entries[0].thinking, 'only thinking');
  const answer = f.text('now text', 'think'); projector.feed(answer);
  assert.equal(projector.finalize({ includeTurnCoordinates: true }).filter((entry) => entry.role === 'assistant').length, 1);
  assert.equal(projector.finalize().find((entry) => entry.role === 'assistant').thinking, 'only thinking');
  assert.equal(JSON.stringify(projector.finalize()), JSON.stringify(api.buildCodexFullHistory(f.records, sid)));
});

test('aborted and failed thinking-only turns retain a settled projection without changing ordinary History', () => {
  for (const event of [{ type: 'turn_aborted', turn_id: 'think' }, { type: 'task_complete', turn_id: 'think', error: { message: 'failed' } }]) {
    const f = fixture(); f.event('task_started', { turn_id: 'think' }); const u = f.user('question'); f.thinking('kept reasoning');
    f.event(event.type, event);
    const result = f.result(u);
    assert.equal(result.terminal.ended, true);
    assert.equal(result.terminal.success, false);
    assert.equal(result.entries[0].thinking, 'kept reasoning');
    assert.equal(result.entries[0].pending, false);
    assert.equal(api.buildCodexFullHistory(f.records, sid).some((entry) => entry.projection), false);
  }
});

test('composite physical SID and view SID mismatch is explicit instead of inventing an execution context', () => {
  const f = fixture(); f.event('task_started', { turn_id: 'physical' }); const u = f.user('question'); f.text('partial', 'physical');
  const records = f.records.map((record) => ({ ...record, __physicalSessionId: 'physical-source' }));
  const result = buildCodexInboxResult({ records, sessionId: 'composite-view', audit: { entryUuid: `codex-user-physical-source-${u.__line}` }, api });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'execution-context-unproven');
  assert.equal(result.identity.turnId, null);
  assert.deepEqual(contents(result), ['partial']);
});

test('invalid record metadata and unavailable projector are explicit non-completion outcomes', () => {
  assert.equal(buildCodexInboxResult({ records: [{}], sessionId: sid, audit: { entryUuid: 'x' }, api }).code, 'transcript-record-metadata-unproven');
  assert.equal(buildCodexInboxResult({ records: [], sessionId: sid, audit: { entryUuid: 'x' }, api: {} }).code, 'transcript-api-unavailable');
  assert.equal(buildCodexInboxResult({ records: [], sessionId: sid, audit: {}, api }).code, 'missing-audit-identity');
});

test('file projector reuses its cache for optional coordinates and builder never constructs a second projector', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-inbox-result-cache-'));
  const filePath = path.join(dir, `rollout-2026-09-07T00-00-00-${sid}.jsonl`);
  t.after(async () => { api.invalidateCodexHistoryProjectors(filePath); await fs.promises.rm(dir, { recursive: true, force: true }); });
  const f = fixture(); f.event('task_started', { turn_id: 'cached' }); f.user('cached question'); f.thinking('cached partial');
  await fs.promises.writeFile(filePath, f.records.map(({ __line, __byteOffset, ...record }) => JSON.stringify(record)).join('\n') + '\n');
  const normal = await api.projectCodexFullHistoryFromFile(sid, null, { sessionsDir: dir });
  assert.equal(normal.success, true);
  assert.equal(normal.entries.some((entry) => 'turnIndex' in entry || entry.projection), false);
  const projected = await api.projectCodexFullHistoryFromFile(sid, null, { sessionsDir: dir, includeTurnCoordinates: true });
  assert.equal(projected.mode, 'unchanged');
  assert.equal(projected.fedRecords, 0);
  const stat = await fs.promises.stat(filePath);
  const loaded = await api.readJsonlRange(filePath, 0, stat.size - 1);
  assert.equal(Array.isArray(loaded.records), true);
  const result = buildCodexInboxResult({ records: loaded.records, sessionId: sid,
    audit: { entryUuid: projected.entries.find((entry) => entry.role === 'user').uuid }, projectedEntries: projected.entries,
    api: { findCodexPromptExecutionContext: api.findCodexPromptExecutionContext, createCodexHistoryProjector() { throw new Error('must reuse projected entries'); } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.terminal.ended, false);
  assert.equal(result.entries[0].thinking, 'cached partial');
  const normalAgain = await api.projectCodexFullHistoryFromFile(sid, null, { sessionsDir: dir });
  assert.equal(normalAgain.fedRecords, 0);
  assert.equal(JSON.stringify(normalAgain.entries), JSON.stringify(normal.entries));
});
