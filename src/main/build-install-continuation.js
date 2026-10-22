'use strict';

// An install handoff is local work, not a fake Research run or provider turn.
// The callback's existing canonical Send receipt and result reader own proof.
const crypto = require('node:crypto');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptFingerprint } = require('./claude-prompt-carriers');
const activity = require('../shared/build-install-activity.cjs');
const logicalFingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = code => Object.assign(new Error(code), { code, statusCode: 409 });

function createBuildInstallContinuations({ read, write, receipts, readResult, readSource,
  readQueuedRequest = () => null, readPreparedHandoff = () => null, changed = () => {} }) {
  let state = null, loadFailed = false;
  let dirty = null;
  const work = new Map();
  const trailing = new Set();
  const load = () => {
    if (state) return state;
    try {
      const saved = read();
      if (saved == null && loadFailed) throw error('install_continuation_authority_unknown');
      if (saved != null && (saved.version !== 1 || !Array.isArray(saved.entries))) throw error('install_continuation_journal_invalid');
      state = saved ? clone(saved) : { version: 1, entries: [] };
      return state;
    } catch (e) { loadFailed = true; throw e; }
  };
  const commit = entry => {
    dirty = entry;
    const result = write(clone(load()));
    if (result?.success === false || result?.then) throw error('install_continuation_write_unconfirmed');
    dirty = null;
    changed(clone(entry));
  };
  const find = id => load().entries.find(entry => entry.requestId === id);
  const reserve = ({ requestId, jobId, source }) => {
    if (!requestId || !source?.tabId || !source.projectId || !source.sessionId
      || !['claude', 'codex'].includes(source.toolType)) throw error('install_continuation_identity_required');
    const fingerprint = digest({ requestId, source });
    let entry = find(requestId);
    if (entry && entry.fingerprint !== fingerprint) throw error('install_continuation_identity_changed');
    if (entry?.jobId && jobId && entry.jobId !== jobId) throw error('install_continuation_job_changed');
    if (!entry) {
      entry = { version: 1, requestId, jobId, source: clone(source), fingerprint,
        state: 'waiting-install', createdAt: Date.now(), callback: null };
      load().entries.push(entry);
    }
    if (jobId && !entry.jobId) entry.jobId = jobId;
    commit(entry); // exact retry persists the same accepted RAM intent
    return clone(entry);
  };
  const sourceReservation = ({ requestId, jobId, tabId, sessionId, projectId }) => {
    const entry = find(requestId);
    if (!entry) return null;
    if (entry.source.tabId !== tabId || entry.source.sessionId !== sessionId
      || projectId && entry.source.projectId !== projectId) throw error('install_continuation_identity_changed');
    return reserve({ requestId, jobId, source: entry.source }).source;
  };
  const armCallback = ({ requestId, jobId, prompt }) => {
    const entry = find(requestId);
    if (!entry || entry.jobId !== jobId || typeof prompt !== 'string' || !prompt) throw error('install_continuation_callback_owner_changed');
    if (['ended-without-callback', 'cancelled'].includes(entry.state)) throw error('install_continuation_already_settled');
    const callback = { handoffId: 'build-install-return:' + jobId, promptHash: promptAuditFingerprint(prompt) };
    if (entry.callback && digest(entry.callback) !== digest(callback)) throw error('install_continuation_callback_changed');
    const intent = { logicalHash: logicalFingerprint(prompt), logicalResultHash: promptFingerprint(prompt) };
    if (entry.callbackIntent && digest(entry.callbackIntent) !== digest(intent)) throw error('install_continuation_callback_changed');
    entry.callbackIntent ||= intent;
    entry.callback ||= callback;
    entry.callbackArmedAt ||= Date.now();
    if (entry.state === 'waiting-install') entry.state = 'waiting-callback-turn';
    commit(entry);
    return clone(entry);
  };
  const assertCommitted = () => { if (dirty) throw error('install_continuation_write_unconfirmed'); };
  const snapshot = () => { assertCommitted(); return { version: 1, known: true, entries: clone(load().entries) }; };
  const blocked = tabId => { assertCommitted(); return load().entries.some(entry => entry.source.tabId === tabId && activity.pending(entry)); };
  const canCancelConfirmedWait = (entry, job, status) => {
    assertCommitted();
    if (!activity.pending(entry) || status?.known !== true || status.stale !== false) return false;
    const records = receipts()?.list({ tabId: entry.source.tabId, handoffId: 'build-install-return:' + entry.jobId }) || [];
    return records.length === 1 && activity.confirmedReturn(entry, job, records[0]);
  };
  const cancelConfirmedWait = (request, status) => {
    const entry = find(request.requestId);
    if (!entry || request.tabId !== entry.source.tabId || request.id !== entry.jobId
      || request.fingerprint !== entry.fingerprint) throw error('install_continuation_cancel_owner_changed');
    if (!activity.pending(entry)) { if (dirty) commit(entry); return clone(entry); }
    const job = status?.jobs?.find(job => activity.ownedJob(entry, job));
    if (!canCancelConfirmedWait(entry, job, status)) throw error('install_continuation_cancel_unproven');
    // User disposal of this wait is not a natural callback result or Stop.
    // Keep callback/Send receipts unchanged and never replay their input.
    entry.state = 'cancelled'; entry.cancelledAt = Date.now();
    entry.outcomeFloorAt = entry.cancelledAt; entry.disposition = 'user-cancelled-continuation';
    commit(entry);
    return clone(entry);
  };
  const settleNoCallback = job => {
    const entry = find(job.requestId);
    if (!entry || job.running || job.installOutcomeUnknown || job.callback?.status !== 'skipped'
      || !(job.cancelled || job.ok === false || job.ok === true && job.returnTo?.notifyOnSuccess === false)) return;
    if (entry.source.tabId !== job.returnTo?.tabId || entry.source.sessionId !== job.returnTo?.sessionId
      || entry.jobId && entry.jobId !== job.id) throw error('install_continuation_terminal_owner_changed');
    if (!activity.pending(entry)) { if (dirty) commit(entry); return; }
    entry.jobId ||= job.id; entry.state = 'ended-without-callback';
    entry.outcomeFloorAt = Number(job.finishedAt) || Date.now();
    entry.disposition = job.cancelled ? 'installer-cancelled' : job.ok === false ? 'installer-failed' : 'callback-disabled';
    // No synthetic completion: old outcomes precede this floor; only a real
    // later source outcome may continue an enabled Loop.
    commit(entry);
  };
  const callbackBinding = (entry, record) => {
    const audit = record?.auditIdentity;
    if (record?.state !== 'confirmed' || record.tabId !== entry.source.tabId
      || record.handoffId !== entry.callback.handoffId || record.provider !== entry.source.toolType || !record.sessionId
      || audit?.attemptId !== record.attemptId || audit.sessionId !== record.sessionId
      || audit.promptHash !== record.promptHash || !audit.entryUuid && !audit.sourceIdentity) return null;
    const queued = readQueuedRequest(record.operationKey);
    let request = null;
    if (queued) {
      try { request = JSON.parse(queued.request_json); } catch { return null; }
      if (queued.operation_key !== record.operationKey || queued.tab_id !== entry.source.tabId
        || queued.request_hash !== fingerprintAgentSendRequest(request)
        || request.tabId !== entry.source.tabId || request.handoffId !== entry.callback.handoffId
        || request.provider !== record.provider || request.source !== 'build-install-return' || typeof request.prompt !== 'string'
        || !request.expectedTarget
        || fingerprintAgentSendRequest(request.expectedTarget) !== fingerprintAgentSendRequest(entry.source.expectedTarget)) return null;
    }
    // A Resume child needs the original immutable admission targeted at source A.
    // Matching a live SID or a body suffix can never supply this proof.
    if (record.sessionId !== entry.source.sessionId && !request) return null;
    const prepared = readPreparedHandoff(entry.source.tabId, entry.callback.handoffId);
    let intent = entry.callbackIntent, transport = null, preparationHash = null;
    if (prepared) {
      if (prepared.tab_id !== entry.source.tabId || prepared.handoff_id !== entry.callback.handoffId
        || !['preparing', 'delivered'].includes(prepared.status)
        || !/^[a-f0-9]{64}$/.test(prepared.base_hash || '') || typeof prepared.prefix !== 'string') return null;
      transport = prepared.prepared_prompt;
      if (transport == null) transport = request?.prompt ?? record.receipt?.transportText;
      if (typeof transport !== 'string' || promptAuditFingerprint(transport) !== prepared.payload_hash
        || prepared.payload_hash !== record.promptHash) return null;
      if (intent) {
        if (intent.logicalHash !== prepared.base_hash) return null;
      } else {
        // v1 stored only the logical audit token. Recover it ONLY when the
        // app-owned exact preparation is reversible AND its original full
        // base_hash and frozen audit token both verify. Wrapper refresh may
        // change the base, in which case legacy proof remains unavailable.
        if (!transport.startsWith(prepared.prefix)) return null;
        const base = transport.slice(prepared.prefix.length);
        if (logicalFingerprint(base) !== prepared.base_hash || promptAuditFingerprint(base) !== entry.callback.promptHash) return null;
        intent = { logicalHash: prepared.base_hash, logicalResultHash: promptFingerprint(base) };
      }
      preparationHash = fingerprintAgentSendRequest({ tabId: prepared.tab_id, handoffId: prepared.handoff_id,
        baseHash: prepared.base_hash, payloadHash: prepared.payload_hash, transportHash: logicalFingerprint(transport) });
    } else {
      if (record.promptHash !== entry.callback.promptHash) return null;
      transport = request?.prompt ?? record.receipt?.transportText ?? record.receipt?.promptText;
      if (typeof transport === 'string') {
        if (promptAuditFingerprint(transport) !== record.promptHash) return null;
        const exact = { logicalHash: logicalFingerprint(transport), logicalResultHash: promptFingerprint(transport) };
        if (intent && digest(intent) !== digest(exact)) return null;
        intent ||= exact;
      }
      if (!intent) return null;
    }
    if (!/^[a-f0-9]{64}$/.test(intent.logicalHash || '') || !/^[a-f0-9]{64}$/.test(intent.logicalResultHash || '')) return null;
    if (request && (typeof transport === 'string' ? request.prompt !== transport
      : logicalFingerprint(request.prompt || '') !== intent.logicalHash)) return null;
    if (typeof record.receipt?.transportText === 'string' && typeof transport === 'string'
      && record.receipt.transportText !== transport) return null;
    const auditAt = Date.parse(audit.auditTimestamp);
    if (!Number.isFinite(auditAt)) return null;
    return { logicalHash: intent.logicalHash, logicalResultHash: intent.logicalResultHash,
      transportAuditHash: record.promptHash,
      resultPromptHash: typeof transport === 'string' ? promptFingerprint(transport) : intent.logicalResultHash,
      preparationHash, requestHash: queued?.request_hash || null, requestFingerprint: record.requestFingerprint || null,
      operationKey: record.operationKey, attemptId: record.attemptId, sessionId: record.sessionId,
      userUuid: audit.entryUuid || null, sourceIdentity: audit.sourceIdentity || null, auditTimestamp: audit.auditTimestamp };
  };
  const reconcileEntry = async entry => {
    if (!entry.callback || !activity.pending(entry)) return;
    const records = receipts()?.list({ tabId: entry.source.tabId, handoffId: entry.callback.handoffId }) || [];
    if (records.length !== 1) return;
    const record = records[0], audit = record.auditIdentity, binding = callbackBinding(entry, record);
    if (!binding || entry.callbackBinding && digest(entry.callbackBinding) !== digest(binding)) return;
    if (!entry.callbackBinding) {
      entry.callbackIntent ||= { logicalHash: binding.logicalHash, logicalResultHash: binding.logicalResultHash };
      entry.callbackBinding = binding;
      commit(entry); // durable exact binding BEFORE waiting for the natural final
    }
    const source = await readSource(entry.source.tabId);
    if (source?.coherent !== true || source.sessionId !== record.sessionId
      || source.toolType !== entry.source.toolType || !['found', 'absent'].includes(source.processStatus)) return;
    const auditAt = Date.parse(audit.auditTimestamp);
    if (!Number.isFinite(auditAt)) return;
    const identity = digest(binding);
    const result = await readResult({ sessionId: record.sessionId, cwd: entry.source.cwd,
      toolType: entry.source.toolType, promptHash: binding.resultPromptHash,
      promptUserUuid: audit.entryUuid || undefined, promptSourceIdentity: audit.sourceIdentity || undefined,
      requestedAt: entry.callbackArmedAt, forceFresh: true, resultReadMode: 'source-proof', maxChars: 1 });
    if (result?.found !== true || result.complete !== true || result.error || result.terminalOutcomeReason
      && !['task_complete', 'done', 'completed', 'end_turn'].includes(result.terminalOutcomeReason)
      || entry.source.toolType === 'codex' && result.sourceVerified !== true) return;
    const exactUser = audit.entryUuid && result.userUuid === audit.entryUuid
      || audit.sourceIdentity && (result.sourceIdentity === audit.sourceIdentity || result.sourceIdentityAliases?.includes(audit.sourceIdentity));
    if (!exactUser) return;
    const latestSource = await readSource(entry.source.tabId);
    if (latestSource?.coherent !== true || latestSource.sessionId !== record.sessionId
      || latestSource.toolType !== entry.source.toolType || !['found', 'absent'].includes(latestSource.processStatus)) return;
    const current = receipts()?.get(record.operationKey);
    const currentBinding = current && callbackBinding(entry, current);
    if (!currentBinding || digest(currentBinding) !== identity) return;
    // All-tab startup and a native single-tab wake can overlap. Recheck the
    // shared entry after the last await; one completed/revoked entry cannot
    // publish another release or be resurrected by a late read.
    if (!activity.pending(entry)) return;
    // This is exact completed callback work. The renderer still consumes its
    // existing natural outcome once, after both Loop and workflow floors.
    entry.state = 'continued'; entry.continuedAt = Date.now(); entry.outcomeFloorAt = auditAt;
    entry.callbackProof = { operationKey: record.operationKey, attemptId: record.attemptId,
      userUuid: result.userUuid || null, sourceIdentity: result.sourceIdentity || null,
      turnId: result.executionContext?.turnId || null, sessionId: record.sessionId };
    commit(entry);
  };
  const reconcile = tabId => {
    const key = tabId || '*';
    if (work.has(key)) { trailing.add(key); return work.get(key); }
    const promise = (async () => {
      if (dirty) commit(dirty);
      for (const entry of load().entries) if (!tabId || entry.source.tabId === tabId) await reconcileEntry(entry);
    })().finally(() => {
      work.delete(key);
      if (trailing.delete(key)) void reconcile(tabId).catch(() => {});
    });
    work.set(key, promise); return promise;
  };
  return { reserve, sourceReservation, armCallback, snapshot, blocked, reconcile, settleNoCallback,
    canCancelConfirmedWait, cancelConfirmedWait };
}

module.exports = { createBuildInstallContinuations };
