'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function normalizeCodexRewindTargetText(text) {
  return String(text || '').trim();
}

function hashCodexRewindTargetText(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeCodexRewindTargetText(text))
    .digest('hex');
}

function buildCodexRewindMessageProof({
  text = '',
  images = [],
  textElements = [],
} = {}) {
  const normalizedText = normalizeCodexRewindTargetText(text);
  return {
    textHash: hashCodexRewindTargetText(normalizedText),
    signature: crypto
      .createHash('sha256')
      .update(JSON.stringify({
        text: normalizedText,
        images: Array.isArray(images) ? images.map(String) : [],
        textElements: Array.isArray(textElements) ? textElements : [],
      }))
      .digest('hex'),
  };
}

function classifyCodexRewindEntryIdentity({
  viewOwnerSessionId = null,
  writerSessionId = null,
  expectedContentRevision = null,
  targetEntryRef = null,
} = {}) {
  const clean = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
  );
  const viewOwner = clean(viewOwnerSessionId);
  const writer = clean(writerSessionId);
  const revision = clean(expectedContentRevision);
  const hasEntryRef = !!targetEntryRef && typeof targetEntryRef === 'object';

  // Physical transcripts have neither a composite revision nor an entryRef.
  // A legacy caller may omit viewOwner entirely; the main-owned writer proof
  // still scopes its direct UUID lookup. If a view owner is supplied, it must
  // be the exact current writer.
  if (!revision && !hasEntryRef) {
    if (viewOwner && (!writer || viewOwner !== writer)) {
      return { valid: false, mode: 'invalid', reason: 'physical-view-owner-mismatch' };
    }
    return { valid: true, mode: 'physical', reason: 'physical-writer-target' };
  }

  // Composite history is an all-or-nothing identity tuple. Never downgrade a
  // partial tuple to the physical fallback: that could rewind the same text in
  // a different frozen source segment.
  if (!revision || !hasEntryRef || !viewOwner || !writer || viewOwner !== writer) {
    return { valid: false, mode: 'invalid', reason: 'composite-entry-identity-incomplete' };
  }
  const refOwner = clean(targetEntryRef.viewOwnerSessionId);
  if (refOwner && refOwner !== viewOwner) {
    return { valid: false, mode: 'invalid', reason: 'composite-entry-owner-mismatch' };
  }
  return { valid: true, mode: 'composite', reason: 'composite-entry-identity' };
}

function classifyCodexRewindUserTurnBoundaries(records = []) {
  const source = Array.isArray(records) ? records : [];
  const hasProviderTurnBoundaries = source.some((record) => (
    record?.type === 'event_msg' && record?.payload?.type === 'task_started'
  ));
  const result = new Map();
  let pendingTaskStartedLine = null;

  for (const record of source) {
    if (record?.type !== 'event_msg') continue;
    const payloadType = record?.payload?.type;
    const sourceLine = Number(record?.__line);
    if (payloadType === 'task_started') {
      pendingTaskStartedLine = Number.isInteger(sourceLine) ? sourceLine : null;
      continue;
    }
    if (payloadType === 'task_complete'
      || payloadType === 'turn_aborted'
      || payloadType === 'thread_rolled_back') {
      pendingTaskStartedLine = null;
      continue;
    }
    if (payloadType !== 'user_message' || !Number.isInteger(sourceLine)) continue;

    const branchable = !hasProviderTurnBoundaries || pendingTaskStartedLine !== null;
    result.set(sourceLine, Object.freeze({
      branchable,
      reason: branchable
        ? (hasProviderTurnBoundaries ? 'provider-turn-boundary' : 'legacy-no-turn-events')
        : 'mid-turn-user-message',
      taskStartedSourceLine: pendingTaskStartedLine,
    }));
    // One provider turn boundary can authorize only its first logical user
    // message. Further user_message records before the next task_started are
    // steering/queued input inside that same turn and are not native branch
    // targets even though Codex may render them in the transcript overlay.
    pendingTaskStartedLine = null;
  }

  return result;
}

