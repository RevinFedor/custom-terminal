'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RESULT_PROOF_CODES,
  classifyOrchestrationResultProbe,
} = require('./orchestration-result-proof');

test('complete exact result is ready', () => {
  assert.deepEqual(classifyOrchestrationResultProbe({ found: true, complete: true }), {
    kind: 'complete',
    code: null,
    message: null,
  });
});

test('an open transcript remains pending even when prompt proof is not materialized yet', () => {
  const result = classifyOrchestrationResultProbe({
    found: false,
    errorCode: RESULT_PROOF_CODES.PROMPT_OUTSIDE_TURN,
    error: 'matching prompt is outside the exact Codex provider turn',
    boundaryReason: 'transcript-end',
    proofDefinitive: false,
  }, { authoritativeCompletion: true });
  assert.equal(result.kind, 'pending');
});

test('a definitive identity contradiction after authoritative completion is terminal', () => {
  const result = classifyOrchestrationResultProbe({
    found: false,
    errorCode: RESULT_PROOF_CODES.PROMPT_OUTSIDE_TURN,
    error: 'matching prompt is outside the exact Codex provider turn',
    boundaryReason: 'task_complete',
    proofDefinitive: true,
  }, { authoritativeCompletion: true });
  assert.deepEqual(result, {
    kind: 'terminal-failure',
    code: RESULT_PROOF_CODES.PROMPT_OUTSIDE_TURN,
    message: 'matching prompt is outside the exact Codex provider turn',
    outcome: 'result_unavailable',
  });
});

test('a structurally closed Codex turn cannot remain pending after authoritative completion', () => {
  const result = classifyOrchestrationResultProbe({
    found: true,
    complete: false,
    boundaryReason: 'next-task-started',
    proofDefinitive: true,
    errorCode: RESULT_PROOF_CODES.TURN_BOUNDARY_CLOSED,
    error: 'Codex provider turn closed before an exact terminal result',
  }, { authoritativeCompletion: true });
  assert.deepEqual(result, {
    kind: 'terminal-failure',
    code: RESULT_PROOF_CODES.TURN_BOUNDARY_CLOSED,
    message: 'Codex provider turn closed before an exact terminal result',
    outcome: 'result_unavailable',
  });
});

test('exact abort and no-final terminal records preserve their distinct outcomes', () => {
  const aborted = classifyOrchestrationResultProbe({
    found: true,
    terminalEvent: 'turn_aborted',
    terminalOutcomeReason: 'turn_aborted',
  });
  const noFinal = classifyOrchestrationResultProbe({
    found: true,
    terminalEvent: 'task_complete',
    hasFinalResult: false,
    terminalOutcomeReason: 'codex-no-final-result',
  });
  assert.equal(aborted.code, RESULT_PROOF_CODES.TURN_ABORTED);
  assert.equal(aborted.outcome, 'interrupted');
  assert.equal(noFinal.code, RESULT_PROOF_CODES.NO_FINAL_RESULT);
  assert.equal(noFinal.outcome, 'failed');
});
