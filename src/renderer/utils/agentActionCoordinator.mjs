// One tab can accept several immutable send intents while the head intent is
// restarting/starting. The scenario sequencer executes them FIFO; this queue
// keeps Stop/cancellation ownership aligned with that same order.
const actionsByTab = new Map();
const listeners = new Set();
let nextToken = 0;

function actionQueue(tabId) {
  return actionsByTab.get(tabId) || [];
}

function snapshot(state, queue = null) {
  return state ? {
    ...state,
    queuedSendCount: Math.max(0, (queue?.length || 1) - 1),
  } : null;
}

function emit(tabId, reason, result = null) {
  const queue = actionQueue(tabId);
  const event = {
    tabId,
    reason,
    state: snapshot(queue[0], queue),
    result,
  };
  for (const listener of listeners) listener(event);
}

export function getCoordinatedAgentAction(tabId) {
  const queue = actionQueue(String(tabId || ''));
  return snapshot(queue[0], queue);
}

export function beginCoordinatedAgentSend(tabId, now = Date.now(), options = {}) {
  const key = String(tabId || '');
  if (!key) return { started: false, reason: 'missing-tab', state: null };
  const queue = actionQueue(key);
  const state = {
    tabId: key,
    token: ++nextToken,
    phase: 'sending',
    startedAt: Number(now) || Date.now(),
    stopRequestedAt: null,
    cancelledAt: null,
    cancelReason: null,
    cascadeRestoreByToken: null,
    cascadeRestoreBatched: false,
    handoffId: null,
    recordWithoutReply: options.recordWithoutReply === true,
  };
  queue.push(state);
  actionsByTab.set(key, queue);
  emit(key, queue.length === 1 ? 'send-started' : 'send-queued');
  return {
    started: true,
    queued: queue.length > 1,
    token: state.token,
    state: snapshot(state, queue),
  };
}

export function bindCoordinatedAgentSendHandoff(tabId, token, handoffId) {
  const key = String(tabId || '');
  const queue = actionQueue(key);
  const state = queue.find((candidate) => candidate.token === token);
  const exactHandoffId = String(handoffId || '').trim();
  if (!state || state.token !== token) {
    return { bound: false, reason: 'stale-send', state: snapshot(queue[0], queue) };
  }
  if (!exactHandoffId) {
    return { bound: false, reason: 'missing-handoff', state: snapshot(state, queue) };
  }
  if (state.handoffId && state.handoffId !== exactHandoffId) {
    return { bound: false, reason: 'handoff-already-bound', state: snapshot(state, queue) };
  }
  state.handoffId = exactHandoffId;
  emit(key, 'send-handoff-bound');
  return { bound: true, handoffId: exactHandoffId, state: snapshot(state, queue) };
}

export function requestCoordinatedStopAfterSend(tabId, now = Date.now()) {
  const key = String(tabId || '');
  const queue = actionQueue(key);
  const state = queue[0];
  if (!state || (state.phase !== 'sending' && state.phase !== 'stopping')) {
    return { queued: false, deduped: false, reason: 'no-send-inflight', state: snapshot(state) };
  }
  if (state.stopRequestedAt !== null) {
    return { queued: true, deduped: true, token: state.token, state: snapshot(state) };
  }
  const requestedAt = Number(now) || Date.now();
  // Stop means “do not submit any intent currently accepted by this tab”.
  // Mark queued followers too; each wakes/cancels when it reaches the head.
  for (const pending of queue) {
    if (pending.stopRequestedAt === null) pending.stopRequestedAt = requestedAt;
  }
  emit(key, 'stop-queued');
  return { queued: true, deduped: false, token: state.token, state: snapshot(state, queue) };
}

export function isCoordinatedAgentSendCancellationRequested(tabId, token) {
  const state = actionQueue(String(tabId || ''))
    .find((candidate) => candidate.token === token);
  return !!state
    && state.token === token
    && (state.stopRequestedAt !== null || state.cancelledAt !== null);
}

