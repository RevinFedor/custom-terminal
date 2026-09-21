'use strict';

const { performance } = require('node:perf_hooks');

// A read transaction, not a Send coordinator or a writer. The caller supplies
// the existing owner proof and event sources. No operation can renew its clock
// or silently adopt another owner after an await.
class AgentInputObservationError extends Error {
  constructor(reason, phase) {
    super(reason);
    this.name = 'AgentInputObservationError';
    this.reason = reason;
    this.phase = phase;
  }
}

function createAgentInputObservation({
  timeoutMs, isCurrent, subscribe = () => () => {},
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (typeof isCurrent !== 'function') throw new TypeError('isCurrent required');
  const startedAt = now();
  const budget = Number(timeoutMs);
  const deadline = startedAt + (Number.isFinite(budget) ? Math.max(0, Math.min(budget, 2_147_483_647)) : 0);
  const controller = new AbortController();
  let stopped = null, phase = 'initial', version = 0, disposed = false;
  let cleanup = null, timer = null, resolveStopped;
  const changed = new Set();
  const stopping = new Promise(resolve => { resolveStopped = resolve; });
  const stop = reason => {
    if (stopped) return;
    stopped = new AgentInputObservationError(reason, phase);
    resolveStopped({ error: stopped });
    controller.abort();
    for (const resolve of [...changed]) resolve();
    changed.clear();
  };
  const checkOwner = () => {
    let current;
    try { current = isCurrent(); } catch { current = false; }
    if (!current) {
      stop('owner-changed');
      // Revocation wins even if the deadline signal won the earlier race.
      throw new AgentInputObservationError('owner-changed', phase);
    }
    if (stopped && stopped.reason !== 'deadline') throw stopped;
  };
  const checkpoint = () => {
    checkOwner();
    if (!stopped && now() >= deadline) stop('deadline');
    if (stopped) throw stopped;
  };
  const wake = ({ cancelReason = null } = {}) => {
    if (disposed || stopped) return;
    version++;
    if (cancelReason) stop(cancelReason);
    else { try { checkOwner(); } catch {} }
    for (const resolve of [...changed]) resolve();
    changed.clear();
  };
  try { cleanup = subscribe(wake); } catch { stop('subscription-failed'); }
  timer = setTimer(() => stop('deadline'), Math.max(0, deadline - now()));
  const context = {
    startedAt, deadline, signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - now()),
    revision: () => version,
    cancel: stop,
    checkpoint,
    async step(name, action) {
      phase = name;
      checkpoint();
      const work = Promise.resolve().then(() => {
        checkpoint();
        return action(context);
      }).then(value => ({ value }), error => ({ error }));
      const result = await Promise.race([work, stopping]);
      checkpoint();
      if (result.error) throw result.error;
      return result.value;
    },
    async waitForChange(observedVersion) {
      return context.step('waiting-frame', () => new Promise(resolve => {
        if (version !== observedVersion || stopped) resolve();
        else changed.add(resolve);
      }));
    },
    finalRead(read) {
      // A deadline is not evidence about input. Only one synchronous read of
      // the still-owned current frame may settle the boundary; no new await.
      checkOwner();
      const value = read();
      if (value && typeof value.then === 'function') throw new TypeError('finalRead must be synchronous');
      checkOwner();
      return value;
    },
    metadata: status => ({ status, phase, elapsedMs: Math.max(0, now() - startedAt),
      budgetMs: deadline - startedAt }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      try { cleanup?.(); }
      catch (error) { console.warn('[AgentInputObservation] cleanup failed:', error?.message || error); }
      finally { stop('disposed'); }
    },
  };
  return context;
}

async function observeAgentInput({ observation, probe, finalProbe, isSettled, shouldWait }) {
  let last = null, checks = 0;
  try {
    for (;;) {
      const revision = observation.revision();
      last = await observation.step('reading', () => probe(observation));
      checks++;
      if (!shouldWait(last)) {
        return { value: last, checks, observation: observation.metadata(isSettled(last) ? 'settled' : 'unresolved') };
      }
      await observation.waitForChange(revision);
    }
  } catch (error) {
    if (error?.reason === 'deadline' && typeof finalProbe === 'function') {
      try {
        last = observation.finalRead(finalProbe); checks++;
        if (isSettled(last)) return { value: last, checks, observation: observation.metadata('settled') };
      } catch (finalError) { error = finalError; }
    }
    const reason = error?.reason || 'read-failed';
    const status = reason === 'deadline' ? 'expired'
      : ['owner-changed', 'process-stopping', 'process-exited', 'input-changed'].includes(reason) ? 'superseded'
      : reason === 'send-cancelled' ? 'cancelled' : 'failed';
    return { value: null, lastObservation: last, checks, reason,
      error: error?.message || String(error), observation: observation.metadata(status) };
  } finally {
    observation.dispose();
  }
}

module.exports = { AgentInputObservationError, createAgentInputObservation, observeAgentInput };
