import {
  describeClaudeStartupFailure,
} from './claudeStartupFailure.mjs';

type GateStatus = 'pending' | 'ready' | 'failed' | 'cleared';

// Failure detail travels with the state, not only inside a free-text message.
// The card needs to name the command that failed and know whether the user may
// retry it; the generic subtitle contradicted the real cause in the incident.
export type GateFailureDetail = {
  errorCode?: string | null;
  failedCommand?: string | null;
  proofOutcome?: 'found' | 'absent' | 'unresolved' | null;
  userRetryable?: boolean;
};

type GateState = {
  status: GateStatus;
  at: number;
  reason: string;
  error?: string;
  detail?: GateFailureDetail;
  generation?: string | null;
  attemptId?: string | null;
  revision?: number;
  dismissed?: boolean;
  waiters: Set<(error?: Error) => void>;
};

const gates = new Map<string, GateState>();
const mainRevisions = new Map<string, number>();

function getGate(tabId: string): GateState | null {
  return gates.get(tabId) || null;
}

function emitGateEvent(
  tabId: string,
  status: GateStatus,
  reason: string,
  error?: string,
  detail?: GateFailureDetail,
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('claude-startup-defaults-gate', {
    detail: { tabId, status, reason, error, at: Date.now(), ...(detail || {}) },
  }));
  try {
    const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;
    ipcRenderer?.send?.('claude:startup-defaults-gate', {
      tabId,
      status,
      reason,
      error,
      ...(detail || {}),
    });
  } catch {}
}

function emitLocalGateEvent(payload: {
  tabId: string;
  status: GateStatus;
  reason?: string;
  error?: string;
  at?: number;
  failedCommand?: string | null;
  errorCode?: string | null;
  proofOutcome?: 'found' | 'absent' | 'unresolved' | null;
  userRetryable?: boolean;
  generation?: string | null;
  attemptId?: string | null;
  revision?: number;
  dismissed?: boolean;
}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('claude-startup-defaults-gate', {
    detail: {
      ...payload,
      at: Number(payload.at) || Date.now(),
    },
  }));
}

// Main is the source of truth for the startup transaction. This applies its
// snapshot to the renderer-side waiter cache and emits the existing DOM event
// for UI consumers, without echoing the state back over IPC.
export function applyClaudeStartupDefaultsGateFromMain(payload: any) {
  const tabId = String(payload?.tabId || '');
  const status = String(payload?.status || '') as GateStatus;
  if (!tabId || !['pending', 'ready', 'failed', 'cleared'].includes(status)) return;
  const revision = Number(payload?.revision) || 0;
  const observed = mainRevisions.get(tabId) || 0;
  const existing = getGate(tabId);
  const retiredBySnapshot = status === 'cleared' && existing
    && payload.generation !== existing.generation;
  if (observed > 0 && (revision < observed || (revision === observed && !retiredBySnapshot))) return;
  if (revision > 0) mainRevisions.set(tabId, revision);
  const identity = { generation: payload?.generation || null, attemptId: payload?.attemptId || null,
    revision, dismissed: payload?.dismissed === true };
  let waiters = existing?.waiters || new Set<(error?: Error) => void>();
  if (existing && ((existing.generation && identity.generation !== existing.generation)
    || (existing.attemptId && identity.attemptId !== existing.attemptId))) {
    for (const resolve of waiters) resolve(new Error('Claude settings attempt was stopped or replaced'));
    waiters = new Set();
  }
  const reason = String(payload?.reason || '');
  const at = Number(payload?.at) || Date.now();

  if (status === 'cleared') {
    gates.delete(tabId);
    if (existing?.status === 'pending') {
      const error = new Error('Claude startup defaults gate cleared before ready');
      for (const resolve of waiters) resolve(error);
    }
    emitLocalGateEvent({ tabId, status, reason, at, ...identity });
    return;
  }

  const detail: GateFailureDetail = {
    errorCode: payload?.errorCode || null,
    failedCommand: payload?.failedCommand || null,
    proofOutcome: payload?.proofOutcome || null,
    userRetryable: payload?.userRetryable === true,
  };
  const describedFailure = status === 'failed'
    ? describeClaudeStartupFailure({
      error: payload?.error,
      errorCode: detail.errorCode,
      failedCommand: detail.failedCommand,
    })
    : null;
  const message = describedFailure?.message
    || (payload?.error ? String(payload.error) : undefined);
  if (describedFailure) detail.errorCode = describedFailure.code;
  gates.set(tabId, {
    status,
    at,
    reason,
    error: message,
    detail,
    ...identity,
    waiters: status === 'pending' ? waiters : new Set(),
  });
  if (status === 'ready') {
    for (const resolve of waiters) resolve();
  } else if (status === 'failed') {
    const error = new Error(message || reason || 'Claude startup defaults failed');
    for (const resolve of waiters) resolve(error);
  }
  emitLocalGateEvent({
    tabId,
    status,
    reason,
    error: message,
    at,
    ...detail,
    ...identity,
  });
}

