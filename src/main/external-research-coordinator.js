const {
  isScResearchNotFound,
  isScResearchTerminalStatus,
} = require('./sc-external-research-client');
const crypto = require('crypto');
const { buildTerminalUserEnvelope } = require('./sc-desktop-notification-client');
const { isOfflineBrowserPreflight, assertBrowserSelectionCapability } = require('./external-research-browser');

function isAuthoritativeClientFailure(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  // Bridge HTTP throttling/unavailability is not a provider-native terminal verdict.
  if (error?.code === 'BROWSER_UNAVAILABLE') return false;
  return status >= 400 && status < 500 && status !== 404 && status !== 429;
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
    this.logger = logger;
    this.longPollMs = longPollMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.watchers = new Map();
    this.stopped = false;
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
      });
    this.watchers.set(runId, { controller, promise });
    return promise;
  }

  async stop() {
    this.stopped = true;
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

  async _run(runId, reason, signal) {
    let failures = 0;
    let preferStatus = true;
    while (!signal.aborted && !this.stopped) {
      const run = await this.store.getInternal(runId);
      if (!run || run.runKind !== 'external-research') return;
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
      const intent = run.externalResearchIntent;
      const jobId = run.externalResearchJobId;
      if (!intent || !jobId) {
        await this._fail(runId, 'external research intent is unavailable', 'external_research_intent_unavailable');
        return;
      }

      try {
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
          await this._fail(runId, 'SC Desktop returned a different research job id', 'external_research_job_mismatch');
          return;
        }
        failures = 0;
        preferStatus = true;
        const applied = await this.store.applyExternalResearchSnapshot(runId, snapshot);
        this.emitChanges(applied.changed, reason + '-status');
        for (const settled of applied.settled || []) {
          await this.finalizeSettled(settled, reason + '-terminal');
        }
        if (isScResearchTerminalStatus(snapshot.status) || applied.terminal) return;
      } catch (error) {
        if (signal.aborted) return;
        if (isAuthoritativeClientFailure(error)) {
          await this._fail(runId, String(error?.message || error), error?.code || 'external_research_rejected');
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
              message: 'Selected research browser profile is offline; waiting without submitting',
            });
          } catch (waitError) {
            if (isAuthoritativeClientFailure(waitError)) {
              await this._fail(runId, waitError.message, waitError.code);
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
          });
          this.emitChanges(waiting ? [waiting] : [], reason + '-transport-wait');
        }
        const continued = await delayWithSignal(
          retryMs,
          signal,
          this.setTimer,
          this.clearTimer,
        );
        if (!continued) return;
      }
    }
  }

  async _noticeBrowserOffline(runId, jobId) {
    if (this.stopped) return;
    let run = await this.store.getInternal(runId);
    if (!run || run.externalResearchJobId !== jobId || run.externalResearchBrowserNoticeQueuedAt
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

  async _fail(runId, message, code) {
    const failed = await this.store.failExternalResearch(runId, { message, code });
    this.emitChanges(failed.changed, 'external-research-failed');
    for (const settled of failed.settled || []) {
      await this.finalizeSettled(settled, 'external-research-failed');
    }
  }
}

module.exports = {
  ExternalResearchCoordinator,
  delayWithSignal,
  isAuthoritativeClientFailure,
};
