'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createAgentSendActivity } = require('./agent-send-activity');

let createVisual, workflowCounts;
test.before(async () => {
  ({ createAgentSendVisualActivity: createVisual } = await import('../renderer/utils/agentSendVisualActivity.mjs'));
  ({ resolveWorkflowActivityCounts: workflowCounts } = await import('../renderer/utils/workflowActivityCounts.mjs'));
});

function setup(t, provider = 'codex', surface = 'history') {
  const ui = createVisual();
  const main = createAgentSendActivity({ generation: 'test-main', onChanged: ui.applyMain });
  const db = new Database(':memory:');
  t.after(() => db.close());
  const store = createAgentSendReceiptStore(db, { onChanged: main.update });
  const identity = { operationKey: 'op', surface, tabId: 'T', handoffId: 'H',
    provider, sessionId: 'S', promptHash: 'hash', promptLength: 76553, requestFingerprint: 'request' };
  const count = (busy = false, pasteBusy = false) => workflowCounts([
    { tabId: 'T', processAlive: true, busy, pasteBusy, sendPending: ui.snapshot().has('T') },
  ]).busyCount;
  const audit = (attemptId) => ({ operationKey: 'op', attemptId, tabId: 'T', handoffId: 'H',
    provider, sessionId: 'S', promptHash: 'hash', actualHash: 'hash', expectedHash: 'hash',
    success: true, auditTimestamp: '2026-09-09T20:05:11.703Z', entryUuid: 'entry' });
  return { ui, main, store, identity, count, audit };
}

for (const provider of ['codex', 'claude']) {
  for (const surface of ['history', 'project-api', 'inbox', 'prompt-queue']) {
    test(`${provider}/${surface}: cold preparation → Enter → late exact receipt has no visual idle gap`, (t) => {
      const h = setup(t, provider, surface);
      h.ui.setLocal('composer', 'T', true); // click, before the first async preparation
      assert.equal(h.count(), 1);
      h.ui.setLocal('scenario', 'T', true); // shared readiness/settings/draft flow
      h.ui.setLocal('composer', 'T', false);
      assert.equal(h.count(), 1, 'starting and settings are still part of this send');
      const begun = h.store.beginAttempt(h.identity);
      assert.equal(h.count(false, true), 1, 'paste does not double-count the tab');
      h.store.markAttemptState('op', begun.attemptId, 'enter-armed');
      assert.equal(h.count(false, false), 1, 'physical write lock is released at Enter, not the visual send');
      h.store.settleAttempt('op', begun.attemptId, {
        submitted: true, success: null, auditPending: true, status: 'audit-pending',
        pasteWritten: true, enterWritten: true,
      });
      h.ui.setLocal('scenario', 'T', false); // caller deadline, same durable attempt remains
      assert.equal(h.count(), 1, 'deadline is not a visual completion');
      assert.equal(h.store.get('op').state, 'audit-pending', 'loader grants no SENT proof');
      assert.equal(h.store.promoteFromAudit(h.audit('foreign')).ok, false);
      assert.equal(h.count(), 1, 'foreign proof cannot dismiss this send');
      assert.equal(h.store.promoteFromAudit(h.audit(begun.attemptId)).promoted, true);
      assert.equal(h.count(true), 1, 'provider turn takes over without changing count');
      assert.equal(h.count(false), 0, 'actual turn completion clears the loader');
      assert.equal(h.store.get('op').attempt, 1, 'no resend or additional Enter');
    });
  }
}

for (const state of ['not-submitted', 'delivery-unknown']) {
  test(`${state} is not falsely displayed as ongoing sending`, (t) => {
    const h = setup(t);
    const begun = h.store.beginAttempt(h.identity);
    assert.equal(h.count(), 1);
    h.store.settleAttempt('op', begun.attemptId, state === 'not-submitted'
      ? { success: false, submitted: false }
      : { success: null, submitted: true, deliveryUnknown: true, status: state });
    assert.equal(h.count(), 0);
  });
}

test('reload hydration is compact, restores pending, and an older snapshot cannot revive a settled send', (t) => {
  const h = setup(t);
  const begun = h.store.beginAttempt(h.identity);
  const old = h.main.snapshot();
  assert.deepEqual(Object.keys(old), ['generation', 'revision', 'pendingTabIds']);
  const reloaded = createVisual();
  reloaded.applyMain(old);
  assert.equal(reloaded.snapshot().has('T'), true);
  h.store.settleAttempt('op', begun.attemptId, { success: false, submitted: false });
  reloaded.applyMain(h.main.snapshot());
  reloaded.applyMain(old);
  assert.equal(reloaded.snapshot().has('T'), false);
});

test('finishing one operation cannot clear another operation on the same tab', (t) => {
  const h = setup(t);
  const a = h.store.beginAttempt(h.identity);
  const b = h.store.beginAttempt({ ...h.identity, operationKey: 'op2', handoffId: 'H2' });
  h.store.settleAttempt('op', a.attemptId, { success: false, submitted: false });
  assert.equal(h.count(), 1);
  h.store.settleAttempt('op2', b.attemptId, { success: false, submitted: false });
  assert.equal(h.count(), 0);
});

test('retryable preparation without a running attempt does not become a stuck loader', (t) => {
  const h = setup(t);
  h.store.reserveOrGet(h.identity);
  h.store.markPreparing('op');
  assert.equal(h.count(), 0);
  const restarted = createAgentSendActivity();
  for (const row of h.store.reconcileStartup().records) restarted.update(row);
  assert.deepEqual(restarted.snapshot().pendingTabIds, []);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider}: exact native queue proof still owns activity across a legacy caller timeout`, (t) => {
    const h = setup(t, provider);
    const begun = h.store.beginAttempt(h.identity);
    h.store.settleAttempt('op', begun.attemptId, {
      success: null, submitted: true, status: 'delivery-unknown', deliveryUnknown: true,
    });
    assert.equal(h.count(), 0, 'unknown alone is not progress');
    const queue = h.store.markProviderQueueAccepted('op', begun.attemptId, {
      provider, sessionId: 'S', sourceIdentity: provider + '-queue:exact',
    });
    assert.equal(queue.ok, true);
    assert.equal(h.count(), 1, 'same receipt is publicly QUEUED, not failed');
    h.store.markDeliveryUnknown('op', begun.attemptId, { source: 'runtime', reason: 'caller-timeout' });
    assert.equal(h.count(), 1, 'caller timeout cannot revoke committed queue evidence');
    h.store.promoteFromAudit(h.audit(begun.attemptId));
    assert.equal(h.count(), 0);
  });
}

test('a renderer/reporting failure cannot change the durable send result', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const h = setup(t);
  const store = createAgentSendReceiptStore(db, { onChanged() { throw new Error('renderer unavailable'); } });
  const begun = store.beginAttempt(h.identity);
  assert.equal(begun.action, 'attempt-started');
  assert.equal(store.settleAttempt('op', begun.attemptId, { success: false, submitted: false }).ok, true);
});
