const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  decideAutomaticRestoreAdmission,
  normalizeAgentLaunchSource,
  normalizeAiLifecycleIdentity,
} = require('./ai-lifecycle-authority');
const {
  agentPromptAuditMatchesHash,
} = require('./agent-prompt-audit-identity');
const {
  RECEIPT_STATES: AGENT_SEND_RECEIPT_STATES,
  isExactProviderNotAcceptedReceipt,
} = require('./agent-send-receipt-registry');
const {
  RESULT_PROOF_CODES,
} = require('./orchestration-result-proof');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set([
  'creating',
  'starting',
  'sending',
  'sent',
  'queued',
  'running',
  'waiting_descendants',
  'waiting_recovery',
]);
const TARGET_EXECUTION_STATUSES = new Set([
  'creating',
  'starting',
  'sending',
  'sent',
  'queued',
  'running',
]);
const SOURCE_FOLLOWUP_DELIVERY_STATUSES = new Set([
  'pending',
  'sending',
  'audit-pending',
  'sent',
  'queued',
]);
const SOURCE_FOLLOWUP_RECONCILABLE_STATUSES = new Set([
  ...SOURCE_FOLLOWUP_DELIVERY_STATUSES,
  'unconfirmed',
]);
const SOURCE_FOLLOWUP_PROBLEM_STATUSES = new Set(['waiting-for-input', 'failed', 'unconfirmed']);
const ORCHESTRATION_TARGET_HANDOFF_PREFIX = 'orchestration:';
const ORCHESTRATION_TARGET_SOURCE_PREFIX = 'orchestration:';
const ORCHESTRATION_COMPLETION_HANDOFF_PREFIX = 'orchestration-complete:';
const ORCHESTRATION_COMPLETION_SOURCE_PREFIX = 'orchestration-completion:';
const MAX_SETTLED_RUNS = 200;
const SETTLED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_POLICY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ORCHESTRATION_SETTINGS = Object.freeze({
  failureGraceMs: 5 * 60 * 1000,
  successAutoStopMs: 5 * 60 * 1000,
  reactToManualInterrupt: false,
  autoStopCreatedTargets: true,
});

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isResultProofPending(run) {
  return run?.status === 'completed' && run.resultComplete === false;
}

function isPausedRun(run) {
  return run?.status === 'waiting_recovery' && run.outcome === 'paused';
}

function ownsTargetExecution(run) {
  return TARGET_EXECUTION_STATUSES.has(run?.status);
}

function normalizeExecutionContext(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  const turnId = typeof value.turnId === 'string' ? value.turnId.trim() : '';
  const processId = value.processId == null ? '' : String(value.processId).trim();
  if (!provider || (!turnId && !processId)) return null;
  return {
    provider,
    sessionId: sessionId || null,
    turnId: turnId || null,
    processId: processId || null,
    generation: value.generation != null && Number.isFinite(Number(value.generation))
      ? Number(value.generation)
      : null,
    startedAt: value.startedAt != null && Number.isFinite(Number(value.startedAt))
      ? Number(value.startedAt)
      : null,
  };
}

function normalizeTargetActivity(value = {}) {
  const revision = Number(value.revision);
  const at = Number(value.at);
  return {
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    at: Number.isFinite(at) && at > 0 ? at : null,
    source: typeof value.source === 'string' && value.source.trim()
      ? value.source.trim()
      : null,
    // A restored store never assumes that the old process is still inside the
    // same busy edge. The first exact busy event after restart is new evidence.
    busy: false,
  };
}

function executionContextsMatch(left, right) {
  const a = normalizeExecutionContext(left);
  const b = normalizeExecutionContext(right);
  return Boolean(a && b
    && a.provider === b.provider
    && a.sessionId === b.sessionId
    && a.turnId === b.turnId
    && a.processId === b.processId);
}

function executionContextOwnersMatch(left, right) {
  const a = normalizeExecutionContext(left);
  const b = normalizeExecutionContext(right);
  if (!a || !b || a.provider !== b.provider || a.sessionId !== b.sessionId) return false;
  if (a.processId && b.processId && a.processId !== b.processId) return false;
  return true;
}

function runExecutionContextMatches(run, executionContext) {
  return executionContextsMatch(run?.targetExecutionContext, executionContext)
    || executionContextsMatch(run?.targetContinuationExecutionContext, executionContext);
}

function promptProofExecutionContext(run, proof = {}) {
  if (proof.executionContext == null) {
    return { context: null, reason: 'target-execution-context-unavailable' };
  }
  const context = normalizeExecutionContext(proof.executionContext);
  if (!context) {
    return { context: null, reason: 'target-execution-context-invalid' };
  }
  const proofProvider = typeof proof.toolType === 'string' ? proof.toolType.trim() : '';
  const targetProvider = typeof run?.targetToolType === 'string' ? run.targetToolType.trim() : '';
  const expectedProvider = proofProvider || targetProvider;
  if (!expectedProvider || context.provider !== expectedProvider) {
    return { context: null, reason: 'target-execution-context-provider-mismatch' };
  }
  const proofSessionId = typeof proof.sessionId === 'string' ? proof.sessionId.trim() : '';
  if (!proofSessionId || !context.sessionId) {
    return { context: null, reason: 'target-execution-context-session-unproven' };
  }
  if (context.sessionId !== proofSessionId) {
    return { context: null, reason: 'target-execution-context-session-mismatch' };
  }
  return { context, reason: null };
}

function bindPromptProofExecutionContext(run, proof = {}) {
  const existing = normalizeExecutionContext(run?.targetExecutionContext);
  if (proof.executionContext == null) {
    return {
      changed: false,
      contextBound: Boolean(existing),
      contextReason: existing ? null : 'target-execution-context-unavailable',
    };
  }
  const verdict = promptProofExecutionContext(run, proof);
  if (!verdict.context) {
    return {
      changed: false,
      contextBound: Boolean(existing),
      contextReason: verdict.reason,
    };
  }
  if (existing) {
    return {
      changed: false,
      contextBound: true,
      contextReason: executionContextsMatch(existing, verdict.context)
        ? null
        : 'target-execution-context-conflict',
    };
  }
  run.targetExecutionContext = verdict.context;
  return { changed: true, contextBound: true, contextReason: null };
}

function sourceFollowupExecutionContext(run, parent, proof = {}) {
  const context = normalizeExecutionContext(proof.executionContext);
  if (!context) {
    return { context: null, reason: 'source-followup-execution-context-unavailable' };
  }
  const proofProvider = typeof proof.toolType === 'string' ? proof.toolType.trim() : '';
  const expectedProvider = typeof parent?.targetToolType === 'string'
    ? parent.targetToolType.trim()
    : '';
  if (!proofProvider) {
    return { context: null, reason: 'source-followup-execution-context-provider-unproven' };
  }
  if (context.provider !== proofProvider
    || (expectedProvider && context.provider !== expectedProvider)) {
    return { context: null, reason: 'source-followup-execution-context-provider-mismatch' };
  }
  const proofSessionId = typeof proof.sessionId === 'string' ? proof.sessionId.trim() : '';
  if (!proofSessionId || !context.sessionId) {
    return { context: null, reason: 'source-followup-execution-context-session-unproven' };
  }
  if (context.sessionId !== proofSessionId) {
    return { context: null, reason: 'source-followup-execution-context-session-mismatch' };
  }
  const previous = normalizeExecutionContext(parent?.targetExecutionContext)
    || normalizeExecutionContext(run?.sourceExecutionContext);
  if (previous?.provider && previous.provider !== context.provider) {
    return { context: null, reason: 'source-followup-execution-context-provider-mismatch' };
  }
  if (previous?.sessionId && previous.sessionId !== context.sessionId) {
    return { context: null, reason: 'source-followup-execution-context-session-mismatch' };
  }
  if (!context.turnId) {
    return { context: null, reason: 'source-followup-execution-context-turn-unproven' };
  }
  if (previous?.turnId && previous.turnId === context.turnId) {
    const exactSameTurn = executionContextsMatch(previous, context)
      && (previous.generation == null || context.generation === previous.generation)
      && (previous.startedAt == null || context.startedAt === previous.startedAt);
    if (!exactSameTurn) {
      return { context: null, reason: 'source-followup-execution-context-same-turn-mismatch' };
    }
    const sameActiveTurn = proof.kind !== 'transcript'
      && proof.queuedAtSubmit === true
      && parent.status === 'running'
      && parent.targetBusySeen === true
      && parent.outcome == null
      && !parent.ownCompletedAt
      && !parent.completedAt;
    if (sameActiveTurn) {
      return { context, reason: null, disposition: 'same-active-turn' };
    }
    const sameSettledTurn = proof.kind === 'transcript'
      && proof.sameTurnComplete === true
      && parent.status === 'waiting_descendants'
      && parent.targetBusySeen !== true
      && parent.outcome === 'success'
      && !!parent.ownCompletedAt
      && !parent.completedAt;
    if (sameSettledTurn) {
      return { context, reason: null, disposition: 'same-settled-turn' };
    }
    return { context: null, reason: 'source-followup-execution-context-turn-not-advanced' };
  }
  return { context, reason: null, disposition: 'advanced-turn' };
}

function lifecycleExecutionContext(payload = {}) {
  return normalizeExecutionContext(payload.executionContext || {
    provider: payload.provider || payload.toolType || payload.commandType,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    processId: payload.processId,
    generation: payload.turnGeneration,
    startedAt: payload.turnStartedAt,
  });
}

function resolveCausalSourceExecutionContext({ sourceTabId, sourceMeta, getExecutionContext }) {
  if (sourceMeta?.server !== 'terminal'
    || sourceMeta.mode !== 'internal'
    || sourceMeta.tabId !== sourceTabId
    || typeof getExecutionContext !== 'function') return null;
  return normalizeExecutionContext(getExecutionContext(sourceTabId));
}

function buildOrchestrationResultLookup(run) {
  const continuationByPrompt = Boolean(run?.resultPromptHash);
  const continuationByTime = !continuationByPrompt && Number(run?.resultAfterAt) > 0;
  const lookup = {
    promptHash: continuationByPrompt
      ? run.resultPromptHash
      : (continuationByTime ? undefined : run?.promptHash),
    promptUserUuid: continuationByPrompt
      ? (run.resultPromptProofUserUuid || undefined)
      : (continuationByTime ? undefined : (run?.targetPromptProofUserUuid || undefined)),
    promptSourceIdentity: continuationByPrompt
      ? (run.resultPromptProofSourceIdentity || undefined)
      : (continuationByTime ? undefined : (run?.targetPromptProofSourceIdentity || undefined)),
    requestedAt: run?.resultPromptRequestedAt || run?.createdAt,
    resultAfterAt: continuationByPrompt ? undefined : run?.resultAfterAt,
    resultBeforeAt: run?.ownCompletedAt || run?.completedAt || undefined,
  };
  const targetExecutionContext = normalizeExecutionContext(run?.targetExecutionContext);
  if (targetExecutionContext) lookup.targetExecutionContext = targetExecutionContext;
  return lookup;
}

function orchestrationSendFailureRecoveryPolicy(sendResult = {}) {
  const provenNotSent = sendResult?.submitted === false;
  const provenProviderNotAccepted = isExactProviderNotAcceptedReceipt(sendResult);
  return {
    provenNotSent,
    provenProviderNotAccepted,
    failureGraceMs: provenNotSent || provenProviderNotAccepted ? 0 : undefined,
  };
}

function classifyAgentSendReceipt(sendResult = {}) {
  const registryState = typeof sendResult?.receiptState === 'string'
    ? sendResult.receiptState
    : null;
  if (isExactProviderNotAcceptedReceipt(sendResult)) {
    return {
      state: AGENT_SEND_RECEIPT_STATES.PROVIDER_NOT_ACCEPTED,
      submitted: true,
      accepted: false,
    };
  }
  if (
    registryState === 'delivery-unknown'
    || registryState === 'evicted-unknown'
    || sendResult?.deliveryUnknown === true
    || sendResult?.status === 'delivery-unknown'
    || sendResult?.status === 'delivery_unknown'
  ) {
    return {
      state: 'delivery-unknown',
      submitted: null,
      accepted: true,
    };
  }
  if (registryState === 'audit-pending') {
    return {
      state: 'audit-pending',
      submitted: true,
      accepted: true,
    };
  }
  if (registryState === 'not-submitted'
    || registryState === 'capacity'
    || registryState === 'conflict') {
    return {
      state: 'not-submitted',
      submitted: false,
      accepted: false,
    };
  }
  if (registryState === 'confirmed') {
    return {
      state: 'confirmed',
      submitted: true,
      accepted: true,
    };
  }
  const failed = sendResult?.success === false || sendResult?.ok === false;
  if (sendResult?.submitted === true) {
    const auditPending = sendResult?.auditPending === true
      || sendResult?.status === 'audit-pending'
      || sendResult?.status === 'submitted_unverified';
    return {
      state: failed || auditPending ? 'audit-pending' : 'confirmed',
      submitted: true,
      accepted: true,
    };
  }
  if (failed || sendResult?.submitted === false) {
    return {
      state: 'not-submitted',
      submitted: false,
      accepted: false,
    };
  }
  // A generic success flag is not physical proof that Enter crossed. Older
  // adapters can omit submitted/audit fields; keep that outcome explicit so a
  // caller cannot turn an incomplete renderer receipt into green success.
  return {
    state: 'delivery-unknown',
    submitted: null,
    accepted: true,
  };
}

