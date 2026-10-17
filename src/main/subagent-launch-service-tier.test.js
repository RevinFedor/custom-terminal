const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexOwnLaunchServiceTier } = require('./subagent-launch-settings');
const { createSubagentStepProjectionState, codexRecordToSteps, readAgentStepsAsync,
  findCodexSubagentNewTaskBoundary } = require('./subagent-transcript');

const meta = { type: 'session_meta', payload: { id: 'child-A', thread_source: 'subagent',
  parent_thread_id: 'parent', agent_path: '/root/A', multi_agent_version: 'v2' } };
const newTask = { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/A',
  content: 'Message Type: NEW_TASK\nTask name: /root/A\nSender: /root\nPayload:\nSynthetic task' } };
const snapshot = (tier, threadId = 'child-A') => ({ type: 'event_msg', timestamp: '2026-10-15T06:00:00Z',
  payload: { type: 'thread_settings_applied', thread_id: threadId,
    thread_settings: { model: 'gpt-6-luna', reasoning_effort: 'max', service_tier: tier } } });
const context = { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'max' } };
const state = () => createSubagentStepProjectionState({ codexSessionId: 'child-A' });
const apply = (projection, ...records) => records.flatMap(record => codexRecordToSteps(record, projection));
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

for (const [input, expected] of [['priority', 'priority'], ['fast', 'priority'], ['default', 'default'],
  [null, null], [undefined, null], ['flex', null], [true, null]]) {
  test(`exact own snapshot tier ${String(input)} is ${String(expected)}, never a parent/default guess`, () => {
    const proof = codexOwnLaunchServiceTier(snapshot(input), 'child-A', 'child-A');
    assert.equal(proof.serviceTier, expected);
    assert.equal(proof.source, 'own-thread-settings');
    assert.equal(proof.sessionId, 'child-A');
    assert.ok(JSON.stringify(proof).length < 512);
    assert.equal(proof.model, undefined);
    assert.equal(proof.thread_settings, undefined);
  });
}

test('missing, foreign, quoted, non-durable and physical-owner mismatched snapshots give no proof', () => {
  assert.equal(codexOwnLaunchServiceTier(snapshot('priority', 'parent'), 'child-A', 'child-A'), null);
  assert.equal(codexOwnLaunchServiceTier(snapshot('priority', undefined), 'child-A', 'parent'), null);
  const absent = snapshot('priority'); delete absent.payload.thread_id;
  assert.equal(codexOwnLaunchServiceTier(absent, 'child-A', 'child-A'), null);
  assert.equal(codexOwnLaunchServiceTier({ type: 'response_item', payload: snapshot('priority').payload }, 'child-A', 'child-A'), null);
  assert.equal(codexOwnLaunchServiceTier({ type: 'turn_context', payload: { service_tier: 'priority' } }, 'child-A', 'child-A'), null);
  assert.equal(codexOwnLaunchServiceTier({ type: 'event_msg', payload: { type: 'session_configured', service_tier: 'priority' } }, 'child-A', 'child-A'), null);
});

test('copied ancestor settings are ignored; own launch tier is independent of model/effort and later updates', () => {
  const projection = state();
  const steps = apply(projection, meta, snapshot('default', 'parent'), snapshot('priority'), newTask,
    context, { ...snapshot('default'), timestamp: '2026-10-16T06:00:00Z' });
  assert.deepEqual(steps, []);
  assert.equal(projection.launchServiceTier.serviceTier, 'priority');
  assert.equal(projection.launchServiceTier.timestamp, '2026-10-15T06:00:00Z');
  assert.equal(projection.launchSettings.model, 'gpt-6-luna');
  assert.equal(projection.launchSettings.effort, 'max');
});

test('first own unknown is not upgraded from a later settings selection', () => {
  const projection = state();
  apply(projection, meta, snapshot(null), snapshot('priority'), newTask, context);
  assert.equal(projection.launchServiceTier.serviceTier, null);
});

test('no creation snapshot: NEW_TASK and first legacy turn prevent a later Resume tier claiming launch', () => {
  const v2 = state();
  apply(v2, meta, snapshot('priority', 'parent'), newTask, context, snapshot('priority'));
  assert.equal(v2.launchServiceTier, null);
  const legacy = state();
  apply(legacy, { type: 'session_meta', payload: { id: 'child-A' } }, context, snapshot('priority'));
  assert.equal(legacy.launchServiceTier, null);
});

