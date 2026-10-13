'use strict';

// A canonical prompt and the physical process which received it are separate
// facts. Use only the existing exact Enter lease, never a later tab snapshot.
function targetInputOwnerFromAudit(runId, record, detail) {
  const lease = record?.inputLease, audit = record?.auditIdentity;
  const context = record?.receipt?.auditExecutionContext;
  if (record?.state !== 'confirmed' || record.provider !== 'codex'
    || record.surface !== 'orchestration' || record.operationKey !== `orchestration-target:${runId}`
    || record.handoffId !== `orchestration:${runId}` || record.tabId !== detail?.tabId
    || record.attemptId !== detail?.sendAttemptId || !record.attemptId
    || audit?.attemptId !== record.attemptId || audit.provider !== 'codex'
    || audit.promptHash !== detail?.actualHash || record.receipt?.actualHash !== audit.promptHash
    || audit.sessionId !== detail?.sessionId || !audit.sessionId
    || (!audit.entryUuid && !audit.sourceIdentity)
    || record.receipt?.exactAuditConfirmed !== true
    || context?.sessionId !== audit.sessionId || context.provider !== 'codex'
    || !context.turnId || context.turnId !== detail?.executionContext?.turnId
    || lease?.version !== 1 || lease.tabId !== record.tabId || lease.provider !== record.provider
    || typeof lease.lifecycleGeneration !== 'string' || !lease.lifecycleGeneration
    || !Number.isSafeInteger(lease.runSeq) || lease.runSeq <= 0) return null;
  return { kind: 'durable-send-enter', operationKey: record.operationKey,
    handoffId: record.handoffId, attemptId: record.attemptId, tabId: record.tabId,
    provider: record.provider, sessionId: audit.sessionId, turnId: context.turnId,
    lifecycleGeneration: lease.lifecycleGeneration, runSeq: lease.runSeq };
}

// Called only after the existing target prompt/hash/context guards accepted
// the proof. A missing generation may be enriched; a known owner never moves.
function bindTargetInputOwner(run, proof, contextBinding) {
  const owner = proof.inputOwner;
  if (!owner) return { changed: false, reason: null };
  if (run.resumeAwaitingNewTurn || !contextBinding.contextBound || contextBinding.contextReason
    || owner.kind !== 'durable-send-enter' || owner.operationKey !== `orchestration-target:${run.runId}`
    || owner.handoffId !== proof.handoffId || owner.tabId !== run.targetTabId
    || owner.provider !== 'codex' || run.targetToolType !== 'codex'
    || !owner.attemptId || owner.sessionId !== proof.sessionId
    || owner.turnId !== run.targetExecutionContext?.turnId
    || typeof owner.lifecycleGeneration !== 'string' || !owner.lifecycleGeneration
    || !Number.isSafeInteger(owner.runSeq) || owner.runSeq <= 0) {
    return { changed: false, reason: 'target-input-owner-proof-mismatch' };
  }
  if (run.targetLifecycleGeneration && run.targetLifecycleGeneration !== owner.lifecycleGeneration) {
    return { changed: false, reason: 'target-input-owner-generation-conflict' };
  }
  if (run.targetLifecycleProof && (run.targetLifecycleProof.attemptId !== owner.attemptId
    || run.targetLifecycleProof.lifecycleGeneration !== owner.lifecycleGeneration)) {
    return { changed: false, reason: 'target-input-owner-attempt-conflict' };
  }
  const changed = !run.targetLifecycleGeneration || !run.targetLifecycleProof;
  run.targetLifecycleGeneration = owner.lifecycleGeneration;
  run.targetLifecycleProof ||= { ...owner };
  return { changed, reason: null };
}

module.exports = { targetInputOwnerFromAudit, bindTargetInputOwner };