function classifyCodexStableSourceTranscriptRecovery({
  journal,
  currentSessionId = null,
  discoveryComplete = false,
  descendants = [],
  sourceMessages = [],
  sourceLifecycleEvents = [],
} = {}) {
  if (discoveryComplete !== true) {
    return { proven: false, reason: 'descendant-discovery-incomplete' };
  }
  if (Array.isArray(descendants) && descendants.length > 0) {
    return { proven: false, reason: 'descendant-present' };
  }
  if (!journal
    || journal.version !== 2
    || !journal.sourceSessionId
    || !journal.actionGeneration
    || !Number.isFinite(Number(journal.actionStartedAtMs))
    || !Number.isInteger(Number(journal.targetSourceLine))
    || !journal.targetUuid
    || !journal.targetTextHash) {
    return { proven: false, reason: 'journal-boundary-incomplete' };
  }
  const isBoundaryPhase = journal.phase === 'confirm-enter-boundary';
  const isDurableSubmitPhase = journal.phase === 'stable-source-submit-written';
  if (!isBoundaryPhase && !isDurableSubmitPhase) {
    return { proven: false, reason: 'journal-boundary-incomplete' };
  }
  const submitProof = journal.submitProof || null;
  if (isDurableSubmitPhase && (
    submitProof?.version !== 1
    || !submitProof.submitId
    || submitProof.sourceSessionId !== journal.sourceSessionId
    || submitProof.actionGeneration !== journal.actionGeneration
    || submitProof.expectedLen === null
    || submitProof.expectedLen === undefined
    || !Number.isSafeInteger(Number(submitProof.expectedLen))
    || Number(submitProof.expectedLen) < 0
    || !/^[a-f0-9]{16}$/i.test(String(submitProof.expectedHash || ''))
    || !Number.isFinite(Number(submitProof.sentAtMs))
    || Number(submitProof.sentAtMs) < Number(journal.actionStartedAtMs)
    || !Number.isFinite(Number(submitProof.submitWrittenAtMs))
    || Number(submitProof.submitWrittenAtMs) < Number(submitProof.sentAtMs)
    || !path.isAbsolute(String(submitProof.sourceFilePath || ''))
    || submitProof.sourceFileSize === null
    || submitProof.sourceFileSize === undefined
    || !Number.isSafeInteger(Number(submitProof.sourceFileSize))
    || Number(submitProof.sourceFileSize) < 0
    || !Number.isInteger(Number(submitProof.runSeq))
    || Number(submitProof.runSeq) <= 0
    || (submitProof.originPhase !== 'stable-source-settled'
      && submitProof.originPhase !== 'branch-draft-restored')
  )) {
    return { proven: false, reason: 'journal-submit-proof-incomplete' };
  }
  const expectedBinding = journal.expectedBindingSessionId || journal.sourceSessionId;
  if (expectedBinding !== journal.sourceSessionId
    || currentSessionId !== journal.sourceSessionId) {
    return { proven: false, reason: 'source-binding-not-stable' };
  }

  const messages = (Array.isArray(sourceMessages) ? sourceMessages : [])
    .filter((message) => Number.isInteger(Number(message?.sourceLine)))
    .sort((a, b) => Number(a.sourceLine) - Number(b.sourceLine));
  const target = messages.find((message) => (
    Number(message.sourceLine) === Number(journal.targetSourceLine)
    && message.uuid === journal.targetUuid
  ));
  if (!target || target.textHash !== journal.targetTextHash) {
    return { proven: false, reason: 'source-target-proof-mismatch' };
  }

  const startedAt = Number(journal.actionStartedAtMs);
  const firstPostActionMessage = messages.find((message) => {
    if (Number(message.sourceLine) <= Number(journal.targetSourceLine)
      || !Number.isFinite(Number(message.timestampMs))) {
      return false;
    }
    if (!isDurableSubmitPhase) return Number(message.timestampMs) >= startedAt;
    return Number(message.timestampMs) >= Number(submitProof.sentAtMs)
      && Number.isFinite(Number(message.byteOffset))
      && Number(message.byteOffset) >= Number(submitProof.sourceFileSize)
      && Number(message.textLength) === Number(submitProof.expectedLen)
      && message.auditHash === submitProof.expectedHash;
  });
  if (!firstPostActionMessage) {
    return {
      proven: false,
      reason: isDurableSubmitPhase
        ? 'durable-submit-user-message-missing'
        : 'post-action-source-message-missing',
    };
  }
  const taskStarted = (Array.isArray(sourceLifecycleEvents) ? sourceLifecycleEvents : [])
    .filter((event) => (
      event?.type === 'task_started'
      && Number.isInteger(Number(event.sourceLine))
      && Number(event.sourceLine) > Number(journal.targetSourceLine)
      && Number(event.sourceLine) < Number(firstPostActionMessage.sourceLine)
      && Number.isFinite(Number(event.timestampMs))
      && Number(event.timestampMs) >= (
        isDurableSubmitPhase ? Number(submitProof.sentAtMs) : startedAt
      )
      && Number(event.timestampMs) <= Number(firstPostActionMessage.timestampMs)
      && (!isDurableSubmitPhase
        || (Number.isFinite(Number(event.byteOffset))
          && Number(event.byteOffset) >= Number(submitProof.sourceFileSize)))
    ))
    .sort((a, b) => Number(b.sourceLine) - Number(a.sourceLine))[0] || null;
  if (!taskStarted) {
    return {
      proven: false,
      reason: isDurableSubmitPhase
        ? 'durable-submit-task-start-missing'
        : 'post-action-source-task-start-missing',
    };
  }

  return {
    proven: true,
    reason: isDurableSubmitPhase
      ? 'stable-source-exact-submit-task-and-user-message'
      : 'stable-source-task-and-user-message',
    sourceSessionId: journal.sourceSessionId,
    actionGeneration: journal.actionGeneration,
    targetSourceLine: Number(journal.targetSourceLine),
    taskStartedSourceLine: Number(taskStarted.sourceLine),
    userMessageSourceLine: Number(firstPostActionMessage.sourceLine),
    userMessageTimestampMs: Number(firstPostActionMessage.timestampMs),
    ...(isDurableSubmitPhase ? {
      taskStartedByteOffset: Number(taskStarted.byteOffset),
      userMessageByteOffset: Number(firstPostActionMessage.byteOffset),
      userMessageTextLength: Number(firstPostActionMessage.textLength),
      userMessageAuditHash: firstPostActionMessage.auditHash,
      submitProof: { ...submitProof },
    } : {}),
  };
}

