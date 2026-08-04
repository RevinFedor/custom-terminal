'use strict';

function resolveClaudeHookTab({
  sessionId,
  ppid,
  sessionByTab,
  tabByPid,
  hasTab,
} = {}) {
  if (sessionId && sessionByTab) {
    for (const [tabId, knownSessionId] of sessionByTab) {
      if (knownSessionId === sessionId) {
        return { tabId, source: 'session', pid: null };
      }
    }
  }

  const pid = Number(ppid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !tabByPid) {
    return { tabId: null, source: null, pid: null };
  }

  const tabId = tabByPid.get(pid) || null;
  if (!tabId || (typeof hasTab === 'function' && !hasTab(tabId))) {
    return { tabId: null, source: null, pid };
  }

  return { tabId, source: 'pid', pid };
}

function prebindClaudeHookPid({
  tabId,
  matches,
  tabByPid,
  hasTab,
  preferredPids = [],
} = {}) {
  if (
    !tabId
    || !tabByPid
    || (typeof hasTab === 'function' && !hasTab(tabId))
  ) {
    return { bound: false, tabId: null, pid: null, reason: 'tab-unavailable' };
  }

  const byPid = new Map();
  for (const candidate of Array.isArray(matches) ? matches : []) {
    const pid = Number(candidate?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!byPid.has(pid)) byPid.set(pid, candidate);
  }
  const preferred = new Set((Array.isArray(preferredPids) ? preferredPids : [])
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0));
  const preferredMatches = Array.from(byPid.values())
    .filter(candidate => preferred.has(Number(candidate.pid)));
  const match = preferredMatches.length === 1
    ? preferredMatches[0]
    : (preferredMatches.length === 0 && byPid.size === 1
      ? Array.from(byPid.values())[0]
      : null);
  if (!match) {
    return {
      bound: false,
      tabId,
      pid: null,
      reason: byPid.size > 1
        ? 'process-owner-ambiguous'
        : 'process-unavailable',
    };
  }

  const pid = Number(match.pid);
  clearClaudeHookPidBindingsForTab({ tabId, tabByPid });
  tabByPid.set(pid, tabId);
  return { bound: true, tabId, pid, reason: 'process-tree-proof' };
}

function clearClaudeHookPidBindingsForTab({
  tabId,
  tabByPid,
} = {}) {
  if (!tabId || !tabByPid) return [];
  const clearedPids = [];
  for (const [pid, candidateTabId] of tabByPid) {
    if (candidateTabId !== tabId) continue;
    tabByPid.delete(pid);
    clearedPids.push(Number(pid));
  }
  return clearedPids;
}

module.exports = {
  clearClaudeHookPidBindingsForTab,
  prebindClaudeHookPid,
  resolveClaudeHookTab,
};
