import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNaturalAgentTurnEndReason,
  isRecoverableAgentTurnInterruption,
} from './agentCompletionOutcome.mjs';

test('only authoritative successful turn ends are natural completions', () => {
  assert.equal(isNaturalAgentTurnEndReason(), true);
  assert.equal(isNaturalAgentTurnEndReason(null), true);
  assert.equal(isNaturalAgentTurnEndReason(''), true);
  assert.equal(isNaturalAgentTurnEndReason('task_complete'), true);
  assert.equal(isNaturalAgentTurnEndReason('codex-no-final-result'), false);
  assert.equal(isNaturalAgentTurnEndReason('turn_aborted'), false);
  assert.equal(isNaturalAgentTurnEndReason('codex-descendants-exited'), false);
  assert.equal(isNaturalAgentTurnEndReason('command-finished'), false);
  assert.equal(isNaturalAgentTurnEndReason('manual-stop'), false);
  assert.equal(isNaturalAgentTurnEndReason('local-command'), false);
});

test('only resumable turn interruptions preserve pivoted Run After subscribers', () => {
  assert.equal(isRecoverableAgentTurnInterruption('interrupt'), true);
  assert.equal(isRecoverableAgentTurnInterruption('turn_aborted'), true);
  assert.equal(isRecoverableAgentTurnInterruption('manual-stop'), false);
  assert.equal(isRecoverableAgentTurnInterruption('process-exited'), false);
  assert.equal(isRecoverableAgentTurnInterruption('task_complete'), false);
});
