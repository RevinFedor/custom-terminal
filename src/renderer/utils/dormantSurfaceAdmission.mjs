/**
 * Completion-serial admission for hidden heavy surfaces.
 *
 * `start()` receives an exact lease. Only that lease can release the active
 * slot; a stale completion from an old owner/job is a no-op. The next hidden
 * job is always scheduled through the supplied idle boundary after completion,
 * never from the same callback or one-rAF-per-pane fan-out.
 */
export function createDormantSurfaceAdmissionQueue({
  schedule,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  timeoutMs = 60_000,
  onTransition = () => {},
} = {}) {
  if (typeof schedule !== 'function') {
    throw new TypeError('createDormantSurfaceAdmissionQueue requires schedule(callback)');
  }

  const pending = new Map();
  let active = null;
  let scheduledCancel = null;
  let sequence = 0;
  const emit = event => onTransition({ ...event, remaining: pending.size + (active ? 1 : 0) });

  const cancelScheduledIfIdle = () => {
    if (pending.size > 0 || !scheduledCancel) return;
    scheduledCancel();
    scheduledCancel = null;
  };

  const scheduleNext = () => {
    if (active || scheduledCancel || pending.size === 0) return;
    scheduledCancel = schedule(() => {
      scheduledCancel = null;
      if (active) return;
      const next = pending.entries().next();
      if (next.done) return;
      const [key, job] = next.value;
      pending.delete(key);

      const token = ++sequence;
      let finished = false;
      let timer = null;
      const lease = {
        key,
        token,
        complete(reason = 'completed') {
          if (finished) return false;
          finished = true;
          if (!active || active.key !== key || active.token !== token) return false;
          if (timer !== null) clearTimer(timer);
          timer = null;
          active = null;
          emit({ phase: 'complete', key, token, reason, pending: pending.size });
          scheduleNext();
          return true;
        },
      };
      active = { key, token, lease };
      timer = setTimer(() => lease.complete('timeout'), timeoutMs);
      emit({ phase: 'start', key, token, pending: pending.size });
      try {
        job.start(lease);
      } catch (error) {
        emit({ phase: 'start-error', key, token, error, pending: pending.size });
        lease.complete('start-error');
      }
    });
  };

  const enqueue = (key, start) => {
    if (!key || typeof start !== 'function') return false;
    if (active?.key === key || pending.has(key)) return false;
    pending.set(key, { start });
    emit({ phase: 'queued', key, pending: pending.size });
    scheduleNext();
    return true;
  };

  const promote = (key) => {
    if (pending.delete(key)) {
      emit({ phase: 'promoted', key, pending: pending.size });
      cancelScheduledIfIdle();
      return 'queued';
    }
    return active?.key === key ? 'active' : 'none';
  };

  const cancel = (key, reason = 'cancelled') => {
    if (pending.delete(key)) {
      emit({ phase: 'cancelled-queued', key, reason, pending: pending.size });
      cancelScheduledIfIdle();
      return true;
    }
    if (active?.key === key) return active.lease.complete(reason);
    return false;
  };

  return {
    enqueue,
    promote,
    cancel,
    activeKey: () => active?.key || null,
    pendingKeys: () => Array.from(pending.keys()),
  };
}