function classifyCodexStableSourceRollbackOutcome({
  journal,
  currentSessionId = null,
  sourceMessages = [],
  sourceLifecycleEvents = [],
} = {}) {
  if (!journal
    || journal.version !== 2
    || (journal.phase !== 'confirm-enter-boundary'
      && journal.phase !== 'rollback-applied')
    || !journal.sourceSessionId
    || !journal.actionGeneration
    || !Number.isFinite(Number(journal.actionStartedAtMs))
    || !Number.isInteger(Number(journal.targetSourceLine))
    || !journal.targetUuid
    || !journal.targetTextHash
    || !Number.isInteger(Number(journal.rollbackTurns))
    || Number(journal.rollbackTurns) < 1) {
    return { proven: false, reason: 'journal-boundary-incomplete' };
  }
  if (journal.phase === 'rollback-applied'
    && (!Number.isFinite(Number(journal.appliedAtMs))
      || Number(journal.appliedAtMs) < Number(journal.actionStartedAtMs)
      || journal.restoredTextHash !== journal.targetTextHash)) {
    return { proven: false, reason: 'journal-rollback-proof-incomplete' };
  }
  const expectedBinding = journal.expectedBindingSessionId || journal.sourceSessionId;
  if (expectedBinding !== journal.sourceSessionId
    || currentSessionId !== journal.sourceSessionId) {
    return { proven: false, reason: 'source-binding-not-stable' };
  }
  const target = (Array.isArray(sourceMessages) ? sourceMessages : []).find((message) => (
    Number(message?.sourceLine) === Number(journal.targetSourceLine)
    && message?.uuid === journal.targetUuid
  ));
  if (!target || target.textHash !== journal.targetTextHash) {
    return { proven: false, reason: 'source-target-proof-mismatch' };
  }
  const rollback = (Array.isArray(sourceLifecycleEvents) ? sourceLifecycleEvents : [])
    .filter((event) => (
      event?.type === 'thread_rolled_back'
      && Number.isInteger(Number(event.sourceLine))
      && Number(event.sourceLine) > Number(journal.targetSourceLine)
      && Number.isFinite(Number(event.timestampMs))
      && Number(event.timestampMs) >= Number(journal.actionStartedAtMs)
    ))
    .sort((a, b) => Number(a.sourceLine) - Number(b.sourceLine))[0] || null;
  if (!rollback) {
    return { proven: false, reason: 'post-action-thread-rollback-missing' };
  }
  if (!Number.isInteger(Number(rollback.numTurns))
    || Number(rollback.numTurns) !== Number(journal.rollbackTurns)) {
    return {
      proven: false,
      reason: 'thread-rollback-depth-mismatch',
      expectedRollbackTurns: Number(journal.rollbackTurns),
      observedRollbackTurns: Number(rollback.numTurns),
    };
  }
  return {
    proven: true,
    reason: 'exact-thread-rolled-back',
    sourceSessionId: journal.sourceSessionId,
    actionGeneration: journal.actionGeneration,
    targetSourceLine: Number(journal.targetSourceLine),
    rollbackSourceLine: Number(rollback.sourceLine),
    rollbackTurns: Number(rollback.numTurns),
    rollbackTimestampMs: Number(rollback.timestampMs),
  };
}

