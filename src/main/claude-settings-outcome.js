'use strict';
const { describeClaudeStartupFailure } = require('../shared/claude-startup-failure.cjs');

// Translate observed steps, not Enter/transport success, into the durable
// settings receipt. This adapter never decides to execute a command.
function claudeParamsOperationOutcome(outcome = {}) {
  const steps = Array.isArray(outcome.steps) ? outcome.steps : [];
  const proven = steps.filter(step => ['applied', 'applied-different'].includes(step.status)
    && ['model', 'effort', 'thinking'].includes(step.kind) && typeof step.actualValue === 'string');
  const appliedSettings = Object.fromEntries(proven.map(step => [step.kind, step.actualValue]));
  const rejected = steps.some(step => step.status === 'rejected');
  const different = steps.some(step => step.status === 'applied-different');
  const incomplete = !steps.length || steps.some(step => !['applied', 'applied-different', 'rejected'].includes(step.status));
  const phase = different ? 'applied-different'
    : rejected ? (proven.length ? 'partial-failed' : 'rejected')
    : incomplete ? (proven.length ? 'partial-unknown' : 'unknown') : 'applied';
  const failure = describeClaudeStartupFailure({ error: outcome.error,
    errorCode: outcome.errorCode, failedCommand: outcome.failedCommand });
  return {
    phase, appliedSettings,
    observed: Object.fromEntries(proven.filter(step => step.observed).map(step => [step.kind, step.observed])),
    steps: steps.map(step => ({ kind: step.kind, phase: step.status,
      requested: step.requestedValue,
      observed: step.observed ? { ...step.observed, requestedSatisfied: step.requestSatisfied ?? null } : undefined,
      commandId: step.commandId || undefined })),
    ...(phase !== 'applied' ? {
      code: outcome.errorCode || (incomplete ? 'claude_setting_outcome_unknown' : failure.code),
      error: incomplete && !rejected && !different ? 'Claude: подтверждение настройки ещё не получено' : failure.userMessage,
      ...(outcome.error ? { detail: outcome.error } : {}),
      ...(outcome.failedCommand ? { failedCommand: outcome.failedCommand } : {}),
      unattempted: steps.filter(step => step.status === 'unattempted').map(step => step.kind),
    } : {}),
  };
}
module.exports = { claudeParamsOperationOutcome };
