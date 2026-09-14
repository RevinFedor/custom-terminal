'use strict';

const crypto = require('node:crypto');
const { normalizeSavedHistoryRequest, selectSavedHistoryTarget } = require('./saved-history-operation');
const { resolveInboxRewindTarget } = require('./inbox-rewind-identity');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const PREFIX = 'inbox-saved-history.v1:';

function inboxHistoryAudit(record, runId, conversationKey, reservedTabId) {
  const audit = record?.auditIdentity;
  if (record?.surface !== 'inbox' || record.runId !== runId || record.operationKey !== 'inbox:' + runId
    || record.handoffId !== 'external-run:' + runId || record.provider !== 'codex'
    || record.state !== 'confirmed' || !record.attemptId || audit?.attemptId !== record.attemptId
    || audit.provider !== record.provider || !audit.sessionId || (!audit.entryUuid && !audit.sourceIdentity)
    || record.tabId !== reservedTabId(runId, conversationKey)) fail('inbox_history_audit_unproven');
  return { runId, conversationKey, tabId: record.tabId, provider: record.provider,
    operationKey: record.operationKey, handoffId: record.handoffId, attemptId: record.attemptId,
    sessionId: audit.sessionId, entryUuid: audit.entryUuid || null, sourceIdentity: audit.sourceIdentity || null };
}

