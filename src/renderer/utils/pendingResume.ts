// Tracks in-flight `claude --resume <X>` operations per tab.
//
// When any subsystem (AutoResume, Claude Intercept of typed `claude --resume`,
// future flows) sends a resume command, it MUST call markPendingResume so the
// Bridge handler in Terminal.tsx can reject conflicting late-arriving stale
// bridge events. See docs/knowledge/fix-bridge-stale-takeover.md for incident.
//
// Lifetime: 15 seconds. A real claude --resume produces a fresh bridge.json
// within 1-3 seconds (statusline-bridge fires on first assistant response),
// but we allow generous slack for cold starts / slow disks.

const TTL_MS = 15_000;

interface Pending {
  sessionId: string;
  at: number;
}

const map = new Map<string, Pending>();

export function markPendingResume(tabId: string, sessionId: string): void {
  map.set(tabId, { sessionId, at: Date.now() });
}

export function getPendingResume(tabId: string): Pending | null {
  const v = map.get(tabId);
  if (!v) return null;
  if (Date.now() - v.at > TTL_MS) {
    map.delete(tabId);
    return null;
  }
  return v;
}

export function clearPendingResume(tabId: string): void {
  map.delete(tabId);
}

// True if the incoming bridge sessionId disagrees with the resume in flight
// for this tab. Caller should drop the bridge event in that case (it's almost
// certainly a stale ~/.claude/bridge/*.json from a long-dead process).
export function isStaleAgainstPending(tabId: string, incomingSessionId: string): boolean {
  const p = getPendingResume(tabId);
  if (!p) return false;
  return p.sessionId !== incomingSessionId;
}
