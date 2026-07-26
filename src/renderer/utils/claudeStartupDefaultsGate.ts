type GateStatus = 'pending' | 'ready' | 'failed' | 'cleared';

// Failure detail travels with the state, not only inside a free-text message.
// The card needs to name the command that failed and know whether the user may
// retry it; the generic subtitle contradicted the real cause in the incident.
export type GateFailureDetail = {
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
  waiters: Set<(error?: Error) => void>;
};

const gates = new Map<string, GateState>();

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
  const message = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : reason);
  gates.set(tabId, {
    status: 'failed',
    at: Date.now(),
    reason,
    error: message,
    detail,
    waiters: new Set(),
  });
  const err = new Error(message || reason || 'Claude startup defaults failed');
  for (const resolve of waiters) resolve(err);
  emitGateEvent(tabId, 'failed', reason, message, detail);
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
    proofOutcome: existing.detail?.proofOutcome || null,
    userRetryable: existing.detail?.userRetryable === true,
  };
}

// Durable fallback: the renderer map only survives one renderer lifetime, and
// a listener-only consumer can miss the event entirely (that is exactly how the
// incident's failure was lost when the user switched tabs 549ms early). Main
// mirrors every gate transition, so presentation can always ask again.
export async function fetchClaudeStartupDefaultsGate(tabId: string) {
  const local = getClaudeStartupDefaultsGateSnapshot(tabId);
  if (local) return local;
  try {
    const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;
    const result = await ipcRenderer?.invoke?.('claude:get-startup-defaults-gate', { tabId });
    const gate = result?.gate;
    if (!gate?.status) return null;
    return {
      status: gate.status as GateStatus,
      at: Number(gate.at) || Date.now(),
      reason: String(gate.reason || ''),
      error: gate.error ? String(gate.error) : undefined,
      failedCommand: gate.failedCommand || null,
      proofOutcome: gate.proofOutcome || null,
      userRetryable: gate.userRetryable === true,
    };
  } catch {
    return null;
  }
}

export async function waitForClaudeStartupDefaultsReady(tabId: string, timeoutMs = 15000) {
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