export function markClaudeStartupDefaultsPending(tabId: string, reason: string) {
  if (!tabId) return;
  const existing = getGate(tabId);
  if (existing?.status === 'pending') return;
  gates.set(tabId, {
    status: 'pending',
    at: Date.now(),
    reason,
    waiters: new Set(),
  });
  emitGateEvent(tabId, 'pending', reason);
}

export function markClaudeStartupDefaultsReady(tabId: string, reason: string) {
  if (!tabId) return;
  const existing = getGate(tabId);
  const waiters = existing?.waiters || new Set<(error?: Error) => void>();
  gates.set(tabId, {
    status: 'ready',
    at: Date.now(),
    reason,
    waiters: new Set(),
  });
  for (const resolve of waiters) resolve();
  emitGateEvent(tabId, 'ready', reason);
}

export function markClaudeStartupDefaultsFailed(
  tabId: string,
  reason: string,
  error?: unknown,
  detail?: GateFailureDetail,
) {
  if (!tabId) return;
  const existing = getGate(tabId);
  const waiters = existing?.waiters || new Set<(error?: Error) => void>();
  const rawMessage = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : reason);
  const describedFailure = describeClaudeStartupFailure({
    error: rawMessage,
    errorCode: detail?.errorCode,
    failedCommand: detail?.failedCommand,
  });
  const message = describedFailure.message;
  const normalizedDetail = {
    ...(detail || {}),
    errorCode: describedFailure.code,
  };
  gates.set(tabId, {
    status: 'failed',
    at: Date.now(),
    reason,
    error: message,
    detail: normalizedDetail,
    waiters: new Set(),
  });
  const err = new Error(message || reason || 'Claude startup defaults failed');
  for (const resolve of waiters) resolve(err);
  emitGateEvent(tabId, 'failed', reason, message, normalizedDetail);
}

export function clearClaudeStartupDefaultsGate(tabId: string) {
  if (!tabId) return;
  const existing = getGate(tabId);
  if (existing?.status === 'pending') {
    const err = new Error('Claude startup defaults gate cleared before ready');
    for (const resolve of existing.waiters) resolve(err);
  }
  gates.delete(tabId);
  emitGateEvent(tabId, 'cleared', 'cleared');
}

export function getClaudeStartupDefaultsGateSnapshot(tabId: string) {
  const existing = getGate(tabId);
  if (!existing) return null;
  return {
    status: existing.status,
    at: existing.at,
    reason: existing.reason,
    error: existing.error,
    failedCommand: existing.detail?.failedCommand || null,
    errorCode: existing.detail?.errorCode || null,
    proofOutcome: existing.detail?.proofOutcome || null,
    userRetryable: existing.detail?.userRetryable === true,
    generation: existing.generation || null,
    attemptId: existing.attemptId || null,
    revision: existing.revision || 0,
    dismissed: existing.dismissed === true,
  };
}

// Durable fallback: the renderer map only survives one renderer lifetime, and
// a listener-only consumer can miss the event entirely (that is exactly how the
// incident's failure was lost when the user switched tabs 549ms early). Main
// mirrors every gate transition, so presentation can always ask again.
export async function fetchClaudeStartupDefaultsGate(tabId: string) {
  const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;
  const result = await ipcRenderer?.invoke?.('claude:get-startup-defaults-gate', { tabId });
  if (result?.success !== true) throw new Error(result?.error || 'Claude settings state is unavailable');
  applyClaudeStartupDefaultsGateFromMain(result.gate
    ? { ...result.gate, tabId, revision: result.revision ?? result.gate.revision }
    : { tabId, status: 'cleared', generation: result.generation, revision: result.revision, reason: 'main-no-gate' });
  // A newer main event may have arrived while this request was in flight.
  // Applying the versioned snapshot above cannot rewind that newer cache.
  return getClaudeStartupDefaultsGateSnapshot(tabId);
}

export async function waitForClaudeStartupDefaultsReady(tabId: string, timeoutMs = 15000) {
  await fetchClaudeStartupDefaultsGate(tabId);
  const existing = getGate(tabId);
  if (!existing || existing.status === 'ready') return;
  if (existing.status === 'failed') {
    throw new Error(existing.error || 'Claude startup defaults failed');
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      existing.waiters.delete(finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new Error('Claude startup defaults did not become ready in ' + timeoutMs + 'ms')), timeoutMs);
    existing.waiters.add(finish);
  });
}

if (typeof window !== 'undefined') {
  try {
    const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;
    const listenerKey = '__claudeStartupDefaultsGateMainListener';
    const previous = (window as any)[listenerKey];
    if (previous) {
      ipcRenderer?.removeListener?.('claude:startup-defaults-gate-state', previous);
    }
    const listener = (_event: unknown, payload: unknown) => {
      applyClaudeStartupDefaultsGateFromMain(payload);
    };
    (window as any)[listenerKey] = listener;
    ipcRenderer?.on?.('claude:startup-defaults-gate-state', listener);
  } catch {}
}
