'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, drainMicrotasks: tick } = require('./fixtures/send-preparation-write.cjs');
const { readAgentSendPreparation } = require('./agent-send-preparation');
const { AgentSendQueue } = require('./agent-send-queue');

// Actual Main final-frame/writer/Enter pipeline + private SQLite receipt owner.
// Controlled PTY sink, clock, process/frame source, audit/config leaves. The
// launch is truly60s, HEAD120s; never substitute91s or remove the launch payload.
test('cold120 + original launch60: late ready leaves one exact no-input failure, never revives Enter', async t => {
  const h = fixture(t, { open: true, preparationMode: 'cold-codex', deadlineOffset: 60000 });
  assert.equal(h.scope.preparation.deadlineAt - h.clock.now(), 120000);
  assert.equal(h.opts.codexStartupFrameWait.deadlineAt - h.clock.now(), 60000);
  const pending = h.start(); await tick(80);
  h.clock.advance(60000); await tick(100);
  const outcome = await pending;
  assert.equal(outcome.success, false); assert.equal(outcome.submitted, false);
  assert.equal(h.writes.length, 0);
  const preparation = readAgentSendPreparation(h.store, 'T', h.opts, h.opts.codexStartupFrameWait, h.clock.now);
  const refusal = preparation.failure();
  assert.equal(refusal.readinessDeadline.limitingDeadline, 'startup');
  assert.equal(refusal.readinessDeadline.headDeadlineAt - refusal.readinessDeadline.headStartedAt, 120000);
  assert.equal(refusal.readinessDeadline.effectiveDeadlineAt, h.opts.codexStartupFrameWait.deadlineAt);
  h.clock.advance(1063); h.frame(false); await tick(100);
  assert.equal(h.writes.length, 0, 'late ready is process readiness, not a new Send');
  assert.equal(h.store.get(h.identity.operationKey).attemptId, h.attempt.attemptId);
  assert.equal(h.store.get(h.identity.operationKey).receipt.preflightScope.id, h.scope.id);
});

test('cold120 + original launch60: an earlier committed composer writes once under the same attempt', async t => {
  const h = fixture(t, { open: true, preparationMode: 'cold-codex', deadlineOffset: 60000 });
  const pending = h.start(); await tick(80);
  h.clock.advance(59000); h.frame(false); await tick(100);
  const outcome = await pending;
  assert.notEqual(outcome.submitted, false, JSON.stringify(outcome));
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.equal(h.writes.filter(value => value.includes('frozen')).length, 1);
  assert.equal(h.store.get(h.identity.operationKey).attemptId, h.attempt.attemptId);
});

test('actual FIFO HEAD + Main writer + receipt: failed cold send survives; late ready/restart has no executor replay', async t => {
  const h = fixture(t, { open: true, preparationMode: 'cold-codex', deadlineOffset: 60000, deferAttempt: true });
  let ready = false, executions = 0;
  const request = { tabId: 'T', provider: 'codex', handoffId: 'H', source: 'history-panel', prompt: 'frozen',
    authoringSnapshot: { editorText: '  original [Image #1]\n', chips: [],
      imagePaths: [{ id: 1, path: '/controlled/A.png', assetId: 'frozen-A' }] } };
  const queue = new AgentSendQueue({ store: h.store, ready: () => ready, execute: async () => {
    executions++; h.beginHead();
    const result = await h.start();
    h.store.settleAttempt(h.identity.operationKey, h.attempt.attemptId, { ...result, promptText: request.prompt,
      authoringSnapshot: request.authoringSnapshot });
    return result;
  } });
  try {
    const admitted = queue.enqueue({ identity: h.identity, request });
    assert.equal(admitted.ok, true); assert.equal(h.store.get(h.identity.operationKey).attemptId, null);
    ready = true; const pumping = queue.pump('T'); await tick(100);
    assert.equal(executions, 1); assert.equal(h.scope.preparation.kind, 'cold-codex');
    h.clock.advance(60000); await tick(120); await pumping;
    const record = queue.projectRecord(h.store.get(h.identity.operationKey));
    assert.equal(record.state, 'not-submitted'); assert.equal(record.applicationQueue.state, 'failed');
    assert.equal(record.receipt.submitted, false); assert.equal(record.receipt.enterWritten, false);
    assert.deepEqual(record.receipt.authoringSnapshot, request.authoringSnapshot);
    assert.equal(queue.referencedAssetIds().has('frozen-A'), true, 'failure retains its image owner until explicit action');
    h.clock.advance(1063); h.frame(false); queue.notifyRuntime('T'); queue.resume(); await tick(120);
    assert.equal(executions, 1); assert.equal(h.writes.length, 0);
    assert.equal(h.store.get(h.identity.operationKey).attemptId, record.attemptId);
  } finally { queue.dispose(); }
});
