// SDK history pre-fetch cache.
//
// Why this exists: on app startup `restoreSession` brings back N SDK tabs.
// Each ClaudeSDKTab triggers loadHistory in a useEffect once storeSessionId
// resolves — but the moment isRestoring flips false the UI mounts the
// workspace BEFORE those IPC calls complete. The user sees empty SDK tabs
// for ~300ms while parallel `claude-sdk:active-branch-messages` requests
// finish. For the active SDK tab this is the visible "blank chat" gap
// after the RestoreLoader disappears.
//
// Fix: while still in isRestoring we kick off all SDK history fetches in
// parallel, await them, and cache the results in this module-level map.
// loadHistory consults the cache first — a cache hit returns synchronously,
// no IPC, no roundtrip. Cache is single-shot per (tabId, sessionId): once
// the value is read, we delete it so subsequent reloads (Reload chip,
// session-rotation, fork) take the live IPC path.

const _prefetchCache = new Map<string, any[]>();

function makeKey(tabId: string, sessionId: string): string {
  return tabId + '::' + sessionId;
}

export function setPrefetched(tabId: string, sessionId: string, messages: any[]): void {
  _prefetchCache.set(makeKey(tabId, sessionId), messages);
}

// Returns the cached messages once and removes them — single-shot. The
// caller (loadHistory) treats this as authoritative for the very first
// mount; afterwards it falls back to the regular IPC path.
export function consumePrefetched(tabId: string, sessionId: string): any[] | null {
  const key = makeKey(tabId, sessionId);
  const v = _prefetchCache.get(key);
  if (v === undefined) return null;
  _prefetchCache.delete(key);
  return v;
}

export function hasPrefetched(tabId: string, sessionId: string): boolean {
  return _prefetchCache.has(makeKey(tabId, sessionId));
}

export function clearPrefetchCache(): void {
  _prefetchCache.clear();
}
