const {
  isScResearchNotFound,
  isScResearchTerminalStatus,
} = require('./sc-external-research-client');
const crypto = require('crypto');
const localDelivery = require('./external-research-completion-delivery');
const { buildTerminalUserEnvelope } = require('./sc-desktop-notification-client');
const { isOfflineBrowserPreflight, assertBrowserSelectionCapability } = require('./external-research-browser');

function isAuthoritativeClientFailure(error) {
  if (error?.operationalCheckOnly === true) return false;
  const status = Number(error?.status || error?.statusCode || 0);
  // Bridge HTTP throttling/unavailability is not a provider-native terminal verdict.
  if (error?.code === 'BROWSER_UNAVAILABLE') return false;
  if (['research_executor_update_required', 'research_upgrade_in_progress', 'research_reader_stale',
    'research_reader_generation_conflict', 'research_reader_recovery_in_progress', 'research_turn_recovery_unproven',
    'external_research_control_epoch_mismatch', 'external_research_operational_owner_mismatch'].includes(error?.code)) return false;
  return status >= 400 && status < 500 && status !== 404 && status !== 429;
}

function hasAcceptedExternalOutcome(run) {
  return run?.runKind === 'external-research' && run.resultComplete === true
    && ['done', 'error'].includes(run.externalResearchStatus)
    && ['completed', 'failed', 'waiting_descendants'].includes(run.status);
}

function hasLocalFinalization(run) {
  // A legacy local failure need not carry a modern SC terminal snapshot. Its
  // adopted delivery only reads old proof and reports the operational wait.
  return hasAcceptedExternalOutcome(run)
    || run?.externalResearchDelivery?.legacy === true && localDelivery.authorized(run);
}

