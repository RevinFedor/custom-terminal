const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexStartedLaunchSettings, codexOwnTurnLaunchSettings } = require('./subagent-launch-settings');
const { createCodexSubagentTracker } = require('./codex-subagent-cards');
const { createSubagentStepProjectionState, codexRecordToSteps, claudeRecordToSteps,
  readAgentStepsAsync } = require('./subagent-transcript');
const { makeHistoryRowStub } = require('./history-entry-window');

const started = (extra = {}) => ({ type: 'sub_agent_activity', kind: 'started', event_id: 'spawn-A',
  agent_thread_id: 'child-A', agent_path: '/root/A', model: 'gpt-6-luna', reasoning_effort: 'max', ...extra });
const context = (model, effort = 'max') => ({ type: 'turn_context', timestamp: '2026-10-09T07:00:00.000Z',
  payload: { model, effort } });
const newTask = { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/A',
  content: 'Message Type: NEW_TASK\nTask name: /root/A\nSender: /root\nPayload:\nDo task A' } };

test('resolved creation requires exact spawn and child, not interacted/requested settings', () => {
  const proof = codexStartedLaunchSettings(started(), 'spawn-A', 'child-A', '2026-10-09T07:00:00Z');
  assert.equal(proof.model, 'gpt-6-luna'); assert.equal(proof.effort, 'max');
  assert.equal(proof.source, 'subagent-started');
  assert.equal(codexStartedLaunchSettings(started({ kind: 'interacted' }), 'spawn-A', 'child-A'), null);
  assert.equal(codexStartedLaunchSettings(started(), 'spawn-B', 'child-A'), null);
  assert.equal(codexStartedLaunchSettings(started(), 'spawn-A', 'child-B'), null);
  assert.equal(codexStartedLaunchSettings(started({ model: null }), 'spawn-A', 'child-A'), null);
});

test('missing/conflicting effort stays unknown without parent/default substitution', () => {
  assert.equal(codexStartedLaunchSettings(started({ reasoning_effort: null }), 'spawn-A', 'child-A').effort, null);
  const proof = codexStartedLaunchSettings(started({ effort: 'low' }), 'spawn-A', 'child-A');
  assert.equal(proof.model, 'gpt-6-luna'); assert.equal(proof.effort, null);
  assert.equal(codexOwnTurnLaunchSettings(context('gpt-6-astra'), 'child-A', 'parent'), null);
});

test('Task retains original creation proof across interacted None and later settings', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({ callId: 'spawn-A', args: { task_name: 'A' } });
  tracker.onSubAgentActivity(started()); const proof = card.launchSettings;
  tracker.onSubAgentActivity(started({ kind: 'interacted', model: null, reasoning_effort: null }));
  tracker.onSubAgentActivity(started({ model: 'gpt-6-astra', reasoning_effort: 'low' }));
  assert.strictEqual(card.launchSettings, proof);
  assert.equal(card.launchSettings.model, 'gpt-6-luna');
});

test('path-only or wrong-thread activity cannot supply creation metadata to another Task', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({ callId: 'spawn-A', args: { task_name: 'A' } });
  tracker.onSubAgentActivity(started({ event_id: 'different-call' }));
  assert.equal(card.launchSettings, undefined);
  tracker.onSubAgentActivity(started({ agent_thread_id: 'different-child' }));
  assert.equal(card.launchSettings, undefined);
});

test('hydration stub preserves only the compact launch object', () => {
  const launchSettings = codexStartedLaunchSettings(started(), 'spawn-A', 'child-A');
  const stub = makeHistoryRowStub({ uuid: 'row-A', role: 'assistant', timestamp: '2026-10-09T07:00:00Z',
    content: '', actions: [{ tool: 'Task', toolUseId: 'spawn-A', description: 'A', launchSettings,
      agentSessionId: 'child-A', result: 'not part of metadata' }] });
  assert.deepEqual(stub.actionSummary[0].launchSettings, launchSettings);
  assert.ok(JSON.stringify(launchSettings).length < 512);
  assert.equal(stub.actionSummary[0].result, undefined);
});

test('v2 copied ancestor settings ignored, first OWN context wins forever', () => {
  const state = createSubagentStepProjectionState({ codexSessionId: 'child-A' });
  codexRecordToSteps({ type: 'session_meta', payload: { id: 'child-A', thread_source: 'subagent',
    parent_thread_id: 'parent', agent_path: '/root/A', multi_agent_version: 'v2' } }, state);
  codexRecordToSteps(context('wrong-parent-model', 'low'), state);
  assert.equal(state.launchSettings, null);
  codexRecordToSteps(newTask, state);
  codexRecordToSteps(context('gpt-6-luna'), state);
  codexRecordToSteps(context('gpt-6-astra', 'low'), state);
  assert.equal(state.launchSettings.model, 'gpt-6-luna');
  assert.equal(state.launchSettings.effort, 'max');
});

test('Claude takes first own assistant model; effort is not guessed', () => {
  const state = createSubagentStepProjectionState();
  claudeRecordToSteps({ type: 'assistant', sessionId: 'claude-A', message: { model: '<synthetic>', content: [] } }, state);
  assert.equal(state.launchSettings, null);
  claudeRecordToSteps({ type: 'assistant', sessionId: 'claude-A', message: { model: 'claude-haiku', content: [] } }, state);
  claudeRecordToSteps({ type: 'assistant', sessionId: 'claude-A', message: { model: 'claude-opus', content: [] } }, state);
  assert.equal(state.launchSettings.model, 'claude-haiku'); assert.equal(state.launchSettings.effort, null);
});

test('incremental EOF with no steps retains metadata; reset discards old source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-subagent-launch-test-'));
  const filePath = path.join(dir, 'child-A.jsonl');
  const state = createSubagentStepProjectionState({ codexSessionId: 'child-A' });
  const write = model => fs.writeFileSync(filePath, [
    { type: 'session_meta', payload: { id: 'child-A' } }, context(model),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  try {
    write('gpt-6-luna');
    const first = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state });
    assert.deepEqual(first.steps, []); assert.equal(first.launchSettings.model, 'gpt-6-luna');
    const eof = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state, offset: first.offset });
    assert.deepEqual(eof.steps, []); assert.equal(eof.offset, first.offset); assert.equal(eof.launchSettings.model, 'gpt-6-luna');
    write('gpt-6-astra');
    const reset = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: state, offset: 0 });
    assert.equal(reset.launchSettings.model, 'gpt-6-astra');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
