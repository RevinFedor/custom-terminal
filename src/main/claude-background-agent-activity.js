'use strict';

const {
  claudeBackgroundToolKind,
} = require('../shared/history-action-grammar.cjs');
const {
  claudeBackgroundTaskId,
  claudeToolResultText,
  isClaudeToolResultError,
} = require('./claude-background-task-protocol');

const MAX_TERMINAL_BACKGROUND_TOOL_IDS = 512;

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

function rememberTerminalBackgroundTool(state, toolUseId) {
  const exact = normalizeString(toolUseId);
  if (!exact) return;
  state.terminalBackgroundToolUseIds.delete(exact);
  state.terminalBackgroundToolUseIds.add(exact);
  while (state.terminalBackgroundToolUseIds.size > MAX_TERMINAL_BACKGROUND_TOOL_IDS) {
    const oldest = state.terminalBackgroundToolUseIds.values().next().value;
    if (!oldest) break;
    state.terminalBackgroundToolUseIds.delete(oldest);
  }
}

function isTerminalNotificationStatus(value) {
  const status = normalizeString(value).toLowerCase();
  return !!status && status !== 'running';
}

/**
 * Main-owned liveness for Claude async Agent/Task calls and background shell
 * work (Bash run_in_background + Monitor).
 *
 * This tracker deliberately does not infer activity from prose. A call becomes
 * background work only after Claude records the structural acceptance; it
 * ends only on an exact task notification, an exact TaskStop, an exact agent
 * sidecar stop proof, or the owning Claude process/session boundary.
 */
