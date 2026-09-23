'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { STORE_STATES } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { harness, enrichedPrompt } = require('./codex-provider-wrapper-receipt.fixture.cjs');

for (const source of ['orchestration-completion:fixture-run', 'prompt-queue', 'prompt-loop']) {
  test('actual Codex wrapper can persist native queued acceptance for ' + source, async t => {
    const h = harness(t, { source });
    if (!h) return;
    const result = await h.send();
    assert.equal(h.writes.filter(write => write.text === '\r').length, 1, JSON.stringify(result));
    assert.equal(h.audits[0]?.source, 'codex-' + source);
    assert.equal(h.proofs[0]?.accepted, true, 'the context-first wrapped visible prefix already matches');
    assert.equal(h.proofs[0]?.reason, 'codex_tui_queue_visible_prefix');
    assert.equal(result.status, 'queued', 'queue proof must not be discarded merely because source was provider-wrapped');
    assert.equal(result.providerQueueAccepted, true);
    const record = h.store.list()[0];
    assert.equal(record.state, STORE_STATES.AUDIT_PENDING);
    assert.equal(record.promptHash, promptAuditFingerprint(enrichedPrompt));
    assert.equal(record.promptLength, 2130);
    assert.equal(record.receipt.promptText, enrichedPrompt);
    assert.equal(record.receipt.source, 'codex-' + source);
    assert.equal(record.receipt.providerQueue.accepted, true);
    assert.equal(h.writes[0].states[0], STORE_STATES.IN_FLIGHT, 'receipt exists before paste');
    assert.equal(h.writes.find(write => write.text === '\r').states[0], STORE_STATES.ENTER_ARMED,
      'exact attempt exists and is armed before physical Enter');
    const replay = await h.send();
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 'queued');
    assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
    assert.equal(h.attempts(), 1);
  });
}

test('ordinary History and already-prefixed native caller share one existing operation without another Enter', async t => {
  const h = harness(t, { source: 'history-panel' });
  if (!h) return;
  assert.equal((await h.send()).status, 'queued');
  const replay = await h.send({ source: 'codex-history-panel' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'queued');
  assert.equal(h.store.list().length, 1);
  assert.equal(h.attempts(), 1);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});

test('an explicit Project API operation is retained rather than replaced by an automatic History receipt', async t => {
  const h = harness(t, { explicit: true });
  if (!h) return;
  const result = await h.send();
  assert.equal(result.status, 'queued');
  const records = h.store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].operationKey, 'project:explicit-operation');
  assert.equal(records[0].surface, 'project-api');
  assert.equal(h.audits[0].sendOperationKey, records[0].operationKey);
  assert.equal(h.audits[0].sendAttemptId, records[0].attemptId);
  assert.equal(h.attempts(), 1);
});

test('an arbitrary wrapped caller label cannot manufacture a receipt after Enter or claim native queue acceptance', async t => {
  const h = harness(t, { source: 'unowned-caller' });
  if (!h) return;
  const result = await h.send();
  assert.equal(h.proofs[0]?.accepted, true, 'matching text alone still has no ownership authority');
  // The caller deadline does not erase a still-live transcript observer.
  // Lack of receipt authority prevents queue acceptance, not pending audit.
  assert.equal(result.status, 'audit-pending');
  assert.equal(result.auditPending, true);
  assert.equal(result.exactAuditConfirmed, false);
  assert.equal(result.submitted, true);
  assert.notEqual(result.providerQueueAccepted, true);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.attempts(), 0);
  assert.ok(h.writes.every(write => write.states.length === 0));
});

test('the separately diagnosed early-refused Cmd+RunAfter still has no Enter and no receipt', async t => {
  const h = harness(t, { source: 'prompt-queue', ready: false });
  if (!h) return;
  const result = await h.send({ promptQueueAction: 'send-now' });
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.attempts(), 0);
});

for (const frameFault of ['old-frame', 'mirror', 'input', 'run', 'no-growth']) {
  test('new receipt eligibility does not relax native queue proof: ' + frameFault, async t => {
    const h = harness(t, { frameFault });
    if (!h) return;
    const result = await h.send();
    assert.equal(h.proofs[0]?.accepted, false);
    assert.equal(result.status, 'delivery-unknown');
    assert.notEqual(result.providerQueueAccepted, true);
    assert.equal(h.store.list().length, 1);
    assert.equal(h.store.list()[0].state, STORE_STATES.DELIVERY_UNKNOWN);
    assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
    assert.equal(h.attempts(), 1);
  });
}

test('the context-prefix queue receipt becomes confirmed only after exact full-prompt audit', async t => {
  const h = harness(t);
  if (!h) return;
  assert.equal((await h.send()).status, 'queued');
  const record = h.store.list()[0];
  const audit = { success: true, operationKey: record.operationKey, attemptId: record.attemptId,
    provider: 'codex', sessionId: 'session-a', promptHash: record.promptHash,
    expectedHash: record.promptHash, entryUuid: 'exact-user-entry',
    sourceIdentity: 'codex-user-source-session-a-4242', auditTimestamp: '2026-09-09T03:00:00.000Z' };
  const mismatch = h.store.promoteFromAudit({ ...audit, promptHash: 'other-hidden-full-text' });
  assert.equal(mismatch.promoted, false);
  assert.equal(h.store.get(record.operationKey).state, STORE_STATES.AUDIT_PENDING);
  assert.equal(h.store.promoteFromAudit(audit).promoted, true);
  assert.equal(h.store.get(record.operationKey).state, STORE_STATES.CONFIRMED);
  assert.equal((await h.send()).exactAuditConfirmed, true);
  assert.equal(h.writes.filter(write => write.text === '\r').length, 1);
});
