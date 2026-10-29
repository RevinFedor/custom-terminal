'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reader = require('./subagent-transcript');
const {inspectCodexSessionMetadata} = require('./codex-source-settings');

const native = (id = 'child-A', parent = 'parent') => ({id, session_id: parent,
  parent_thread_id: parent, thread_source: 'subagent', multi_agent_version: 'v1',
  source: {subagent: {thread_spawn: {parent_thread_id: parent, depth: 1,
    agent_path: null, agent_nickname: 'Native fixture', agent_role: 'default'}}}});
const record = payload => ({type: 'session_meta', payload});
const settings = thread_id => ({type: 'event_msg', payload: {type: 'thread_settings_applied',
  thread_id, thread_settings: {service_tier: 'priority'}}});
const context = {type: 'turn_context', payload: {model: 'gpt-6-luna', effort: 'high'}};
const text = value => ({type: 'response_item', payload: {type: 'message', role: 'assistant',
  phase: 'commentary', content: [{type: 'output_text', text: value}]}});
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
async function fixture(rows, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-native-v1-root-'));
  const filePath = path.join(dir, 'own.jsonl');
  try { fs.writeFileSync(filePath, jsonl(rows)); return await run(filePath); }
  finally { fs.rmSync(dir, {recursive: true}); }
}

test('native v1 parent-context session_id keeps exact child identity, own parameters, body and EOF/reopen', async () => {
  await fixture([record(native()), settings('parent'), settings('child-A'), context, text('OWN')], async filePath => {
    const boundary = await reader.findCodexSubagentNewTaskBoundary({filePath, expectedSessionId: 'child-A'});
    assert.equal(boundary.identityError, null); assert.equal(boundary.sessionId, 'child-A');
    assert.equal(boundary.requiresBoundary, false);
    const state = reader.createSubagentStepProjectionState({codexSessionId: 'child-A'});
    const own = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state});
    assert.equal(own.success, true); assert.equal(own.launchSettings.sessionId, 'child-A');
    assert.equal(own.launchSettings.model, 'gpt-6-luna'); assert.equal(own.launchSettings.effort, 'high');
    assert.equal(own.launchServiceTier.sessionId, 'child-A');
    assert.deepEqual(own.steps.map(step => step.text), ['OWN']);
    const eof = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state, offset: own.offset});
    assert.equal(eof.success, true); assert.equal(eof.launchSettings, own.launchSettings); assert.deepEqual(eof.steps, []);
    const reopened = reader.readAgentSteps({toolType: 'codex', filePath, sessionId: 'child-A'});
    assert.equal(reopened.success, true); assert.deepEqual(reopened.steps.map(step => step.text), ['OWN']);
  });
});

test('native v1 exemption never accepts another child or contradictory/missing parent provenance', async () => {
  const base = native();
  for (const meta of [native('child-B'), {...base, id: undefined}, {...base, session_id: 'unrelated'},
    {...base, parent_thread_id: 'unrelated'}, {...base, parent_thread_id: undefined},
    {...base, source: undefined}, {...base, source: {subagent: {thread_spawn: {parent_thread_id: 'unrelated'}}}},
    {...base, multi_agent_version: 'v2'}, {...base, multi_agent_version: undefined}, {...base, thread_source: 'user'}]) {
    await fixture([record(meta), context, text('FOREIGN'), record(base), text('NOT_A_REPAIR')], async filePath => {
      const boundary = await reader.findCodexSubagentNewTaskBoundary({filePath, expectedSessionId: 'child-A'});
      assert.ok(boundary.identityError); assert.equal(boundary.found, false);
      const result = await reader.readAgentStepsAsync({toolType: 'codex', filePath, sessionId: 'child-A'});
      assert.equal(result.success, false); assert.equal(result.reason, 'child-root-identity-mismatch');
      assert.deepEqual(result.steps, []); assert.equal(result.launchSettings, undefined);
    });
  }
});

test('native parent-context exception is local to child reads; generic source/Fork alias guard remains strict', () => {
  assert.equal(inspectCodexSessionMetadata([record(native())], 'child-A').valid, false);
  const ownAliases = {...native(), session_id: 'child-A'};
  assert.equal(inspectCodexSessionMetadata([record(ownAliases)], 'child-A').valid, true);
});

test('native v1 projection retains only small root provenance and resets it with the selected source', () => {
  const meta = native();
  Object.defineProperty(meta, 'base_instructions', {get() { assert.fail('identity must not inspect or retain body'); }});
  const state = reader.createSubagentStepProjectionState({codexSessionId: 'child-A'});
  reader.codexRecordToSteps(record(meta), state);
  assert.equal(state.codexRootIdentityError, null);
  assert.equal(state.codexRootIdentity.id, 'child-A');
  assert.equal(state.codexRootIdentity.source.subagent.thread_spawn.parent_thread_id, 'parent');
  assert.ok(JSON.stringify(state.codexRootIdentity).length < 512);
  assert.equal('base_instructions' in state.codexRootIdentity, false);
  const other = reader.createSubagentStepProjectionState({codexSessionId: 'child-B'});
  reader.codexRecordToSteps(record(meta), other);
  assert.ok(other.codexRootIdentityError);
  assert.deepEqual(reader.codexRecordToSteps(text('FOREIGN'), other), []);
});

test('native v1 unbound read behavior and v2 compatible aliases are preserved', async () => {
  await fixture([record(native()), context, text('OWN')], async filePath => {
    const result = reader.readAgentSteps({toolType: 'codex', filePath});
    assert.equal(result.success, true); assert.deepEqual(result.steps.map(step => step.text), ['OWN']);
  });
  const state = reader.createSubagentStepProjectionState({codexSessionId: 'child-A'});
  reader.codexRecordToSteps(record({...native(), session_id: 'child-A', multi_agent_version: 'v2', agent_path: '/root/A'}), state);
  assert.equal(state.codexRootIdentityError, null); assert.equal(state.codexNeedsNewTaskBoundary, true);
  assert.deepEqual(reader.codexRecordToSteps(text('COPIED_PREFIX'), state), []);
});
