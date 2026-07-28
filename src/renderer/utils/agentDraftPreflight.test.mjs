import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentDraftPreflight } from './agentDraftPreflight.mjs';

test('current-frame found and absent proofs keep their exact decisions', () => {
  assert.equal(classifyAgentDraftPreflight({
    proofOutcome: 'found',
    hasDraft: true,
  }).decision, 'conflict');
  assert.equal(classifyAgentDraftPreflight({
    proofOutcome: 'absent',
    hasDraft: false,
  }).decision, 'clear');
});

test('unknown proof never becomes permission to send from source strings or busy state', () => {
  assert.deepEqual(classifyAgentDraftPreflight({
    proofOutcome: 'unknown',
    proofReason: 'terminal-or-input-generation-changed',
    hasDraft: null,
    source: 'headless-main:claude-composer:unknown:generation-changed',
  }), {
    decision: 'unknown',
    reason: 'terminal-or-input-generation-changed',
  });
  assert.equal(classifyAgentDraftPreflight({
    hasDraft: null,
    source: 'claude-composer:presence-not-live',
  }).decision, 'unknown');
});