function classifyCodexNativeRewindNoMutationRecovery({
  journal,
  currentSessionId = null,
  discoveryComplete = false,
  descendants = [],
  sourceMessages = [],
  sourceLifecycleEvents = [],
} = {}) {
  if (discoveryComplete !== true) {
    return { proven: false, reason: 'descendant-discovery-incomplete' };
  }
  if (Array.isArray(descendants) && descendants.length > 0) {
    return { proven: false, reason: 'descendant-present' };
  }
  if (!journal
    || journal.version !== 2
    || (journal.phase !== 'confirm-enter-boundary'
      && journal.phase !== 'branch-draft-restored'
      && journal.phase !== 'rollback-applied')
    || !journal.sourceSessionId
    || !journal.actionGeneration
    || !Number.isFinite(Number(journal.actionStartedAtMs))
    || !Number.isInteger(Number(journal.targetSourceLine))
    || !journal.targetUuid
    || !journal.targetTextHash) {
    return { proven: false, reason: 'journal-boundary-incomplete' };
  }
  if (journal.phase === 'rollback-applied'
    && (!Number.isFinite(Number(journal.appliedAtMs))
      || Number(journal.appliedAtMs) < Number(journal.actionStartedAtMs)
      || journal.restoredTextHash !== journal.targetTextHash)) {
    return { proven: false, reason: 'journal-rollback-proof-incomplete' };
  }
  const expectedBinding = journal.expectedBindingSessionId || journal.sourceSessionId;
  if (expectedBinding !== journal.sourceSessionId
    || currentSessionId !== journal.sourceSessionId) {
    return { proven: false, reason: 'source-binding-not-stable' };
  }

  const messages = (Array.isArray(sourceMessages) ? sourceMessages : [])
    .filter((message) => Number.isInteger(Number(message?.sourceLine)));
  const target = messages.find((message) => (
    Number(message.sourceLine) === Number(journal.targetSourceLine)
    && message.uuid === journal.targetUuid
  ));
  if (!target || target.textHash !== journal.targetTextHash) {
    return { proven: false, reason: 'source-target-proof-mismatch' };
  }

  const startedAt = Number(journal.actionStartedAtMs);
  const postActionUser = messages.find((message) => (
    Number(message.sourceLine) > Number(journal.targetSourceLine)
    && Number.isFinite(Number(message.timestampMs))
    && Number(message.timestampMs) >= startedAt
  ));
  if (postActionUser) {
    return { proven: false, reason: 'post-action-source-user-message-present' };
  }
  const postActionLifecycle = (Array.isArray(sourceLifecycleEvents)
    ? sourceLifecycleEvents
    : []).find((event) => (
    Number.isInteger(Number(event?.sourceLine))
    && Number(event.sourceLine) > Number(journal.targetSourceLine)
    && Number.isFinite(Number(event.timestampMs))
    && Number(event.timestampMs) >= startedAt
    && (event.type === 'task_started' || event.type === 'thread_rolled_back')
  ));
  if (postActionLifecycle) {
    return {
      proven: false,
      reason: 'post-action-source-' + postActionLifecycle.type + '-present',
    };
  }

  return {
    proven: true,
    reason: 'no-persisted-rewind-mutation',
    sourceSessionId: journal.sourceSessionId,
    actionGeneration: journal.actionGeneration,
    targetSourceLine: Number(journal.targetSourceLine),
  };
}

