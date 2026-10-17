const {
  isScResearchNotFound,
  isScResearchTerminalStatus,
} = require('./sc-external-research-client');

function isAuthoritativeClientFailure(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return status >= 400 && status < 500 && status !== 404;
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
          const attempt = Number(run.externalResearchStartAttempt || 0) + 1;
          const attempting = await this.store.patch(runId, {
            status: 'sending',
            externalResearchStartAttempt: attempt,
            externalResearchStartAttemptedAt: Date.now(),
            externalResearchTransportError: null,
            deliveryDeferredReason: null,
          }, { unlessTerminal: true });
          if (!attempting) return;
          await this.store.persistStrict();
          const current = await this.store.getInternal(runId);
          if (signal.aborted || this.stopped || !current
            || current.runKind !== 'external-research' || current.externalResearchJobId !== jobId
            || ['completed', 'failed', 'cancelled'].includes(current.status)) return;
          this.emitChanges([attempting], reason + '-start-attempt');
          snapshot = await this.client.start({
            jobId,
            provider: intent.provider,
            prompt: intent.prompt,
            options: intent.options,
            files: intent.files,
            conversationUrl: intent.conversationUrl,
          }, { signal });
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
        const waiting = await this.store.markExternalResearchTransportWait(runId, {
          error: String(error?.message || error),
          retryAt: Date.now() + retryMs,
        });
        this.emitChanges(waiting ? [waiting] : [], reason + '-transport-wait');
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