test('physical root mismatch and metadata before root cannot lend launch tier', () => {
  const projection = state();
  apply(projection, snapshot('priority'), { ...meta, payload: { ...meta.payload, id: 'child-B' } },
    snapshot('priority'), newTask, context);
  assert.equal(projection.launchServiceTier, null);
});

test('selected reader keeps tier at empty EOF and across chunks; replay/truncation resets old metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-child-tier-reader-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  const projection = state();
  try {
    fs.writeFileSync(filePath, jsonl([meta, snapshot('priority')]));
    const first = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection });
    assert.equal(first.launchServiceTier.serviceTier, 'priority');
    fs.appendFileSync(filePath, jsonl([newTask, context, snapshot('default')]));
    const second = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: first.offset });
    assert.equal(second.launchServiceTier.serviceTier, 'priority');
    const eof = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: second.offset });
    assert.equal(eof.launchServiceTier, second.launchServiceTier);
    assert.equal(eof.offset, second.offset);
    assert.deepEqual(eof.steps, []);
    fs.writeFileSync(filePath, jsonl([{ type: 'session_meta', payload: { id: 'child-A' } }, snapshot('default')]));
    const reset = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: eof.offset });
    assert.equal(reset.reset, true);
    assert.equal(reset.launchServiceTier.serviceTier, 'default');
    fs.writeFileSync(filePath, jsonl([{ type: 'session_meta', payload: { id: 'child-A' } }, context]));
    const replay = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: 0 });
    assert.equal(replay.launchServiceTier, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing NEW_TASK scan carries only the own scalar snapshot before its skip offset, including resumed scan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-child-tier-boundary-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    fs.writeFileSync(filePath, jsonl([meta, snapshot('priority', 'parent'), snapshot('default')]));
    const pending = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A' });
    assert.equal(pending.found, false);
    assert.equal(pending.launchServiceTier.serviceTier, 'default');
    fs.appendFileSync(filePath, jsonl([newTask, context, snapshot('priority')]));
    const boundary = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A', resume: pending });
    assert.equal(boundary.found, true);
    assert.equal(boundary.launchServiceTier.serviceTier, 'default');
    const projection = createSubagentStepProjectionState({ codexSessionId: 'child-A',
      codexRootMetaSeen: true, codexAgentPath: boundary.agentPath,
      codexNeedsNewTaskBoundary: true, codexNewTaskBoundarySeen: true,
      launchServiceTier: boundary.launchServiceTier });
    const result = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: boundary.offset });
    assert.equal(result.launchServiceTier.serviceTier, 'default');
    assert.equal(result.launchSettings.model, 'gpt-6-luna');
    assert.ok(JSON.stringify(boundary.launchServiceTier).length < 512);
    assert.equal(result.offset, fs.statSync(filePath).size);
    const cold = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A' });
    assert.deepEqual(cold.launchServiceTier, boundary.launchServiceTier);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('partial settings line cannot publish Fast before the full committed JSON record arrives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-child-tier-partial-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    const line = JSON.stringify(snapshot('priority'));
    const split = line.indexOf('priority') + 3;
    fs.writeFileSync(filePath, jsonl([meta]) + line.slice(0, split));
    const projection = state();
    const partial = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection });
    assert.equal(partial.launchServiceTier, null);
    const pending = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A' });
    assert.equal(pending.launchServiceTier, null);
    fs.appendFileSync(filePath, line.slice(split) + '\n' + jsonl([newTask, context]));
    const committed = await readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'child-A', projectionState: projection, offset: partial.offset });
    assert.equal(committed.launchServiceTier.serviceTier, 'priority');
    const boundary = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A', resume: pending });
    assert.equal(boundary.found, true);
    assert.equal(boundary.launchServiceTier.serviceTier, 'priority');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('NEW_TASK scan skips oversized settings without retaining their payload or changing boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-child-tier-large-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  try {
    const large = snapshot('priority'); large.payload.thread_settings.syntheticPadding = 'x'.repeat(600_000);
    fs.writeFileSync(filePath, jsonl([meta, large, snapshot('default'), newTask, context]));
    const boundary = await findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId: 'child-A' });
    assert.equal(boundary.found, true);
    assert.equal(boundary.launchServiceTier, null);
    assert.equal(boundary.launchServiceTierBlocked, true, 'do not promote a later small update over skipped initial metadata');
    assert.ok(JSON.stringify(boundary).length < 1024);
    assert.ok(boundary.offset > 600_000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