function canNotifySource(run) {
  return run?.notifySource !== false
    && !!run?.sourceTabId
    && run.sourceTabId !== run.targetTabId
    && run.notificationSuppressed !== true;
}

function isSourceFollowupPending(run) {
  return isTerminalStatus(run?.status)
    && canNotifySource(run)
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && SOURCE_FOLLOWUP_DELIVERY_STATUSES.has(run.notificationStatus);
}

function isSourceNotificationBlocked(run) {
  return isTerminalStatus(run?.status)
    && canNotifySource(run)
    && SOURCE_FOLLOWUP_PROBLEM_STATUSES.has(run.notificationStatus);
}

function shouldMarkSourceFollowupUnconfirmed(run, reconciliation) {
  return reconciliation?.confirmed !== true
    && isTerminalStatus(run?.status)
    && canNotifySource(run)
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && (run.notificationStatus === 'sending'
      || run.notificationStatus === 'audit-pending'
      || run.notificationStatus === 'sent'
      || run.notificationStatus === 'queued');
}

function isTrackedOrchestrationRun(run) {
  return isActiveStatus(run?.status)
    // A Stop edge can beat the final JSONL append. Keep the durable run in
    // startup reconciliation even when it has no separate source notification;
    // otherwise a restart removes the only owner capable of proving the result.
    || isResultProofPending(run)
    || isSourceFollowupPending(run)
    || isSourceNotificationBlocked(run);
}

function isCompleteOrchestrationResult(result) {
  return result?.found === true && result?.resultComplete === true;
}

function shouldScheduleCreatedTargetAutoStop(run) {
  return run?.status === 'completed'
    && run.resultComplete === true
    && run.targetCreatedByOrchestration === true
    && run.autoStopCreatedTargets !== false
    && Number(run.successAutoStopMs) > 0
    && !run.autoStopAt
    && !run.autoStopFinishedAt;
}

function requiresExactLifecycleGeneration(run) {
  return run?.targetToolType === 'codex';
}

function lifecycleGenerationCheck(run, observedGeneration) {
  if (!requiresExactLifecycleGeneration(run)) {
    return { verdict: 'not-required', reason: null };
  }
  const expected = typeof run?.targetLifecycleGeneration === 'string'
    ? run.targetLifecycleGeneration.trim()
    : '';
  const observed = typeof observedGeneration === 'string'
    ? observedGeneration.trim()
    : '';
  if (!expected) return { verdict: 'unknown', reason: 'expected-generation-unproven' };
  if (!observed) return { verdict: 'unknown', reason: 'observed-generation-unproven' };
  return expected === observed
    ? { verdict: 'match', reason: null }
    : { verdict: 'changed', reason: 'process-generation-changed' };
}

function shouldRetryWaitingNotificationForSourceLifecycle(payload) {
  return payload?.type === 'done'
    || (payload?.type === 'busy' && payload?.busy === true)
    || (payload?.type === 'snapshot'
      && payload?.inputReady === true
      && payload?.busy !== true
      && payload?.starting !== true
      && payload?.stopping !== true);
}

function canonicalPromptAuditSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source.startsWith('codex-') ? source.slice('codex-'.length) : source;
}

function orchestrationTargetRunIdFromAudit(payload) {
  if (payload?.success !== true) return null;
  const handoffId = typeof payload?.handoffId === 'string' ? payload.handoffId.trim() : '';
  if (!handoffId.startsWith(ORCHESTRATION_TARGET_HANDOFF_PREFIX)) return null;
  const runId = handoffId.slice(ORCHESTRATION_TARGET_HANDOFF_PREFIX.length).trim();
  if (!runId || handoffId !== ORCHESTRATION_TARGET_HANDOFF_PREFIX + runId) return null;
  return runId;
}

function orchestrationCompletionRunIdFromAudit(payload) {
  if (payload?.success !== true) return null;
  const handoffId = typeof payload?.handoffId === 'string' ? payload.handoffId.trim() : '';
  if (!handoffId.startsWith(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX)) return null;
  const runId = handoffId.slice(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX.length).trim();
  if (!runId || handoffId !== ORCHESTRATION_COMPLETION_HANDOFF_PREFIX + runId) return null;
  const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
  // Codex normalizes every PTY source with one `codex-` prefix before staging
  // its rollout audit. The handoff remains provider-neutral. Canonicalize only
  // that one known transport prefix; arbitrary suffix/prefix matches are still
  // rejected so an audit cannot confirm a neighboring run.
  const canonicalSource = canonicalPromptAuditSource(source);
  if (canonicalSource !== ORCHESTRATION_COMPLETION_SOURCE_PREFIX + runId) return null;
  return runId;
}

function orchestrationInstallBlockers(run) {
  if (!run?.runId) return [];
  const blockers = [];
  const separateSource = Boolean(
    run.sourceTabId
    && run.sourceTabId !== run.targetTabId
    && run.notifySource !== false
    && run.notificationSuppressed !== true,
  );
  const resultProofPending = isResultProofPending(run);
  const active = isActiveStatus(run.status);
  const waitingForResumedTurn = run.resumeAwaitingNewTurn === true;
  const deliveryAwaitingReadiness = run.status === 'queued'
    && !run.deliveryAcceptedAt
    && !run.targetPromptProofAt;
  const attentionOnly = run.status === 'waiting_recovery'
    || waitingForResumedTurn
    || deliveryAwaitingReadiness;

  if (resultProofPending) {
    if (separateSource) {
      blockers.push({
        tabId: run.sourceTabId,
        kind: 'orchestration',
        status: 'result-proof',
        role: 'source',
        runId: run.runId,
        orchestrationStatus: run.status,
        notificationStatus: run.notificationStatus || null,
        projectId: run.sourceProjectId || null,
        project: run.sourceProjectName || null,
        name: run.sourceTabName || ('tab ' + String(run.sourceTabId).slice(-6)),
        cwd: run.sourceProjectPath || null,
      });
    }
    if (run.targetTabId) {
      blockers.push({
        tabId: run.targetTabId,
        kind: 'orchestration',
        status: 'result-proof',
        role: 'target',
        runId: run.runId,
        orchestrationStatus: run.status,
        notificationStatus: run.notificationStatus || null,
        projectId: run.targetProjectId || null,
        project: run.targetProjectName || null,
        name: run.targetTabName || ('tab ' + String(run.targetTabId).slice(-6)),
        cwd: run.targetCwd || run.targetProjectPath || null,
      });
    }
    return blockers;
  }

  if (active && separateSource) {
    blockers.push({
      tabId: run.sourceTabId,
      kind: 'orchestration',
      status: attentionOnly ? 'recovery' : 'inherited-busy',
      role: 'source',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.sourceProjectId || null,
      project: run.sourceProjectName || null,
      name: run.sourceTabName || ('tab ' + String(run.sourceTabId).slice(-6)),
      cwd: run.sourceProjectPath || null,
    });
  }

  if (active && run.targetTabId) {
    blockers.push({
      tabId: run.targetTabId,
      kind: 'orchestration',
      status: attentionOnly ? 'recovery' : run.status,
      role: 'target',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.targetProjectId || null,
      project: run.targetProjectName || null,
      name: run.targetTabName || ('tab ' + String(run.targetTabId).slice(-6)),
      cwd: run.targetCwd || run.targetProjectPath || null,
    });
  }

  if (!active && separateSource && (isSourceFollowupPending(run) || isSourceNotificationBlocked(run))) {
    blockers.push({
      tabId: run.sourceTabId,
      kind: 'orchestration',
      status: isSourceFollowupPending(run) ? 'completion-handoff' : 'notification-blocked',
      role: 'source',
      runId: run.runId,
      orchestrationStatus: run.status,
      notificationStatus: run.notificationStatus || null,
      projectId: run.sourceProjectId || null,
      project: run.sourceProjectName || null,
      name: run.sourceTabName || ('tab ' + String(run.sourceTabId).slice(-6)),
      cwd: run.sourceProjectPath || null,
    });
  }

  return blockers;
}

function mergeActiveLoadersWithOrchestrations(runtimeSnapshot = {}, runs = []) {
  const loaders = [];
  const seen = new Set();
  for (const loader of Array.isArray(runtimeSnapshot?.loaders) ? runtimeSnapshot.loaders : []) {
    if (!loader?.tabId || seen.has(loader.tabId)) continue;
    loaders.push(loader);
    seen.add(loader.tabId);
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const blocker of orchestrationInstallBlockers(run)) {
      if (seen.has(blocker.tabId)) continue;
      loaders.push(blocker);
      seen.add(blocker.tabId);
    }
  }
  return {
    ...runtimeSnapshot,
    idle: runtimeSnapshot?.idle === false ? false : loaders.length === 0,
    count: loaders.length,
    loaders,
    ts: Date.now(),
  };
}

function hasNewerTargetRun(runs, scheduledRun) {
  if (!scheduledRun?.runId || !scheduledRun?.targetTabId) return false;
  const completedAt = Number(scheduledRun.completedAt);
  return (Array.isArray(runs) ? runs : []).some((candidate) => {
    if (!candidate || candidate.runId === scheduledRun.runId) return false;
    if (candidate.targetTabId !== scheduledRun.targetTabId) return false;
    if (isActiveStatus(candidate.status)) return true;
    if (!Number.isFinite(completedAt)) return false;
    return [candidate.deliveryAcceptedAt, candidate.startedAt, candidate.ownCompletedAt]
      .map(Number)
      .some((timestamp) => Number.isFinite(timestamp) && timestamp >= completedAt);
  });
}

function isAbortedReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('abort') ||
    value.includes('interrupt') ||
    value.includes('manual-stop') ||
    value.includes('killed') ||
    value.includes('failed') ||
    value.includes('error') ||
    value.includes('exited') ||
    value.includes('closed');
}

function outcomeForReason(reason) {
  const value = String(reason || '').toLowerCase();
  if (value.includes('target_closed') || value.includes('target-closed') || value === 'close') return 'target_closed';
  if (value.includes('startup')) return 'startup_failed';
  if (value.includes('replace')) return 'process_replaced';
  if (value === 'pty-exit'
    || value === 'terminal-kill'
    || value === 'watchdog'
    || value === 'command-finished'
    || value === 'exit'
    || value.includes('process-exit')
    || value.includes('process_killed')) return 'process_exited';
  if (value.includes('process') && (value.includes('exit') || value.includes('killed'))) return 'process_exited';
  if (value.includes('no-final-result')) return 'failed';
  if (value.includes('abort')
    || value.includes('interrupt')
    || value.includes('manual-stop')
    || value === 'stopping') return 'interrupted';
  if (value.includes('failed') || value.includes('error')) return 'failed';
  return isAbortedReason(value) ? 'unknown' : 'success';
}

function canExactResultResolveRecovery(run) {
  if (run?.status !== 'waiting_recovery') return true;
  if (['target_closed', 'process_exited', 'process_replaced'].includes(run.outcome)) return true;
  if (run.resultErrorCode === RESULT_PROOF_CODES.RESULT_PROOF_DEADLINE) return true;
  const error = String(run.error || '').toLowerCase();
  return error.includes('delivery outcome is unknown')
    || error.includes('bridge_timeout_delivery_unknown')
    || error.includes('result proof deadline');
}

function clampDelay(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_POLICY_DELAY_MS, Math.round(number)));
}

function normalizeSettings(value = {}) {
  return {
    failureGraceMs: clampDelay(value.failureGraceMs, DEFAULT_ORCHESTRATION_SETTINGS.failureGraceMs),
    successAutoStopMs: clampDelay(value.successAutoStopMs, DEFAULT_ORCHESTRATION_SETTINGS.successAutoStopMs),
    reactToManualInterrupt: value.reactToManualInterrupt === true,
    autoStopCreatedTargets: value.autoStopCreatedTargets !== false,
  };
}

function publicRun(run) {
  if (!run) return null;
  const {
    // The unsent prompt is persisted only so a queued orchestration survives
    // an app restart.  It must never leak through Project API/status payloads.
    deliveryIntent: _deliveryIntent,
    requestFingerprint: _requestFingerprint,
    promptHash: _promptHash,
    resultPromptHash: _resultPromptHash,
    notificationPromptHash: _notificationPromptHash,
    notificationPromptAuditHash: _notificationPromptAuditHash,
    targetPromptProofHash: _targetPromptProofHash,
    targetPromptProofExpectedHash: _targetPromptProofExpectedHash,
    targetPromptProofSourceIdentity: _targetPromptProofSourceIdentity,
    targetPromptAuditHash: _targetPromptAuditHash,
    targetBusySeen: _targetBusySeen,
    waitingForPriorTurn: _waitingForPriorTurn,
    ...safe
  } = run;
  return { ...safe };
}

class OrchestrationRunStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.runs = new Map();
    this.createdTargetTabIds = new Set();
    this.targetActivityByTab = new Map();
    this.settings = { ...DEFAULT_ORCHESTRATION_SETTINGS };
    this.initialized = false;
    this.initializePromise = null;
    this.persistChain = Promise.resolve();
    this.reservationChain = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      try {
        const raw = await fs.promises.readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.settings = normalizeSettings(parsed?.settings);
        const storedRuns = Array.isArray(parsed?.runs) ? parsed.runs : [];
        for (const tabId of Array.isArray(parsed?.createdTargetTabIds) ? parsed.createdTargetTabIds : []) {
          if (typeof tabId === 'string' && tabId) this.createdTargetTabIds.add(tabId);
        }
        const storedTargetActivity = parsed?.targetActivityByTab && typeof parsed.targetActivityByTab === 'object'
          ? parsed.targetActivityByTab
          : {};
        for (const [tabId, activity] of Object.entries(storedTargetActivity)) {
          if (typeof tabId === 'string' && tabId) {
            this.targetActivityByTab.set(tabId, normalizeTargetActivity(activity));
          }
        }
        // Backfill ownership from v2 stores before settled-run pruning removes
        // the original run which physically created the executor tab.
        for (const stored of storedRuns) {
          if (stored?.targetCreated === true && stored?.targetTabId) {
            this.createdTargetTabIds.add(stored.targetTabId);
          }
        }
        let migrationNeeded = !Array.isArray(parsed?.createdTargetTabIds);
        for (const stored of storedRuns) {
          if (!stored?.runId || !stored?.targetTabId) continue;
          const run = {
            waitForDescendants: stored.waitForDescendants !== false,
            failureGraceMs: clampDelay(stored.failureGraceMs, this.settings.failureGraceMs),
            successAutoStopMs: clampDelay(stored.successAutoStopMs, this.settings.successAutoStopMs),
            reactToManualInterrupt: stored.reactToManualInterrupt === true,
            autoStopCreatedTargets: stored.autoStopCreatedTargets !== false,
            ...stored,
          };
          run.targetCreatedByOrchestration = stored.targetCreatedByOrchestration === true
            || this.createdTargetTabIds.has(stored.targetTabId);
          if (stored.targetCreatedByOrchestration !== run.targetCreatedByOrchestration) {
            migrationNeeded = true;
          }
          // Legacy notification failures predate the persistent attention flag.
          // Surface only failures that still block the source, not every old run.
          if (isSourceNotificationBlocked(run) && !run.attentionRequiredAt) {
            run.attentionRequiredAt = run.notificationAttemptedAt || run.updatedAt || run.completedAt || Date.now();
          }
          // Exact transcript identity proves that the prompt crossed Enter.
          // A stale private queue payload must not survive that proof and be
          // replayed after restart.
          if (run.targetPromptProofAt && run.deliveryIntent) {
            run.deliveryIntent = null;
            migrationNeeded = true;
          }
          if (run.autoStopAt && !run.autoStopFinishedAt
            && !Number.isInteger(Number(run.autoStopActivityRevision))) {
            run.autoStopActivityRevision = this._activityForTarget(run.targetTabId).revision;
            migrationNeeded = true;
          }
          this.runs.set(run.runId, run);
        }
        migrationNeeded = this._backfillCreatedTargetAutoStops() || migrationNeeded;
        this._pruneInMemory();
        if (migrationNeeded) this._schedulePersist();
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn('[OrchestrationRuns] load failed:', error?.message || error);
        }
      }
      this.initialized = true;
    })();
    return this.initializePromise;
  }

  async create(input, options = {}) {
    await this.initialize();
    if (!input?.runId) throw new Error('runId required');
    if (this.runs.has(input.runId)) throw new Error('runId already exists');
    const predecessor = this._deliveryPredecessorsForTarget(input.targetTabId).at(-1) || null;
    const explicitParentRunId = typeof input.parentRunId === 'string' ? input.parentRunId.trim() : '';
    const sourceExecutionContext = normalizeExecutionContext(input.sourceExecutionContext);
    const parentRunId = explicitParentRunId
      || this._inferParentRunId(input.sourceTabId, sourceExecutionContext);
    if (parentRunId) this._validateParent(parentRunId, input);
    if (input.targetCreated === true && input.targetTabId) {
      this.createdTargetTabIds.add(input.targetTabId);
    }
    const now = Date.now();
    const run = {
      ...input,
      targetCreatedByOrchestration: this.createdTargetTabIds.has(input.targetTabId),
      status: 'creating',
      createdAt: now,
      updatedAt: now,
      notifySource: input.notifySource !== false,
      notificationStatus: 'pending',
      resultAvailable: false,
      resultComplete: false,
      predecessorRunId: predecessor?.runId || null,
      parentRunId: parentRunId || null,
      waitForDescendants: input.waitForDescendants !== false,
      failureGraceMs: clampDelay(input.failureGraceMs, this.settings.failureGraceMs),
      successAutoStopMs: clampDelay(input.successAutoStopMs, this.settings.successAutoStopMs),
      reactToManualInterrupt: typeof input.reactToManualInterrupt === 'boolean'
        ? input.reactToManualInterrupt
        : this.settings.reactToManualInterrupt,
      autoStopCreatedTargets: typeof input.autoStopCreatedTargets === 'boolean'
        ? input.autoStopCreatedTargets
        : this.settings.autoStopCreatedTargets,
      targetBusySeen: false,
      waitingForPriorTurn: false,
      waitingForInternalDescendants: false,
      internalBackgroundWorkCount: 0,
      internalContinuationCountSeen: 0,
      internalContinuationBaseline: 0,
      outcome: null,
      ownCompletedAt: null,
      resultPromptHash: null,
      resultPromptProofUserUuid: null,
      resultPromptProofSourceIdentity: null,
      resultErrorCode: null,
      resultAfterAt: null,
      resultPromptRequestedAt: null,
      recoveryDeadlineAt: null,
      waitingOnRunIds: [],
      notificationHandoffId: null,
      sourceFollowupPending: false,
      sourceFollowupStartedAt: null,
      sourceFollowupProofKind: null,
      sourceExecutionContext,
      targetExecutionContext: normalizeExecutionContext(input.targetExecutionContext),
      targetContinuationExecutionContext: null,
    };
    this.runs.set(run.runId, run);
    if (options.persistStrict === true) {
      try {
        await this.persistStrict();
      } catch (error) {
        this.runs.delete(run.runId);
        if (input.targetCreated === true
          && !Array.from(this.runs.values()).some((candidate) => (
            candidate.targetTabId === input.targetTabId
            && candidate.targetCreatedByOrchestration === true
          ))) {
          this.createdTargetTabIds.delete(input.targetTabId);
        }
        error.code ||= 'orchestration_persist_failed';
        error.statusCode ||= 503;
        throw error;
      }
    } else this._schedulePersist();
    return publicRun(run);
  }

  async reserveOrGet(input) {
    const work = this.reservationChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        const existing = this.runs.get(input?.runId);
        if (existing) {
          if (!existing.requestFingerprint) {
            return {
              created: false,
              conflict: true,
              reason: 'request-identity-unavailable',
              run: publicRun(existing),
            };
          }
          if (existing.requestFingerprint !== input.requestFingerprint) {
            return {
              created: false,
              conflict: true,
              reason: 'idempotency-key-reused',
              run: publicRun(existing),
            };
          }
          return { created: false, conflict: false, reason: null, run: publicRun(existing) };
        }
        const run = await this.create(input, { persistStrict: true });
        return { created: true, conflict: false, reason: null, run };
      });
    this.reservationChain = work.then(() => undefined, () => undefined);
    return work;
  }

  async patch(runId, patch) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    Object.assign(run, patch, { updatedAt: Date.now() });
    if (patch?.autoStopStatus === 'scheduled' && patch?.autoStopAt) {
      const activity = this._activityForTarget(run.targetTabId);
      run.autoStopActivityRevision = activity.revision;
      run.autoStopClaimId = null;
      run.autoStopClaimedAt = null;
      run.autoStopExpectedTargetIdentity = null;
    }
    this._syncSourceFollowupState(run);
    this._schedulePersist();
    return publicRun(run);
  }

  async recordResultProofObservation(runId, observation = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'completed') return publicRun(run);
    if (run.resultComplete === true && observation.resultComplete !== true) {
      return publicRun(run);
    }
    const fields = [
      'resultComplete',
      'resultAvailable',
      'resultTurnIndex',
      'resultUserUuid',
      'resultSourceIdentity',
      'resultPromptCarrierKind',
      'resultInternalContinuationCount',
      'resultProofStatus',
      'resultProofDeadlineAt',
      'resultProofObservedSize',
      'resultProofObservedMtimeMs',
      'resultError',
      'resultErrorCode',
      'sessionId',
      'autoStopAt',
      'autoStopStatus',
    ];
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(observation, field)) {
        run[field] = observation[field];
      }
    }
    if (run.autoStopStatus === 'scheduled' && run.autoStopAt) {
      const activity = this._activityForTarget(run.targetTabId);
      run.autoStopActivityRevision = activity.revision;
      run.autoStopClaimId = null;
      run.autoStopClaimedAt = null;
      run.autoStopExpectedTargetIdentity = null;
    }
    run.updatedAt = Date.now();
    this._syncSourceFollowupState(run);
    if (run.autoStopStatus === 'scheduled') await this.persistStrict();
    else this._schedulePersist();
    return publicRun(run);
  }

  async bindNotificationSourceSession(runId, sessionId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    run.notificationSourceSessionId = sessionId || null;
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  _activityForTarget(tabId) {
    const existing = this.targetActivityByTab.get(tabId);
    if (existing) return existing;
    const created = normalizeTargetActivity();
    this.targetActivityByTab.set(tabId, created);
    return created;
  }

  _recordTargetActivity(tabId, {
    source = 'unknown',
    at = Date.now(),
    busy = false,
    force = false,
  } = {}) {
    if (!tabId) return { changed: false, activity: normalizeTargetActivity() };
    const activity = this._activityForTarget(tabId);
    const nextBusy = busy === true;
    const beginsNewActivity = force === true || (nextBusy && activity.busy !== true);
    let changed = false;
    if (beginsNewActivity) {
      activity.revision += 1;
      activity.at = Number.isFinite(Number(at)) ? Number(at) : Date.now();
      activity.source = typeof source === 'string' && source ? source : 'unknown';
      changed = true;
    }
    if (activity.busy !== nextBusy) {
      activity.busy = nextBusy;
      changed = true;
    }
    return { changed, activity: { ...activity } };
  }

  _pendingAutoStopsForTarget(tabId, { dueOnly = false, now = Date.now() } = {}) {
    return Array.from(this.runs.values())
      .filter((run) => run.targetTabId === tabId
        && run.status === 'completed'
        && run.resultComplete === true
        && run.autoStopAt
        && !run.autoStopFinishedAt
        && (run.autoStopStatus === 'scheduled' || run.autoStopStatus === 'claimed')
        && (!dueOnly || run.autoStopStatus === 'claimed' || Number(run.autoStopAt) <= Number(now)))
      .sort((a, b) => Number(a.autoStopAt || 0) - Number(b.autoStopAt || 0));
  }

  async admitAgentLaunch(tabId, {
    launchSource = 'explicit',
    now = Date.now(),
  } = {}) {
    const work = this.reservationChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        const source = normalizeAgentLaunchSource(launchSource);
        const due = this._pendingAutoStopsForTarget(tabId, { dueOnly: true, now });
        const decision = decideAutomaticRestoreAdmission({
          launchSource: source,
          pendingAutoStop: due.length > 0
            ? { authoritative: true, runId: due[0].runId }
            : null,
        });
        if (!decision.allowed) return decision;
        if (source === 'auto-resume') {
          return {
            allowed: true,
            source,
            reason: null,
            activityRevision: this._activityForTarget(tabId).revision,
            supersededRunIds: [],
          };
        }

        const activityResult = this._recordTargetActivity(tabId, {
          source: 'launch:' + source,
          at: now,
          force: true,
        });
        const supersededRunIds = [];
        for (const run of this._pendingAutoStopsForTarget(tabId, { now })) {
          run.autoStopFinishedAt = Number(now);
          run.autoStopStatus = 'skipped-target-changed';
          run.autoStopError = null;
          run.autoStopSupersededAt = Number(now);
          run.autoStopSupersededBy = source;
          run.updatedAt = Number(now);
          supersededRunIds.push(run.runId);
        }
        if (activityResult.changed || supersededRunIds.length > 0) {
          await this.persistStrict();
        }
        return {
          allowed: true,
          source,
          reason: null,
          activityRevision: activityResult.activity.revision,
          supersededRunIds,
        };
      });
    this.reservationChain = work.then(() => undefined, () => undefined);
    return work;
  }

  async claimDueAutoStop(runId, {
    now = Date.now(),
    expectedTargetIdentity = null,
    observedBusy = false,
  } = {}) {
    const work = this.reservationChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        const run = this.runs.get(runId);
        if (!run) return { claimed: false, reason: 'run-not-found', run: null };
        if (run.autoStopFinishedAt) {
          return { claimed: false, reason: 'auto-stop-already-finished', run: publicRun(run) };
        }
        if (run.status !== 'completed' || run.resultComplete !== true || !run.autoStopAt) {
          return { claimed: false, reason: 'auto-stop-not-eligible', run: publicRun(run) };
        }
        if (Number(run.autoStopAt) > Number(now) && run.autoStopStatus !== 'claimed') {
          return { claimed: false, reason: 'auto-stop-not-due', run: publicRun(run) };
        }

        const activity = this._activityForTarget(run.targetTabId);
        const baselineRevision = Number.isInteger(Number(run.autoStopActivityRevision))
          ? Number(run.autoStopActivityRevision)
          : activity.revision;
        const superseded = observedBusy === true
          || activity.revision > baselineRevision
          || hasNewerTargetRun(Array.from(this.runs.values()), run);
        if (superseded) {
          run.autoStopFinishedAt = Number(now);
          run.autoStopStatus = observedBusy === true ? 'skipped-busy' : 'skipped-target-changed';
          run.autoStopError = null;
          run.updatedAt = Number(now);
          await this.persistStrict();
          return { claimed: false, reason: run.autoStopStatus, run: publicRun(run) };
        }

        const normalizedIdentity = normalizeAiLifecycleIdentity(expectedTargetIdentity);
        if (run.autoStopStatus === 'claimed' && run.autoStopClaimId) {
          // A process that was already stopped before a crash legitimately
          // reappears as ABSENT after restart. Refresh only that safe boundary;
          // a live replacement process is never adopted by an old claim.
          if (normalizedIdentity?.processStatus === 'absent') {
            run.autoStopExpectedTargetIdentity = normalizedIdentity;
            run.autoStopClaimActivityRevision = activity.revision;
            run.updatedAt = Number(now);
            await this.persistStrict();
          }
          return {
            claimed: true,
            idempotent: true,
            claimId: run.autoStopClaimId,
            run: publicRun(run),
          };
        }

        run.autoStopStatus = 'claimed';
        run.autoStopClaimId = crypto.randomUUID();
        run.autoStopClaimedAt = Number(now);
        run.autoStopActivityRevision = baselineRevision;
        run.autoStopClaimActivityRevision = activity.revision;
        run.autoStopExpectedTargetIdentity = normalizedIdentity;
        run.updatedAt = Number(now);
        await this.persistStrict();
        return {
          claimed: true,
          idempotent: false,
          claimId: run.autoStopClaimId,
          run: publicRun(run),
        };
      });
    this.reservationChain = work.then(() => undefined, () => undefined);
    return work;
  }

  validateAutoStopClaim(runId, claimId) {
    if (!this.initialized) {
      return { valid: false, reason: 'orchestration-store-not-ready', run: null };
    }
    const run = this.runs.get(runId);
    if (!run) return { valid: false, reason: 'run-not-found', run: null };
    if (run.autoStopFinishedAt) {
      return { valid: false, reason: 'auto-stop-already-finished', run: publicRun(run) };
    }
    if (run.autoStopStatus !== 'claimed' || !claimId || run.autoStopClaimId !== claimId) {
      return { valid: false, reason: 'auto-stop-claim-changed', run: publicRun(run) };
    }
    const activity = this._activityForTarget(run.targetTabId);
    if (activity.revision !== Number(run.autoStopClaimActivityRevision)) {
      return { valid: false, reason: 'target-activity-changed', run: publicRun(run) };
    }
    return {
      valid: true,
      reason: null,
      expectedTargetIdentity: normalizeAiLifecycleIdentity(run.autoStopExpectedTargetIdentity),
      run: publicRun(run),
    };
  }

  async settleAutoStopClaim(runId, claimId, {
    status,
    error = null,
    now = Date.now(),
  } = {}) {
    const work = this.reservationChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        const run = this.runs.get(runId);
        if (!run) return { settled: false, reason: 'run-not-found', run: null };
        if (run.autoStopFinishedAt) {
          return { settled: false, reason: 'auto-stop-already-finished', run: publicRun(run) };
        }
        if (run.autoStopStatus !== 'claimed' || run.autoStopClaimId !== claimId) {
          return { settled: false, reason: 'auto-stop-claim-changed', run: publicRun(run) };
        }
        const allowedStatuses = new Set([
          'stopped',
          'stopped-no-process',
          'skipped-target-changed',
          'failed',
        ]);
        run.autoStopStatus = allowedStatuses.has(status) ? status : 'failed';
        run.autoStopFinishedAt = Number(now);
        run.autoStopError = error ? String(error) : null;
        run.updatedAt = Number(now);
        await this.persistStrict();
        return { settled: true, reason: null, run: publicRun(run) };
      });
    this.reservationChain = work.then(() => undefined, () => undefined);
    return work;
  }

  async cancelAutoStop(runId, {
    reason = 'detached-by-user',
    now = Date.now(),
  } = {}) {
    const work = this.reservationChain
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        const run = this.runs.get(runId);
        if (!run) return { cancelled: false, reason: 'run-not-found', run: null };
        if (!run.autoStopAt || run.autoStopFinishedAt) {
          return { cancelled: false, reason: 'auto-stop-not-pending', run: publicRun(run) };
        }
        run.autoStopStatus = 'cancelled';
        run.autoStopFinishedAt = Number(now);
        run.autoStopError = null;
        run.autoStopCancelledAt = Number(now);
        run.autoStopCancelledReason = String(reason || 'cancelled');
        run.updatedAt = Number(now);
        await this.persistStrict();
        return { cancelled: true, reason: null, run: publicRun(run) };
      });
    this.reservationChain = work.then(() => undefined, () => undefined);
    return work;
  }

  async markDelivery(runId, {
    baselineBusy = false,
    sessionId = null,
    lifecycleGeneration = null,
    launchGeneration = null,
    auditPending = false,
  } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return publicRun(run);
    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    const waitingForPredecessor = Boolean(predecessor && ownsTargetExecution(predecessor));
    if (isPausedRun(run)) {
      run.sessionId = sessionId || run.sessionId || null;
      run.targetLifecycleGeneration = lifecycleGeneration || run.targetLifecycleGeneration || null;
      run.targetLaunchGeneration = launchGeneration || run.targetLaunchGeneration || null;
      run.deliveryAcceptedAt ||= Date.now();
      run.deliveryAuditPendingAt = auditPending ? (run.deliveryAuditPendingAt || Date.now()) : null;
      run.deliveryIntent = null;
      run.deliveryDispatchFinishedAt = run.deliveryAcceptedAt;
      run.updatedAt = Date.now();
      this._schedulePersist();
      return publicRun(run);
    }
    run.waitingForPriorTurn = !waitingForPredecessor && baselineBusy;
    run.status = (waitingForPredecessor || run.waitingForPriorTurn) ? 'queued' : 'sent';
    run.sessionId = sessionId || run.sessionId || null;
    run.targetLifecycleGeneration = lifecycleGeneration || run.targetLifecycleGeneration || null;
    run.targetLaunchGeneration = launchGeneration || run.targetLaunchGeneration || null;
    run.deliveryAcceptedAt = Date.now();
    run.deliveryAuditPendingAt = auditPending ? run.deliveryAcceptedAt : null;
    run.deliveryIntent = null;
    run.deliveryDispatchFinishedAt = run.deliveryAcceptedAt;
    if (run.targetPromptProofAt && !waitingForPredecessor) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= run.targetPromptProofAt;
    }
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  async confirmTargetPromptDelivery(runId, proof = {}, options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    const changed = [];
    if (!run) return { confirmed: false, reason: 'run-not-found', changed };
    if (proof.targetTabId !== run.targetTabId) {
      return { confirmed: false, reason: 'target-tab-mismatch', run: publicRun(run), changed };
    }
    const expectedHandoffId = ORCHESTRATION_TARGET_HANDOFF_PREFIX + run.runId;
    const expectedSource = ORCHESTRATION_TARGET_SOURCE_PREFIX + run.sourceTabId;
    if (proof.handoffId !== expectedHandoffId
      || canonicalPromptAuditSource(proof.source) !== expectedSource) {
      return { confirmed: false, reason: 'target-prompt-identity-mismatch', run: publicRun(run), changed };
    }
    // promptHash is the full transcript lookup identity (SHA-256). PasteAudit
    // emits a separate short transport identity. Comparing those two domains
    // made every real audit fail even though unit fixtures used equal strings.
    const targetPromptProof = run.targetPromptAuditHash
      ? agentPromptAuditMatchesHash(run.targetPromptAuditHash, {
          ...proof,
          provider: proof.toolType || run.targetToolType,
        })
      : { matches: false };
    if (!run.targetPromptAuditHash || targetPromptProof.matches !== true) {
      return { confirmed: false, reason: 'target-prompt-hash-mismatch', run: publicRun(run), changed };
    }
    if (proof.toolType && run.targetToolType && proof.toolType !== run.targetToolType) {
      return { confirmed: false, reason: 'target-tool-mismatch', run: publicRun(run), changed };
    }
    if (run.targetPromptProofAt) {
      const sameProof = proof.actualHash === run.targetPromptProofHash
        && proof.expectedHash === run.targetPromptProofExpectedHash
        && (!proof.userUuid || !run.targetPromptProofUserUuid || proof.userUuid === run.targetPromptProofUserUuid);
      if (!sameProof) {
        return {
          confirmed: false,
          idempotent: false,
          reason: 'target-prompt-proof-conflict',
          run: publicRun(run),
          changed,
        };
      }
      const contextBinding = run.resumeAwaitingNewTurn === true
        ? {
            changed: false,
            contextBound: false,
            contextReason: 'resumed-turn-not-started',
          }
        : bindPromptProofExecutionContext(run, proof);
      if (contextBinding.changed) {
        run.updatedAt = Date.now();
        this._pushChanged(changed, run);
        this._schedulePersist();
      }
      return {
        confirmed: true,
        idempotent: true,
        reason: null,
        contextBound: contextBinding.contextBound,
        contextReason: contextBinding.contextReason,
        run: publicRun(run),
        changed,
      };
    }
    const parsedAuditAt = Date.parse(String(proof.auditTimestamp || ''));
    const requestedNow = Number(options.now);
    const now = Number.isFinite(requestedNow)
      ? requestedNow
      : (Number.isFinite(parsedAuditAt) ? parsedAuditAt : Date.now());
    run.targetPromptProofAt = now;
    run.targetPromptProofKind = 'prompt-audit';
    run.targetPromptProofHash = proof.actualHash;
    run.targetPromptProofExpectedHash = proof.expectedHash;
    run.targetPromptProofCanonicalized = proof.canonicalized === true;
    run.targetPromptProofActualLen = Number.isFinite(proof.actualLen) ? Number(proof.actualLen) : null;
    run.targetPromptProofExpectedLen = Number.isFinite(proof.expectedLen) ? Number(proof.expectedLen) : null;
    run.targetPromptProofSessionId = proof.sessionId || null;
    run.targetPromptProofUserUuid = proof.userUuid || null;
    run.targetPromptProofSourceIdentity = proof.sourceIdentity || null;
    run.deliveryAuditPendingAt = null;
    // A prompt-audit record is itself stronger than the renderer transport
    // reply. In particular it may arrive after that reply timed out, so let
    // the exact record establish the delivery boundary instead of leaving the
    // run forever in `sending` with no accepted timestamp.
    run.deliveryAcceptedAt ||= now;
    // The exact prompt carrier is stronger than the transport return.  Clear
    // the durable unsent payload here as well, because the audit can arrive
    // before markDelivery() resolves.
    run.deliveryIntent = null;
    run.deliveryDispatchFinishedAt ||= now;
    run.sessionId = proof.sessionId || run.sessionId || null;
    const contextBinding = run.resumeAwaitingNewTurn === true
      ? {
          changed: false,
          contextBound: false,
          contextReason: 'resumed-turn-not-started',
        }
      : bindPromptProofExecutionContext(run, proof);

    const repairableUnknownDelivery = run.status === 'waiting_recovery'
      && canExactResultResolveRecovery(run);
    if (repairableUnknownDelivery) {
      run.outcome = null;
      run.error = null;
      run.recoveryDeadlineAt = null;
      run.completionReason = null;
      run.ownCompletedAt = null;
    }

    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    if (!isTerminalStatus(run.status)
      && !isPausedRun(run)
      && run.resumeAwaitingNewTurn !== true
      && run.deliveryAcceptedAt
      && (!predecessor || !ownsTargetExecution(predecessor))) {
      run.waitingForPriorTurn = false;
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= now;
      run.deliveryTransportUnknownAt = null;
      run.deliveryTransportError = null;
    }
    const adoptedChildRunIds = this._adoptExactOrphanChildren(run, changed, now);
    run.updatedAt = now;
    this._pushChanged(changed, run);
    this._schedulePersist();
    return {
      confirmed: true,
      contextBound: contextBinding.contextBound,
      contextReason: contextBinding.contextReason,
      adoptedChildRunIds,
      run: publicRun(run),
      changed,
    };
  }

  async deferDelivery(runId, {
    reason = 'target-busy',
    sessionId = null,
    lifecycleGeneration = null,
    launchGeneration = null,
  } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return publicRun(run);
    if (!run.deliveryIntent) return publicRun(run);
    const now = Date.now();
    run.status = 'queued';
    run.waitingForPriorTurn = true;
    run.deliveryDeferredAt ||= now;
    run.deliveryDeferredReason = reason;
    run.sessionId = sessionId || run.sessionId || null;
    run.targetLifecycleGeneration = lifecycleGeneration || run.targetLifecycleGeneration || null;
    run.targetLaunchGeneration = launchGeneration || run.targetLaunchGeneration || null;
    run.updatedAt = now;
    this._schedulePersist();
    return publicRun(run);
  }

  async claimDeferredDelivery(runId, {
    sessionId = null,
    lifecycleGeneration = null,
    launchGeneration = null,
  } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return { claimed: false, reason: 'run-not-found', run: null, intent: null };
    if (isTerminalStatus(run.status)) {
      return { claimed: false, reason: 'run-settled', run: publicRun(run), intent: null };
    }
    if (!run.deliveryIntent) {
      return { claimed: false, reason: 'delivery-already-crossed-enter', run: publicRun(run), intent: null };
    }
    const predecessor = run.predecessorRunId ? this.runs.get(run.predecessorRunId) : null;
    if (predecessor && (ownsTargetExecution(predecessor) || isResultProofPending(predecessor))) {
      return { claimed: false, reason: 'predecessor-not-materialized', run: publicRun(run), intent: null };
    }
    // A previous process died after the send attempt began but before an exact
    // prompt audit landed.  Replaying automatically could apply the same user
    // intent twice, so restart reconciliation must surface recovery instead.
    if (run.deliveryDispatchStartedAt && !run.targetPromptProofAt) {
      return { claimed: false, reason: 'delivery-outcome-unknown', run: publicRun(run), intent: null };
    }
    const now = Date.now();
    run.status = 'sending';
    run.waitingForPriorTurn = false;
    run.deliveryDispatchStartedAt = now;
    run.deliveryDispatchAttempt = Number(run.deliveryDispatchAttempt || 0) + 1;
    run.deliveryDeferredReason = null;
    run.sessionId = sessionId || run.sessionId || null;
    run.targetLifecycleGeneration = lifecycleGeneration || run.targetLifecycleGeneration || null;
    run.targetLaunchGeneration = launchGeneration || run.targetLaunchGeneration || null;
    run.updatedAt = now;
    // The durable claim is the boundary before PTY Enter. If persistence
    // fails, the caller must not press Enter; a best-effort write would make a
    // restart unable to distinguish "not sent" from "sent once".
    await this.persistStrict();
    return {
      claimed: true,
      reason: null,
      run: publicRun(run),
      intent: { ...run.deliveryIntent },
    };
  }

  async resetDeferredDelivery(runId, reason = 'delivery-not-sent') {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status) || !run.deliveryIntent) return publicRun(run);
    run.status = 'queued';
    run.waitingForPriorTurn = true;
    run.deliveryDispatchStartedAt = null;
    run.deliveryDeferredAt ||= Date.now();
    run.deliveryDeferredReason = reason;
    run.updatedAt = Date.now();
    this._schedulePersist();
    return publicRun(run);
  }

  async markNotification(runId, status, patch = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    // Exact prompt/transcript proof is stronger than the transport's earlier
    // `queued` reply. The reply can resolve after the audit event, so never
    // regress an already materialized source notification back to queued.
    run.notificationStatus = run.sourceFollowupStartedAt
      && ['sending', 'audit-pending', 'sent', 'queued', 'unconfirmed', 'failed', 'waiting-for-input'].includes(status)
      ? 'sent'
      : status;
    Object.assign(run, patch);
    if (status === 'sent' || status === 'queued' || status === 'audit-pending') {
      run.notificationDeliveredAt ||= Date.now();
      run.parentFollowupPending = Boolean(run.parentRunId && run.notifySource !== false);
    } else if (status === 'suppressed') {
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= Date.now();
    }
    this._syncSourceFollowupState(run);
    run.updatedAt = Date.now();
    const changed = [];
    this._pushChanged(changed, run);
    const settled = [];
    this._refreshAncestors(run.parentRunId, changed, settled, Date.now());
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async applyLifecycle(tabId, payload = {}) {
    await this.initialize();
    if (payload.type === 'background-work') {
      const changed = [];
      const settled = [];
      const count = Math.max(0, Number(payload.backgroundWorkCount) || 0);
      const candidates = this._activeForTarget(tabId).filter((run) => (
        run.waitingForInternalDescendants === true
        && run.targetBusySeen !== true
        && (run.internalBackgroundWorkProvider || run.targetToolType) === 'codex'
      ));
      if (candidates.length !== 1) {
        return {
          changed,
          settled,
          completed: [],
          ignored: true,
          ignoreReason: candidates.length === 0
            ? 'background-work-owner-unavailable'
            : 'background-work-owner-ambiguous',
        };
      }
      const run = candidates[0];
      const now = Date.now();
      run.internalBackgroundWorkCount = count;
      run.updatedAt = now;
      if (count === 0) {
        run.waitingForInternalDescendants = false;
        run.ownCompletedAt ||= now;
        run.completionReason ||= 'codex-background-work-complete';
        run.outcome = 'success';
        this._settleSuccessfulRun(run, changed, settled, now);
        this._refreshAncestors(run.parentRunId, changed, settled, now);
      } else {
        this._pushChanged(changed, run);
      }
      this._schedulePersist();
      return {
        changed,
        settled,
        completed: settled.filter((item) => item.status === 'completed'),
      };
    }
    const activityResult = payload.type === 'busy' && payload.busy === true
      ? this._recordTargetActivity(tabId, {
          source: 'lifecycle-busy',
          at: payload.startedAt || Date.now(),
          busy: true,
        })
      : payload.type === 'done' || (payload.type === 'busy' && payload.busy === false)
        ? this._recordTargetActivity(tabId, {
            source: 'lifecycle-idle',
            at: payload.completedAt || Date.now(),
            busy: false,
          })
        : { changed: false };
    if (activityResult.changed) this._schedulePersist();
    const executionContext = lifecycleExecutionContext(payload);
    const internalContinuation = this._internalContinuationForTarget(
      tabId,
      executionContext,
      payload,
    );
    let head = internalContinuation
      || this._headForTarget(tabId, executionContext, payload.type);
    const changed = [];
    const settled = [];
    const now = Date.now();
    const internalContinuationAdopted = Boolean(internalContinuation);

    if (internalContinuation) {
      head.targetContinuationExecutionContext = executionContext;
      head.waitingForInternalDescendants = false;
      head.internalBackgroundWorkCount = Math.max(
        0,
        Number(payload.backgroundWorkCount) || 0,
      );
      head.internalContinuationCountSeen = Number(head.internalContinuationCountSeen || 0) + 1;
      head.updatedAt = now;
      this._pushChanged(changed, head);
    }

    if (!head) {
      const recoveryContinuation = this._interruptedRecoveryForTarget(
        tabId,
        executionContext,
        payload,
      );
      if (recoveryContinuation.run) {
        head = recoveryContinuation.run;
        this._adoptInterruptedRecovery(head, executionContext, payload, changed, now);
      }
    }

    if (!head && this._activeForTarget(tabId).some((run) => run.status === 'waiting_recovery')) {
      return {
        changed,
        settled,
        completed: [],
        ignored: true,
        ignoreReason: 'recovery-continuation-unproven',
      };
    }

    if (head?.deliveryAcceptedAt) {
      const resumedExactStart = head.resumeAwaitingNewTurn === true
        && payload.type === 'busy'
        && payload.busy === true
        && executionContext?.startedAt
        && executionContext.startedAt >= Number(head.resumeAfterAt || head.resumedAt);
      if (resumedExactStart && payload.lifecycleGeneration) {
        // Resume explicitly arms the next future turn. Its exact start may
        // legitimately belong to a process generation created after Resume;
        // only this start edge may replace the old generation. A done edge can
        // never do so, preserving stale-generation recovery safety.
        head.targetLifecycleGeneration = payload.lifecycleGeneration;
      }
      const generationCheck = lifecycleGenerationCheck(head, payload.lifecycleGeneration);
      if (generationCheck.verdict === 'changed') {
        this._beginRecovery(
          head,
          'process_replaced',
          'target process ownership changed: ' + generationCheck.reason,
          changed,
          settled,
          now,
        );
        head.observedLifecycleGeneration = payload.lifecycleGeneration || null;
        head.updatedAt = now;
        this._refreshAncestors(head.parentRunId, changed, settled, now);
        this._schedulePersist();
        return {
          changed,
          settled,
          completed: [],
          ignored: false,
          generationVerdict: generationCheck.verdict,
          expectedLifecycleGeneration: head.targetLifecycleGeneration || null,
          observedLifecycleGeneration: payload.lifecycleGeneration || null,
        };
      }
      if (generationCheck.verdict === 'unknown') {
        return {
          changed,
          settled,
          completed: [],
          ignored: true,
          generationVerdict: generationCheck.verdict,
          ignoreReason: generationCheck.reason,
          expectedLifecycleGeneration: head.targetLifecycleGeneration || null,
          observedLifecycleGeneration: payload.lifecycleGeneration || null,
        };
      }
      const sessionId = payload.sessionId || head.sessionId || null;
      if (payload.type === 'busy' && payload.busy === true) {
        if (!head.waitingForPriorTurn) {
          // A generic busy edge cannot identify which completion notification
          // started this turn. A waiting parent is reopened only by the exact
          // PasteAudit/transcript proof in confirmSourceFollowup().
          if (head.status === 'waiting_descendants') {
            return { changed, settled, completed: [] };
          }
          // A generic busy edge proves only that the tab is working again. It
          // does not prove that this turn continues the interrupted delegation.
          // Automatic continuation is handled earlier from an exact new-turn
          // execution context; explicit recovery can also re-arm the run.
          if (head.status === 'waiting_recovery' || head.outcome) {
            return {
              changed,
              settled,
              completed: [],
              ignored: true,
              ignoreReason: 'recovery-continuation-unproven',
            };
          }
          head.targetBusySeen = true;
          head.status = 'running';
          head.resumeAwaitingNewTurn = false;
          head.resumedTurnStartedAt = executionContext?.startedAt || now;
          head.startedAt ||= now;
          head.sessionId = sessionId;
          if (!head.targetExecutionContext) {
            head.targetExecutionContext = executionContext || null;
          } else if (internalContinuationAdopted) {
            head.targetContinuationExecutionContext = executionContext;
          }
          head.updatedAt = now;
          this._pushChanged(changed, head);
        }
      } else if (payload.type === 'done') {
        if (head.waitingForPriorTurn) {
          head.waitingForPriorTurn = false;
          head.status = 'queued';
          head.updatedAt = now;
          this._pushChanged(changed, head);
        } else if (head.targetBusySeen) {
          const outcome = outcomeForReason(payload.reason);
          head.targetBusySeen = false;
          head.sessionId = sessionId;
          const backgroundWorkCount = Math.max(0, Number(payload.backgroundWorkCount) || 0);
          const provider = head.targetToolType
            || executionContext?.provider
            || normalizeExecutionContext(head.targetExecutionContext)?.provider
            || null;
          const promptProofMissing = head.requiresTargetPromptProof === true
            && !head.targetPromptProofAt;
          if (outcome === 'success' && promptProofMissing) {
            head.ownCompletedAt = now;
            head.completionReason = payload.reason || 'turn-complete-without-prompt-proof';
            this._beginRecovery(
              head,
              'unknown',
              'delivery outcome is unknown: target turn ended before exact prompt proof',
              changed,
              settled,
              now,
            );
          } else if (outcome === 'success' && backgroundWorkCount > 0) {
            head.status = 'running';
            head.outcome = null;
            head.ownCompletedAt = null;
            head.completionReason = null;
            head.waitingForInternalDescendants = true;
            head.internalBackgroundWorkCount = backgroundWorkCount;
            head.internalBackgroundWorkProvider = provider;
            head.internalContinuationBaseline = Number(head.internalContinuationCountSeen || 0);
            head.internalTurnStoppedAt = now;
            head.updatedAt = now;
            this._pushChanged(changed, head);
          } else if (outcome === 'success') {
            head.waitingForInternalDescendants = false;
            head.internalBackgroundWorkCount = backgroundWorkCount;
            head.ownCompletedAt = now;
            head.completionReason = payload.reason || 'turn-complete';
            head.outcome = 'success';
            this._settleSuccessfulRun(head, changed, settled, now);
          } else {
            head.waitingForInternalDescendants = false;
            head.internalBackgroundWorkCount = backgroundWorkCount;
            head.ownCompletedAt = now;
            head.completionReason = payload.reason || 'turn-complete';
            this._beginRecovery(head, outcome, payload.reason || 'target turn aborted', changed, settled, now);
          }
          this._refreshAncestors(head.parentRunId, changed, settled, now);
        }
      }
    }

    if (changed.length) this._schedulePersist();
    return {
      changed,
      settled,
      completed: settled.filter((run) => run.status === 'completed'),
    };
  }

  async confirmSourceFollowup(runId, proof = {}, options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    const changed = [];
    const settled = [];
    if (!run) return { confirmed: false, reason: 'run-not-found', changed, settled };
    if (run.sourceFollowupStartedAt) {
      return { confirmed: true, idempotent: true, run: publicRun(run), changed, settled };
    }
    if (!isTerminalStatus(run.status) || !canNotifySource(run)) {
      return { confirmed: false, reason: 'run-not-awaiting-source-followup', run: publicRun(run), changed, settled };
    }
    this._syncSourceFollowupState(run);
    if (!run.sourceFollowupPending) {
      return { confirmed: false, reason: 'source-followup-not-pending', run: publicRun(run), changed, settled };
    }
    if (!proof.sourceTabId || proof.sourceTabId !== run.sourceTabId) {
      return { confirmed: false, reason: 'source-tab-mismatch', run: publicRun(run), changed, settled };
    }

    const proofKind = proof.kind === 'transcript' ? 'transcript' : 'prompt-audit';
    if (proofKind === 'prompt-audit') {
      const expectedHandoffId = run.notificationHandoffId
        || ORCHESTRATION_COMPLETION_HANDOFF_PREFIX + run.runId;
      const expectedSource = ORCHESTRATION_COMPLETION_SOURCE_PREFIX + run.runId;
      if (proof.handoffId !== expectedHandoffId
        || canonicalPromptAuditSource(proof.source) !== expectedSource) {
        return { confirmed: false, reason: 'notification-identity-mismatch', run: publicRun(run), changed, settled };
      }
      const notificationPromptProof = run.notificationPromptAuditHash
        ? agentPromptAuditMatchesHash(run.notificationPromptAuditHash, {
            ...proof,
            provider: proof.toolType || run.sourceToolType,
          })
        : { matches: false };
      if (!run.notificationPromptAuditHash
        || notificationPromptProof.matches !== true) {
        return { confirmed: false, reason: 'notification-prompt-audit-hash-mismatch', run: publicRun(run), changed, settled };
      }
    } else if (!run.notificationPromptHash
      || proof.notificationPromptHash !== run.notificationPromptHash) {
      return { confirmed: false, reason: 'notification-prompt-hash-mismatch', run: publicRun(run), changed, settled };
    }

    const parent = run.parentRunId ? this.runs.get(run.parentRunId) : null;
    const causalParent = parent
      && parent.targetTabId === run.sourceTabId
      && !isTerminalStatus(parent.status)
      && !isPausedRun(parent)
      ? parent
      : null;
    const followupContext = causalParent
      ? sourceFollowupExecutionContext(run, causalParent, proof)
      : { context: null, reason: null };
    if (causalParent && !followupContext.context) {
      // The exact notification record proves only delivery. It cannot consume a
      // child or reopen its parent by tab identity alone; provider/session/turn
      // must identify the new source turn before any durable state is mutated.
      return {
        confirmed: false,
        reason: followupContext.reason,
        contextBound: false,
        run: publicRun(run),
        changed,
        settled,
      };
    }

    const parsedAuditAt = Date.parse(String(proof.auditTimestamp || ''));
    const requestedNow = Number(options.now);
    const now = Number.isFinite(requestedNow)
      ? requestedNow
      : (Number.isFinite(parsedAuditAt) ? parsedAuditAt : Date.now());
    run.sourceFollowupPending = false;
    run.sourceFollowupStartedAt = now;
    run.sourceFollowupProofKind = proofKind;
    run.sourceFollowupSessionId = proof.sessionId || null;
    run.sourceFollowupUserUuid = proof.userUuid || null;
    run.sourceFollowupSourceIdentity = proof.sourceIdentity || null;
    run.sourceFollowupAuditHash = proof.actualHash || null;
    // A causal prompt audit or transcript match proves that the notification
    // has materialized in the source session. `queued` describes only the
    // earlier Enter transport; after exact proof the durable delivery state is
    // unambiguously sent.
    run.notificationStatus = 'sent';
    run.notificationDeliveredAt ||= now;
    run.notificationError = null;
    run.notificationUnconfirmedAt = null;
    run.notificationUnconfirmedReason = null;
    if (run.status === 'completed') run.attentionRequiredAt = null;
    run.updatedAt = now;

    if (parent && parent.targetTabId === run.sourceTabId) {
      run.parentConsumedAt = now;
      run.parentFollowupPending = false;
      const sameParentTurn = followupContext.disposition === 'same-active-turn'
        || followupContext.disposition === 'same-settled-turn';
      if (causalParent && !sameParentTurn) {
        parent.resultPromptHash = run.notificationPromptHash || parent.resultPromptHash || null;
        parent.resultPromptProofUserUuid = proof.userUuid || parent.resultPromptProofUserUuid || null;
        parent.resultPromptProofSourceIdentity = proof.sourceIdentity
          || parent.resultPromptProofSourceIdentity
          || null;
        parent.resultAfterAt = null;
        parent.resultPromptRequestedAt = run.notificationAttemptedAt
          || run.notificationDeliveredAt
          || now;
      }
      if (causalParent && !sameParentTurn) {
        parent.outcome = null;
        parent.ownCompletedAt = null;
        parent.completedAt = null;
        parent.completionReason = null;
        parent.error = null;
        parent.recoveryDeadlineAt = null;
        parent.waitingOnRunIds = this._unresolvedChildren(parent).map((child) => child.runId);
        parent.targetBusySeen = true;
        parent.status = 'running';
        parent.startedAt ||= now;
        parent.sessionId = followupContext.context.sessionId || parent.sessionId || null;
        parent.targetExecutionContext = followupContext.context;
        parent.updatedAt = now;
        this._pushChanged(changed, parent);
      }
      if (causalParent && followupContext.disposition === 'same-settled-turn') {
        // The exact notification and the parent's final response already live
        // inside the same completed provider turn. Consume only the child, then
        // let the ordinary descendant settlement close the parent; reopening
        // would wait for a second task_complete that can never arrive.
        this._refreshAncestors(parent.runId, changed, settled, now);
      }
    }
    this._pushChanged(changed, run);
    this._schedulePersist();
    return {
      confirmed: true,
      contextBound: Boolean(followupContext.context),
      contextDisposition: followupContext.disposition || null,
      run: publicRun(run),
      changed,
      settled,
    };
  }

  async reconcile(runId, observation = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) return { changed: null, completed: false, settled: [] };
    const changed = [];
    const settled = [];
    const resultFound = observation.resultFound === true;
    const resultComplete = observation.resultComplete === true;
    const resultInternalContinuationCount = Math.max(
      0,
      Number(observation.internalContinuationCount) || 0,
    );
    const internalContinuationAdvanced = resultInternalContinuationCount
      > Number(run?.internalContinuationBaseline || 0);
    const resultCompletionBlockedByInternalWork = run?.waitingForInternalDescendants === true
      && !internalContinuationAdvanced;
    const effectiveResultComplete = resultComplete
      && !resultCompletionBlockedByInternalWork;
    const resultTerminalEvent = typeof observation.resultTerminalEvent === 'string'
      ? observation.resultTerminalEvent.trim()
      : '';
    const resultTerminalReason = typeof observation.resultTerminalReason === 'string'
      ? observation.resultTerminalReason.trim()
      : '';
    const resultHasFinalResult = observation.resultHasFinalResult === true;
    const terminalFailureReason = resultFound && resultTerminalEvent === 'turn_aborted'
      ? (resultTerminalReason || 'turn_aborted')
      : resultFound
        && resultTerminalEvent === 'task_complete'
        && resultHasFinalResult !== true
        ? (resultTerminalReason || 'codex-no-final-result')
        : '';
    const busy = observation.busy === true;
    const now = Date.now();
    const generationCheck = lifecycleGenerationCheck(run, observation.lifecycleGeneration);

    if (isPausedRun(run) || run.resumeAwaitingNewTurn === true) {
      return {
        changed: null,
        completed: false,
        settled,
        ignored: true,
        ignoreReason: isPausedRun(run) ? 'orchestration-paused' : 'resumed-turn-not-started',
      };
    }

    if (terminalFailureReason) {
      // Exact transcript proof of an aborted provider turn closes the identity
      // question, but it is never success proof. Preserve a stronger recovery
      // outcome already observed (provider_error/process exit/etc.); otherwise
      // recover as an interrupted turn even if the volatile lifecycle edge was
      // missed before restart.
      if (run.status !== 'waiting_recovery') {
        run.resultAvailable = observation.resultAvailable !== false;
        run.resultTurnIndex = Number.isInteger(observation.turnIndex)
          ? observation.turnIndex
          : run.resultTurnIndex;
        this._beginRecovery(
          run,
          outcomeForReason(terminalFailureReason),
          terminalFailureReason,
          changed,
          settled,
          now,
        );
        this._refreshAncestors(run.parentRunId, changed, settled, now);
      }
    } else if (resultFound && effectiveResultComplete && !canExactResultResolveRecovery(run)) {
      // Provider failure, explicit interruption and startup failure are durable
      // recovery decisions. A later result from the same still-running process
      // cannot silently rewrite them as success; only an explicit recovery can
      // arm a new turn. Ownership-only recovery (closed/replaced/exited target)
      // and an unknown transport remain repairable by exact transcript proof.
      return {
        changed: publicRun(run),
        completed: false,
        settled,
        ignored: true,
        ignoreReason: 'recovery-requires-explicit-resolution',
      };
    } else if (resultFound && effectiveResultComplete) {
      run.waitingForPriorTurn = false;
      run.waitingForInternalDescendants = false;
      run.internalBackgroundWorkCount = 0;
      run.internalContinuationCountSeen = Math.max(
        Number(run.internalContinuationCountSeen || 0),
        resultInternalContinuationCount,
      );
      run.targetBusySeen = true;
      run.resultAvailable = observation.resultAvailable !== false;
      run.resultTurnIndex = Number.isInteger(observation.turnIndex) ? observation.turnIndex : run.resultTurnIndex;
      if (busy) {
        run.status = 'running';
        run.startedAt ||= now;
      } else {
        run.targetBusySeen = false;
        run.outcome = 'success';
        run.ownCompletedAt ||= now;
        run.completionReason ||= 'recovered-from-transcript';
        this._settleSuccessfulRun(run, changed, settled, now);
      }
    } else if (generationCheck.verdict === 'changed') {
      if (run.status !== 'waiting_recovery') {
        this._beginRecovery(
          run,
          'process_replaced',
          'target process ownership changed: ' + generationCheck.reason,
          changed,
          settled,
          now,
        );
        this._refreshAncestors(run.parentRunId, changed, settled, now);
      }
      run.observedLifecycleGeneration = observation.lifecycleGeneration || null;
      run.updatedAt = now;
    } else if (generationCheck.verdict === 'unknown') {
      // An unavailable process observation is neither a match nor proof that
      // ownership changed. Keep the existing run untouched until an exact
      // generation or transcript result arrives.
    } else if (busy && !run.waitingForPriorTurn && run.status !== 'waiting_descendants') {
      if (run.status === 'waiting_recovery') {
        return {
          changed: publicRun(run),
          completed: false,
          generationVerdict: generationCheck.verdict,
          ignored: true,
          ignoreReason: 'recovery-continuation-unproven',
        };
      }
      run.targetBusySeen = true;
      run.status = 'running';
      run.startedAt ||= now;
      this._pushChanged(changed, run);
    }
    const canAdoptObservedSession = (resultFound
        && (effectiveResultComplete || terminalFailureReason))
      || generationCheck.verdict === 'match'
      || generationCheck.verdict === 'not-required';
    if (observation.sessionId && canAdoptObservedSession) {
      run.sessionId = observation.sessionId;
    }
    run.updatedAt = now;
    this._schedulePersist();
    return {
      changed: publicRun(run),
      completed: settled.some((item) => item.runId === run.runId && item.status === 'completed'),
      settled,
      generationVerdict: generationCheck.verdict,
    };
  }

  async markResultProofUnavailable(runId, reason = 'exact result proof is unavailable', options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || !isResultProofPending(run)) {
      return {
        run: publicRun(run),
        changed: [],
        settled: [],
        resolved: false,
      };
    }

    const now = Number(options.now) || Date.now();
    const changed = [];
    const settled = [];
    run.status = 'failed';
    run.outcome = 'result_unavailable';
    run.error = reason;
    run.resultProofStatus = 'unavailable';
    run.resultProofUnavailableAt = now;
    run.resultError ||= reason;
    run.resultErrorCode = options.errorCode || RESULT_PROOF_CODES.RESULT_UNAVAILABLE;
    run.deliveryIntent = null;
    run.recoveryDeadlineAt = null;
    if (canNotifySource(run)) {
      run.notificationStatus = 'pending';
      run.notificationError = null;
    } else if (run.notificationSuppressed) {
      run.notificationStatus = 'suppressed';
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
    settled.push(publicRun(run));
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return {
      run: publicRun(run),
      changed,
      settled,
      resolved: true,
    };
  }

  async markResultProofTerminalFailure(runId, reason, options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || !isResultProofPending(run)) {
      return {
        run: publicRun(run),
        changed: [],
        settled: [],
        resolved: false,
      };
    }

    const failureReason = String(reason || 'exact provider turn ended without a final result');
    const now = Number(options.now) || Date.now();
    const changed = [];
    const settled = [];
    run.status = 'failed';
    run.outcome = options.outcome || outcomeForReason(failureReason);
    run.error = failureReason;
    run.resultComplete = false;
    run.resultAvailable = options.resultAvailable === true;
    run.resultTurnIndex = Number.isInteger(options.turnIndex)
      ? options.turnIndex
      : run.resultTurnIndex;
    run.resultUserUuid = options.userUuid || run.resultUserUuid || null;
    run.resultProofStatus = 'failed';
    run.resultError = failureReason;
    run.resultErrorCode = options.errorCode || RESULT_PROOF_CODES.RESULT_UNAVAILABLE;
    run.deliveryIntent = null;
    run.recoveryDeadlineAt = null;
    if (canNotifySource(run)) {
      run.notificationStatus = 'pending';
      run.notificationError = null;
    } else if (run.notificationSuppressed) {
      run.notificationStatus = 'suppressed';
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
    settled.push(publicRun(run));
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return {
      run: publicRun(run),
      changed,
      settled,
      resolved: true,
    };
  }

  async handleTargetClosed(tabId, { now = Date.now(), failureGraceMs } = {}) {
    await this.initialize();
    const changed = [];
    const settled = [];
    for (const run of this._activeForTarget(tabId)) {
      this._beginRecovery(
        run,
        'target_closed',
        'target tab closed',
        changed,
        settled,
        now,
        failureGraceMs,
      );
      this._refreshAncestors(run.parentRunId, changed, settled, now);
    }
    if (changed.length) this._schedulePersist();
    return changed;
  }

  async beginRecovery(runId, outcome = 'failed', reason = 'agent run failed', options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || isTerminalStatus(run.status)) {
      return { changed: run ? [publicRun(run)] : [], settled: [] };
    }
    const now = Number(options.now) || Date.now();
    const changed = [];
    const settled = [];
    this._beginRecovery(run, outcome, reason, changed, settled, now, options.failureGraceMs);
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { changed, settled };
  }

  async beginResultProofRecovery(runId, reason = 'result proof deadline elapsed', options = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || run.status !== 'completed' || run.resultComplete === true) {
      return { changed: [], settled: [], run: publicRun(run) };
    }
    const now = Number(options.now) || Date.now();
    const changed = [];
    const settled = [];
    run.completedAt = null;
    run.resultProofDeadlineAt = null;
    run.resultErrorCode = options.errorCode || RESULT_PROOF_CODES.RESULT_PROOF_DEADLINE;
    this._beginRecovery(
      run,
      'failed',
      reason,
      changed,
      settled,
      now,
      options.failureGraceMs,
    );
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { changed, settled, run: publicRun(run) };
  }

  async handleSourceClosed(tabId) {
    await this.initialize();
    const changed = [];
    const now = Date.now();
    for (const run of this.runs.values()) {
      if (run.sourceTabId !== tabId) continue;
      this._syncSourceFollowupState(run);
      if (['suppressed', 'source-closed'].includes(run.notificationStatus)) continue;
      // `sent`/`queued` means only that Enter was attempted. Until exact
      // prompt-audit/transcript proof arrives, closing the source makes that
      // handoff impossible to consume and must release the inherited blocker.
      if (['sent', 'queued'].includes(run.notificationStatus)
        && (run.sourceFollowupStartedAt || run.sourceFollowupPending !== true)) continue;
      run.notificationStatus = 'source-closed';
      run.notificationSuppressed = true;
      run.sourceFollowupPending = false;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    }
    if (changed.length) this._schedulePersist();
    return changed;
  }

  async resolveRecovery(runId, action, proof = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || run.status !== 'waiting_recovery') {
      return { run: publicRun(run), changed: [], settled: [] };
    }
    const now = Date.now();
    const changed = [];
    const settled = [];
    if (action === 'dismiss') {
      run.status = 'cancelled';
      run.deliveryIntent = null;
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
    } else if (action === 'report') {
      run.status = 'failed';
      run.deliveryIntent = null;
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'pending';
      run.notificationSuppressed = false;
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
    } else if (action === 'reopen' || action === 'resume') {
      const resumingPause = action === 'resume' && run.outcome === 'paused';
      if (action === 'resume' && !resumingPause) {
        throw new Error('run is not paused');
      }
      const continuationAfterAt = resumingPause ? now : (run.ownCompletedAt || now);
      const retryingUndeliveredIntent = Boolean(run.deliveryIntent);
      run.status = 'queued';
      run.resultPromptHash = null;
      run.resultPromptProofUserUuid = null;
      run.resultPromptProofSourceIdentity = null;
      run.resultAfterAt = retryingUndeliveredIntent ? null : continuationAfterAt;
      run.resultPromptRequestedAt = retryingUndeliveredIntent ? null : continuationAfterAt;
      run.resultComplete = false;
      run.resultAvailable = false;
      run.resultTurnIndex = null;
      run.resultUserUuid = null;
      run.resultError = null;
      run.resultErrorCode = null;
      run.resultProofStatus = resumingPause ? 'awaiting-resumed-turn' : run.resultProofStatus;
      run.outcome = null;
      run.ownCompletedAt = null;
      run.completedAt = null;
      run.completionReason = null;
      run.recoveryDeadlineAt = null;
      run.error = null;
      run.targetBusySeen = false;
      run.waitingForPriorTurn = false;
      run.resumeAwaitingNewTurn = resumingPause;
      run.resumeAfterAt = resumingPause ? now : null;
      run.resumedAt = resumingPause ? now : run.resumedAt;
      run.resumedTurnStartedAt = null;
      run.lastPausedAt = resumingPause ? run.pausedAt : run.lastPausedAt;
      run.pausedAt = null;
      run.sessionId = proof.sessionId || run.sessionId || null;
      run.targetLifecycleGeneration = proof.lifecycleGeneration
        || run.targetLifecycleGeneration
        || null;
      run.targetExecutionContext = normalizeExecutionContext(proof.executionContext);
      run.recoveryAttempt = (run.recoveryAttempt || 0) + 1;
      run.recoveryReopenedAt = now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    } else if (action === 'wait') {
      run.recoveryDeadlineAt = null;
      run.recoveryWaitStartedAt = now;
      run.updatedAt = now;
      this._pushChanged(changed, run);
    } else {
      throw new Error('unsupported recovery action');
    }
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async pause(runId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return { run: null, changed: [], settled: [], paused: false };
    if (isPausedRun(run)) {
      return { run: publicRun(run), changed: [], settled: [], paused: true, idempotent: true };
    }
    const established = Boolean(run.deliveryAcceptedAt || run.targetPromptProofAt);
    const pausableRecovery = run.status === 'waiting_recovery' && run.outcome === 'interrupted';
    const pausableExecution = isActiveStatus(run.status)
      && run.status !== 'waiting_recovery'
      && established;
    if (!pausableRecovery && !pausableExecution && !isResultProofPending(run)) {
      return { run: publicRun(run), changed: [], settled: [], paused: false };
    }
    if (run.sourceFollowupStartedAt || run.sourceFollowupPending === true) {
      return { run: publicRun(run), changed: [], settled: [], paused: false };
    }

    const now = Date.now();
    const changed = [];
    const settled = [];
    run.pausePreviousStatus = run.status;
    run.status = 'waiting_recovery';
    run.outcome = 'paused';
    run.pausedAt = now;
    run.resumeAwaitingNewTurn = false;
    run.resumeAfterAt = null;
    run.completedAt = null;
    run.recoveryDeadlineAt = null;
    run.error = null;
    run.resultError = null;
    run.resultErrorCode = null;
    run.resultProofStatus = 'paused';
    run.targetBusySeen = false;
    run.waitingForPriorTurn = false;
    run.notificationStatus = 'pending';
    run.notificationSuppressed = false;
    run.updatedAt = now;
    this._pushChanged(changed, run);
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled, paused: true };
  }

  async cancel(runId, {
    reason = 'cancelled-by-api',
    suppressNotification = true,
    outcome = 'interrupted',
  } = {}) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run || (isTerminalStatus(run.status) && !isResultProofPending(run))) {
      return { run: publicRun(run), changed: [], settled: [] };
    }
    const now = Date.now();
    const changed = [];
    const settled = [];
    run.status = 'cancelled';
    run.deliveryIntent = null;
    run.outcome = outcome;
    run.completedAt = now;
    run.completionReason = reason;
    run.recoveryDeadlineAt = null;
    if (suppressNotification) {
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
    settled.push(publicRun(run));
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled };
  }

  async expireRecoveryDeadlines(now = Date.now()) {
    await this.initialize();
    const changed = [];
    const settled = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'waiting_recovery' || !run.recoveryDeadlineAt || run.recoveryDeadlineAt > now) continue;
      run.status = 'failed';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      run.notificationStatus = 'pending';
      run.updatedAt = now;
      this._pushChanged(changed, run);
      settled.push(publicRun(run));
      this._refreshAncestors(run.parentRunId, changed, settled, now);
    }
    if (changed.length) this._schedulePersist();
    return { changed, settled, completed: [] };
  }

  async nextRecoveryDeadline() {
    await this.initialize();
    let next = null;
    for (const run of this.runs.values()) {
      if (run.status !== 'waiting_recovery' || !run.recoveryDeadlineAt) continue;
      if (next === null || run.recoveryDeadlineAt < next) next = run.recoveryDeadlineAt;
    }
    return next;
  }

  async get(runId) {
    await this.initialize();
    return publicRun(this.runs.get(runId));
  }

  async getInternal(runId) {
    await this.initialize();
    return this.runs.get(runId) || null;
  }

  async acknowledge(runId, tabId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return null;
    const now = Date.now();
    if (run.sourceTabId === tabId) {
      run.sourceAcknowledgedAt = now;
    }
    if (run.targetTabId === tabId) {
      run.targetAcknowledgedAt = now;
    }
    run.updatedAt = now;
    this._schedulePersist();
    return publicRun(run);
  }

  async dismissAttention(runId, tabId) {
    await this.initialize();
    const run = this.runs.get(runId);
    if (!run) return { run: null, changed: [], settled: [], dismissed: false };
    if (run.sourceTabId !== tabId && run.targetTabId !== tabId) {
      return { run: publicRun(run), changed: [], settled: [], dismissed: false };
    }

    const now = Date.now();
    const changed = [];
    const settled = [];
    if (run.sourceTabId === tabId) {
      run.sourceAcknowledgedAt = now;
      run.sourceAttentionDismissedAt = now;
    }
    if (run.targetTabId === tabId) {
      run.targetAcknowledgedAt = now;
      run.targetAttentionDismissedAt = now;
    }

    // Closing a source-side delivery error is an explicit decision not to inject
    // that old completion into the composer. Persist it and release descendants.
    if (run.sourceTabId === tabId && isSourceNotificationBlocked(run)) {
      run.notificationStatus = 'suppressed';
      run.notificationSuppressed = true;
      run.notificationDismissedAt = now;
      run.parentFollowupPending = false;
      run.parentConsumedAt ||= now;
    }

    run.updatedAt = now;
    this._pushChanged(changed, run);
    this._refreshAncestors(run.parentRunId, changed, settled, now);
    this._schedulePersist();
    return { run: publicRun(run), changed, settled, dismissed: true };
  }

  async listForTab(tabId, { activeOnly = false } = {}) {
    await this.initialize();
    return Array.from(this.runs.values())
      .filter((run) => run.sourceTabId === tabId || run.targetTabId === tabId)
      .filter((run) => !activeOnly || isTrackedOrchestrationRun(run))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicRun);
  }

  async listActive() {
    await this.initialize();
    return Array.from(this.runs.values())
      .filter(isTrackedOrchestrationRun)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map(publicRun);
  }

  async listAll() {
    await this.initialize();
    return Array.from(this.runs.values())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(publicRun);
  }

  async getSettings() {
    await this.initialize();
    return { ...this.settings };
  }

  async updateSettings(patch = {}) {
    await this.initialize();
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.settings = normalizeSettings({ ...this.settings, ...definedPatch });
    this._schedulePersist();
    return { ...this.settings };
  }

  async flush() {
    await this.persistChain;
  }

  async persistStrict() {
    await this._enqueuePersist(true);
  }

  _activeForTarget(tabId) {
    return Array.from(this.runs.values())
      .filter((run) => run.targetTabId === tabId && isActiveStatus(run.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _executionsForTarget(tabId) {
    return Array.from(this.runs.values())
      .filter((run) => run.targetTabId === tabId && ownsTargetExecution(run))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _deliveryPredecessorsForTarget(tabId) {
    return Array.from(this.runs.values())
      .filter((run) => run.targetTabId === tabId
        && (ownsTargetExecution(run) || isResultProofPending(run)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _headForTarget(tabId, executionContext = null, lifecycleType = null) {
    const executions = this._executionsForTarget(tabId);
    const eligible = executions.filter((run) => {
      if (!run.predecessorRunId) return true;
      const predecessor = this.runs.get(run.predecessorRunId);
      return !predecessor || !ownsTargetExecution(predecessor);
    }).filter((run) => {
      if (run.resumeAwaitingNewTurn !== true) return true;
      if (lifecycleType !== 'busy') return false;
      const exactContext = normalizeExecutionContext(executionContext);
      const resumeAfterAt = Number(run.resumeAfterAt || run.resumedAt);
      return Boolean(exactContext?.startedAt
        && Number.isFinite(resumeAfterAt)
        && exactContext.startedAt >= resumeAfterAt);
    });
    if (executionContext) {
      const exact = eligible.filter((run) => (
        runExecutionContextMatches(run, executionContext)
      ));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;

      // A busy edge starts/binds a previously unbound target execution. A done
      // edge never does: it can belong to an older process generation and must
      // not settle a newer run merely because both reused the same tabId.
      if (lifecycleType !== 'busy') return null;
    }
    const candidates = executionContext
      ? eligible.filter((run) => (
          !normalizeExecutionContext(run.targetExecutionContext)
          && lifecycleType === 'busy'
        ))
      : eligible;
    for (const run of candidates) {
      return run;
    }
    return null;
  }

  _internalContinuationForTarget(tabId, executionContext, payload = {}) {
    if (payload.type !== 'busy'
      || payload.busy !== true
      || !payload.internalAgentContinuation) return null;
    const exactContext = normalizeExecutionContext(executionContext);
    if (!exactContext?.sessionId) return null;
    const candidates = this._executionsForTarget(tabId).filter((run) => {
      if (run.waitingForInternalDescendants !== true || run.targetBusySeen === true) return false;
      if (run.targetToolType && run.targetToolType !== exactContext.provider) return false;
      if (!executionContextOwnersMatch(run.targetExecutionContext, exactContext)) return false;
      const generationCheck = lifecycleGenerationCheck(run, payload.lifecycleGeneration);
      return generationCheck.verdict === 'match'
        || generationCheck.verdict === 'not-required';
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  _interruptedRecoveryForTarget(tabId, executionContext, payload = {}) {
    if (payload.type !== 'busy' || payload.busy !== true) {
      return { run: null, reason: 'recovery-continuation-not-a-start' };
    }
    const exactContext = normalizeExecutionContext(executionContext);
    if (!exactContext?.sessionId) {
      return { run: null, reason: 'recovery-continuation-context-unproven' };
    }
    const candidates = this._activeForTarget(tabId).filter((run) => {
      if (run.status !== 'waiting_recovery'
        || run.outcome !== 'interrupted'
        || !run.deliveryAcceptedAt
        || run.deliveryIntent) return false;
      if (run.targetToolType && run.targetToolType !== exactContext.provider) return false;
      const previousContext = normalizeExecutionContext(run.targetExecutionContext);
      if (previousContext && executionContextsMatch(previousContext, exactContext)) return false;
      const expectedSessionId = previousContext?.sessionId
        || run.sessionId
        || run.targetPromptProofSessionId
        || null;
      if (expectedSessionId && expectedSessionId !== exactContext.sessionId) return false;
      const generationCheck = lifecycleGenerationCheck(run, payload.lifecycleGeneration);
      return generationCheck.verdict === 'match'
        || generationCheck.verdict === 'not-required';
    });
    if (candidates.length !== 1) {
      return {
        run: null,
        reason: candidates.length > 1
          ? 'recovery-continuation-ambiguous'
          : 'recovery-continuation-unproven',
      };
    }
    return { run: candidates[0], reason: null };
  }

  _adoptInterruptedRecovery(run, executionContext, payload, changed, now) {
    const continuationAfterAt = run.ownCompletedAt || run.updatedAt || now;
    run.status = 'running';
    run.resultPromptHash = null;
    run.resultPromptProofUserUuid = null;
    run.resultPromptProofSourceIdentity = null;
    run.resultAfterAt = continuationAfterAt;
    run.resultPromptRequestedAt = continuationAfterAt;
    run.outcome = null;
    run.ownCompletedAt = null;
    run.completedAt = null;
    run.completionReason = null;
    run.recoveryDeadlineAt = null;
    run.error = null;
    run.resultError = null;
    run.resultErrorCode = null;
    run.targetBusySeen = true;
    run.waitingForPriorTurn = false;
    run.sessionId = executionContext.sessionId || payload.sessionId || run.sessionId || null;
    run.targetLifecycleGeneration = payload.lifecycleGeneration
      || run.targetLifecycleGeneration
      || null;
    run.targetExecutionContext = normalizeExecutionContext(executionContext);
    run.recoveryAttempt = Number(run.recoveryAttempt || 0) + 1;
    run.recoveryReopenedAt = now;
    run.recoveryContinuedAutomatically = true;
    run.updatedAt = now;
    this._pushChanged(changed, run);
  }

  _inferParentRunId(sourceTabId, sourceExecutionContext) {
    if (!sourceTabId || !sourceExecutionContext) return null;
    const matches = Array.from(this.runs.values()).filter((run) => (
      run.targetTabId === sourceTabId
      && !isTerminalStatus(run.status)
      && !isPausedRun(run)
      && run.resumeAwaitingNewTurn !== true
      && (run.requiresTargetPromptProof !== true || !!run.targetPromptProofAt)
      && executionContextsMatch(run.targetExecutionContext, sourceExecutionContext)
    ));
    return matches.length === 1 ? matches[0].runId : null;
  }

  _adoptExactOrphanChildren(parent, changed, now = Date.now()) {
    if (!parent
      || isTerminalStatus(parent.status)
      || isPausedRun(parent)
      || parent.resumeAwaitingNewTurn === true
      || (parent.requiresTargetPromptProof === true && !parent.targetPromptProofAt)) return [];
    const parentContext = normalizeExecutionContext(parent.targetExecutionContext);
    if (!parentContext) return [];
    const adopted = [];
    for (const child of this.runs.values()) {
      if (child.runId === parent.runId
        || child.parentRunId
        || child.sourceTabId !== parent.targetTabId
        || !executionContextsMatch(child.sourceExecutionContext, parentContext)) continue;
      child.parentRunId = parent.runId;
      child.updatedAt = now;
      adopted.push(child.runId);
      this._pushChanged(changed, child);
    }
    return adopted;
  }

  _validateParent(parentRunId, input) {
    const parent = this.runs.get(parentRunId);
    if (!parent) throw new Error('parent run not found');
    if (parent.runId === input.runId) throw new Error('run cannot parent itself');
    if (isTerminalStatus(parent.status)) throw new Error('parent run is already settled');
    if (isPausedRun(parent) || parent.resumeAwaitingNewTurn === true) {
      throw new Error('parent run is paused');
    }
    if (parent.targetTabId !== input.sourceTabId) {
      throw new Error('parent target must be the child source tab');
    }
    let cursor = parent;
    while (cursor?.parentRunId) {
      if (cursor.parentRunId === input.runId) throw new Error('orchestration run cycle');
      cursor = this.runs.get(cursor.parentRunId);
    }
  }

  _children(parentRunId) {
    return Array.from(this.runs.values())
      .filter((run) => run.parentRunId === parentRunId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  _unresolvedChildren(run) {
    if (run.waitForDescendants === false) return [];
    return this._children(run.runId).filter((child) => {
      if (!isTerminalStatus(child.status)) return true;
      if (child.notificationSuppressed || child.notifySource === false || child.sourceTabId === child.targetTabId) return false;
      return !child.parentConsumedAt;
    });
  }

  _settleSuccessfulRun(run, changed, settled, now) {
    const unresolved = this._unresolvedChildren(run);
    run.waitingOnRunIds = unresolved.map((child) => child.runId);
    if (unresolved.length > 0) {
      run.status = 'waiting_descendants';
      run.completedAt = null;
    } else {
      run.status = 'completed';
      run.completedAt = now;
      settled.push(publicRun(run));
    }
    run.updatedAt = now;
    this._pushChanged(changed, run);
  }

  _beginRecovery(run, outcome, reason, changed, settled, now, graceOverride) {
    const graceMs = clampDelay(graceOverride, run.failureGraceMs);
    const manualIgnored = outcome === 'interrupted' && run.reactToManualInterrupt !== true;
    run.status = 'waiting_recovery';
    run.outcome = outcome;
    run.error = String(reason || outcome || 'agent run failed');
    run.ownCompletedAt = now;
    run.completedAt = null;
    run.recoveryDeadlineAt = manualIgnored ? null : now + graceMs;
    run.waitingOnRunIds = [];
    // The process/run generation that owned the interrupted turn is retained as
    // evidence, but recovery itself no longer owns target lifecycle. A late
    // generic done edge must not complete it. A manual interruption can be
    // adopted by an exact later turn; other recovery requires exact proof or an
    // explicit reopen.
    run.targetBusySeen = false;
    run.updatedAt = now;
    if (!manualIgnored && graceMs === 0) {
      run.status = 'failed';
      run.completedAt = now;
      run.recoveryDeadlineAt = null;
      settled.push(publicRun(run));
    }
    this._pushChanged(changed, run);
  }

  _refreshAncestors(parentRunId, changed, settled, now) {
    const visited = new Set();
    let currentId = parentRunId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parent = this.runs.get(currentId);
      if (!parent) break;
      if (parent.outcome === 'success' && !isTerminalStatus(parent.status)) {
        this._settleSuccessfulRun(parent, changed, settled, now);
      }
      currentId = parent.parentRunId;
    }
  }

  _pushChanged(changed, run) {
    if ((run.status === 'failed' || isSourceNotificationBlocked(run)) && !run.attentionRequiredAt) {
      run.attentionRequiredAt = run.updatedAt || Date.now();
    }
    this._syncSourceFollowupState(run);
    const item = publicRun(run);
    const index = changed.findIndex((candidate) => candidate.runId === item.runId);
    if (index === -1) changed.push(item);
    else changed[index] = item;
  }

  _syncSourceFollowupState(run) {
    if (!isTerminalStatus(run?.status)
      || isResultProofPending(run)
      || !canNotifySource(run)
      || run.sourceFollowupStartedAt
      || !SOURCE_FOLLOWUP_RECONCILABLE_STATUSES.has(run.notificationStatus)) {
      run.sourceFollowupPending = false;
      return;
    }
    run.sourceFollowupPending = true;
  }

  _pruneInMemory() {
    const now = Date.now();
    const settled = Array.from(this.runs.values())
      .filter((run) => isTerminalStatus(run.status) && !isTrackedOrchestrationRun(run))
      .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0));
    const keepSettled = new Set(settled
      .filter((run, index) => index < MAX_SETTLED_RUNS && now - (run.completedAt || run.updatedAt || now) <= SETTLED_RETENTION_MS)
      .map((run) => run.runId));
    for (const [runId, run] of this.runs) {
      if (isTerminalStatus(run.status)
        && !isTrackedOrchestrationRun(run)
        && !keepSettled.has(runId)) {
        this.runs.delete(runId);
      }
    }
  }

  _backfillCreatedTargetAutoStops() {
    const latestCompletedByTarget = new Map();
    for (const run of this.runs.values()) {
      if (run.status !== 'completed' || run.targetCreatedByOrchestration !== true) continue;
      const previous = latestCompletedByTarget.get(run.targetTabId);
      if (!previous || Number(run.createdAt || 0) > Number(previous.createdAt || 0)) {
        latestCompletedByTarget.set(run.targetTabId, run);
      }
    }

    let changed = false;
    for (const run of latestCompletedByTarget.values()) {
      if (!shouldScheduleCreatedTargetAutoStop(run)) continue;
      run.autoStopAt = Number(run.completedAt || Date.now()) + run.successAutoStopMs;
      run.autoStopStatus = 'scheduled';
      run.autoStopActivityRevision = this._activityForTarget(run.targetTabId).revision;
      changed = true;
    }
    return changed;
  }

  _schedulePersist() {
    void this._enqueuePersist(false);
  }

  _enqueuePersist(strict) {
    this._pruneInMemory();
    const snapshot = JSON.stringify({
      version: 4,
      settings: this.settings,
      createdTargetTabIds: Array.from(this.createdTargetTabIds),
      targetActivityByTab: Object.fromEntries(this.targetActivityByTab),
      runs: Array.from(this.runs.values()),
    }, null, 2);
    const write = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = this.filePath + '.tmp-' + process.pid;
        await fs.promises.writeFile(tempPath, snapshot, 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      });
    this.persistChain = write.catch((error) => {
        console.warn('[OrchestrationRuns] persist failed:', error?.message || error);
      });
    return strict ? write : this.persistChain;
  }
}

module.exports = {
  OrchestrationRunStore,
  DEFAULT_ORCHESTRATION_SETTINGS,
  isActiveStatus,
  isTerminalStatus,
  isResultProofPending,
  isPausedRun,
  isCompleteOrchestrationResult,
  shouldScheduleCreatedTargetAutoStop,
  shouldRetryWaitingNotificationForSourceLifecycle,
  shouldMarkSourceFollowupUnconfirmed,
  orchestrationTargetRunIdFromAudit,
  orchestrationCompletionRunIdFromAudit,
  orchestrationInstallBlockers,
  mergeActiveLoadersWithOrchestrations,
  hasNewerTargetRun,
  isAbortedReason,
  outcomeForReason,
  buildOrchestrationResultLookup,
  classifyAgentSendReceipt,
  orchestrationSendFailureRecoveryPolicy,
  resolveCausalSourceExecutionContext,
};
