import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAgentSendOutcome } from './agentSendOutcome.mjs';

test('normalizes only evidence-backed delivery outcomes', () => {
  assert.equal(normalizeAgentSendOutcome({ applicationQueued: true, applicationQueue: { version: 1 },
    accepted: true, submitted: false }), 'application-queued');
  assert.equal(normalizeAgentSendOutcome({
    success: true,
    submitted: true,
    pasteAudit: {
      success: true,
      auditTimestamp: '2026-08-19T00:00:00.000Z',
      actualHash: 'exact-hash',
    },
  }), 'confirmed');
  assert.equal(normalizeAgentSendOutcome({ queued: true, submitted: true }), 'queued');
  assert.equal(normalizeAgentSendOutcome({ auditPending: true, submitted: true }), 'audit-pending');
  assert.equal(normalizeAgentSendOutcome({ success: false, submitted: false }), 'not-submitted');
  assert.equal(normalizeAgentSendOutcome({ providerAccepted: false, submitted: true }), 'provider-not-accepted');
  assert.equal(normalizeAgentSendOutcome({ success: false, submitted: true }), 'delivery-unknown');
  assert.equal(normalizeAgentSendOutcome({ success: null, submitted: true }), 'delivery-unknown');
  assert.equal(normalizeAgentSendOutcome({ success: true, submitted: true }), 'delivery-unknown');
  assert.equal(normalizeAgentSendOutcome({
    success: true,
    submitted: true,
    localSlashCommand: true,
  }), 'local-command-confirmed');
});
