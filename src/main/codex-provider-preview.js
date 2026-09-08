'use strict';

function exactString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function codexProviderPreviewOwnerVerdict(owner, current = {}, incomingSourceId = null) {
  if (!owner) return { allowed: false, reason: 'provider-owner-missing' };
  if (incomingSourceId && owner.sourceId !== incomingSourceId) {
    return { allowed: false, reason: 'provider-source-replaced' };
  }
  if (!owner.terminalToken || owner.terminalToken !== current.terminalToken) {
    return { allowed: false, reason: 'provider-terminal-replaced' };
  }
  if (!Number.isInteger(owner.runSeq) || owner.runSeq <= 0 || owner.runSeq !== current.runSeq) {
    return { allowed: false, reason: 'provider-run-replaced' };
  }
  if (!owner.lifecycleGeneration
    || owner.lifecycleGeneration !== current.lifecycleGeneration) {
    return { allowed: false, reason: 'provider-lifecycle-replaced' };
  }
  if (current.launchId && owner.launchId !== current.launchId) {
    return { allowed: false, reason: 'provider-launch-replaced' };
  }
  return { allowed: true, reason: 'exact-provider-run' };
}

/**
 * A provider `turn_id` is transport correlation, not proof that the request is
 * the user's live Codex turn. Codex 0.151 also sends TUI-owned requests such as
 * Conversation recap with their own turn id after the real compact task has
 * already ended. Admit provider text only while this terminal has a causal
 * prompt/turn/startup owner, and reject a request that contradicts an already
 * adopted rollout writer.
 */
function codexProviderRequestAdmissionVerdict({
  hasCausalTurn = false,
  writerSessionId = null,
  requestSessionId = null,
} = {}) {
  if (hasCausalTurn !== true) {
    return { allowed: false, reason: 'provider-request-without-causal-turn' };
  }
  const writer = exactString(writerSessionId);
  const request = exactString(requestSessionId);
  if (writer && request && writer !== request) {
    return { allowed: false, reason: 'provider-request-writer-session-mismatch' };
  }
  return {
    allowed: true,
    reason: writer && request
      ? 'exact-causal-writer-session'
      : 'causal-turn-without-session-proof',
  };
}

function codexProviderCausalTurnVerdict({
  providerTurnActive = false,
  rolloutTurnBusy = false,
  promptInFlightSubmitted = false,
  startupBeforeInputReady = false,
  pendingCompact = false,
} = {}) {
  if (providerTurnActive === true) {
    return { active: true, reason: 'provider-turn-active' };
  }
  if (rolloutTurnBusy === true) {
    return { active: true, reason: 'rollout-turn-active' };
  }
  if (promptInFlightSubmitted === true) {
    return { active: true, reason: 'submitted-prompt-in-flight' };
  }
  if (startupBeforeInputReady === true) {
    return { active: true, reason: 'startup-before-input-ready' };
  }
  return {
    active: false,
    reason: pendingCompact === true
      ? 'compact-pending-without-task-started'
      : 'provider-request-without-causal-turn',
  };
}

function codexProviderPreviewRolloutVerdict({ owner, current, watcher, detail } = {}) {
  const ownerVerdict = codexProviderPreviewOwnerVerdict(
    owner,
    current,
    owner?.sourceId || null,
  );
  if (!ownerVerdict.allowed) return ownerVerdict;
  if (!watcher) return { allowed: false, reason: 'rollout-watcher-missing' };
  if (watcher.tabId !== detail?.tabId) {
    return { allowed: false, reason: 'rollout-tab-mismatch' };
  }
  if (watcher.sessionId !== detail?.sessionId) {
    return { allowed: false, reason: 'rollout-session-mismatch' };
  }
  if (watcher.filePath && detail?.filePath && watcher.filePath !== detail.filePath) {
    return { allowed: false, reason: 'rollout-file-mismatch' };
  }
  if (watcher.processGeneration !== owner.lifecycleGeneration) {
    return { allowed: false, reason: 'rollout-lifecycle-mismatch' };
  }
  if (watcher.sourceObservationLaunchId
    && watcher.sourceObservationLaunchId !== owner.launchId) {
    return { allowed: false, reason: 'rollout-launch-mismatch' };
  }
  const offset = finiteNumber(detail?.recordByteOffset);
  const boundary = finiteNumber(watcher.processGenerationBoundaryOffset);
  if (offset === null) return { allowed: false, reason: 'rollout-offset-missing' };
  if (boundary !== null && offset < boundary) {
    return { allowed: false, reason: 'rollout-before-run-boundary' };
  }
  return { allowed: true, reason: 'exact-rollout-run' };
}

