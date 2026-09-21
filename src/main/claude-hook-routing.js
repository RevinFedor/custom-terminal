'use strict';

const MAIN_HOOK_EVENTS = new Set([
  'UserPromptSubmit', 'Stop', 'StopFailure',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
]);
const TOOL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

// Routing locates a tab, not the owner of a turn within that tab. Claude runs
// subagents inside the same process/session; their errors must not settle the
// parent. agent_type alone is also present for a main session using --agent.
function admitClaudeMainHook({ message = {}, currentTurn = null, currentProcessId = null } = {}) {
  if (!MAIN_HOOK_EVENTS.has(message.event)) {
    return { accepted: false, reason: 'non-turn-hook' };
  }
  const pid = Number(message.ppid);
  const ownerPid = Number(currentProcessId);
  if (Number.isSafeInteger(pid) && pid > 0
    && Number.isSafeInteger(ownerPid) && ownerPid > 0 && pid !== ownerPid) {
    return { accepted: false, reason: 'process-owner-mismatch' };
  }
  // Tools have their own tool_use_id/question ownership and never fall through
  // to the turn reducer. Keep their existing path, including a subagent's
  // interactive question; isolating child completion must not hide that UI.
  if (TOOL_HOOK_EVENTS.has(message.event)) {
    return { accepted: true, reason: 'tool-hook' };
  }
  if (message.agent_id || message.agent_transcript_path) {
    return { accepted: false, reason: 'subagent-hook' };
  }
  if (message.event === 'UserPromptSubmit' && currentTurn?.provider === 'claude'
    && currentTurn.active === true && message.prompt_id
    && message.prompt_id === currentTurn.providerPromptId
    && message.session_id === currentTurn.sessionId
    && Number.isSafeInteger(pid) && pid > 0
    && String(pid) === String(currentTurn.processId)) {
    return { accepted: false, reason: 'duplicate-prompt-start' };
  }
  // Legacy CLI versions do not supply prompt_id. Preserve their hook behavior;
  // compare exact IDs when both ends provide them, never text or elapsed time.
  if (message.event !== 'UserPromptSubmit' && currentTurn?.provider === 'claude') {
    if (message.session_id && currentTurn.sessionId
      && message.session_id !== currentTurn.sessionId) {
      return { accepted: false, reason: 'turn-session-mismatch' };
    }
    if (message.prompt_id && currentTurn.providerPromptId
      && message.prompt_id !== currentTurn.providerPromptId) {
      return { accepted: false, reason: 'prompt-owner-mismatch' };
    }
    if (Number.isSafeInteger(pid) && pid > 0
      && currentTurn.processId && String(pid) !== String(currentTurn.processId)) {
      return { accepted: false, reason: 'turn-process-mismatch' };
    }
  }
  return { accepted: true, reason: 'main-hook' };
}

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
  admitClaudeMainHook,
  clearClaudeHookPidBindingsForTab,
  prebindClaudeHookPid,
  resolveClaudeHookTab,
};
