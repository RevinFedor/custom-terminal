'use strict';

const { createHash } = require('node:crypto');

const RESPONSE_OBSERVATION_KIND = 'response-observation';

function isResponseObservation(run) {
  return run?.runKind === RESPONSE_OBSERVATION_KIND;
}

function normalizeResponseSubject(subject) {
  const kind = subject?.kind || 'transcript';
  const provider = subject?.toolType;
  const sessionId = typeof subject?.sessionId === 'string' ? subject.sessionId.trim() : '';
  const promptUserUuid = typeof subject?.promptUserUuid === 'string' ? subject.promptUserUuid.trim() : '';
  const promptSourceIdentity = typeof subject?.promptSourceIdentity === 'string'
    ? subject.promptSourceIdentity.trim() : '';
  const context = subject?.targetExecutionContext;
  const providerPromptId = typeof subject?.providerPromptId === 'string' ? subject.providerPromptId.trim() : '';
  const exactExecution = context?.turnId && Number.isSafeInteger(context.generation) && context.generation > 0;
  const anchored = kind === 'transcript' ? promptUserUuid || promptSourceIdentity
    : kind === 'codex-execution' ? provider === 'codex' && exactExecution
      : kind === 'codex-historical-execution' ? provider === 'codex' && context?.turnId
        && context.generation === null && context.processId == null
      : kind === 'claude-hook' ? provider === 'claude' && exactExecution && providerPromptId && context.processId
        : false;
  if (!['claude', 'codex'].includes(provider) || !sessionId || !anchored) {
    throw Object.assign(new Error('An observed response requires an exact prompt or provider execution identity'), {
      code: 'response_subject_unresolved', statusCode: 409,
    });
  }
  if (context && (context.provider !== provider || typeof context.sessionId !== 'string' || !context.sessionId.trim()
    || (kind !== 'codex-historical-execution' && context.sessionId !== sessionId) || !context.turnId)) {
    throw Object.assign(new Error('Observed execution and saved prompt belong to different sessions'), {
      code: 'response_subject_identity_conflict', statusCode: 409,
    });
  }
  return {
    kind,
    toolType: provider,
    sessionId,
    ...(kind === 'claude-hook' ? { providerPromptId } : {}),
    promptUserUuid: promptUserUuid || null,
    promptSourceIdentity: promptSourceIdentity || null,
    targetExecutionContext: context ? {
      provider, sessionId: context.sessionId, turnId: context.turnId,
      processId: context.processId == null ? null : String(context.processId),
      generation: Number.isFinite(context.generation) ? context.generation : null,
      startedAt: Number.isFinite(context.startedAt) ? context.startedAt : null,
    } : null,
    requestedAt: Number.isFinite(subject.requestedAt) ? subject.requestedAt : null,
    resultBeforeAt: Number.isFinite(subject.resultBeforeAt) ? subject.resultBeforeAt : null,
  };
}

function responseObservationRequestIdentity({ sourceTabId, targetTabId, waitForDescendants = true }) {
  if (!sourceTabId || !targetTabId || sourceTabId === targetTabId) {
    throw Object.assign(new Error('Choose another tab to observe'), {
      code: 'response_observation_target_invalid', statusCode: 400,
    });
  }
  const requestIdentity = {
    version: 1, runKind: RESPONSE_OBSERVATION_KIND, sourceTabId, targetTabId,
    waitForDescendants: waitForDescendants !== false,
  };
  return {
    requestIdentity,
    requestFingerprint: createHash('sha256').update(JSON.stringify(requestIdentity)).digest('hex'),
  };
}

// Waiting adds a dependency without acquiring the target's execution lane.
function assertResponseObservationAcyclic(runs, input, isBlocking) {
  const pending = [input.targetTabId];
  const visited = new Set();
  while (pending.length) {
    const tabId = pending.pop();
    if (tabId === input.sourceTabId) {
      throw Object.assign(new Error('This wait would create a cycle between tabs'), {
        code: 'response_observation_cycle', statusCode: 409,
      });
    }
    if (visited.has(tabId)) continue;
    visited.add(tabId);
    for (const run of runs) {
      if (run.sourceTabId === tabId && run.targetTabId && isBlocking(run)) pending.push(run.targetTabId);
    }
  }
}

module.exports = {
  RESPONSE_OBSERVATION_KIND,
  isResponseObservation,
  normalizeResponseSubject,
  responseObservationRequestIdentity,
  assertResponseObservationAcyclic,
};
