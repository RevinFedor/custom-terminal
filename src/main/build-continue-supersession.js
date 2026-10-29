'use strict';

// Positive proof of a different, completed request. Unlike restart interval
// coverage, this does not need to prove the absence of intervening inputs.
// The native final and canonical input must name the SAME current writer/turn.
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const ordinarySource = source => {
  const origin = String(source || '').replace(/^external:/, '').replace(/^(?:codex|claude)-/, '');
  return ['history-panel', 'external-api', 'terminal-mcp'].includes(origin) || /^orchestration:[^\s]+$/.test(origin);
};

function readBuildContinueSupersession({ operation, target, state, capture, receipts, readQueued }) {
  const unknown = reason => ({ proven: false, reason });
  const view = capture?.(target.source.tabId);
  if (state?.known !== true || state.processStatus !== 'found' || state.busy !== false
    || state.transitioning !== false || view?.known !== true || view.exists !== true
    || view.busy !== false || view.transitioning !== false || view.runtime?.known !== true
    || view.runtime.status !== 'active' || view.runtime.liveLifecycle !== true
    || view.toolType !== target.source.provider || view.sessionId !== state.sessionId
    || view.cwd !== target.source.cwd || view.toolType === 'codex' && view.runtime.writerConfirmed !== true) {
    return unknown('later_input_current_owner_unproven');
  }
  if (view.turn?.status !== 'completed' || !['task_complete', 'Stop'].includes(view.turn.outcome)
    || !view.turn.turnId || view.turn.turnId === target.subject?.targetExecutionContext?.turnId
    && view.sessionId === target.subject.targetExecutionContext.sessionId) return unknown('later_input_natural_final_unproven');
  // Native Codex audit context is currently the supported canonical port.
  // Claude/terminal-only input without this proof keeps its existing interval
  // route, or can be explicitly cancelled. No source/text heuristics.
  if (view.toolType !== 'codex' || typeof receipts?.findExecutionReceipts !== 'function') {
    return unknown('later_input_audit_reader_unavailable');
  }
  const candidates = receipts.findExecutionReceipts({ tabId: target.source.tabId, provider: view.toolType,
    sessionId: view.sessionId, turnId: view.turn.turnId });
  if (candidates.length !== 1) return unknown(candidates.length ? 'later_input_audit_ambiguous' : 'later_input_audit_not_retained');
  const record = candidates[0], audit = record.auditIdentity, native = record.receipt?.auditExecutionContext;
  const queued = readQueued(record.operationKey);
  let request; try { request = JSON.parse(queued?.request_json); } catch { return unknown('later_input_request_unavailable'); }
  if (!ordinarySource(request.source)) return unknown('later_input_not_independent_request');
  if (!record.attemptId || audit?.attemptId !== record.attemptId || audit.provider !== view.toolType
    || audit.sessionId !== view.sessionId || audit.promptHash !== record.promptHash
    || !audit.entryUuid && !audit.sourceIdentity || record.receipt?.exactAuditConfirmed !== true
    || record.receipt.actualHash !== record.promptHash || record.state !== 'confirmed'
    || native?.provider !== view.toolType || native.sessionId !== view.sessionId || native.turnId !== view.turn.turnId
    || !Number.isFinite(Date.parse(audit.auditTimestamp)) || Date.parse(audit.auditTimestamp) <= operation.capturedAt
    || record.operationKey === target.operationKey || record.handoffId === target.handoffId
    || queued?.operation_key !== record.operationKey || queued.tab_id !== target.source.tabId
    || queued.request_hash !== fingerprintAgentSendRequest(request) || queued.request_hash !== record.requestFingerprint
    || request.tabId !== target.source.tabId || request.provider !== view.toolType || request.handoffId !== record.handoffId
    || request.expectedTarget?.toolType !== view.toolType || request.expectedTarget?.sessionId !== target.source.sessionId
    || promptAuditFingerprint(request.prompt) !== record.promptHash) return unknown('later_input_canonical_binding_unproven');
  const stamp = fingerprintAgentSendRequest({ audit, native, state: record.state, hash: record.promptHash });
  return { proven: true, proof: { kind: 'independent-input-natural-final', operationKey: record.operationKey,
    handoffId: record.handoffId, attemptId: record.attemptId, source: request.source, requestFingerprint: queued.request_hash,
    userUuid: audit.entryUuid || null, sourceIdentity: audit.sourceIdentity || null,
    executionContext: native, auditTimestamp: audit.auditTimestamp, outcome: view.turn.outcome },
  isCurrent: () => {
    const current = capture(target.source.tabId), receipt = receipts.get(record.operationKey);
    return current?.known === true && current.revision === view.revision && !!view.revision
      && receipt?.state === 'confirmed' && stamp === fingerprintAgentSendRequest({ audit: receipt.auditIdentity,
        native: receipt.receipt?.auditExecutionContext, state: receipt.state, hash: receipt.promptHash })
      && readQueued(record.operationKey)?.request_hash === queued.request_hash;
  } };
}

module.exports = { readBuildContinueSupersession };
