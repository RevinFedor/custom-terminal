type GateStatus = 'pending' | 'ready' | 'failed' | 'cleared';

type GateState = {
  status: GateStatus;
  at: number;
  reason: string;
  error?: string;
  waiters: Set<(error?: Error) => void>;
};

const gates = new Map<string, GateState>();

function getGate(tabId: string): GateState | null {
  return gates.get(tabId) || null;
}

function emitGateEvent(tabId: string, status: GateStatus, reason: string, error?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('claude-startup-defaults-gate', {
    detail: { tabId, status, reason, error, at: Date.now() },
  }));
  try {
    const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;
    ipcRenderer?.send?.('claude:startup-defaults-gate', { tabId, status, reason, error });
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

export function markClaudeStartupDefaultsFailed(tabId: string, reason: string, error?: unknown) {
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
    waiters: new Set(),
  });
  const err = new Error(message || reason || 'Claude startup defaults failed');
  for (const resolve of waiters) resolve(err);
  emitGateEvent(tabId, 'failed', reason, message);
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
  };
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
