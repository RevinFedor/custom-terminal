import { useEffect, useSyncExternalStore } from 'react';

const { ipcRenderer } = window.require('electron');

export type AgentSessionProvider = 'claude' | 'codex' | 'gemini';
export type AgentSessionAvailabilityState =
  | 'none'
  | 'checking'
  | 'available'
  | 'archived'
  | 'partial'
  | 'missing'
  | 'unknown';

export interface AgentSessionDescriptor {
  tabId: string;
  provider: AgentSessionProvider;
  sessionId: string;
  cwd?: string | null;
}

export interface AgentSessionAvailability {
  tabId: string | null;
  provider: AgentSessionProvider | null;
  sessionId: string | null;
  state: AgentSessionAvailabilityState;
  historyState?: string | null;
  reason?: string | null;
  checkedAt?: number | null;
  archived?: boolean;
  missingDependencies?: string[];
  deletedAt?: number | null;
  deletionSource?: string | null;
  deletionOperationId?: string | null;
}

// Current UI consumers use verdict/identity/deletion metadata, not probe time.
// Imperative readers retain the full, fresh verdict through the raw getters.
type SessionAvailabilityView = Omit<AgentSessionAvailability, 'checkedAt'>;

type SessionTabLike = {
  id?: string;
  cwd?: string;
  commandType?: string;
  tabType?: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  geminiSessionId?: string;
};

type Registration = { descriptor: AgentSessionDescriptor; count: number };

const NONE: AgentSessionAvailability = Object.freeze({
  tabId: null,
  provider: null,
  sessionId: null,
  state: 'none',
  historyState: 'none',
  reason: 'no-session-id',
  checkedAt: null,
});

const registry = new Map<string, Registration>();
const cache = new Map<string, AgentSessionAvailability>();
const views = new Map<string, SessionAvailabilityView>();
const fallback = new Map<string, AgentSessionAvailability>();
const listeners = new Map<string, Set<() => void>>();
let flushTimer: number | null = null;
let pollTimer: number | null = null;
let inflight: Promise<void> | null = null;
let forceAfterInflight = false;
let globalsBound = false;

const POLL_MS = 30_000;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function sessionAvailabilityKey(descriptor: AgentSessionDescriptor | null | undefined): string {
  if (!descriptor) return '';
  return `${descriptor.tabId}:${descriptor.provider}:${descriptor.sessionId.toLowerCase()}`;
}

export function resolveTabSessionDescriptor(
  tab: SessionTabLike | null | undefined,
  explicitTabId?: string | null,
): AgentSessionDescriptor | null {
  if (!tab) return null;
  const tabId = clean(explicitTabId) || clean(tab.id);
  if (!tabId) return null;
  const commandType = clean(tab.commandType);
  const tabType = clean(tab.tabType);
  const claudeSessionId = clean(tab.claudeSessionId);
  const codexSessionId = clean(tab.codexSessionId);
  const geminiSessionId = clean(tab.geminiSessionId);
  const bindings = [
    claudeSessionId ? { provider: 'claude' as const, sessionId: claudeSessionId } : null,
    codexSessionId ? { provider: 'codex' as const, sessionId: codexSessionId } : null,
    geminiSessionId ? { provider: 'gemini' as const, sessionId: geminiSessionId } : null,
  ].filter((binding): binding is { provider: AgentSessionProvider; sessionId: string } => !!binding);
  // The same fail-closed rule as resolvePtyAgentOwner: two concrete bindings
  // are unfinished handoff/corruption, not permission to trust commandType.
  // No binding means a fresh launch tab; there is no disk artifact to probe.
  if (bindings.length !== 1) return null;
  const { provider, sessionId } = bindings[0];
  void commandType;
  void tabType;
  return { tabId, provider, sessionId, cwd: clean(tab.cwd) || null };
}

