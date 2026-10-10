'use strict';
const { normalizeIdleSessionStopPolicy, idleSessionStopIncludes } = require('../shared/idle-session-stop.cjs');

// One Main owner for policy, deadline and cancellation. The deadline never
// proves idle: the existing process owner revalidates it at its signal boundary.
function createIdleSessionStop({ readPolicy, savePolicy, capture, sameOwner, observe, stop,
  publish = () => {}, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let policy = normalizeIdleSessionStopPolicy(readPolicy() || {}), revision = 0;
  let records = new Map(), timer = null, disposed = false, published = '', sequence = 0;
  const flights = new Set();
  const selected = row => idleSessionStopIncludes(policy, row.workflowId);
  const snapshot = () => ({ revision, sequence, policy, states: Object.fromEntries([...records].map(([id, record]) => [id,
    { phase: record.phase, deadline: record.phase === 'scheduled' ? record.deadline : null,
      idleSince: record.idleSince || null, ...(record.error ? { error: record.error } : {}) }])) });
  const notify = () => {
    const value = snapshot(), key = JSON.stringify([value.revision, value.policy, value.states]);
    if (key !== published) { published = key; sequence++; publish({ ...value, sequence }); }
  };
  const current = (record, row) => row && selected(row) && row.scope === record.row.scope
    && sameOwner(record.row.owner, row.owner) && row.known === true && row.idle === true
    && row.activityKey === record.row.activityKey
    && row.completedAt === record.row.completedAt;
  const guard = record => {
    if (disposed || records.get(record.row.tabId) !== record || record.revision !== revision
      || record.deadline > now()) return { allowed: false, reason: 'idle_stop_cancelled' };
    let row;
    try { row = capture(record.row.tabId)[0]; }
    catch { return { allowed: false, reason: 'idle_stop_observation_unknown' }; }
    return current(record, row) ? { allowed: true }
      : { allowed: false, reason: 'idle_stop_activity_changed' };
  };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed) return;
    const deadlines = [...records.values()].filter(r => r.phase === 'scheduled' && !flights.has(r.row.tabId)).map(r => r.deadline);
    if (!deadlines.length) return;
    timer = setTimer(() => { timer = null; void fire(); }, Math.max(0, Math.min(...deadlines) - now()));
  };
  const fire = async () => {
    const due = [...records.values()].filter(r => r.phase === 'scheduled' && r.deadline <= now() && !flights.has(r.row.tabId));
    let next = 0;
    const worker = async () => {
      while (next < due.length && !disposed) {
        const record = due[next++], id = record.row.tabId;
        if (!guard(record).allowed) { refresh(); continue; }
        flights.add(id); record.phase = 'checking'; notify();
        let result;
        try {
          const proof = await observe(id, record.row.owner);
          if (!guard(record).allowed) result = { success: false, skipped: true, error: 'idle_stop_activity_changed' };
          else if (proof?.known !== true) result = { success: false, error: proof?.error || 'idle_stop_proof_unknown' };
          else result = await stop(id, record.row.owner, proof, () => guard(record));
        } catch (error) { result = { success: false, error: error?.message || String(error) }; }
        flights.delete(id);
        if (records.get(id) === record) {
          record.phase = result?.success ? 'inactive' : 'waiting';
          record.error = result?.success ? null : result?.error || 'idle_stop_not_confirmed';
        }
        log('settled', { tabId: id, idleSince: record.idleSince, deadline: record.deadline, ...result });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));
    refresh();
  };
  const refresh = () => {
    if (disposed) return snapshot();
    let rows;
    try { rows = capture(); }
    catch (error) {
      for (const record of records.values()) { record.phase = 'unknown'; record.error = 'idle_stop_observation_unknown'; }
      log('observation-unavailable', { error: error?.message || String(error) }); notify(); schedule(); return snapshot();
    }
    const next = new Map();
    for (const row of rows) {
      if (!selected(row)) continue;
      const old = records.get(row.tabId);
      const stableOwner = old && old.row.scope === row.scope && sameOwner(old.row.owner, row.owner);
      if (old && old.revision === revision && current(old, row)
        && !['busy', 'unknown'].includes(old.phase)) { old.row = row; next.set(row.tabId, old); continue; }
      const record = { row, revision, phase: !row.owner.live ? 'inactive'
        : row.known !== true ? 'unknown' : !row.idle ? 'busy' : 'waiting', idleSince: null, deadline: null };
      if (row.owner.live && row.known === true && row.idle === true) {
        const freshCompletion = row.completedAt >= policy.armedAt && row.completedAt > 0;
        const previousIdleAt = stableOwner && old.row.known === true
          && old.row.idle === true && old.row.completedAt === row.completedAt ? old.idleSince : null;
        if (policy.includeAlreadyIdle || freshCompletion || previousIdleAt != null || stableOwner && old.row.working === true) {
          record.idleSince = row.completedAt > 0 && (!stableOwner || old.phase !== 'busy' || row.completedAt !== old.row.completedAt)
            ? row.completedAt : previousIdleAt ?? now();
          record.deadline = record.idleSince + policy.minutes * 60_000;
          record.phase = 'scheduled';
          log('scheduled', { tabId: row.tabId, workflowId: row.workflowId, idleSince: record.idleSince, deadline: record.deadline });
        }
      }
      next.set(row.tabId, record);
    }
    records = next; notify(); schedule(); return snapshot();
  };
  return {
    snapshot, refresh,
    update(patch) {
      const next = normalizeIdleSessionStopPolicy({ ...policy, ...patch, armedAt: now() });
      savePolicy(next); policy = next; revision++; refresh(); return snapshot();
    },
    dispose() { disposed = true; if (timer !== null) clearTimer(timer); timer = null; records.clear(); },
  };
}
module.exports = { createIdleSessionStop };
