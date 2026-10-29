'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reader = require('./subagent-transcript');

const root = (id = 'child-A', extra = {}) => ({type: 'session_meta', payload: {
  id, parent_thread_id: 'parent', thread_source: 'subagent', multi_agent_version: 'v2', agent_path: '/root/A', ...extra,
}});
const task = {type: 'response_item', payload: {type: 'agent_message', author: '/root', recipient: '/root/A',
  content: 'Message Type: NEW_TASK\nTask name: /root/A\nSender: /root\nPayload:\n'}};
const body = text => ({type: 'response_item', payload: {type: 'message', role: 'assistant',
  phase: 'commentary', content: [{type: 'output_text', text}]}});
const rows = records => records.map(row => JSON.stringify(row) + '\n').join('');
async function fixture(records, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-root-identity-'));
  const filePath = path.join(dir, 'selected-child-A.jsonl');
  try { fs.writeFileSync(filePath, rows(records)); return await run(filePath, dir); }
  finally { fs.rmSync(dir, {recursive: true}); }
}
const scan = (filePath, extra = {}) => reader.findCodexSubagentNewTaskBoundary({filePath,
  expectedSessionId: 'child-A', ...extra});

test('selected root: exact v2, both compatible aliases, alias-only root, and omitted legacy parent remain readable', async () => {
  for (const meta of [root(), root('child-A', {session_id: 'child-A'}),
    root(undefined, {id: undefined, session_id: 'child-A'}), root('child-A', {parent_thread_id: undefined})]) {
    await fixture([meta, task, body('OWN')], async filePath => {
      const result = await scan(filePath);
      assert.equal(result.found, true);
      assert.equal(result.sessionId, 'child-A');
      const projected = await reader.readAgentStepsAsync({toolType: 'codex', filePath,
        sessionId: 'child-A'});
      assert.equal(projected.success, true);
      assert.deepEqual(projected.steps.map(step => step.text), ['OWN']);
    });
  }
});

test('selected root: foreign ID/alias or absent ID never authorizes boundary/body', async () => {
  for (const meta of [root('foreign'), root('child-A', {session_id: 'foreign'}),
    root(undefined, {id: undefined}),
    {type: 'session_meta', payload: null}]) {
    await fixture([meta, task, body('FOREIGN'), root(), task, body('NOT_A_REPAIR')], async filePath => {
      const boundary = await scan(filePath);
      assert.equal(boundary.found, false);
      assert.ok(boundary.identityError);
      assert.equal(boundary.offset, 0);
      for (const read of [reader.readAgentSteps, reader.readAgentStepsAsync]) {
        const result = await read({toolType: 'codex', filePath, sessionId: 'child-A'});
        assert.equal(result.success, false);
        assert.equal(result.reason, 'child-root-identity-mismatch');
        assert.deepEqual(result.steps, []);
        assert.equal(result.offset, 0);
        assert.equal(result.launchSettings, undefined);
      }
    });
  }
});

test('selected root: copied ancestor root cannot replace the first matching root or disable NEW_TASK', async () => {
  await fixture([root(), root('foreign', {multi_agent_version: 'v1'}), body('COPIED_PARENT'), task, body('OWN')], async filePath => {
    const boundary = await scan(filePath);
    assert.equal(boundary.found, true);
    assert.equal(boundary.sessionId, 'child-A');
    const result = reader.readAgentSteps({toolType: 'codex', filePath, sessionId: 'child-A'});
    assert.deepEqual(result.steps.map(step => step.text), ['OWN']);
  });
});

test('selected root: v1 needs identity proof but not a v2 NEW_TASK; no-explicit-SID semantics stay unbound', async () => {
  await fixture([root('legacy', {multi_agent_version: 'v1'}), body('LEGACY')], async filePath => {
    const own = await scan(filePath, {expectedSessionId: 'legacy'});
    assert.equal(own.rootMetaSeen, true); assert.equal(own.requiresBoundary, false); assert.equal(own.identityError, null);
    const wrong = await scan(filePath);
    assert.ok(wrong.identityError); assert.equal(wrong.found, false);
    const legacy = reader.readAgentSteps({toolType: 'codex', filePath});
    assert.equal(legacy.success, true); assert.deepEqual(legacy.steps.map(step => step.text), ['LEGACY']);
    const unbound = await reader.findCodexSubagentNewTaskBoundary({filePath});
    assert.equal(unbound.sessionId, 'legacy'); assert.equal(unbound.requiresBoundary, false);
  });
});

