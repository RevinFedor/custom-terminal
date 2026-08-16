'use strict';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toolUses(record) {
  if (record?.type !== 'assistant' || !Array.isArray(record?.message?.content)) return [];
  return record.message.content.filter((part) => part?.type === 'tool_use');
}

function toolResults(record) {
  if (record?.type !== 'user' || !Array.isArray(record?.message?.content)) return [];
  return record.message.content.filter((part) => part?.type === 'tool_result');
}

function isTerminalNotificationStatus(value) {
  const status = normalizeString(value).toLowerCase();
  return !!status && status !== 'running';
}

/**
 * Main-owned liveness for Claude async Agent/Task calls.
 *
 * This tracker deliberately does not infer activity from prose. A call becomes
 * background work only after Claude records the structural async acceptance;
 * it ends only on an exact task notification, an exact sidecar stop proof, or
 * the owning Claude process/session boundary.
 */
function createClaudeBackgroundAgentActivityTracker({ onChange = null } = {}) {
  const tabs = new Map();

  const snapshotFor = (tabId) => {
    const state = tabs.get(tabId);
    const agents = state
      ? [...state.calls.entries()]
        .filter(([, call]) => call.status === 'running')
        .map(([toolUseId, call]) => ({
          toolUseId,
          agentId: call.agentId || '',
        }))
      : [];
    return {
      tabId,
      sessionId: state?.sessionId || null,
      generation: state?.generation || null,
      count: agents.length,
      agents,
    };
  };

  const publishIfChanged = (tabId, previousCount, reason, { force = false } = {}) => {
    const snapshot = snapshotFor(tabId);
    if (!force && snapshot.count === previousCount) return snapshot;
    if (typeof onChange === 'function') onChange({ ...snapshot, reason });
    return snapshot;
  };

  const bind = ({ tabId, sessionId, generation = null }) => {
    const exactTabId = normalizeString(tabId);
    const exactSessionId = normalizeString(sessionId);
    if (!exactTabId || !exactSessionId) return { bound: false, reason: 'identity-required' };
    const exactGeneration = normalizeString(generation) || null;
    const previous = tabs.get(exactTabId);
    if (previous
      && previous.sessionId === exactSessionId
      && previous.generation === exactGeneration) {
      return { bound: true, changed: false, ...snapshotFor(exactTabId) };
    }
    const previousCount = snapshotFor(exactTabId).count;
    tabs.set(exactTabId, {
      sessionId: exactSessionId,
      generation: exactGeneration,
      calls: new Map(),
      seenRecords: new Set(),
    });
    const snapshot = publishIfChanged(exactTabId, previousCount, 'binding-changed', {
      // A new process/session is an authoritative zero even if the old state
      // was also empty: renderer reload may have retained a stale positive.
      force: true,
    });
    return { bound: true, changed: true, ...snapshot };
  };

  const observe = ({
    tabId,
    sessionId,
    record,
    recordByteOffset = null,
    notifications = [],
  }) => {
    const exactTabId = normalizeString(tabId);
    const exactSessionId = normalizeString(sessionId);
    const state = tabs.get(exactTabId);
    if (!state || !exactSessionId || state.sessionId !== exactSessionId) {
      return { observed: false, reason: 'binding-mismatch', ...snapshotFor(exactTabId) };
    }
    const recordSessionId = normalizeString(record?.sessionId);
    if (recordSessionId && recordSessionId !== state.sessionId) {
      return { observed: false, reason: 'record-session-mismatch', ...snapshotFor(exactTabId) };
    }
    const hasExactOffset = recordByteOffset !== null && recordByteOffset !== undefined;
    const exactOffset = hasExactOffset ? Number(recordByteOffset) : NaN;
    const recordIdentity = Number.isSafeInteger(exactOffset) && exactOffset >= 0
      ? exactOffset + ':' + normalizeString(record?.uuid) + ':' + normalizeString(record?.type)
      : '';
    if (recordIdentity && state.seenRecords.has(recordIdentity)) {
      return { observed: false, reason: 'duplicate-record', ...snapshotFor(exactTabId) };
    }
    if (recordIdentity) state.seenRecords.add(recordIdentity);

    const previousCount = snapshotFor(exactTabId).count;
    let changed = false;

    for (const part of toolUses(record)) {
      const name = normalizeString(part.name);
      if ((name === 'Task' || name === 'Agent') && part.input?.run_in_background === true) {
        const toolUseId = normalizeString(part.id);
        if (toolUseId && !state.calls.has(toolUseId)) {
          // A tool call alone is not yet a launched agent. The parent turn is
          // already busy, so the tab loader needs no speculative extra owner.
          state.calls.set(toolUseId, { status: 'awaiting-acceptance', agentId: '' });
          changed = true;
        }
      } else if (name === 'SendMessage') {
        const target = normalizeString(part.input?.to);
        if (!target || target === 'main') continue;
        for (const call of state.calls.values()) {
          if (call.agentId === target && call.status !== 'running') {
            call.status = 'running';
            changed = true;
          }
        }
      }
    }

    const recordAsync = record?.toolUseResult?.isAsync === true;
    const recordAgentId = normalizeString(record?.toolUseResult?.agentId);
    for (const part of toolResults(record)) {
      const toolUseId = normalizeString(part.tool_use_id);
      const call = state.calls.get(toolUseId);
      const blockAsync = part?.toolUseResult?.isAsync === true;
      if (!call || (!recordAsync && !blockAsync)) continue;
      // Transcript tail reads can replay a previously parsed acceptance after
      // truncate/reconcile. Only an explicit SendMessage or a newer running
      // notification may reopen terminal work.
      if (call.status === 'terminal') continue;
      const agentId = recordAgentId || normalizeString(part?.toolUseResult?.agentId);
      call.status = 'running';
      if (agentId) call.agentId = agentId;
      changed = true;
    }

    for (const notification of Array.isArray(notifications) ? notifications : []) {
      const toolUseId = normalizeString(notification?.toolUseId);
      if (!toolUseId) continue;
      const agentId = normalizeString(notification?.agentId);
      let call = state.calls.get(toolUseId);
      if (!call) {
        // The observer may attach after the launch record but before a progress
        // notification. The notification itself is exact background-task
        // identity, so a running status is sufficient to recover liveness.
        if (isTerminalNotificationStatus(notification?.status)) continue;
        call = { status: 'running', agentId };
        state.calls.set(toolUseId, call);
      }
      if (agentId) call.agentId = agentId;
      call.status = isTerminalNotificationStatus(notification?.status)
        ? 'terminal'
        : 'running';
      changed = true;
    }

    const snapshot = publishIfChanged(exactTabId, previousCount, 'transcript-record');
    return { observed: true, changed, ...snapshot };
  };

  const markStopped = ({ tabId, sessionId, toolUseId }) => {
    const exactTabId = normalizeString(tabId);
    const state = tabs.get(exactTabId);
    if (!state || state.sessionId !== normalizeString(sessionId)) {
      return { applied: false, reason: 'binding-mismatch', ...snapshotFor(exactTabId) };
    }
    const call = state.calls.get(normalizeString(toolUseId));
    if (!call || call.status === 'terminal') {
      return { applied: false, reason: 'call-not-live', ...snapshotFor(exactTabId) };
    }
    const previousCount = snapshotFor(exactTabId).count;
    call.status = 'terminal';
    const snapshot = publishIfChanged(exactTabId, previousCount, 'sidecar-stopped');
    return { applied: true, ...snapshot };
  };

  const clear = (tabId, reason = 'process-ended') => {
    const exactTabId = normalizeString(tabId);
    const existed = tabs.has(exactTabId);
    tabs.delete(exactTabId);
    const snapshot = snapshotFor(exactTabId);
    // Process exit is an authoritative zero and must repair any renderer that
    // missed the earlier transition, even when the tracker itself was empty.
    if (existed && typeof onChange === 'function') onChange({ ...snapshot, reason });
    return { cleared: existed, ...snapshot };
  };

  const list = () => [...tabs.keys()].map(snapshotFor);

  return {
    bind,
    observe,
    markStopped,
    clear,
    snapshot: snapshotFor,
    list,
  };
}

module.exports = {
  createClaudeBackgroundAgentActivityTracker,
};
