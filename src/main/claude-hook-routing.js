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
} = {}) {
  if (
    !tabId
    || !tabByPid
    || (typeof hasTab === 'function' && !hasTab(tabId))
  ) {
    return { bound: false, tabId: null, pid: null, reason: 'tab-unavailable' };
  }

  const match = Array.isArray(matches)
    ? matches.find(candidate => (
      Number.isSafeInteger(Number(candidate?.pid))
      && Number(candidate.pid) > 0
    ))
    : null;
  if (!match) {
    return { bound: false, tabId, pid: null, reason: 'process-unavailable' };
  }

  const pid = Number(match.pid);
  tabByPid.set(pid, tabId);
  return { bound: true, tabId, pid, reason: 'process-tree-proof' };
}

module.exports = {
  prebindClaudeHookPid,
  resolveClaudeHookTab,
};