function initialVerdict(descriptor: AgentSessionDescriptor): AgentSessionAvailability {
  const key = sessionAvailabilityKey(descriptor);
  let value = fallback.get(key);
  if (!value) {
    value = Object.freeze({
      tabId: descriptor.tabId,
      provider: descriptor.provider,
      sessionId: descriptor.sessionId,
      state: 'checking' as const,
      historyState: 'checking',
      reason: 'not-checked',
      checkedAt: null,
    });
    fallback.set(key, value);
  }
  return value;
}

function snapshot(key: string, descriptor?: AgentSessionDescriptor | null): AgentSessionAvailability {
  if (!key || !descriptor) return NONE;
  return cache.get(key) || initialVerdict(descriptor);
}

function viewSnapshot(key: string, descriptor?: AgentSessionDescriptor | null): SessionAvailabilityView {
  if (!key || !descriptor) return NONE;
  return views.get(key) || initialVerdict(descriptor);
}

// Compare the small IPC metadata object by value, including field presence and
// extension fields. A field whitelist would hide new owner/source/count metadata.
function sameViewValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && sameViewValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function publish(key: string, verdict: AgentSessionAvailability) {
  // Refresh raw checkedAt even when the subscribed UI projection is unchanged.
  // Only this top-level probe clock is excluded; nested metadata remains exact.
  cache.set(key, verdict);
  const { checkedAt: _checkedAt, ...view } = verdict;
  if (sameViewValue(views.get(key), view)) return;
  views.set(key, view);
  for (const listener of listeners.get(key) || []) {
    try { listener(); } catch {}
  }
}

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  // Focus/visibility are ordinary reconciliation points. Respect the main
  // cache so Cmd+Tab between apps cannot turn into a full ~/.codex walk.
  // Exact Noted deletions use the invalidation event below and force once.
  const refresh = () => scheduleProbe(false);
  const onVisibility = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  const onCommandFinished = () => scheduleProbe(false);
  const onTranscriptChanged = (_event: unknown, payload: { sessionId?: string } = {}) => {
    const sessionId = clean(payload.sessionId).toLowerCase();
    if (!sessionId) return;
    const needsPromotion = [...registry].some(([key, registration]) => (
      registration.descriptor.sessionId.toLowerCase() === sessionId
      && !['available', 'archived', 'partial'].includes(cache.get(key)?.state || 'checking')
    ));
    if (needsPromotion) scheduleProbe(true);
  };
  const onInvalidated = (_event: unknown, payload: { sessionIds?: string[] } = {}) => {
    const ids = new Set((payload.sessionIds || []).map((value) => clean(value).toLowerCase()).filter(Boolean));
    if (ids.size === 0) return;
    for (const [key, registration] of registry) {
      if (!ids.has(registration.descriptor.sessionId.toLowerCase())) continue;
      cache.delete(key);
      views.delete(key);
      for (const listener of listeners.get(key) || []) {
        try { listener(); } catch {}
      }
    }
    scheduleProbe(true);
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', onVisibility);
  ipcRenderer.on('terminal:command-finished', onCommandFinished);
  ipcRenderer.on('agent-transcript:changed', onTranscriptChanged);
  ipcRenderer.on('agent-session:availability-invalidated', onInvalidated);
  (bindGlobals as any).cleanup = () => {
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', onVisibility);
    ipcRenderer.removeListener('terminal:command-finished', onCommandFinished);
    ipcRenderer.removeListener('agent-transcript:changed', onTranscriptChanged);
    ipcRenderer.removeListener('agent-session:availability-invalidated', onInvalidated);
    globalsBound = false;
  };
}

function unbindGlobalsIfIdle() {
  if (registry.size > 0 || !globalsBound) return;
  (bindGlobals as any).cleanup?.();
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensurePoll() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void probeRegistered(false);
  }, POLL_MS);
}

