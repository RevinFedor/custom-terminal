const lanes = new Map();
const listeners = new Set();
const laneSnapshot = (tabId, lane) => ({ tabId, pending: lane?.pending || 0,
  handoffIds: [...(lane?.activityHandoffs || [])].map(item => item.handoffId) });
const notify = (tabId) => {
  const event = laneSnapshot(tabId, lanes.get(tabId));
  for (const listener of listeners) {
    try { listener(event); }
    catch (error) { console.warn('[SendActivity] listener failed:', error?.message); }
  }
};

export function subscribeAgentSendScenarios(listener) {
  listeners.add(listener);
  for (const [tabId, lane] of lanes) listener(laneSnapshot(tabId, lane));
  return () => listeners.delete(listener);
}

const cleanIdentity = (value) => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

/**
 * Serialize complete agent-send scenarios per terminal tab.
 *
 * A PTY write lock protects bytes only after a caller reaches main.  History,
 * Project API and orchestration all perform readiness and draft checks before
 * that boundary, so they need one earlier lane which keeps every distinct
 * intent and its result together.  An exact handoff may join its own retry;
 * different handoffs never share a promise.
 */
export function enqueueAgentSendScenario({ tabId, handoffId, run }) {
  const key = cleanIdentity(tabId);
  if (!key) return Promise.reject(new Error('tabId required'));
  if (typeof run !== 'function') return Promise.reject(new Error('run required'));

  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      tail: Promise.resolve(),
      pending: 0,
      byHandoff: new Map(),
      activityHandoffs: new Set(),
    };
    lanes.set(key, lane);
  }

  const identity = cleanIdentity(handoffId);
  if (identity && lane.byHandoff.has(identity)) {
    return lane.byHandoff.get(identity);
  }

  const activity = { handoffId: identity };
  lane.activityHandoffs.add(activity);
  lane.pending += 1;
  notify(key);
  const work = lane.tail
    .catch(() => undefined)
    .then(() => run());
  // The lane itself always recovers so one failed send cannot poison later
  // intents.  The caller still receives the original fulfilled/rejected work.
  lane.tail = work.then(() => undefined, () => undefined);
  if (identity) lane.byHandoff.set(identity, work);

  const cleanup = () => {
    if (identity && lane.byHandoff.get(identity) === work) {
      lane.byHandoff.delete(identity);
    }
    lane.activityHandoffs.delete(activity);
    lane.pending -= 1;
    if (lane.pending === 0 && lanes.get(key) === lane) lanes.delete(key);
    notify(key);
  };
  void work.then(cleanup, cleanup);
  return work;
}

export function pendingAgentSendScenarioCount(tabId) {
  return lanes.get(cleanIdentity(tabId))?.pending || 0;
}