export function cancelCoordinatedAgentSendFollowers(
  tabId,
  token,
  reason = 'head-failed-before-provider-acceptance',
  now = Date.now(),
  options = {},
) {
  const key = String(tabId || '');
  const queue = actionQueue(key);
  const index = queue.findIndex((candidate) => candidate.token === token);
  if (index < 0) return { cancelled: 0, reason: 'stale-send' };
  const cancelledAt = Number(now) || Date.now();
  let cancelled = 0;
  for (let cursor = index + 1; cursor < queue.length; cursor += 1) {
    const follower = queue[cursor];
    if (follower.cancelledAt !== null) continue;
    follower.cancelledAt = cancelledAt;
    follower.cancelReason = reason;
    follower.cascadeRestoreByToken = options.cascadeRestore === false ? null : token;
    follower.cascadeRestoreBatched = options.cascadeRestore === false
      ? false
      : !!follower.handoffId;
    cancelled += 1;
  }
  if (cancelled > 0) emit(key, 'send-followers-cancelled');
  return {
    cancelled,
    handoffIds: queue.slice(index + 1).map((follower) => follower.handoffId).filter(Boolean),
    reason: cancelled > 0 ? reason : 'no-followers',
  };
}

export function getCoordinatedAgentSendCancellation(tabId, token) {
  const state = actionQueue(String(tabId || ''))
    .find((candidate) => candidate.token === token);
  if (!state || (state.stopRequestedAt === null && state.cancelledAt === null)) return null;
  return {
    stopRequestedAt: state.stopRequestedAt,
    cancelledAt: state.cancelledAt,
    cancelReason: state.cancelReason,
    cascadeRestoreByToken: state.cascadeRestoreByToken,
    cascadeRestoreBatched: state.cascadeRestoreBatched === true,
  };
}

// Event-driven cancellation edge for the Start/Resume → readiness phase.
// Stop must wake that wait immediately; otherwise the original prompt can be
// submitted to a process the user has already asked to cancel.
export function createCoordinatedAgentSendCancellationWait(tabId, token) {
  const key = String(tabId || '');
  let settled = false;
  let unsubscribe = () => {};
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (state) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    resolvePromise({
      tabId: key,
      token,
      stopRequestedAt: state?.stopRequestedAt ?? null,
      cancelledAt: state?.cancelledAt ?? null,
      cancelReason: state?.cancelReason ?? null,
      cascadeRestoreByToken: state?.cascadeRestoreByToken ?? null,
      cascadeRestoreBatched: state?.cascadeRestoreBatched === true,
    });
  };
  unsubscribe = subscribeCoordinatedAgentActions((event) => {
    if (event.tabId !== key) return;
    if (event.state?.token !== token
      || (event.state?.stopRequestedAt === null && event.state?.cancelledAt === null)) return;
    finish(event.state);
  });
  const current = actionQueue(key).find((candidate) => candidate.token === token);
  if (current?.token === token
    && (current.stopRequestedAt !== null || current.cancelledAt !== null)) finish(current);
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      unsubscribe();
    },
  };
}

export async function settleCoordinatedAgentSend({
  tabId,
  token,
  runQueuedStop,
}) {
  const key = String(tabId || '');
  const queue = actionQueue(key);
  const state = queue[0];
  if (!state || state.token !== token) {
    return { settled: false, reason: 'stale-send', stopped: false };
  }

  if (state.stopRequestedAt === null) {
    queue.shift();
    if (queue.length === 0) actionsByTab.delete(key);
    else actionsByTab.set(key, queue);
    emit(key, 'send-settled');
    return { settled: true, reason: 'send-settled', stopped: false };
  }

  state.phase = 'stopping';
  emit(key, 'queued-stop-started');
  let result;
  try {
    result = await runQueuedStop();
  } catch (error) {
    result = {
      success: false,
      error: String(error?.message || error),
    };
  }
  const currentQueue = actionQueue(key);
  if (currentQueue[0]?.token === token) currentQueue.shift();
  if (currentQueue.length === 0) actionsByTab.delete(key);
  else actionsByTab.set(key, currentQueue);
  const success = result?.success === true || result?.stopped === true;
  emit(key, success ? 'queued-stop-complete' : 'queued-stop-failed', result);
  return {
    settled: true,
    reason: success ? 'queued-stop-complete' : 'queued-stop-failed',
    stopped: success,
    result,
  };
}

export function subscribeCoordinatedAgentActions(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetCoordinatedAgentActionsForTests() {
  actionsByTab.clear();
  listeners.clear();
  nextToken = 0;
}