function register(descriptor: AgentSessionDescriptor): () => void {
  const key = sessionAvailabilityKey(descriptor);
  const current = registry.get(key);
  registry.set(key, { descriptor, count: (current?.count || 0) + 1 });
  bindGlobals();
  ensurePoll();
  scheduleProbe(false);
  return () => {
    const latest = registry.get(key);
    if (!latest) return;
    if (latest.count <= 1) registry.delete(key);
    else registry.set(key, { ...latest, count: latest.count - 1 });
    unbindGlobalsIfIdle();
  };
}

function subscribe(key: string, listener: () => void): () => void {
  if (!key) return () => {};
  const set = listeners.get(key) || new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

function scheduleProbe(force: boolean) {
  if (force) forceAfterInflight = true;
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const shouldForce = forceAfterInflight;
    forceAfterInflight = false;
    void probeRegistered(shouldForce);
  }, 0);
}

async function probeRegistered(force: boolean) {
  if (registry.size === 0) return;
  if (inflight) {
    // A surface may register while the previous batch is already on the wire.
    // The old request cannot contain that descriptor, so one trailing batch is
    // required even when the caller did not ask for an explicit force refresh.
    forceAfterInflight = true;
    return inflight;
  }
  const descriptors = [...registry.values()].map((entry) => entry.descriptor);
  const run = ipcRenderer.invoke('agent-session:get-availability-batch', {
    sessions: descriptors,
    force,
  }).then((response: { success?: boolean; results?: AgentSessionAvailability[] } | null) => {
    if (response?.success !== true || !Array.isArray(response.results)) {
      for (const descriptor of descriptors) {
        const key = sessionAvailabilityKey(descriptor);
        if (cache.has(key)) continue;
        publish(key, {
          tabId: descriptor.tabId,
          provider: descriptor.provider,
          sessionId: descriptor.sessionId,
          state: 'unknown',
          historyState: 'unknown',
          reason: 'availability-read-failed',
          checkedAt: Date.now(),
        });
      }
      return;
    }
    for (const verdict of response.results) {
      if (!verdict?.tabId || !verdict?.provider || !verdict?.sessionId) continue;
      const descriptor: AgentSessionDescriptor = {
        tabId: verdict.tabId,
        provider: verdict.provider,
        sessionId: verdict.sessionId,
      };
      const key = sessionAvailabilityKey(descriptor);
      if (!registry.has(key)) continue;
      publish(key, verdict);
    }
  }).catch(() => {
    for (const descriptor of descriptors) {
      const key = sessionAvailabilityKey(descriptor);
      if (cache.has(key)) continue;
      publish(key, {
        tabId: descriptor.tabId,
        provider: descriptor.provider,
        sessionId: descriptor.sessionId,
        state: 'unknown',
        historyState: 'unknown',
        reason: 'availability-read-failed',
        checkedAt: Date.now(),
      });
    }
  }).finally(() => {
    if (inflight === run) inflight = null;
    if (forceAfterInflight) {
      forceAfterInflight = false;
      scheduleProbe(true);
    }
  });
  inflight = run;
  return run;
}

export function useSessionAvailability(
  descriptor: AgentSessionDescriptor | null | undefined,
): SessionAvailabilityView {
  const key = sessionAvailabilityKey(descriptor);
  useEffect(() => {
    if (!descriptor || !key) return undefined;
    return register(descriptor);
  }, [key, descriptor?.cwd]);
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => viewSnapshot(key, descriptor),
    () => viewSnapshot(key, descriptor),
  );
}

export function getSessionAvailabilitySnapshot(
  descriptor: AgentSessionDescriptor | null | undefined,
): AgentSessionAvailability {
  return snapshot(sessionAvailabilityKey(descriptor), descriptor);
}

export function getTabSessionAvailabilitySnapshot(tab: SessionTabLike | null | undefined): AgentSessionAvailability {
  return getSessionAvailabilitySnapshot(resolveTabSessionDescriptor(tab));
}

export function refreshSessionAvailability(force = true): void {
  scheduleProbe(force);
}