const CODEX_HISTORY_REWRITE_FORK_MODES = new Set([
  'history_delete',
  'history_edit',
  'history_rewind',
]);

function classifyCodexHistoryRewriteRecoveryCandidate({
  journal,
  currentSessionId = null,
  historyEvent = null,
} = {}) {
  if (!journal
    || journal.version !== 2
    || !journal.sourceSessionId
    || !journal.actionGeneration
    || !Number.isFinite(Number(journal.actionStartedAtMs))) {
    return { eligible: false, reason: 'journal-boundary-incomplete' };
  }
  if (!currentSessionId || currentSessionId === journal.sourceSessionId) {
    return { eligible: false, reason: 'history-rewrite-child-not-bound' };
  }
  if (!historyEvent || typeof historyEvent !== 'object') {
    return { eligible: false, reason: 'history-rewrite-event-missing' };
  }
  const eventSessionId = historyEvent.sessionId || historyEvent.childSessionId || null;
  const eventChildSessionId = historyEvent.childSessionId || historyEvent.sessionId || null;
  const forkMode = String(historyEvent.forkMode || historyEvent.fork_mode || '').trim();
  const occurredAtRaw = Number(historyEvent.occurredAt ?? historyEvent.occurred_at);
  const occurredAtMs = Number.isFinite(occurredAtRaw)
    ? (occurredAtRaw < 1e12 ? occurredAtRaw * 1000 : occurredAtRaw)
    : NaN;
  if (historyEvent.eventType !== 'fork'
    || historyEvent.provider !== 'codex'
    || historyEvent.sourceSessionId !== journal.sourceSessionId
    || eventSessionId !== currentSessionId
    || eventChildSessionId !== currentSessionId
    || historyEvent.origin !== 'app'
    || historyEvent.isDirect !== true
    || historyEvent.snapshotComplete !== true
    || !CODEX_HISTORY_REWRITE_FORK_MODES.has(forkMode)
    || !Number.isFinite(occurredAtMs)
    || occurredAtMs < Number(journal.actionStartedAtMs)) {
    return { eligible: false, reason: 'history-rewrite-event-scope-mismatch' };
  }
  return {
    eligible: true,
    reason: 'exact-app-history-rewrite-lineage',
    sessionId: currentSessionId,
    sourceSessionId: journal.sourceSessionId,
    forkMode,
    occurredAtMs,
  };
}

module.exports = {
  buildCodexRewindMessageProof,
  classifyCodexHistoryRewriteRecoveryCandidate,
  classifyCodexRewindEntryIdentity,
  classifyCodexRewindUserTurnBoundaries,
  classifyCodexNativeRewindNoMutationRecovery,
  classifyCodexStableSourceRollbackOutcome,
  classifyCodexStableSourceTranscriptRecovery,
  hashCodexRewindTargetText,
  normalizeCodexRewindTargetText,
};
