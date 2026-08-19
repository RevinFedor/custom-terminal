import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { normalizeAgentSendOutcome } from './agentSendOutcome.mjs';
import { historyPromptHandoffAuditProofFromSendResult } from './historyPromptHandoffs.ts';

const require = createRequire(import.meta.url);
const { desktopHistorySendReplayResult } = require('../../main/agent-history-send-receipt.js');

test('real confirmed durable replay stays confirmed and retains exact History proof', () => {
  const replay = desktopHistorySendReplayResult({
    operationKey: 'history:tab-a:handoff-a',
    attemptId: 'attempt-a',
    handoffId: 'handoff-a',
    state: 'confirmed',
    receipt: {
      success: true,
      submitted: true,
      exactAuditConfirmed: true,
      auditTimestamp: '2026-08-19T04:00:00.000Z',
      actualHash: 'exact-replay-hash',
      sessionId: 'session-a',
      entryUuid: 'entry-a',
      sourceIdentity: 'source-a',
      recordByteOffset: 4096,
    },
  });

  assert.equal(normalizeAgentSendOutcome(replay), 'confirmed');
  assert.deepEqual(historyPromptHandoffAuditProofFromSendResult(replay), {
    auditTimestamp: '2026-08-19T04:00:00.000Z',
    actualHash: 'exact-replay-hash',
    sessionId: 'session-a',
    entryUuid: 'entry-a',
    sourceIdentity: 'source-a',
    recordByteOffset: 4096,
  });
});

test('bare confirmed label without exact replay proof remains unknown', () => {
  assert.equal(normalizeAgentSendOutcome({
    success: true,
    submitted: true,
    status: 'confirmed',
    exactAuditConfirmed: true,
  }), 'delivery-unknown');
});