function codexProviderTerminalOutcomeVerdict({ owner, current, watcher, currentWatcher, outcome, turnId } = {}) {
  const scope = codexProviderPreviewOwnerVerdict(owner, current, owner?.sourceId);
  if (!scope.allowed) return scope;
  if (!watcher || watcher !== currentWatcher) return { allowed: false, reason: 'outcome-watcher-replaced' };
  if (watcher.processGeneration !== owner.lifecycleGeneration) {
    return { allowed: false, reason: 'outcome-lifecycle-mismatch' };
  }
  if (watcher.sourceObservationLaunchId && watcher.sourceObservationLaunchId !== owner.launchId) {
    return { allowed: false, reason: 'outcome-launch-mismatch' };
  }
  // A provider response segment may finish before its next tool call. Only the
  // canonical watcher's typed whole-turn outcome can close provider activity.
  if (outcome?.busy !== false || !['task_complete', 'turn_aborted'].includes(outcome?.event)) {
    return { allowed: false, reason: 'not-terminal-turn-outcome' };
  }
  const endedTurnId = exactString(turnId || outcome?.turnId);
  if (!endedTurnId || endedTurnId !== exactString(owner.turnId)) {
    return { allowed: false, reason: 'outcome-turn-mismatch' };
  }
  if (owner.turnActive !== true) return { allowed: false, reason: 'provider-turn-already-idle' };
  return { allowed: true, reason: 'exact-current-provider-turn-ended', turnId: endedTurnId };
}

function codexOutputText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string'
      ? part.text
      : typeof part?.value === 'string'
        ? part.value
        : '';
  }).filter(Boolean).join('\n');
}

function collectStrings(value, output, depth = 0) {
  if (output.length >= 64 || depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
  }
}

function physicalSessionId(record, fallbackSessionId) {
  return exactString(record?.__physicalSessionId) || exactString(fallbackSessionId) || 'unknown';
}

function sourceIdentity(prefix, record, sessionId, recordByteOffset) {
  const offset = finiteNumber(recordByteOffset);
  return prefix + '-source-' + physicalSessionId(record, sessionId) + '-'
    + (offset === null ? 'unknown' : offset);
}

function classifyCodexProviderPreviewRecord({
  record,
  sessionId,
  recordByteOffset,
  recordEndByteOffset,
} = {}) {
  if (!record || typeof record !== 'object') return null;
  const payload = record.payload || {};
  if (record.type === 'event_msg') {
    const type = exactString(payload.type);
    if (type === 'task_started') {
      return {
        kind: 'lifecycle',
        active: true,
        phase: 'turn',
        turnId: exactString(payload.turn_id),
        reason: 'task_started',
      };
    }
    if (type === 'task_complete' || type === 'turn_aborted') {
      return {
        kind: 'lifecycle',
        active: false,
        phase: 'idle',
        turnId: exactString(payload.turn_id),
        reason: type,
      };
    }
    return null;
  }
  if (record.type !== 'response_item') return null;

  const shared = {
    sessionId: exactString(sessionId),
    recordByteOffset: finiteNumber(recordByteOffset),
    recordEndByteOffset: finiteNumber(recordEndByteOffset),
  };
  if (payload.type === 'message' && payload.role === 'assistant') {
    const text = codexOutputText(payload.content).trim();
    if (!text) return null;
    return {
      kind: 'assistant',
      ...shared,
      itemId: exactString(payload.id),
      identity: sourceIdentity('codex-assistant', record, sessionId, recordByteOffset),
      text,
    };
  }
  if (payload.type === 'reasoning') {
    const structuredTexts = [];
    collectStrings(payload.summary, structuredTexts);
    return {
      kind: 'boundary',
      ...shared,
      boundaryKind: 'thinking',
      identity: sourceIdentity('codex-thinking', record, sessionId, recordByteOffset),
      structuredTexts,
      phase: 'reasoning',
    };
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const structuredTexts = [];
    collectStrings(payload.arguments ?? payload.input, structuredTexts);
    return {
      kind: 'boundary',
      ...shared,
      boundaryKind: 'tool-use',
      identity: sourceIdentity('codex-assistant', record, sessionId, recordByteOffset),
      structuredTexts,
      phase: 'tool',
    };
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const structuredTexts = [];
    collectStrings(payload.output, structuredTexts);
    return {
      kind: 'boundary',
      ...shared,
      boundaryKind: 'tool-result',
      identity: sourceIdentity('codex-tool-result', record, sessionId, recordByteOffset),
      structuredTexts,
      phase: 'tool',
    };
  }
  return null;
}

module.exports = {
  classifyCodexProviderPreviewRecord,
  codexProviderCausalTurnVerdict,
  codexProviderPreviewOwnerVerdict,
  codexProviderRequestAdmissionVerdict,
  codexProviderPreviewRolloutVerdict,
  codexProviderTerminalOutcomeVerdict,
};
