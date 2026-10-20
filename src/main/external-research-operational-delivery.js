'use strict';
const { canDeliver, canReport, hash } = require('./external-research-operational');
const { isDeepStrictEqual } = require('node:util');
const cancelled = () => Object.assign(new Error('Operational notice is no longer authorized'),
  { code: 'external_research_operational_cancelled', submitted: false, statusCode: 409 });
function noticeRef(notice) {
  return { version: 1, runId: notice.runId, noticeId: notice.id, jobId: notice.jobId,
    origin: notice.origin, runCreatedAt: notice.runCreatedAt,
    ...(notice.origin === 'sc' ? { scControlEpoch: notice.scControlEpoch } : { localEpisodeId: notice.localEpisodeId }),
    bodyHash: notice.bodyHash, preparedPromptHash: notice.preparedPromptHash, cancelRevision: notice.cancelRevision };
}
async function resolveOperationalRequest(store, request) {
  const reserved = String(request.source || '').startsWith('research-operational:');
  if (!reserved && !request.operationalNoticeRef) return null;
  const ref = request.operationalNoticeRef;
  if (!reserved || ref?.version !== 1) throw cancelled();
  const run = await store.getInternal(ref.runId), notice = run?.externalResearchOperational?.notices?.[ref.noticeId];
  if (!notice || !canDeliver(run, notice) || !isDeepStrictEqual(ref, noticeRef(notice))
    || request.source !== 'research-operational:' + notice.runId + ':' + notice.id
    || request.tabId !== notice.sourceTabId || request.handoffId !== notice.handoffId
    || request.sendOperationKey !== notice.operationKey || request.sendSurface !== 'desktop-history'
    || request.restoreClosedTab === true
    || request.ownership !== 'project' || request.prompt !== notice.preparedPrompt
    || hash(request.prompt) !== notice.preparedPromptHash || hash(notice.body) !== notice.bodyHash
    || !isDeepStrictEqual(request.expectedTarget, notice.sourceTarget)
    || request.provider !== notice.sendOptions?.provider || request.queue !== notice.sendOptions?.queue
    || !isDeepStrictEqual(request.statusAtSend ?? null, notice.sendOptions?.statusAtSend ?? null)) throw cancelled();
  return { run, notice, prepareSend: async () => { await resolveOperationalRequest(store, request); } };
}
function createOperationalDelivery({ store, prepare, pin, send, lookup, classify, providerQueued = result => result?.providerQueueAccepted === true,
  onBlocked = async () => {}, humanNotificationsEnabled = false, logger = console }) {
  const inflight = new Map(), indexed = new Map();
  let stopped = false;
  const notifyBlocked = async (run, notice) => {
    if (humanNotificationsEnabled === true && !run.externalResearchMaintenanceOperationId) await onBlocked(run, notice);
  };
  function schedule(runId) {
    if (stopped || inflight.has(runId)) return;
    const promise = deliverRun(runId).catch(async error => {
      logger.warn?.('[ResearchOperational] delivery pending run=' + runId + ' code=' + String(error.code || 'unavailable'));
      const run = await store.getInternal(runId);
      const notice = run?.externalResearchOperational?.notices?.[error.operationalNoticeId];
      if (notice) {
        try { await store.markExternalOperationalDelivery(runId, notice.id, {
          lastError: error.code || 'operational_delivery_unavailable',
          ...(notice.delivery === 'sending' ? { delivery: 'unknown' } : {}) }); } catch {}
        if (canDeliver(run, notice)) await notifyBlocked(run, notice);
      }
    }).finally(() => { if (inflight.get(runId) === promise) inflight.delete(runId); });
    promise.catch(error => logger.warn?.('[ResearchOperational] durable notification unavailable run=' + runId
      + ' code=' + String(error.code || 'unavailable')));
    inflight.set(runId, promise);
  }
  async function saveOutcome(runId, noticeId, result) {
    const proof = classify(result);
    const delivery = providerQueued(result) || proof.state === 'confirmed' ? 'sent'
      : proof.state === 'application-queued' ? 'queued'
        : ['not-submitted', 'provider-not-accepted'].includes(proof.state) ? 'waiting_for_input' : 'unknown';
    const patch = { delivery,
      attemptId: result?.attemptId || result?.sendAttemptId || null,
      observedReceipt: { state: proof.state, submitted: proof.submitted,
        operationKey: result?.operationKey || null, attemptId: result?.attemptId || result?.sendAttemptId || null },
      lastError: delivery === 'sent' ? null : result?.code || proof.state };
    const run = await store.getInternal(runId), notice = run?.externalResearchOperational?.notices?.[noticeId];
    if (!(notice && isDeepStrictEqual(notice.observedReceipt, patch.observedReceipt)
      && notice.lastError === patch.lastError && (notice.delivery === delivery || notice.delivery === 'suppressed'))) {
      await store.markExternalOperationalDelivery(runId, noticeId, patch);
    }
    if (['waiting_for_input', 'unknown'].includes(delivery)) {
      // A returned readiness/draft refusal is not an exception, but still
      // leaves the parent unaware. The human outbox deduplicates this exact
      // episode; a normal busy-parent FIFO admission does not trigger it.
      const current = await store.getInternal(runId), latest = current?.externalResearchOperational?.notices?.[noticeId];
      if (latest && canDeliver(current, latest)) await notifyBlocked(current, latest);
    }
  }
  async function deliverRun(runId) {
    let run = await store.getInternal(runId);
    for (const original of Object.values(run?.externalResearchOperational?.notices || {})) {
      if (stopped) return;
      indexed.set(original.operationKey, { runId, noticeId: original.id });
      run = await store.getInternal(runId);
      let notice = run?.externalResearchOperational?.notices?.[original.id];
      if (!notice) continue;
      try {
      if (!canDeliver(run, notice) && notice.origin === 'noted-delivery' && canReport(run, notice)) {
        await notifyBlocked(run, notice);
      }
      if (notice.delivery !== 'pending') {
        const previous = await lookup(notice);
        if (previous?.result) { await saveOutcome(runId, notice.id, previous.result); continue; }
        // Absence only authorizes the SAME enqueue when a pre-existing durable
        // retention pin proves that an old receipt could not have been pruned.
        if (!previous?.absentBeforeAdmission || !notice.receiptRetentionPinned) continue;
      }
      if (!canDeliver(run, notice)) {
        continue;
      }
      if (!notice.preparedPrompt) {
        const prepared = await prepare(run, notice);
        await store.markExternalOperationalDelivery(runId, notice.id, { preparedPrompt: prepared.prompt, sendOptions: prepared.sendOptions });
      }
      run = await store.getInternal(runId); notice = run.externalResearchOperational.notices[notice.id];
      if (!canDeliver(run, notice)) continue;
      pin(notice);
      await store.markExternalOperationalDelivery(runId, notice.id, { delivery: 'sending', receiptRetentionPinned: true });
      run = await store.getInternal(runId); notice = run.externalResearchOperational.notices[notice.id];
      if (!canDeliver(run, notice)) continue;
      const request = { tabId: notice.sourceTabId, prompt: notice.preparedPrompt, handoffId: notice.handoffId,
        sendOperationKey: notice.operationKey, sendSurface: 'desktop-history', ownership: 'project',
        source: 'research-operational:' + runId + ':' + notice.id, operationalNoticeRef: noticeRef(notice),
        expectedTarget: notice.sourceTarget, provider: notice.sendOptions.provider,
        sessionId: notice.sourceTarget?.sessionId || null, queue: notice.sendOptions.queue,
        statusAtSend: notice.sendOptions.statusAtSend ?? null, workContextPrepared: true };
      await resolveOperationalRequest(store, request);
      const result = await send(request);
      await saveOutcome(runId, notice.id, result);
      } catch (error) { error.operationalNoticeId = notice.id; throw error; }
    }
  }
  async function observeReceipt(operationKey, result) {
    const ref = indexed.get(operationKey);
    if (ref) await saveOutcome(ref.runId, ref.noticeId, result);
  }
  async function restore(runs) {
    for (const run of runs) {
      if (stopped) return;
      const current = await store.getInternal(run.runId);
      if (!current?.externalResearchOperational) continue;
      for (const n of Object.values(current?.externalResearchOperational?.notices || {})) indexed.set(n.operationKey, { runId: run.runId, noticeId: n.id });
      schedule(run.runId);
    }
  }
  async function reportBlocked(runId) {
    const run = await store.getInternal(runId);
    for (const notice of Object.values(run?.externalResearchOperational?.notices || {})) {
      // An UNKNOWN final input may itself occupy the source FIFO. Its local
      // DELIVERING warning still uses the existing independent human outbox.
      if (notice.origin === 'noted-delivery' && canReport(run, notice)) await notifyBlocked(run, notice);
    }
  }
  return { reportBlocked, schedule, restore, observeReceipt, resolve: request => resolveOperationalRequest(store, request),
    stop: () => { stopped = true; },
    // Owned tests can await current work without introducing a production poll.
    drain: () => Promise.all([...inflight.values()]) };
}
module.exports = { createOperationalDelivery, resolveOperationalRequest, noticeRef };
