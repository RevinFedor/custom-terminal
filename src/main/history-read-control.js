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
//
// Concurrency is bounded by the COST of the admitted work, not by its count.
// The lane exists because parsing a journal holds its whole record graph in
// memory, and several large parses at once exceed the reader process budget —
// a V8 heap OOM there is fatal and uncatchable. But the old "exactly one at a
// time" rule charged that protection to everyone: measured on 31.10, a tab
// with 51 records waited 233s behind a large parse, while the same work in a
// quiet moment took 2s, and admission waits reached 11.7s. Small sources do
// not threaten the budget, so they are admitted alongside a large one.
//
// `weight` is the source size in bytes (0 when unknown). An unknown or
// oversized caller is treated as a full-lane occupant, so the default stays
// exactly as strict as before.
const DEFAULT_ADMISSION_CAPACITY = 64 * 1024 * 1024;

function createReadAdmission({ capacity = DEFAULT_ADMISSION_CAPACITY } = {}) {
  let used = 0, activeCount = 0;
  const waiters = [];
  // Cost of one admitted read. Unknown size must not look free: it is charged
  // the whole lane, which reproduces the previous serialized behaviour.
  const costOf = weight => Number.isFinite(weight) && weight > 0
    ? Math.min(capacity, Math.ceil(weight)) : capacity;
  // First fit with bounded aging. Strict head-of-line order would barely help:
  // in the 31.10 burst 42 tabs asked at once, so a cheap read would still sit
  // behind whichever expensive one happened to arrive first. So a read that
  // fits in the remaining budget is admitted even if a larger one is queued
  // ahead of it — that is exactly the 51-record tab no longer waiting 233s.
  //
  // Letting that run unbounded would invert the unfairness and starve the
  // large read, so the head counts how many times it has been passed; after
  // MAX_HEAD_SKIPS the lane admits nobody else until the head gets in.
  const MAX_HEAD_SKIPS = 8;
  const fits = cost => activeCount === 0 || used + cost <= capacity;
  // The head's skip budget must also bind a BRAND-NEW caller, not just the
  // queue: admission has a direct path for an arrival that fits, and without
  // this check a steady stream of fresh cheap reads would pass the head
  // forever while the queue-side counter never moved.
  const mayOvertakeQueue = () => waiters.length === 0 || waiters[0].skipped < MAX_HEAD_SKIPS;
  const pump = () => {
    let progressed = true;
    while (progressed && waiters.length) {
      progressed = false;
      const head = waiters[0];
      const headFits = fits(head.cost);
      if (headFits) {
        waiters.shift();
        if (head.grant()) { progressed = true; continue; }
        progressed = true; // a revoked waiter must not park the queue
        continue;
      }
      if (head.skipped >= MAX_HEAD_SKIPS) return;
      // Admit the first later waiter that fits in what is left.
      const index = waiters.findIndex((waiter, position) =>
        position > 0 && used + waiter.cost <= capacity);
      if (index < 0) return;
      const [passer] = waiters.splice(index, 1);
      head.skipped++;
      if (passer.grant()) progressed = true;
      else progressed = true;
    }
  };
  function acquire(control = currentReadControl(), { weight } = {}) {
    control?.assertCurrent();
    return new Promise((resolve, reject) => {
      const waiter = { control, resolve, reject, done: false, cost: costOf(weight), skipped: 0 };
      const cleanup = () => control?.signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (waiter.done) return;
        waiter.done = true; cleanup();
        const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
        reject(historyReadCancelled());
        // A revoked head must not keep the queue parked behind itself.
        pump();
      };
      waiter.grant = () => {
        if (waiter.done) return false;
        try { control?.assertCurrent(); }
        catch (error) { waiter.done = true; cleanup(); reject(error); pump(); return false; }
        waiter.done = true; cleanup();
        used += waiter.cost; activeCount++;
        let released = false;
        resolve(() => {
          if (released) return; released = true;
          used = Math.max(0, used - waiter.cost); activeCount--;
          pump();
        });
        return true;
      };
      control?.signal?.addEventListener('abort', abort, { once: true });
      if (control?.signal?.aborted) { abort(); return; }
      // An empty lane always admits, whatever the cost: a source larger than
      // the whole budget must still be readable, just alone.
      if (!fits(waiter.cost) || !mayOvertakeQueue()) waiters.push(waiter);
      else {
        if (waiters.length) waiters[0].skipped++;
        waiter.grant();
      }
    });
  }
  return Object.freeze({ acquire,
    get active() { return activeCount > 0; },
    get activeCount() { return activeCount; },
    get usedBytes() { return used; },
    get capacityBytes() { return capacity; },
    get waiting() { return waiters.length; } });
}

module.exports = { CANCELLED, historyReadCancelled, isHistoryReadCancelled, isHistoryReadUnavailable,
  createReadControl, currentReadControl, withReadControl, createDemandRegistry, createReadAdmission,
  DEFAULT_ADMISSION_CAPACITY };