function delayWithSignal(ms, signal, setTimer = setTimeout, clearTimer = clearTimeout) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimer(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimer(timer);
      resolve(false);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

class ExternalResearchCoordinator {
  constructor({
    store,
    client,
    emitChanges = () => {},
    finalizeSettled = async () => {},
    notifyBrowserOffline = async () => ({ ok: false, reason: 'outbox_unavailable' }),
    humanNotificationsEnabled = false,
    notifyOperational = () => {},
    logger = console,
    longPollMs = 60_000,
    retryBaseMs = 500,
    retryMaxMs = 15_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.store = store;
    this.client = client;
    this.emitChanges = emitChanges;
    this.finalizeSettled = finalizeSettled;
    this.notifyBrowserOffline = notifyBrowserOffline;
    this.humanNotificationsEnabled = humanNotificationsEnabled === true;
    this.notifyOperational = notifyOperational;
    this.logger = logger;
    this.longPollMs = longPollMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.watchers = new Map();
    this.stopped = false;
    this.deliveryTrailing = new Set();
  }

  watch(runId, reason = 'watch') {
    if (!runId || this.stopped) return null;
    const existing = this.watchers.get(runId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this._run(runId, reason, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.logger.warn?.('[ExternalResearch] monitor failed run=' + runId
            + ' error=' + String(error?.message || error));
        }
      })
      .finally(() => {
        if (this.watchers.get(runId)?.controller === controller) this.watchers.delete(runId);
        if (this.deliveryTrailing.delete(runId) && !this.stopped) this.wakeDelivery(runId, 'completion-trailing');
      });
    this.watchers.set(runId, { controller, promise });
    return promise;
  }

  wakeDelivery(runId, reason = 'completion-wake') {
    if (this.stopped) return;
    if (this.watchers.has(runId)) { this.deliveryTrailing.add(runId); return; }
    // Read-only wake classification; a terminal delivery never calls start.
    void this.store.getInternal(runId).then(run => {
      if (!this.stopped && run?.externalResearchDelivery && localDelivery.authorized(run)) this.watch(runId, reason);
    }).catch(error => this.logger.warn?.('[ExternalResearchDelivery] wake failed run=' + runId + ' code=' + String(error.code || 'unavailable')));
  }

  async stop() {
    this.stopped = true;
    this.deliveryTrailing.clear();
    const pending = [];
    for (const watcher of this.watchers.values()) {
      watcher.controller.abort();
      pending.push(watcher.promise);
    }
    this.watchers.clear();
    await Promise.allSettled(pending);
  }

  async readStatus(runId) {
    const run = await this.store.getInternal(runId);
    if (!run || run.runKind !== 'external-research' || !run.externalResearchJobId) return null;
    try {
      return await this.client.status(run.externalResearchJobId, { waitMs: 0 });
    } catch (error) {
      if (isScResearchNotFound(error)) return null;
      throw error;
    }
  }

  async recheckOperational(runId, scope, signal) {
    if (this.stopped || signal?.aborted || !await this.store.externalOperationalRearmCheckCurrent(runId, scope)) return null;
    try {
      if (typeof this.client.operationalRecheck !== 'function') throw Object.assign(
        new Error('SC correlated recheck is unavailable'), { code: 'sc_research_operational_recheck_unavailable' });
      const result = await this.client.operationalRecheck(scope.jobId, { checkId: scope.checkId,
        controlEpoch: scope.controlEpoch, browserInstanceId: scope.browserInstanceId, signal });
      if (this.stopped || signal?.aborted) return null;
      const applied = await this.store.completeExternalOperationalRearmCheck(runId, scope, result);
      if (applied?.run) this.emitChanges([applied.run], 'external-research-maintenance-recheck');
      return applied;
    } catch (error) {
      if (this.stopped || signal?.aborted) return null;
      const failed = await this.store.recordExternalOperationalRearmFailure(runId, scope, error);
      if (failed?.run) this.emitChanges([failed.run], 'external-research-maintenance-recheck-unavailable');
      return failed;
    } finally {
      if (!this.stopped && !signal?.aborted) this.notifyOperational(runId);
    }
  }

  async _run(runId, reason, signal) {
    let failures = 0;
    let preferStatus = true;
    let localFinalizationPending = false;
    while (!signal.aborted && !this.stopped) {
      const run = await this.store.getInternal(runId);
      if (!run || run.runKind !== 'external-research') return;
      if (run.status === 'cancelled') return;
      const delivering = run.externalResearchDelivery && localDelivery.authorized(run);
      if (['completed', 'failed'].includes(run.status) && !localFinalizationPending && !delivering) return;
      if (delivering) localFinalizationPending = true;
      const intent = run.externalResearchIntent;
      const jobId = run.externalResearchJobId;
      if ((!intent || !jobId) && !localFinalizationPending) {
        await this._fail(runId, 'external research intent is unavailable', 'external_research_intent_unavailable', signal);
        return;
      }

      let operationalRead = null;
      try {
        if (localFinalizationPending) {
          // SC's original terminal evidence is already held in this run.
          // Retry only its local commit/finalizer, never start/status/Send.
          const retryAt = run.externalResearchDelivery?.retryAt;
          if (retryAt > Date.now() && !await delayWithSignal(Math.min(this.retryMaxMs, retryAt - Date.now()), signal, this.setTimer, this.clearTimer)) return;
          await this.store.persistStrict();
          if (signal.aborted || this.stopped) return;
          const current = await this.store.getInternal(runId);
          if (!hasLocalFinalization(current) || current.externalResearchJobId !== jobId) return;
          const durable = await this.store.get(runId);
          if (signal.aborted || this.stopped) return;
          this.emitChanges([durable], reason + '-local-finalization');
          if (['completed', 'failed'].includes(current.status)) await this.finalizeSettled(durable, reason + '-terminal');
          const after = await this.store.getInternal(runId);
          if (localDelivery.pending(after)) {
            if (!after.externalResearchDelivery.retryAt) throw Object.assign(new Error('Local completion is pending'), { code: 'external_completion_pending' });
            continue;
          }
          return;
        }
        operationalRead = await this.store.captureExternalOperationalRead?.(runId) || null;
        let snapshot = null;
        if (preferStatus) {
          try {
            snapshot = await this.client.status(jobId, {
              waitMs: run.externalResearchAcceptedAt && !run.externalResearchTransportError
                ? this.longPollMs
                : 0,
              signal,
            });
          } catch (error) {
            if (!isScResearchNotFound(error)) throw error;
          }
        }

        if (!snapshot) {
          if (run.externalResearchContinuedFromRunId && !run.externalResearchBrowserInstanceId
            && !run.externalResearchExpectedBrowserInstanceId) {
            const { continuationRequest, resolveExternalResearchBrowserBinding } = require('./external-research-request');
            const previous = await this.store.getInternal(run.externalResearchContinuedFromRunId);
            continuationRequest(previous, { prompt: intent.prompt });
            const capabilities = await this.client.capabilities({ signal });
            assertBrowserSelectionCapability(capabilities);
            const owner = await resolveExternalResearchBrowserBinding({ request: intent, previous,
              capabilities, client: this.client, store: this.store });
            if (!await this.store.patch(runId, { externalResearchExpectedBrowserInstanceId: owner }, { unlessTerminal: true })) return;
            await this.store.persistStrict();
          }
          const attempt = Number(run.externalResearchStartAttempt || 0) + 1;
          const attempting = await this.store.patch(runId, {
            status: 'sending',
            externalResearchStartAttempt: attempt,
            externalResearchStartAttemptedAt: Date.now(),
            externalResearchStartHadUncertainty: run.externalResearchStartPending === true
              || run.externalResearchDeliveryUnknown === true || !!run.externalResearchAcceptedAt,
            externalResearchStartPending: true,
            externalResearchTransportError: null,
            externalResearchTransportCode: null,
            deliveryDeferredReason: null,
          }, { unlessTerminal: true });
          if (!attempting) return;
          await this.store.persistStrict();
          const current = await this.store.getInternal(runId);
          if (signal.aborted || this.stopped || !current
            || current.runKind !== 'external-research' || current.externalResearchJobId !== jobId
            || ['completed', 'failed', 'cancelled'].includes(current.status)) return;
          const browserPin = current.externalResearchBrowserInstanceId;
          const expectedBrowserPin = current.externalResearchExpectedBrowserInstanceId;
          this.emitChanges([attempting], reason + '-start-attempt');
          snapshot = await this.client.start({
            jobId,
            provider: intent.provider,
            prompt: intent.prompt,
            options: intent.options,
            files: intent.files,
            conversationUrl: intent.conversationUrl,
            browserId: browserPin || expectedBrowserPin || intent.browserId,
          }, { signal, beforeStart: async () => {
            const latest = await this.store.getInternal(runId);
            return !signal.aborted && !this.stopped && latest?.runKind === 'external-research'
              && latest.externalResearchJobId === jobId
              && !['completed', 'failed', 'cancelled'].includes(latest.status)
              && latest.externalResearchBrowserInstanceId === browserPin
              && latest.externalResearchExpectedBrowserInstanceId === expectedBrowserPin;
          } });
        }

        if (signal.aborted) return;
        if (!snapshot || snapshot.id !== jobId) {
          await this._fail(runId, 'SC Desktop returned a different research job id', 'external_research_job_mismatch', signal);
          return;
        }
        failures = 0;
        preferStatus = true;
        localFinalizationPending = isScResearchTerminalStatus(snapshot.status);
        const applied = await this.store.applyExternalResearchSnapshot(runId, snapshot, { operationalRead });
        if (signal.aborted || this.stopped) return;
        if (applied.rearmCheck) await this.recheckOperational(runId, applied.rearmCheck, signal);
        if (signal.aborted || this.stopped) return;
        this.notifyOperational(runId);
        this.emitChanges(applied.changed, reason + '-status');
        for (const settled of applied.settled || []) {
          await this.finalizeSettled(settled, reason + '-terminal');
        }
        const deliveryAfter = await this.store.getInternal(runId);
        if (localDelivery.pending(deliveryAfter)) { localFinalizationPending = true; continue; }
        localFinalizationPending = false;
        if (isScResearchTerminalStatus(snapshot.status) || applied.terminal) return;
      } catch (error) {
        if (signal.aborted) return;
        const latest = localFinalizationPending ? await this.store.getInternal(runId) : null;
        if (localFinalizationPending && hasLocalFinalization(latest) && latest.externalResearchJobId === jobId) {
          failures += 1;
          const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(8, failures - 1)));
          this.logger.warn?.('[ExternalResearch] local finalization pending run=' + runId
            + ' code=' + String(error?.code || 'external_research_local_finalization_unavailable'));
          if (!await delayWithSignal(retryMs, signal, this.setTimer, this.clearTimer)) return;
          continue;
        }
        localFinalizationPending = false;
        if (isAuthoritativeClientFailure(error)) {
          await this._fail(runId, String(error?.message || error), error?.code || 'external_research_rejected', signal);
          return;
        }
        failures += 1;
        preferStatus = true;
        const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(8, failures - 1)));
        let waiting = null;
        if (isOfflineBrowserPreflight(error)
          && (intent.browserId || run.externalResearchExpectedBrowserInstanceId)) {
          try {
            waiting = await this.store.markExternalResearchBrowserWait(runId, {
              jobId, owner: error.body.browserInstanceId.toLowerCase(), retryAt: Date.now() + retryMs,
              operationalRead,
              message: 'Selected research browser profile is offline; waiting without submitting',
            });
          } catch (waitError) {
            if (isAuthoritativeClientFailure(waitError)) {
              await this._fail(runId, waitError.message, waitError.code, signal);
              return;
            }
            error = waitError;
          }
        }
        if (waiting) {
          this.logger.log?.('[ExternalResearch] browser-wait run=' + runId + ' job=' + jobId
            + ' browser=' + waiting.externalResearchExpectedBrowserInstanceId + ' notSubmitted=true');
          this.emitChanges([waiting], reason + '-browser-wait');
          try { if (!signal.aborted && !this.stopped) await this._noticeBrowserOffline(runId, jobId); }
          catch (cause) {
            const noticeWait = await this.store.patch(runId, { externalResearchBrowserNoticeError:
              String(cause?.code || 'outbox_unavailable') }, { unlessTerminal: true });
            this.emitChanges(noticeWait ? [noticeWait] : [], reason + '-browser-notice-unavailable');
            this.logger.warn?.('[ExternalResearch] browser notice unavailable run=' + runId
              + ' code=' + String(cause?.code || cause?.message || cause));
          }
        } else {
          waiting = await this.store.markExternalResearchTransportWait(runId, {
            error: String(error?.message || error), code: error?.code || null, retryAt: Date.now() + retryMs,
            operationalRead,
          });
          this.emitChanges(waiting ? [waiting] : [], reason + '-transport-wait');
        }
        if (typeof this.store.recordExternalOperationalFailure === 'function') {
          const operational = await this.store.recordExternalOperationalFailure(runId, {
            phase: run.externalResearchAcceptedAt ? 'observing' : 'opening',
            reason: waiting?.deliveryDeferredReason === 'waiting-for-browser' ? 'browser_unavailable' : 'transport_unavailable',
            code: error?.code || 'sc_research_transport_unavailable', retryAt: Date.now() + retryMs,
            notificationGraceMs: 60000, operationalRead });
          this.emitChanges(operational ? [operational] : [], reason + '-operational');
          this.notifyOperational(runId);
        }
        const continued = await delayWithSignal(
          retryMs,
          signal,
          this.setTimer,
          this.clearTimer,
        );
        if (!continued) return;
      } finally {
        this.store.releaseExternalOperationalRead?.(operationalRead);
      }
    }
  }

  async _noticeBrowserOffline(runId, jobId) {
    if (this.stopped || !this.humanNotificationsEnabled) return;
    let run = await this.store.getInternal(runId);
    if (!run || run.externalResearchMaintenanceOperationId || run.externalResearchJobId !== jobId || run.externalResearchBrowserNoticeQueuedAt
      || run.deliveryDeferredReason !== 'waiting-for-browser' || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    if (!run.externalResearchBrowserNotice) {
      const profile = run.externalResearchIntent?.browserId === 'chrome' ? 'Chrome'
        : run.externalResearchIntent?.browserId === 'yandex' ? 'Яндекс' : run.externalResearchExpectedBrowserInstanceId;
      const requestId = 'research-browser-offline:' + crypto.createHash('sha256')
        .update(JSON.stringify([runId, jobId, run.externalResearchExpectedBrowserInstanceId])).digest('hex');
      const envelope = buildTerminalUserEnvelope({ requestId, tabId: run.sourceTabId,
        projectId: run.sourceProjectId, tabName: run.sourceTabName || 'Terminal',
        createdAt: run.externalResearchBrowserOfflineAt, waitSeconds: 0,
        text: 'External Research: выбранный профиль ' + profile + ' недоступен. Запрос ' + runId
          + ' ещё не отправлен. Откройте этот браузер с настроенным SC Parser; сохранённая задача продолжит ожидание без смены профиля.' });
      if (!await this.store.patch(runId, { externalResearchBrowserNotice: envelope,
        externalResearchBrowserNoticeRequestId: envelope.requestId }, { unlessTerminal: true })) return;
      await this.store.persistStrict();
    }
    run = await this.store.getInternal(runId);
    if (this.stopped || !run || run.externalResearchJobId !== jobId || run.deliveryDeferredReason !== 'waiting-for-browser'
      || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    const result = await this.notifyBrowserOffline(run.externalResearchBrowserNotice);
    if (result?.ok === true) {
      const notified = await this.store.patch(runId, { externalResearchBrowserNoticeQueuedAt: Date.now(),
        externalResearchBrowserNoticeError: null }, { unlessTerminal: true });
      await this.store.persistStrict();
      this.emitChanges(notified ? [notified] : [], 'external-research-browser-notice-queued');
      if (notified) this.logger.log?.('[ExternalResearch] browser-notice-queued run=' + runId
        + ' request=' + run.externalResearchBrowserNotice.requestId + ' channel=telegram (not delivery proof)');
    } else {
      throw Object.assign(new Error('Research browser offline notice could not be queued'),
        { code: result?.reason || 'outbox_unavailable' });
    }
  }

  async _fail(runId, message, code, signal) {
    let failures = 0;
    let pending = null;
    while (!this.stopped && !signal?.aborted) {
      try {
        const failed = await this.store.failExternalResearch(runId, { message, code });
        if (this.stopped || signal?.aborted) return;
        pending ||= (failed.settled || []).map(run => run.runId);
        this.emitChanges(failed.changed, 'external-research-failed');
        while (pending.length) {
          const current = await this.store.get(pending[0]);
          if (this.stopped || signal?.aborted) return;
          if (current && ['completed', 'failed'].includes(current.status)) {
            await this.finalizeSettled(current, 'external-research-failed');
          }
          pending.shift();
        }
        return;
      } catch (error) {
        if (this.stopped || signal?.aborted) return;
        failures += 1;
        this.logger.warn?.('[ExternalResearch] local failure finalization pending run=' + runId
          + ' code=' + String(error?.code || 'external_research_local_finalization_unavailable'));
        const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(8, failures - 1)));
        if (!await delayWithSignal(retryMs, signal, this.setTimer, this.clearTimer)) return;
      }
    }
  }
}

module.exports = {
  ExternalResearchCoordinator,
  delayWithSignal,
  isAuthoritativeClientFailure,
};
