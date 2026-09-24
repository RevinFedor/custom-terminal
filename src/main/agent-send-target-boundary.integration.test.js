'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./codex-provider-wrapper-receipt.fixture.cjs');
const { createAgentSendTargetExpectation, resolveReadyAgentSendTarget } = require('../shared/agent-send-target-precondition.cjs');

test('actual Codex wrapper cannot drop expected A and send into already-live B', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'B' });
  if (!h) return;
  const result = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.equal(h.writes.length, 0);
});

test('the same immutable A expectation is rechecked after async preparation at the actual paste boundary', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A',
    beforeDrain: setWriter => setWriter('B') });
  if (!h) return;
  const result = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.equal(h.writes.length, 0);
});

test('actual current accepted Resume A may send through B and records A before paste/Enter', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'B', acceptedResumeSourceSessionId: 'A' });
  if (!h) return;
  const result = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex', lifecycleGeneration: 'lifecycle-a' } });
  assert.equal(result.status, 'queued');
  const record = h.store.list()[0];
  assert.equal(record.receipt.expectedTarget.sessionId, 'A');
  assert.equal(record.receipt.expectedTarget.toolType, 'codex');
  assert.equal(record.sessionId, 'B', 'the actual audit writer remains separate from the requested conversation');
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('unrelated lineage does not authorize the same source-to-writer transition', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'B', lineageSourceSessionId: 'A' });
  if (!h) return;
  const result = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(h.writes.length, 0);
});

test('a current confirmed writer sends without the missing-target recovery read', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A' });
  if (!h) return;
  assert.equal((await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'A' } })).status, 'queued');
  assert.equal(h.targetReads(), 0);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('input-ready first source uses the existing main submission observation, not a new startup refusal', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true });
  if (!h) return;
  const result = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex' } });
  assert.equal(result.status, 'queued');
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('same-operation replay survives a new process generation without another prompt or attempt', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A' });
  if (!h) return;
  assert.equal((await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex', lifecycleGeneration: 'lifecycle-a' } })).status, 'queued');
  h.setGeneration('new-process-generation');
  const replay = await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex', lifecycleGeneration: 'new-process-generation' } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'queued');
  assert.equal(h.attempts(), 1);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('changing the conversation under the same raw handoff conflicts rather than replaying another conversation receipt', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A' });
  if (!h) return;
  assert.equal((await h.send({ expectedTarget: { sessionId: 'A', toolType: 'codex' } })).status, 'queued');
  h.setWriter('B');
  const changed = await h.send({ expectedTarget: { sessionId: 'B', toolType: 'codex' } });
  assert.equal(changed.success, false);
  assert.equal(changed.submitted, false);
  assert.equal(h.attempts(), 1);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('a renderer target never overrides the original explicit Project API target', async t => {
  const h = harness(t, { explicit: true, initialWriterSessionId: 'B' });
  if (!h) return;
  const record = h.store.list()[0];
  h.store.stageAttemptContext(record.operationKey, record.attemptId, { expectedTarget: { sessionId: 'A', toolType: 'codex' } });
  const result = await h.send({ expectedTarget: { sessionId: 'B', toolType: 'codex' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(h.writes.length, 0);
});

test('provisional same-launch first OSC-B may advance runSeq without retargeting the actual paste', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true });
  if (!h) return;
  const expectedTarget = resolveReadyAgentSendTarget(createAgentSendTargetExpectation('codex', 'A'),
    { runtimeSnapshot: { sendTarget: h.readTarget() } }, 'codex');
  const oldRunAliasPolicy = { sessionId: 'A', toolType: 'codex', lifecycleGeneration: h.readTarget().lifecycleGeneration };
  h.firstOsc();
  const oldPolicyResult = await h.send({ expectedTarget: oldRunAliasPolicy });
  assert.equal(oldPolicyResult.code, 'agent_send_target_changed',
    'counterexample: pinning the provisional run alias would reject this same accepted launch');
  assert.equal(h.writes.length, 0);
  const result = await h.send({ expectedTarget });
  assert.equal(result.status, 'queued', JSON.stringify(result));
  assert.equal(expectedTarget.sessionId, 'A');
  assert.equal(expectedTarget.launchId, h.readTarget().launchId);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

for (const replacement of ['Launch', 'Terminal']) {
  test('provisional target scope still rejects actual ' + replacement.toLowerCase() + ' replacement', async t => {
    const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true });
    if (!h) return;
    const expectedTarget = resolveReadyAgentSendTarget(createAgentSendTargetExpectation('codex', 'A'),
      { sendTarget: h.readTarget() }, 'codex');
    h['replace' + replacement]();
    const result = await h.send({ expectedTarget });
    assert.equal(result.code, 'agent_send_target_changed');
    assert.equal(h.writes.length, 0);
  });
}

test('busy Send joins missing writer observation inside the same attempt instead of comparing the target to null', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true,
    synchronousObservationMissing: true,
    revalidateTarget: async ({ confirmWriter }) => {
      await gate; confirmWriter('A');
      return { available: true, kind: 'turn', sessionId: 'A', writerStatus: 'adopted' };
    } });
  if (!h) return;
  const send = h.send({ expectedTarget: { toolType: 'codex', sessionId: 'A' } });
  await new Promise(setImmediate);
  assert.equal(h.targetReads(), 1, h.targetReads() ? '' : JSON.stringify(await send));
  assert.equal(h.writes.length, 0, 'no input before the same current read resolves');
  finish();
  const result = await send;
  assert.equal(result.status, 'queued', JSON.stringify(result));
  assert.equal(h.attempts(), 1);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('persistent writer uncertainty is distinct from a proven target change and does not write input', async t => {
  const h = harness(t, { source: 'history-panel', writerUnconfirmed: true,
    synchronousObservationMissing: true });
  if (!h) return;
  const result = await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'A' } });
  assert.equal(result.code, 'agent_send_target_unresolved', JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(h.targetReads(), 1);
  assert.equal(h.writes.length, 0);
});

test('revalidated foreign writer still rejects the original target', async t => {
  const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true,
    synchronousObservationMissing: true, revalidateTarget: async ({ confirmWriter }) => {
      confirmWriter('B'); return { available: true, sessionId: 'B' };
    } });
  if (!h) return;
  const result = await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'A' } });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(h.writes.length, 0);
});

for (const change of ['terminal', 'stop', 'input']) {
  test('target recovery cannot pass a newer ' + change + ' boundary', async t => {
    const h = harness(t, { source: 'history-panel', initialWriterSessionId: 'A', writerUnconfirmed: true,
      synchronousObservationMissing: true, revalidateTarget: async ({ context, confirmWriter, touchInput, tabId }) => {
        confirmWriter('A');
        if (change === 'terminal') context.terminals.set(tabId, {});
        if (change === 'stop') context.terminalStopRevisions.set(context.terminals.get(tabId), 1);
        if (change === 'input') touchInput();
        return { available: true, sessionId: 'A' };
      } });
    if (!h) return;
    const result = await h.send({ expectedTarget: { toolType: 'codex', sessionId: 'A' } });
    assert.equal(result.submitted, false, JSON.stringify(result));
    assert.equal(h.writes.length, 0);
  });
}