test('selected root: direct reducer latches first-root mismatch, suppressing settings/calls/results and copied repair', () => {
  const state = reader.createSubagentStepProjectionState({codexSessionId: 'child-A'});
  const records = [root('foreign'), task,
    {type: 'turn_context', payload: {model: 'foreign-model', effort: 'max'}},
    {type: 'response_item', payload: {type: 'function_call', call_id: 'foreign-call', name: 'Read', arguments: '{}'}},
    body('FOREIGN'), root(), task, body('NOT_A_REPAIR')];
  assert.deepEqual(records.flatMap(row => reader.codexRecordToSteps(row, state)), []);
  assert.ok(state.codexRootIdentityError); assert.equal(state.launchSettings, null);
  assert.equal(state.codexCalls.size, 0);
});

test('selected root: bound live reducer without a root record retains its existing delta-consumer behavior', () => {
  const state = reader.createSubagentStepProjectionState({codexSessionId: 'already-bound'});
  const result = reader.codexRecordToSteps(body('LIVE_DELTA'), state);
  assert.deepEqual(result.map(step => step.text), ['LIVE_DELTA']);
});

test('selected root: resumed scan preserves exact root/NEW_TASK and refuses another requested child', async () => {
  await fixture([root()], async filePath => {
    const pending = await scan(filePath);
    fs.appendFileSync(filePath, rows([task, body('OWN')]));
    const resumed = await scan(filePath, {resume: pending});
    assert.equal(resumed.found, true);
    const wrongChild = await scan(filePath, {expectedSessionId: 'child-B', resume: pending});
    assert.equal(wrongChild.found, false); assert.ok(wrongChild.identityError);
  });
});

test('selected root: resume from a different physical file never bypasses its first root', async () => {
  await fixture([root()], async (filePath, dir) => {
    const pending = await scan(filePath);
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(other, rows([root('foreign'), task, body('FOREIGN') ]));
    const result = await scan(other, {resume: pending});
    assert.equal(result.found, false); assert.ok(result.identityError);
  });
});

test('selected root: filename candidate and an unbound resumed scan cannot replace exact root/alias proof', async () => {
  for (const meta of [root('foreign'), root('child-A', {session_id: 'foreign'})]) {
    await fixture([meta], async (filePath, dir) => {
      assert.equal(reader.findCodexAgentFile({agentSessionId: 'child-A', sessionsDir: dir}), filePath);
      const unbound = await reader.findCodexSubagentNewTaskBoundary({filePath});
      fs.appendFileSync(filePath, rows([task, body('FOREIGN')]));
      const selected = await scan(filePath, {resume: unbound});
      assert.equal(selected.found, false); assert.ok(selected.identityError);
    });
  }
});

test('selected root: exact child does not relax NEW_TASK parent/recipient proof; a later valid boundary remains eligible', async () => {
  const foreignParentTask = {...task, payload: {...task.payload, author: '/foreign',
    content: 'Message Type: NEW_TASK\nTask name: /root/A\nSender: /foreign\nPayload:\n'}};
  const otherRecipientTask = {...task, payload: {...task.payload, recipient: '/root/B'}};
  await fixture([root(), foreignParentTask, otherRecipientTask, body('COPIED')], async filePath => {
    const pending = await scan(filePath);
    assert.equal(pending.found, false); assert.equal(pending.identityError, null);
    assert.equal(pending.rootMetaSeen, true); assert.equal(pending.requiresBoundary, true);
    const before = reader.readAgentSteps({toolType: 'codex', filePath, sessionId: 'child-A'});
    assert.equal(before.success, true); assert.deepEqual(before.steps, []);
    fs.appendFileSync(filePath, rows([task, body('OWN')]));
    assert.equal((await scan(filePath, {resume: pending})).found, true);
    const after = reader.readAgentSteps({toolType: 'codex', filePath, sessionId: 'child-A'});
    assert.deepEqual(after.steps.map(step => step.text), ['OWN']);
  });
});

test('selected root: replacement/reset and changed expected owner replay identity before using an old EOF', async () => {
  await fixture([root(), task, body('OWN_A')], async (filePath, dir) => {
    const state = reader.createSubagentStepProjectionState({codexSessionId: 'child-A'});
    const a = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state});
    assert.equal(a.success, true);
    const wrong = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-B', projectionState: state, offset: a.offset});
    assert.equal(wrong.success, false); assert.deepEqual(wrong.steps, []);
    const replacement = path.join(dir, 'replacement.jsonl');
    fs.writeFileSync(replacement, rows([root('child-B'), task, body('OWN_B')]));
    fs.renameSync(replacement, filePath);
    const b = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-B', projectionState: state, offset: a.offset});
    assert.equal(b.success, true); assert.deepEqual(b.steps.map(step => step.text), ['OWN_B']);
    assert.equal(b.reset, true);
    const eof = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-B', projectionState: state, offset: b.offset});
    assert.equal(eof.success, true); assert.deepEqual(eof.steps, []);
  });
});
