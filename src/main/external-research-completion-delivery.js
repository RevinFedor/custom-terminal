'use strict';

// Local delivery of an already committed SC result. This module has no provider
// start/stop/Send capability. RunStore owns progress; History owns input proof.
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { sourceTarget } = require('./external-research-operational');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { isAgentSendProviderQueueAccepted, fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { isExternalCompletionNoInputReceipt } = require('../shared/agent-send-receipt-control.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PIN = 'external-research-completion';
const cancelled = () => Object.assign(new Error('External completion is no longer authorized'),
  { code: 'external_completion_revoked', submitted: false });

function birthIdentity(run) {
  return { runId: run.runId, jobId: run.externalResearchJobId, runCreatedAt: run.createdAt,
    requestFingerprint: run.requestFingerprint || null, intentDigest: digest(run.externalResearchIntent || null),
    sourceTabId: run.sourceTabId, sourceProjectId: run.sourceProjectId || null, sourceTarget: sourceTarget(run) };
}
// Only RunStore.create calls this, before its mandatory strict reservation
// write. initialize/load, existing-ID retry and SC observations never mint it.
function createBirth(run) {
  return { version: 1, id: crypto.randomUUID(), identity: clone(birthIdentity(run)) };
}
function hasBirth(run) {
  const birth = run?.externalResearchDeliveryBirth;
  return run?.runKind === 'external-research' && birth?.version === 1
    && typeof birth.id === 'string' && /^[0-9a-f-]{36}$/.test(birth.id)
    && isDeepStrictEqual(birth.identity, birthIdentity(run));
}
function canAdmit(run, delivery = run?.externalResearchDelivery) {
  return hasBirth(run) && delivery?.legacy !== true && delivery?.birthId === run.externalResearchDeliveryBirth.id;
}

function initializeDelivery(run, { legacy = false } = {}) {
  legacy ||= !hasBirth(run);
  if (run.externalResearchDelivery || run.runKind !== 'external-research'
    || (legacy ? !['completed', 'failed'].includes(run.status) || run.sourceFollowupStartedAt
      : run.resultComplete !== true)
    || (!legacy && (run.externalResearchStatus !== 'done' || run.notificationAttemptedAt || run.notificationPromptHash || run.notificationAttempt))) return;
  const owner = run.externalResearchDeliveryBirth?.identity || birthIdentity(run);
  // SC done proves a result, not the history of Noted input. A loaded ACTIVE
  // legacy row stays observational even when this is its first local done.
  run.externalResearchDelivery = {
    version: 1, id: crypto.randomUUID(), runId: owner.runId, jobId: owner.jobId,
    runCreatedAt: owner.runCreatedAt, sourceTabId: owner.sourceTabId,
    sourceProjectId: owner.sourceProjectId, sourceTarget: clone(owner.sourceTarget || null),
    ...(legacy ? { legacy: true, legacyNotificationStatus: run.notificationStatus }
      : { birthId: run.externalResearchDeliveryBirth.id }),
    phase: legacy ? 'unknown' : 'preparing', retryPending: false, failures: 0, retryAt: null,
    request: null, requestHash: null, retentionPinned: false, lastError: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function sameOwner(run, delivery) {
  return !!run && !!delivery && delivery.version === 1 && run.runKind === 'external-research'
    && run.externalResearchDelivery?.id === delivery.id && run.runId === delivery.runId
    && run.externalResearchJobId === delivery.jobId && run.createdAt === delivery.runCreatedAt
    && run.sourceTabId === delivery.sourceTabId && (run.sourceProjectId || null) === delivery.sourceProjectId
    && isDeepStrictEqual(sourceTarget(run), delivery.sourceTarget);
}
function authorized(run, delivery = run?.externalResearchDelivery) {
  return sameOwner(run, delivery) && (run.status === 'completed' && run.resultComplete === true
    || delivery.legacy === true && run.status === 'failed')
    && run.notifySource !== false && !run.notificationSuppressed && !run.notificationCancelRequestedAt
    && !['suppressed', 'source-closed'].includes(run.notificationStatus);
}
function synchronizeRevocation(run, revoke) {
  const d = run.externalResearchDelivery;
  if (!d || run.sourceFollowupStartedAt || authorized(run) || d.cancellationConfirmed || !d.request) return null;
  try {
    const result = revoke?.(run, d);
    if (result?.then || result?.ok !== true) throw Object.assign(new Error('Completion cancellation is not durable'),
      { code: 'external_completion_cancel_unconfirmed' });
    d.cancellationConfirmed = true; d.retryPending = false;
    return null;
  } catch (error) { return error; }
}
function pending(run) {
  return authorized(run) && !run.sourceFollowupStartedAt
    && run.externalResearchDelivery.retryPending === true;
}
function deliveryRef(delivery) {
  return { version: 1, runId: delivery.runId, deliveryId: delivery.id, requestHash: delivery.requestHash };
}
function frozenRequest(delivery) {
  if (!delivery.request || digest(delivery.request) !== delivery.requestHash) {
    throw Object.assign(new Error('Frozen completion request is unavailable'), { code: 'external_completion_request_corrupt' });
  }
  return { ...clone(delivery.request), completionDeliveryRef: deliveryRef(delivery) };
}
function receiptMatchesDelivery(delivery, record, queued) {
  if (!record || !delivery?.request || record.operationKey !== delivery.request.sendOperationKey
    || record.tabId !== delivery.sourceTabId || record.handoffId !== delivery.request.handoffId
    || record.provider !== delivery.sourceTarget?.toolType || record.promptHash !== promptAuditFingerprint(delivery.request.prompt)) return false;
  const target = delivery.sourceTarget;
  if (target.sessionId) return !record.sessionId || record.sessionId === target.sessionId;
  if (!target.terminalInstanceId || !target.launchId || queued?.operation_key !== record.operationKey) return false;
  // The physical executor may materialize a first writer SID. Its authority
  // is the same immutable FIFO launch pin plus the exact input receipt, not
  // equality to the intentionally null SID captured at Research reservation.
  try {
    const request = JSON.parse(queued.request_json), original = frozenRequest(delivery);
    if (queued.request_hash !== fingerprintAgentSendRequest(request)) return false;
    return Object.keys(original).every(key => isDeepStrictEqual(original[key], request[key]));
  } catch { return false; }
}
function receiptSourceSessionId(delivery, record, queued) {
  return receiptMatchesDelivery(delivery, record, queued) ? record.sessionId || record.auditIdentity?.sessionId || null : null;
}
async function resolveCompletionRequest(store, request) {
  const ref = request.completionDeliveryRef;
  const run = await store.getInternal(ref?.runId), d = run?.externalResearchDelivery;
  if (!authorized(run) || !canAdmit(run, d) || !d.retentionPinned || run.sourceFollowupStartedAt
    || !isDeepStrictEqual(ref, deliveryRef(d))) throw cancelled();
  const original = frozenRequest(d);
  // Execution-only fields (FIFO fingerprint/callback/symbol) are not payload.
  for (const key of Object.keys(original)) if (!isDeepStrictEqual(original[key], request[key])) throw cancelled();
  const driverFields = new Set(['applicationQueueExecution', 'sendRequestFingerprint', 'prepareSend', 'onLateReceipt', 'retryCompletionNoInput']);
  for (const key of Object.keys(request)) if (!Object.hasOwn(original, key) && !driverFields.has(key)) throw cancelled();
  if (request.restoreClosedTab === true) throw cancelled();
  return { run, prepareSend: async () => { await resolveCompletionRequest(store, request); } };
}

function createExternalCompletionDelivery({ store, receipts, queueItem, waitReady, prepare,
  send, reconcile, notifyOperational, changed = () => {}, logger = console,
  now = Date.now, retryBaseMs = 500, retryMaxMs = 15000, notificationGraceMs = 60000 }) {
  const flights = new Map();
  let stopped = false;
  const checkpoint = async (id, d, patch) => store.updateExternalResearchDelivery(id, d.id, patch);
  async function current(id, expected) {
    const run = await store.getInternal(id);
    if (stopped || !authorized(run, expected || run?.externalResearchDelivery)) throw cancelled();
    return run;
  }
  function evidence(d) {
    const record = receipts.get(d.request.sendOperationKey);
    const queued = queueItem(d.request.sendOperationKey);
    const pinned = receipts.listOwnerPins(PIN).includes(d.request.sendOperationKey);
    if (record && !receiptMatchesDelivery(d, record, queued)) {
      throw Object.assign(new Error('Completion receipt identity mismatch'), { code: 'external_completion_receipt_conflict' });
    }
    return { record, queued, absentBeforeAdmission: !record && !queued && pinned && d.retentionPinned === true };
  }
  async function observe(id, d, record) {
    const run = await current(id, d);
    // Existing exact receipt/transcript reconciliation owns causal semantics.
    await reconcile(run);
    const latest = await current(id, d);
    if (latest.sourceFollowupStartedAt) {
      await checkpoint(id, d, { phase: 'delivered', retryPending: false, retryAt: null, lastError: null });
      receipts.unpinForOwner(d.request.sendOperationKey, PIN);
      return;
    }
    const state = record?.state;
    const item = queueItem(d.request.sendOperationKey);
    const phase = item?.state === 'waiting' && !record?.attemptId && ['reserved', 'preparing'].includes(state) ? 'queued'
      : state === 'confirmed' || isAgentSendProviderQueueAccepted(record?.receipt) ? 'observing'
        : state === 'not-submitted' || state === 'provider-not-accepted' ? 'waiting-for-input' : 'unknown';
    const status = phase === 'queued' ? 'sending' : phase === 'observing' ? 'queued'
      : phase === 'waiting-for-input' ? 'waiting-for-input' : 'unconfirmed';
    await checkpoint(id, d, { phase, retryPending: false, retryAt: null,
      notificationStatus: status, lastError: phase === 'unknown' ? 'external_completion_input_unconfirmed' : null });
    if (phase === 'unknown' || phase === 'waiting-for-input') {
      await store.recordExternalOperationalFailure(id, { phase: 'delivering', reason: 'delivery_blocked',
        code: phase === 'unknown' ? 'external_completion_input_unconfirmed' : 'external_completion_input_unavailable' });
      notifyOperational(id, { blocked: phase === 'unknown' });
    }
  }
  async function attempt(id, options) {
    let retryCompletionNoInput = false;
    let run, d;
    try {
      // Also repairs a previous failed strict write in this process. RAM is
      // never a successful checkpoint, including after a receipt was accepted.
      await store.persistStrict();
      run = await current(id); d = clone(run.externalResearchDelivery);
      await waitReady(); run = await current(id, d);
      if (run.sourceFollowupStartedAt) {
        await checkpoint(id, d, { phase: 'delivered', retryPending: false, retryAt: null, lastError: null });
        if (d.request) receipts.unpinForOwner(d.request.sendOperationKey, PIN);
        return;
      }
      if (!canAdmit(run, d)) {
        // Includes old v1 delivery rows with a frozen request but no birth
        // witness. Keep their exact IDs/pins/payload and reconcile only.
        await reconcile(run);
        const latest = await current(id, d);
        if (latest.sourceFollowupStartedAt) {
          await checkpoint(id, d, { phase: 'delivered', retryPending: false, lastError: null });
          return;
        }
        await checkpoint(id, d, { phase: 'unknown', retryPending: false, notificationStatus: 'unconfirmed',
          lastError: 'external_completion_legacy_input_unproven' });
        await store.recordExternalOperationalFailure(id, { phase: 'delivering', reason: 'delivery_blocked',
          code: 'external_completion_legacy_input_unproven' });
        notifyOperational(id, { blocked: true });
        return;
      }
      if (d.request) {
        const prior = evidence(d);
        retryCompletionNoInput = options.retryNoInput === true && run.notificationStatus !== 'unconfirmed'
          && isExternalCompletionNoInputReceipt(prior.record, frozenRequest(d));
        const reservedOnly = run.notificationStatus !== 'unconfirmed' && d.phase === 'admitting' && !prior.queued && !prior.record?.attemptId
          && ['reserved', 'preparing'].includes(prior.record?.state) && !prior.record?.deliveryControl?.cancelledAt;
        if ((prior.record || prior.queued) && !retryCompletionNoInput && !reservedOnly) return await observe(id, d, prior.record);
        // UNKNOWN/unconfirmed cannot become no-input from absence, even with
        // a pin. Only our durable pre-admission state permits this transition.
        if (!retryCompletionNoInput && !reservedOnly && (d.phase !== 'admitting' || !prior.absentBeforeAdmission || run.notificationStatus === 'unconfirmed')) {
          return await observe(id, d, null);
        }
      } else {
        if (d.phase !== 'preparing' || run.notificationStatus === 'unconfirmed') return;
        const request = await prepare(clone(run), () => current(id, d));
        run = await current(id, d);
        if (run.sourceFollowupStartedAt) return;
        receipts.pinForOwner(request.sendOperationKey, PIN);
        receipts.pinForOwner(request.sendOperationKey, 'orchestration-source-followup');
        await checkpoint(id, d, { request: clone(request), requestHash: digest(clone(request)),
          phase: 'admitting', retentionPinned: true, retryPending: true, retryAt: null });
        run = await current(id, d); d = clone(run.externalResearchDelivery);
      }
      await checkpoint(id, d, { phase: 'admitting', notificationStatus: 'sending', retryPending: true, retryAt: null });
      await current(id, d);
      const request = frozenRequest(d);
      await resolveCompletionRequest(store, request);
      await current(id, d);
      await send(request, { retryCompletionNoInput });
      await current(id, d);
      const after = evidence(d);
      if (!after.record && !after.queued) throw Object.assign(new Error('Completion admission has no receipt'),
        { code: 'external_completion_admission_unavailable' });
      await observe(id, d, after.record);
    } catch (error) {
      const latest = await store.getInternal(id);
      if (stopped || !authorized(latest, d || latest?.externalResearchDelivery)) return;
      d = clone(latest.externalResearchDelivery);
      if (latest.sourceFollowupStartedAt) {
        // Preserve the strict-write failure for the coordinator's local retry.
        await checkpoint(id, d, { phase: 'delivered', retryPending: false, retryAt: null, lastError: null });
        if (d.request) receipts.unpinForOwner(d.request.sendOperationKey, PIN);
        return;
      }
      // A thrown lower adapter may already have admitted/entered. Observe the
      // original receipt before deciding whether another local preparation is safe.
      let prior = null;
      if (d.request) {
        try { prior = evidence(d); } catch { /* An unreadable journal is UNKNOWN. */ }
        if (prior?.record || prior?.queued) {
          try { await observe(id, d, prior.record); return; }
          catch (cause) { error = cause; }
        }
      }
      const failures = Number(d.failures || 0) + 1;
      const retryAt = now() + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(8, failures - 1));
      const code = String(error.code || 'external_completion_local_io_unavailable');
      // Retrying journal READ/projection is safe even in UNKNOWN. attempt()
      // will never call send for that state. No timeout changes input evidence.
      let writeFailure;
      try { await checkpoint(id, d, { failures, retryAt, retryPending: true, lastError: code,
        ...(!d.request ? {} : prior?.absentBeforeAdmission && d.phase === 'admitting' ? {} : { phase: 'unknown' }),
        notificationStatus: d.request && !prior?.absentBeforeAdmission ? 'unconfirmed' : 'failed' });
      } catch (cause) { writeFailure = cause; }
      try {
        await store.recordExternalOperationalFailure(id, { phase: 'delivering', reason: 'delivery_blocked', code, retryAt,
          notificationGraceMs });
      } finally {
        // Its strict pre-input write can still fail. The existing operational
        // delivery owner then uses its independent human outbox, never RAM ACK.
        notifyOperational(id);
      }
      if (writeFailure) throw writeFailure;
      changed(await store.get(id));
      logger.warn?.('[ExternalResearchDelivery] pending run=' + id + ' code=' + code + ' retryAt=' + retryAt);
    }
  }
  function deliver(id, options = {}) {
    if (stopped) return Promise.resolve();
    if (flights.has(id)) return flights.get(id);
    const promise = Promise.resolve().then(() => attempt(id, options)).finally(() => flights.delete(id));
    flights.set(id, promise); return promise;
  }
  return { deliver, resolve: request => resolveCompletionRequest(store, request), stop: () => { stopped = true; } };
}
module.exports = { createBirth, hasBirth, canAdmit, synchronizeRevocation, initializeDelivery, sameOwner, authorized, pending, deliveryRef, frozenRequest,
  receiptMatchesDelivery, receiptSourceSessionId,
  resolveCompletionRequest, createExternalCompletionDelivery, PIN };