// Only an ingress/ownership adapter. No terminal controls or mutation planner.
// The existing durable executor owns ALL Stop -> rewrite -> adopt -> Resume.
class InboxSavedHistoryOperations {
  constructor({ db, executor, getReceipt, reservedTabId, ensureOpen, resolveSession, transcript,
    cleanup, readNativeState }) {
    Object.assign(this, { db, executor, getReceipt, reservedTabId, ensureOpen, resolveSession,
      transcript, cleanup, readNativeState });
    this.preparing = new Map();
  }
  key(runId, operationId) { return PREFIX + digest([runId, operationId]); }
  lock(tabId) { return PREFIX + 'tab:' + tabId; }
  holds(tabId) {
    if (this.preparing.has(tabId)) return true;
    const key = this.db.getAppState(this.lock(tabId));
    const saved = key && this.db.getAppState(key);
    return !!saved && this.cleanupState(saved).state === 'held';
  }
  cleanupState(saved) {
    const cleanup = saved.cleanup;
    if (cleanup?.state !== 'held') return cleanup;
    const operation = this.executor.read(saved.tabId, saved.executorOperationId);
    // A crash can occur AFTER durable completion but BEFORE ingress cleanup.
    // The exact terminal receipt releases admission, not a timer or another POST.
    // It does not resurrect process timers belonging to the previous app instance.
    if (operation && !operation.pending && ['completed', 'failed'].includes(operation.state)
      && (!operation.historyMutated || operation.bindingCommitted)) return { ...cleanup, state: 'released-recovered' };
    return cleanup;
  }
  assertAvailable(tabId) { if (this.holds(tabId)) fail('inbox_history_operation_pending'); }
  normalize(runId, body) {
    if (typeof runId !== 'string' || !runId || runId.length > 160
      || typeof body.conversationKey !== 'string' || !body.conversationKey || body.conversationKey.length > 512) fail('inbox_history_conversation_required');
    const tabId = this.reservedTabId(runId, body.conversationKey);
    const request = normalizeSavedHistoryRequest(tabId, { ...body, toolType: 'codex',
      targetUuid: body.targetEntryUuid });
    return { ...request, runId, conversationKey: body.conversationKey };
  }
  read(runId, operationId) {
    const saved = this.db.getAppState(this.key(runId, operationId));
    if (!saved) return null;
    const operation = this.executor.read(saved.tabId, saved.executorOperationId);
    // Missing/unfinished execution is NOT permission to submit the operation again.
    return { runId, conversationKey: saved.request.conversationKey, tabId: saved.tabId,
      cleanup: this.cleanupState(saved), operation: operation ? { ...operation, operationId,
        executorOperationId: saved.executorOperationId } : {
        operationId, state: 'outcome-unknown', pending: true, success: false,
        error: 'inbox_history_execution_receipt_missing' } };
  }
  async accept(runId, body) {
    const request = this.normalize(runId, body);
    const key = this.key(runId, request.operationId);
    const existing = this.db.getAppState(key);
    if (existing) {
      if (digest(existing.request) !== digest(request)) fail('history_operation_request_mismatch');
      return { ...this.read(runId, request.operationId), idempotent: true };
    }
    const tabId = request.tabId;
    this.assertAvailable(tabId);
    const audit = inboxHistoryAudit(this.getReceipt(runId), runId, request.conversationKey, this.reservedTabId);
    const native = this.readNativeState?.(tabId);
    if (!native || native.pending !== false) fail('inbox_history_native_operation_unresolved');
    this.preparing.set(tabId, key); // also prevents a cleanup callback already queued in this tick
    let ownership;
    let reserved = false;
    const validateOwner = () => {
      ownership?.validate();
      if (this.readNativeState?.(tabId)?.pending !== false) fail('inbox_history_native_operation_unresolved');
      const current = this.getReceipt(runId);
      // The confirmed proof is durably copied at acceptance. TTL expiration
      // cannot revoke it; a conflicting still-present receipt does revoke it.
      if (current && digest(inboxHistoryAudit(current, runId, request.conversationKey, this.reservedTabId)) !== digest(audit)) fail('inbox_history_audit_changed');
    };
    try {
      // Restores the SAME archived tab with resumePolicy:never. Never creates
      // a new tab or independently launches a provider.
      const opened = await this.ensureOpen(tabId);
      ownership = this.cleanup.claim({ tabId, runId, conversationKey: request.conversationKey,
        descriptor: opened?.descriptor, audit });
      validateOwner();
      const info = await this.resolveSession(tabId);
      validateOwner();
      if (info?.toolType !== 'codex' || info.sessionId !== request.expectedSessionId) fail('history_operation_session_changed');
      const timeline = await this.transcript.getTimeline({ tabId, toolType: 'codex', sessionId: info.sessionId, cwd: info.cwd });
      validateOwner();
      if (!timeline?.success) fail(timeline?.error || 'history_read_failed');
      const selected = resolveInboxRewindTarget(timeline.entries, audit, {
        entryUuid: request.targetUuid, sourceIdentity: request.targetSourceIdentity });
      if (!selected.ok) fail(selected.code);
      const canonical = { ...request, targetUuid: selected.entry.uuid };
      selectSavedHistoryTarget(timeline, canonical); // includes physical/composite revision guards
      const executorOperationId = 'inbox-history:' + digest([runId, request.operationId]);
      const saved = { version: 1, request, tabId, executorOperationId, audit,
        cleanup: { state: 'held', ownerRunId: ownership.runId || null } };
      this.executor.accept(tabId, { ...canonical, operationId: executorOperationId }, {
        origin: { surface: 'inbox', runId, conversationKey: request.conversationKey, operationId: request.operationId, audit },
        validateOwner,
        onReserve: () => {
          this.db.setAppState(key, saved);
          this.db.setAppState(this.lock(tabId), key);
        },
        onSettled: operation => {
          // An unbound mutation must remain protected for explicit recovery.
          if (operation.historyMutated && !operation.bindingCommitted) return;
          let owned = true;
          try { ownership.validate(); } catch { owned = false; }
          const cleanup = { ...saved.cleanup, state: owned ? 'released' : 'released-owner-changed' };
          this.db.setAppState(key, { ...saved, cleanup });
          if (owned) ownership.release(operation);
        },
      });
      reserved = true;
      return this.read(runId, request.operationId);
    } finally {
      this.preparing.delete(tabId);
      if (!reserved) ownership?.release(null);
    }
  }
}

module.exports = { InboxSavedHistoryOperations, inboxHistoryAudit };
