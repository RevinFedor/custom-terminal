'use strict';

// Explicit proof-read adapter over the existing scanner and receipt publisher.
// It has no terminal input, queue bypass, retry or negative settlement authority.
const { reconcileAgentSendStartupRecords } = require('./agent-send-startup-reconcile');
const { agentPromptAuditAddressesOverlap } = require('./agent-prompt-audit-identity');

const AUDITABLE = new Set(['audit-pending', 'delivery-unknown']);
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const string = value => typeof value === 'string' && value.trim() ? value : null;

function normalizeAgentSendReceiptReconcile(tabId, body = {}) {
  if (!string(tabId) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['operationKey', 'attemptId'].includes(key))
    || !string(body.operationKey) || !string(body.attemptId)) {
    fail('send_receipt_reconcile_identity_required', 400);
  }
  return { tabId, operationKey: body.operationKey, attemptId: body.attemptId };
}

function exactReceipt(store, request) {
  const record = store.get(request.operationKey);
  if (!record || record.tabId !== request.tabId) fail('send_receipt_not_found', 404);
  if (record.attemptId !== request.attemptId) fail('send_receipt_attempt_changed');
  return record;
}

function canonical(record) {
  return record.state === 'confirmed' && record.auditIdentity?.attemptId === record.attemptId
    && !!record.auditIdentity.sessionId && !!(record.auditIdentity.entryUuid || record.auditIdentity.sourceIdentity);
}

function immutableProofIdentity(record) {
  return JSON.stringify([record.operationKey, record.attemptId, record.tabId,
    record.requestFingerprint, record.provider, record.sessionId, record.promptHash,
    record.promptLength, record.transcriptBoundary]);
}

function createAgentSendReceiptReconciler({ store, publishAudit,
  scan = reconcileAgentSendStartupRecords, tabFlights = new Map() }) {
  const exactFlights = new Map();

  async function execute(request) {
    // Join the existing tab-wide live audit before taking our exact read slot.
    while (tabFlights.has(request.tabId)) await tabFlights.get(request.tabId).catch(() => {});
    const before = exactReceipt(store, request);
    if (before.provider !== 'codex') fail('send_receipt_reconciliation_provider_unsupported');
    if (canonical(before)) return { ...request, record: before,
      reconciliation: { decision: 'confirmed', reason: 'already-exact-confirmed', confirmed: true, promoted: false } };
    if (!AUDITABLE.has(before.state)) fail('send_receipt_not_auditable');
    const identity = immutableProofIdentity(before);
    const work = Promise.resolve().then(async () => {
      // Neighbouring attempts and claimed canonical rows are part of the
      // existing scanner's causal/ambiguity guards, not just the selected row.
      const allRecords = store.listAuditReferences('codex');
      const [decision] = await scan([before], { allRecords });
      const current = exactReceipt(store, request);
      if (immutableProofIdentity(current) !== identity) fail('send_receipt_source_changed');
      if (canonical(current)) return { ...request, record: current,
        reconciliation: { decision: 'confirmed', reason: 'confirmed-during-read', confirmed: true, promoted: false } };
      if (!AUDITABLE.has(current.state)) fail('send_receipt_not_auditable');
      if (!decision || decision.operationKey !== request.operationKey || decision.attemptId !== request.attemptId) {
        fail('send_receipt_audit_identity_mismatch');
      }
      let publicationError = null;
      if (decision.decision === 'found') {
        if (!decision.audit || decision.audit.operationKey !== request.operationKey
          || decision.audit.attemptId !== request.attemptId) fail('send_receipt_audit_identity_mismatch');
        if (store.findConflictingAuditClaim?.(decision.audit) || store.listAuditReferences('codex').some(other => (
          other.operationKey !== current.operationKey && other.provider === 'codex' && canonical(other)
          && other.auditIdentity.sessionId === decision.audit.sessionId
          && agentPromptAuditAddressesOverlap(other.auditIdentity, decision.audit)
        ))) {
          return { ...request, record: current, reconciliation: { decision: 'unknown',
            reason: 'canonical-user-already-owned', confirmed: false, promoted: false,
            evidence: decision.evidence || null } };
        }
        try { await publishAudit(current, decision.audit); }
        catch (error) { publicationError = String(error?.message || error); }
      }
      // Negative/unknown proof remains a read result. Never convert a recorded
      // Enter into not-submitted or free its slot because nothing was found.
      const record = exactReceipt(store, request);
      const confirmed = canonical(record);
      return { ...request, record, reconciliation: {
        decision: decision.decision, reason: decision.reason, confirmed, promoted: confirmed,
        evidence: decision.evidence || null,
        ...(publicationError ? { publicationError } : {}),
      } };
    });
    tabFlights.set(request.tabId, work);
    try { return await work; }
    finally { if (tabFlights.get(request.tabId) === work) tabFlights.delete(request.tabId); }
  }

  return function reconcile(request = {}) {
    const { tabId, ...body } = request;
    const exact = normalizeAgentSendReceiptReconcile(tabId, body);
    const key = JSON.stringify([exact.tabId, exact.operationKey, exact.attemptId]);
    const previous = exactFlights.get(key);
    if (previous) return previous;
    const work = execute(exact);
    exactFlights.set(key, work);
    work.finally(() => { if (exactFlights.get(key) === work) exactFlights.delete(key); }).catch(() => {});
    return work;
  };
}

module.exports = { createAgentSendReceiptReconciler, normalizeAgentSendReceiptReconcile };
