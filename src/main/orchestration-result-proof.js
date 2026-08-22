'use strict';

const RESULT_PROOF_CODES = Object.freeze({
  PROVIDER_MISMATCH: 'provider_mismatch',
  SESSION_MISMATCH: 'session_mismatch',
  EXECUTION_IDENTITY_INCOMPLETE: 'execution_identity_incomplete',
  TASK_STARTED_NOT_FOUND: 'task_started_not_found',
  TASK_STARTED_AMBIGUOUS: 'task_started_ambiguous',
  PROMPT_IDENTITY_REQUIRED: 'prompt_identity_required',
  PROMPT_OUTSIDE_TURN: 'prompt_outside_turn',
  PROMPT_AMBIGUOUS: 'prompt_ambiguous',
  ASSISTANT_NOT_MATERIALIZED: 'assistant_not_materialized',
  TURN_BOUNDARY_CLOSED: 'turn_boundary_closed_without_completion',
  TURN_ABORTED: 'turn_aborted',
  NO_FINAL_RESULT: 'no_final_result',
  RESULT_UNAVAILABLE: 'result_unavailable',
  RESULT_PROOF_DEADLINE: 'result_proof_deadline_elapsed',
});

const RESULT_PROOF_KINDS = Object.freeze({
  COMPLETE: 'complete',
  PENDING: 'pending',
  TERMINAL_FAILURE: 'terminal-failure',
});

function classifyOrchestrationResultProbe(probe = {}, {
  authoritativeCompletion = false,
} = {}) {
  if (probe.complete === true) {
    return { kind: RESULT_PROOF_KINDS.COMPLETE, code: null, message: null };
  }
  if (probe.found === true && probe.terminalEvent === 'turn_aborted') {
    return {
      kind: RESULT_PROOF_KINDS.TERMINAL_FAILURE,
      code: RESULT_PROOF_CODES.TURN_ABORTED,
      message: probe.terminalOutcomeReason || 'turn_aborted',
      outcome: 'interrupted',
    };
  }
  if (probe.found === true
    && probe.terminalEvent === 'task_complete'
    && probe.hasFinalResult !== true) {
    return {
      kind: RESULT_PROOF_KINDS.TERMINAL_FAILURE,
      code: RESULT_PROOF_CODES.NO_FINAL_RESULT,
      message: probe.terminalOutcomeReason || 'codex-no-final-result',
      outcome: 'failed',
    };
  }
  if (authoritativeCompletion && probe.proofDefinitive === true) {
    return {
      kind: RESULT_PROOF_KINDS.TERMINAL_FAILURE,
      code: probe.errorCode || RESULT_PROOF_CODES.RESULT_UNAVAILABLE,
      message: probe.error || 'exact result proof is unavailable',
      outcome: 'result_unavailable',
    };
  }
  return {
    kind: RESULT_PROOF_KINDS.PENDING,
    code: probe.errorCode || null,
    message: probe.error || null,
  };
}

module.exports = {
  RESULT_PROOF_CODES,
  RESULT_PROOF_KINDS,
  classifyOrchestrationResultProbe,
};
