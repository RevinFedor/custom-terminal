'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const readControls = new AsyncLocalStorage();
const CANCELLED = 'HISTORY_READ_CONSUMER_REVOKED';
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

function historyReadCancelled(reason = 'consumer-revoked') {
  const error = new Error('History read consumer revoked');
  error.code = CANCELLED;
  // Diagnostic categories only. Never retain an HTTP request or its payload.
  error.reason = typeof reason === 'string' && /^[\w-]{1,64}$/.test(reason) ? reason : 'consumer-revoked';
  return error;
}
function isHistoryReadCancelled(error) { return error?.code === CANCELLED; }
function isHistoryReadUnavailable(error) {
  return error?.code === 'HISTORY_READER_FENCE_UNAVAILABLE'
    || error?.code === 'HISTORY_READER_TRANSPORT_UNKNOWN'
    || error?.code === 'HISTORY_READER_PROCESS_EXITED';
}
function currentReadControl() { return readControls.getStore(); }
function withReadControl(control, operation) {
  return readControls.run(control, () => control?.runOwned ? control.runOwned(operation) : operation());
}

function createReadControl({ signal, assertSourceCurrent = () => {}, refreshSourceCurrent = () => {}, schedule = yieldTurn,
  forkSignal, adoptReadDependencies = () => {}, runOwned = operation => operation() } = {}) {
  const cleanup = new Set();
  let settled = false;
  const assertCurrent = () => {
    if (settled) throw historyReadCancelled('consumer-settled');
    if (signal?.aborted) throw historyReadCancelled();
    assertSourceCurrent();
  };
  return Object.freeze({ signal, assertCurrent, runOwned, adoptReadDependencies,
    forkSignal(nextSignal) { return forkSignal ? forkSignal(nextSignal)
      : createReadControl({ signal: nextSignal, assertSourceCurrent, refreshSourceCurrent, schedule, runOwned, adoptReadDependencies }); },
    async checkpoint() { assertCurrent(); await schedule(); refreshSourceCurrent(); assertCurrent(); },
    onSettled(release) {
      if (settled) { release(); return () => {}; }
      cleanup.add(release); return () => cleanup.delete(release);
    },
    finish() {
      if (settled) return; settled = true;
      for (const release of cleanup) { try { release(); } catch {} }
      cleanup.clear();
    },
  });
}

// A read Promise is not a demand lease. Every actual borrower owns one lease;
// A's HTTP disconnect must not revoke B's work. A job abandoned by its final
// borrower is removed immediately, so C cannot revive that generation.
function createDemandRegistry() {
  const jobs = new Map();
  let generation = 0;
  function run(key, consumerControl = currentReadControl(), factory) {
    consumerControl?.assertCurrent();
    let job = jobs.get(key);
    if (!job || job.abandoned) {
      const controller = new AbortController();
      job = { generation: ++generation, controller, consumers: new Set(), abandoned: false, settled: false };
      const jobControl = consumerControl?.forkSignal?.(controller.signal) || createReadControl({ signal: controller.signal });
      job.control = jobControl;
      jobs.set(key, job);
      // Start only after the first lease is registered. No factory observer is
      // allowed to run between the demand check and installing that lease.
      job.promise = Promise.resolve().then(() => withReadControl(jobControl, () => {
        jobControl.assertCurrent();
        return factory(jobControl);
      })).finally(() => {
        job.settled = true;
        if (jobs.get(key) === job) jobs.delete(key);
        if (!job.consumers.size) jobControl.finish();
      });
      // A last-demand cancellation may leave no user waiting for rejection.
      job.promise.catch(() => {});
    }
    const owner = job;
    return new Promise((resolve, reject) => {
      const lease = { done: false };
      const signal = consumerControl?.signal;
      const detach = () => {
        signal?.removeEventListener('abort', aborted);
        owner.consumers.delete(lease);
        if (!owner.settled && !owner.consumers.size) {
          owner.abandoned = true;
          if (jobs.get(key) === owner) jobs.delete(key);
          owner.controller.abort(historyReadCancelled('last-demand-revoked'));
        }
        if (owner.settled && !owner.consumers.size) owner.control.finish();
      };
      const finish = (error, value) => {
        if (lease.done) return;
        lease.done = true; detach();
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(historyReadCancelled());
      owner.consumers.add(lease);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      owner.promise.then(value => {
        if (lease.done) return; // A revoked borrower must not acquire resources on B's completion.
        try { consumerControl?.assertCurrent(); consumerControl?.adoptReadDependencies?.(owner.control); consumerControl?.assertCurrent(); finish(null, value); }
        catch (error) { finish(error); }
      }, error => finish(error));
    });
  }
  return Object.freeze({ run, get size() { return jobs.size; } });
}

// FIFO admission has removable waiters. A revoked waiter never acquires the
// lane later and cannot strand an admitted lease behind a cancelled Promise.
function createReadAdmission() {
  let active = false;
  const waiters = [];
  function acquire(control = currentReadControl()) {
    control?.assertCurrent();
    return new Promise((resolve, reject) => {
      const waiter = { control, resolve, reject, done: false };
      const cleanup = () => control?.signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (waiter.done) return;
        waiter.done = true; cleanup();
        const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
        reject(historyReadCancelled());
      };
      waiter.grant = () => {
        if (waiter.done) return false;
        try { control?.assertCurrent(); }
        catch (error) { waiter.done = true; cleanup(); reject(error); return false; }
        waiter.done = true; cleanup(); active = true;
        let released = false;
        resolve(() => {
          if (released) return; released = true;
          active = false;
          while (waiters.length) if (waiters.shift().grant()) break;
        });
        return true;
      };
      control?.signal?.addEventListener('abort', abort, { once: true });
      if (control?.signal?.aborted) { abort(); return; }
      if (active) waiters.push(waiter); else waiter.grant();
    });
  }
  return Object.freeze({ acquire, get active() { return active; }, get waiting() { return waiters.length; } });
}

module.exports = { CANCELLED, historyReadCancelled, isHistoryReadCancelled, isHistoryReadUnavailable,
  createReadControl, currentReadControl, withReadControl, createDemandRegistry, createReadAdmission };
