const actionsByTab = new Map();
const listeners = new Set();
let nextToken = 0;

function snapshot(state) {
  return state ? { ...state } : null;
}

function emit(tabId, reason, result = null) {
  const event = {
    tabId,
    reason,
    state: snapshot(actionsByTab.get(tabId)),
    result,
  };
  for (const listener of listeners) listener(event);
}

export function getCoordinatedAgentAction(tabId) {
  return snapshot(actionsByTab.get(String(tabId || '')));
}

export function beginCoordinatedAgentSend(tabId, now = Date.now()) {
  const key = String(tabId || '');
  if (!key) return { started: false, reason: 'missing-tab', state: null };
  const existing = actionsByTab.get(key);
  if (existing) {
    return { started: false, reason: 'action-inflight', state: snapshot(existing) };
  }
  const state = {
    tabId: key,
    token: ++nextToken,
    phase: 'sending',
    startedAt: Number(now) || Date.now(),
    stopRequestedAt: null,
    handoffId: null,
  };
  actionsByTab.set(key, state);
  emit(key, 'send-started');
  return { started: true, token: state.token, state: snapshot(state) };
}

export function bindCoordinatedAgentSendHandoff(tabId, token, handoffId) {
  const key = String(tabId || '');
  const state = actionsByTab.get(key);
  const exactHandoffId = String(handoffId || '').trim();
  if (!state || state.token !== token) {
    return { bound: false, reason: 'stale-send', state: snapshot(state) };
  }
  if (!exactHandoffId) {
    return { bound: false, reason: 'missing-handoff', state: snapshot(state) };
  }
  if (state.handoffId && state.handoffId !== exactHandoffId) {
    return { bound: false, reason: 'handoff-already-bound', state: snapshot(state) };
  }
  state.handoffId = exactHandoffId;
  emit(key, 'send-handoff-bound');
  return { bound: true, handoffId: exactHandoffId, state: snapshot(state) };
}

export function requestCoordinatedStopAfterSend(tabId, now = Date.now()) {
  const key = String(tabId || '');
  const state = actionsByTab.get(key);
  if (!state || (state.phase !== 'sending' && state.phase !== 'stopping')) {
    return { queued: false, deduped: false, reason: 'no-send-inflight', state: snapshot(state) };
  }
  if (state.stopRequestedAt !== null) {
    return { queued: true, deduped: true, token: state.token, state: snapshot(state) };
  }
  state.stopRequestedAt = Number(now) || Date.now();
  emit(key, 'stop-queued');
  return { queued: true, deduped: false, token: state.token, state: snapshot(state) };
}

export function isCoordinatedAgentSendCancellationRequested(tabId, token) {
  const state = actionsByTab.get(String(tabId || ''));
  return !!state
    && state.token === token
    && state.stopRequestedAt !== null;
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
    });
  };
  unsubscribe = subscribeCoordinatedAgentActions((event) => {
    if (event.tabId !== key) return;
    if (event.state?.token !== token || event.state?.stopRequestedAt === null) return;
    finish(event.state);
  });
  const current = actionsByTab.get(key);
  if (current?.token === token && current.stopRequestedAt !== null) finish(current);
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
  const state = actionsByTab.get(key);
  if (!state || state.token !== token) {
    return { settled: false, reason: 'stale-send', stopped: false };
  }

  if (state.stopRequestedAt === null) {
    actionsByTab.delete(key);
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
  const current = actionsByTab.get(key);
  if (current?.token === token) actionsByTab.delete(key);
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
