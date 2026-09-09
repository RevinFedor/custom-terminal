import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNaturalAgentTurnEndReason,
  isRecoverableAgentTurnInterruption,
  interruptionContinuesWithQueuedTurn,
  normalizeAgentTurnEndReason,
} from './agentCompletionOutcome.mjs';

test('only authoritative successful turn ends are natural completions', () => {
  assert.equal(isNaturalAgentTurnEndReason(), true);
  assert.equal(isNaturalAgentTurnEndReason(null), true);
  assert.equal(isNaturalAgentTurnEndReason(''), true);
  assert.equal(isNaturalAgentTurnEndReason('task_complete'), true);
  assert.equal(isNaturalAgentTurnEndReason('rollout-task_complete'), true);
  assert.equal(isNaturalAgentTurnEndReason('codex-no-final-result'), false);
  assert.equal(isNaturalAgentTurnEndReason('turn_aborted'), false);
  assert.equal(isNaturalAgentTurnEndReason('codex-descendants-exited'), false);
  assert.equal(isNaturalAgentTurnEndReason('command-finished'), false);
  assert.equal(isNaturalAgentTurnEndReason('manual-stop'), false);
  assert.equal(isNaturalAgentTurnEndReason('local-command'), false);
});

test('only main-proven manual Escape plus native queue preserves the workflow', () => {
  assert.equal(interruptionContinuesWithQueuedTurn({
    reason: 'turn_aborted', outcomeTs: 100,
    manualQueueContinuationExpected: true,
  }), true);
  assert.equal(interruptionContinuesWithQueuedTurn({
    lastAbnormalOutcomeReason: 'turn_aborted',
    lastAbnormalOutcomeTs: 100,
    lastAbnormalOutcomeHasQueuedContinuation: true,
    lastAbnormalOutcomeContinuationTs: 100,
  }), true);
  assert.equal(interruptionContinuesWithQueuedTurn({
    lastAbnormalOutcomeReason: 'turn_aborted',
    lastAbnormalOutcomeTs: 101,
    lastAbnormalOutcomeHasQueuedContinuation: true,
    lastAbnormalOutcomeContinuationTs: 100,
  }), false);
  assert.equal(interruptionContinuesWithQueuedTurn({
    reason: 'turn_aborted', outcomeTs: 100,
  }), false);
  assert.equal(interruptionContinuesWithQueuedTurn({
    reason: 'manual-stop', outcomeTs: 100,
    manualQueueContinuationExpected: true,
  }), false);
});

test('renderer rollout aliases normalize to the same authoritative outcome', () => {
  assert.equal(normalizeAgentTurnEndReason('task_complete'), 'task_complete');
  assert.equal(normalizeAgentTurnEndReason('rollout-task_complete'), 'task_complete');
  assert.equal(normalizeAgentTurnEndReason('rollout-turn_aborted'), 'turn_aborted');
  assert.equal(normalizeAgentTurnEndReason('provider-source-release'), 'provider-source-release');
});

test('only resumable turn interruptions preserve pivoted Run After subscribers', () => {
  assert.equal(isRecoverableAgentTurnInterruption('interrupt'), true);
  assert.equal(isRecoverableAgentTurnInterruption('turn_aborted'), true);
  assert.equal(isRecoverableAgentTurnInterruption('rollout-turn_aborted'), true);
  assert.equal(isRecoverableAgentTurnInterruption('manual-stop'), false);
  assert.equal(isRecoverableAgentTurnInterruption('process-exited'), false);
  assert.equal(isRecoverableAgentTurnInterruption('task_complete'), false);
});