function createClaudeBackgroundAgentActivityTracker({ onChange = null } = {}) {
  const tabs = new Map();

  const snapshotFor = (tabId) => {
    const state = tabs.get(tabId);
    const running = state
      ? [...state.calls.entries()].filter(([, call]) => call.status === 'running')
      : [];
    const agents = running
        .filter(([, call]) => call.kind === 'agent')
        .map(([toolUseId, call]) => ({
          toolUseId,
          agentId: call.agentId || '',
          startedAt: Number(call.startedAt) || 0,
        }));
    const tasks = running
      .filter(([, call]) => call.kind === 'bash' || call.kind === 'monitor')
      .map(([toolUseId, call]) => ({
        toolUseId,
        taskId: call.taskId || '',
        kind: call.kind,
        label: call.label || '',
        command: call.command || '',
        acceptance: call.acceptance || '',
        entryUuid: call.entryUuid || '',
        startedAt: Number(call.startedAt) || 0,
      }));
    return {
      tabId,
      sessionId: state?.sessionId || null,
      generation: state?.generation || null,
      count: agents.length,
      taskCount: tasks.length,
      agents,
      tasks,
      terminalBackgroundToolUseIds: state
        ? [...state.terminalBackgroundToolUseIds]
        : [],
    };
  };

  const snapshotFingerprint = (snapshot) => JSON.stringify({
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    agents: snapshot.agents,
    tasks: snapshot.tasks,
    terminalBackgroundToolUseIds: snapshot.terminalBackgroundToolUseIds,
  });

  const publishIfChanged = (tabId, previousFingerprint, reason, { force = false } = {}) => {
    const snapshot = snapshotFor(tabId);
    if (!force && snapshotFingerprint(snapshot) === previousFingerprint) return snapshot;
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
    const previousFingerprint = snapshotFingerprint(snapshotFor(exactTabId));
    tabs.set(exactTabId, {
      sessionId: exactSessionId,
      generation: exactGeneration,
      calls: new Map(),
      stopCalls: new Map(),
      terminalBackgroundToolUseIds: new Set(),
      seenRecords: new Set(),
    });
    const snapshot = publishIfChanged(exactTabId, previousFingerprint, 'binding-changed', {
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

    const previousFingerprint = snapshotFingerprint(snapshotFor(exactTabId));
    let changed = false;

    for (const part of toolUses(record)) {
      const name = normalizeString(part.name);
      if (name === 'Task' || name === 'Agent') {
        const toolUseId = normalizeString(part.id);
        if (toolUseId && !state.calls.has(toolUseId)) {
          // A tool call alone is not yet a launched background agent. Current
          // Claude no longer needs `run_in_background:true` on Agent: the
          // exact result proves async ownership with toolUseResult.isAsync.
          // Keep every Agent/Task attempt pending, but publish nothing until
          // that structural acceptance arrives. A synchronous/rejected result
          // removes the pending attempt below without ever creating a lease.
          state.calls.set(toolUseId, {
            kind: 'agent',
            status: 'awaiting-acceptance',
            agentId: '',
            startedAt: Date.parse(record?.timestamp || '') || Date.now(),
          });
          changed = true;
        }
      } else if (claudeBackgroundToolKind(name, part.input)) {
        const toolUseId = normalizeString(part.id);
        if (toolUseId && !state.calls.has(toolUseId)) {
          const kind = claudeBackgroundToolKind(name, part.input);
          state.calls.set(toolUseId, {
            kind,
            status: 'awaiting-acceptance',
            taskId: '',
            label: normalizeString(part.input?.description),
            command: normalizeString(part.input?.command),
            acceptance: '',
            entryUuid: normalizeString(record?.uuid),
            startedAt: Date.parse(record?.timestamp || '') || Date.now(),
          });
          changed = true;
        }
      } else if (name === 'TaskStop') {
        const stopUseId = normalizeString(part.id);
        const taskId = normalizeString(part.input?.task_id || part.input?.taskId);
        if (stopUseId && taskId) {
          state.stopCalls.set(stopUseId, taskId);
          while (state.stopCalls.size > 128) {
            const oldest = state.stopCalls.keys().next().value;
            if (!oldest) break;
            state.stopCalls.delete(oldest);
          }
        }
      } else if (name === 'SendMessage') {
        const target = normalizeString(part.input?.to);
        if (!target || target === 'main') continue;
        for (const call of state.calls.values()) {
          if (call.kind === 'agent' && call.agentId === target && call.status !== 'running') {
            call.status = 'running';
            call.startedAt = Date.parse(record?.timestamp || '') || Date.now();
            changed = true;
          }
        }
      }
    }

    const recordAsync = record?.toolUseResult?.isAsync === true;
    const recordAgentId = normalizeString(record?.toolUseResult?.agentId);
    for (const part of toolResults(record)) {
      const toolUseId = normalizeString(part.tool_use_id);
      const stoppedTaskId = state.stopCalls.get(toolUseId);
      if (stoppedTaskId) {
        state.stopCalls.delete(toolUseId);
        if (!isClaudeToolResultError(part)) {
          for (const [originalUseId, backgroundCall] of state.calls) {
            if ((backgroundCall.kind === 'bash' || backgroundCall.kind === 'monitor')
              && backgroundCall.taskId === stoppedTaskId
              && backgroundCall.status !== 'terminal') {
              backgroundCall.status = 'terminal';
              rememberTerminalBackgroundTool(state, originalUseId);
              changed = true;
            }
          }
        }
        continue;
      }
      const blockAsync = part?.toolUseResult?.isAsync === true;
      const acceptedAsyncAgent = recordAsync || blockAsync;
      const blockAgentId = normalizeString(part?.toolUseResult?.agentId);
      let call = state.calls.get(toolUseId);
      if (!call && acceptedAsyncAgent && (recordAgentId || blockAgentId)) {
        // The observer can subscribe between the call and its result. The
        // result itself carries exact tool-use identity and provider async
        // metadata, so it is sufficient to recover the live lease without a
        // text/time match or a speculative generic-tool classification.
        call = {
          kind: 'agent',
          status: 'awaiting-acceptance',
          agentId: '',
          startedAt: Date.parse(record?.timestamp || '') || Date.now(),
        };
        state.calls.set(toolUseId, call);
        changed = true;
      }
      if (!call) continue;
      if (call.kind === 'bash' || call.kind === 'monitor') {
        if (call.status === 'terminal') continue;
        if (isClaudeToolResultError(part)) {
          call.status = 'terminal';
          changed = true;
          continue;
        }
        const acceptance = claudeToolResultText(part);
        const taskId = claudeBackgroundTaskId(record, part, call.kind);
        // Monitor acceptance has an output schema with a task id. Without it
        // we have only an ordinary successful-looking result, not proof that
        // a persistent watch exists. Explicit background Bash is already
        // structural and can be accepted even on older Claude versions that
        // omitted the task id from toolUseResult.
        if (call.kind === 'monitor' && !taskId) continue;
        call.status = 'running';
        call.taskId = taskId || call.taskId;
        call.acceptance = acceptance;
        state.terminalBackgroundToolUseIds.delete(toolUseId);
        changed = true;
        continue;
      }
      if (call.kind !== 'agent') continue;
      // Transcript tail reads can replay a previously parsed acceptance after
      // truncate/reconcile. Only an explicit SendMessage or a newer running
      // notification may reopen terminal work.
      if (call.status === 'terminal') continue;
      if (isClaudeToolResultError(part) || !acceptedAsyncAgent) {
        state.calls.delete(toolUseId);
        changed = true;
        continue;
      }
      const agentId = recordAgentId || blockAgentId;
      call.status = 'running';
      if (agentId) call.agentId = agentId;
      changed = true;
    }

    for (const notification of Array.isArray(notifications) ? notifications : []) {
      const toolUseId = normalizeString(notification?.toolUseId);
      if (!toolUseId) continue;
      const agentId = normalizeString(notification?.agentId);
      const notificationBackgroundKind = notification?.backgroundKind === 'monitor'
        ? 'monitor'
        : notification?.backgroundKind === 'bash'
          ? 'bash'
          : null;
      let call = state.calls.get(toolUseId);
      if (!call) {
        // The observer may attach after the launch record but before a progress
        // notification. The notification itself is exact background-task
        // identity, so a running status is sufficient to recover liveness.
        if (isTerminalNotificationStatus(notification?.status)) {
          if (notificationBackgroundKind) {
            rememberTerminalBackgroundTool(state, toolUseId);
            changed = true;
          }
          continue;
        }
        if (notificationBackgroundKind) {
          call = {
            kind: notificationBackgroundKind,
            status: 'running',
            taskId: normalizeString(notification?.taskId),
            label: normalizeString(notification?.summary),
            command: '',
            acceptance: '',
            entryUuid: '',
            startedAt: Date.parse(record?.timestamp || notification?.timestamp || '') || Date.now(),
          };
        } else if (agentId) {
          call = {
            kind: 'agent',
            status: 'running',
            agentId,
            startedAt: Date.parse(record?.timestamp || notification?.timestamp || '') || Date.now(),
          };
        } else {
          continue;
        }
        state.calls.set(toolUseId, call);
      }
      if (call.kind === 'agent' && agentId) call.agentId = agentId;
      const terminal = isTerminalNotificationStatus(notification?.status);
      call.status = terminal ? 'terminal' : 'running';
      if (terminal && (call.kind === 'bash' || call.kind === 'monitor')) {
        rememberTerminalBackgroundTool(state, toolUseId);
      }
      changed = true;
    }

    const snapshot = publishIfChanged(exactTabId, previousFingerprint, 'transcript-record');
    return { observed: true, changed, ...snapshot };
  };

  const markStopped = ({ tabId, sessionId, toolUseId }) => {
    const exactTabId = normalizeString(tabId);
    const state = tabs.get(exactTabId);
    if (!state || state.sessionId !== normalizeString(sessionId)) {
      return { applied: false, reason: 'binding-mismatch', ...snapshotFor(exactTabId) };
    }
    const call = state.calls.get(normalizeString(toolUseId));
    if (!call || call.kind !== 'agent' || call.status === 'terminal') {
      return { applied: false, reason: 'call-not-live', ...snapshotFor(exactTabId) };
    }
    const previousFingerprint = snapshotFingerprint(snapshotFor(exactTabId));
    call.status = 'terminal';
    const snapshot = publishIfChanged(exactTabId, previousFingerprint, 'sidecar-stopped');
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
