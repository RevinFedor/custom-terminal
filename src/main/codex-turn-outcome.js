'use strict';

const CODEX_NO_FINAL_RESULT_REASON = 'codex-no-final-result';
const CODEX_INPUT_READY_TURN_END_EVENTS = new Set([
  'task_complete',
  'turn_aborted',
]);
const codexTurnObservationWatchers = new WeakMap();
let codexTurnObservationWatcherSequence = 0;

function isCodexInputReadyTurnEndEvent(event) {
  return CODEX_INPUT_READY_TURN_END_EVENTS.has(event);
}

function hasNonEmptyCodexFinalResult(payload) {
  return typeof payload?.last_agent_message === 'string'
    && payload.last_agent_message.trim().length > 0;
}

function codexRecordEventType(record) {
  if (!record || record.type !== 'event_msg') return null;
  return record.payload?.type || null;
}

function codexRecordTurnId(record) {
  const value = record?.payload?.turn_id
    || record?.payload?.internal_chat_message_metadata_passthrough?.turn_id
    || record?.payload?.metadata?.turn_id
    || null;
  return typeof value === 'string' && value ? value : null;
}

function codexRootFinalAnswerText(record) {
  const payload = record?.payload;
  if (record?.type !== 'response_item'
    || payload?.type !== 'message'
    || payload?.role !== 'assistant'
    || payload?.phase !== 'final_answer'
    || !Array.isArray(payload?.content)) {
    return '';
  }
  return payload.content
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

function observeCodexTurnRecord(tracker, record) {
  const event = codexRecordEventType(record);
  const recordTurnId = codexRecordTurnId(record);
  if (event === 'task_started') {
    tracker.currentTurnId = recordTurnId;
    tracker.currentTurnHasFinalResult = false;
    tracker.currentTurnFinalResultTurnId = null;
    return;
  }

  const finalText = codexRootFinalAnswerText(record);
  if (!finalText || !recordTurnId) return;
  if (tracker.currentTurnId && recordTurnId && tracker.currentTurnId !== recordTurnId) return;
  tracker.currentTurnHasFinalResult = true;
  tracker.currentTurnFinalResultTurnId = recordTurnId;
}

function trackerHasFinalResultForEvent(tracker, payload) {
  if (tracker?.currentTurnHasFinalResult !== true) return false;
  const completedTurnId = typeof payload?.turn_id === 'string' ? payload.turn_id : null;
  const proofTurnId = tracker.currentTurnFinalResultTurnId || null;
  return !!completedTurnId && !!proofTurnId && completedTurnId === proofTurnId;
}

function classifyCodexTurnEvent(event, payload, options = {}) {
  if (event === 'task_started') {
    return { event, busy: true, reason: event, hasFinalResult: null };
  }
  if (event === 'turn_aborted') {
    return { event, busy: false, reason: event, hasFinalResult: false };
  }
  if (event === 'task_complete') {
    // A provider can retain an earlier answer while reporting a failed turn.
    // The typed failure wins; that text must not trigger successful Run After.
    if (payload?.error && typeof payload.error === 'object') {
      const capacity = payload.error.codex_error_info === 'server_overloaded'
        && String(payload.error.message || '').trim()
          === 'Selected model is at capacity. Please try a different model.';
      return { event, busy: false, reason: capacity ? 'model_capacity' : 'provider_error', hasFinalResult: false };
    }
    const hasFinalResult = hasNonEmptyCodexFinalResult(payload)
      || options.hasTrackedFinalResult === true;
    return {
      event,
      busy: false,
      reason: hasFinalResult ? event : CODEX_NO_FINAL_RESULT_REASON,
      hasFinalResult,
    };
  }
  return null;
}

// Observation only: explicit cross-turn completion may reflect a provider
// ordering contract we have not yet seen in a real live rollout. Describe the
// contradiction without deciding that either turn id or outcome is wrong.
function describeCodexTurnEndContradiction(tracker, record) {
  const event = codexRecordEventType(record);
  const currentTurnId = typeof tracker?.currentTurnId === 'string' ? tracker.currentTurnId : null;
  const incomingTurnId = typeof record?.payload?.turn_id === 'string' ? record.payload.turn_id : null;
  if (tracker?.busy !== true || !currentTurnId || !incomingTurnId
    || currentTurnId === incomingTurnId || !CODEX_INPUT_READY_TURN_END_EVENTS.has(event)) {
    return null;
  }
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = value => typeof value === 'string' ? value : null;
  return {
    kind: 'busy-turn-end-id-mismatch',
    observationOnly: true,
    previous: {
      busy: true,
      currentTurnId,
      currentTurnHasFinalResult: tracker.currentTurnHasFinalResult === true,
      currentTurnFinalResultTurnId: text(tracker.currentTurnFinalResultTurnId),
      lastEventType: text(tracker.lastEventType),
      lastEventTs: text(tracker.lastEventTs),
      outcomeKnown: tracker.outcomeKnown === true,
      lastOutcomeReason: text(tracker.lastOutcomeReason),
      lastOutcomeTs: text(tracker.lastOutcomeTs),
      lastOutcomeHasFinalResult: typeof tracker.lastOutcomeHasFinalResult === 'boolean'
        ? tracker.lastOutcomeHasFinalResult : null,
      lastOutcomeTurnId: text(tracker.lastOutcomeTurnId),
      liveTurnEvents: number(tracker.liveTurnEvents),
    },
    record: {
      event,
      turnId: incomingTurnId,
      timestamp: text(record.timestamp),
      byteOffset: number(record.__byteOffset),
      eventSequence: number(record.__eventSequence),
      hasInlineFinalResult: hasNonEmptyCodexFinalResult(record.payload),
      hasProviderError: !!record.payload?.error && typeof record.payload.error === 'object',
    },
  };
}

function classifyCodexTurnRecord(tracker, record, options = null) {
  if (typeof options?.onTurnEndContradiction === 'function') {
    try {
      const contradiction = describeCodexTurnEndContradiction(tracker, record);
      if (contradiction) {
        let watcherId = codexTurnObservationWatchers.get(tracker);
        if (!watcherId) {
          watcherId = 'codex-turn-watcher-' + (++codexTurnObservationWatcherSequence);
          codexTurnObservationWatchers.set(tracker, watcherId);
        }
        // Capture begins synchronously, before any existing tracker mutation.
        // Neither a thrown observer nor a rejected capture can change parsing.
        Promise.resolve(options.onTurnEndContradiction({ ...contradiction, watcherId })).catch(() => {});
      }
    } catch { /* diagnostic observer must never become a lifecycle gate */ }
  }
  observeCodexTurnRecord(tracker, record);
  const event = codexRecordEventType(record);
  const outcome = classifyCodexTurnEvent(event, record?.payload, {
    hasTrackedFinalResult: trackerHasFinalResultForEvent(tracker, record?.payload),
  });
  if (!outcome) return null;
  return {
    ...outcome,
    timestamp: record?.timestamp || null,
    turnId: typeof record?.payload?.turn_id === 'string' ? record.payload.turn_id : null,
  };
}

function reduceCodexTurnOutcomeSummary(summary, outcome) {
  if (!outcome) return summary;
  summary.latest = outcome;
  if (!outcome.busy && outcome.reason !== 'task_complete') {
    summary.lastAbnormal = outcome;
  }
  return summary;
}

function projectCodexSuppressedCatchUpPublication(state) {
  if (state?.catchUpPublicationsSuppressed !== true
    || Number(state?.liveTurnEvents || 0) <= 0) {
    return null;
  }
  const busy = state.busy === true;
  const event = state.lastEventType || (busy ? 'task_started' : null);
  const reason = state.lastOutcomeReason || event || (busy ? 'task_started' : 'catch-up-idle');
  return {
    busy,
    reason,
    outcome: {
      event,
      busy,
      reason,
      hasFinalResult: typeof state.lastOutcomeHasFinalResult === 'boolean'
        ? state.lastOutcomeHasFinalResult
        : null,
    },
    timestamp: state.lastEventTs || null,
    turnId: state.lastOutcomeTurnId || state.currentTurnId || null,
  };
}

function configureCodexCatchUpSuppression(state, {
  suppressBusy = false,
  suppressPublic = false,
} = {}) {
  if (!state) return false;
  state.publicTurnStateSuppressed = suppressPublic === true;
  state.catchUpPublicationsSuppressed = suppressBusy === true || suppressPublic === true;
  state.releasePublicSuppressionAfterCatchUp = false;
  state.releasePublicSuppressionTargetOffset = null;
  state.releasePublicSuppressionKind = null;
  return true;
}

function armCodexSuppressedCatchUpRelease(state, {
  targetOffset,
  kind = 'catch-up',
} = {}) {
  const normalizedTarget = Number(targetOffset);
  if (!state || !Number.isFinite(normalizedTarget) || normalizedTarget < 0) return false;
  state.publicTurnStateSuppressed = true;
  state.catchUpPublicationsSuppressed = true;
  state.releasePublicSuppressionAfterCatchUp = true;
  state.releasePublicSuppressionTargetOffset = normalizedTarget;
  state.releasePublicSuppressionKind = kind;
  state.catchUpPending = true;
  return true;
}

function completeCodexSuppressedCatchUpRelease(state, {
  scanSucceeded = true,
} = {}) {
  if (!state
    || scanSucceeded !== true
    || state.releasePublicSuppressionAfterCatchUp !== true) {
    return { released: false, publication: null };
  }
  const targetOffset = Number(state.releasePublicSuppressionTargetOffset);
  const currentOffset = Number(state.offset);
  if (
    !Number.isFinite(targetOffset)
    || !Number.isFinite(currentOffset)
    || currentOffset < targetOffset
  ) {
    return { released: false, publication: null };
  }

  const publication = projectCodexSuppressedCatchUpPublication(state);
  const kind = state.releasePublicSuppressionKind || 'catch-up';
  state.releasePublicSuppressionAfterCatchUp = false;
  state.releasePublicSuppressionTargetOffset = null;
  state.releasePublicSuppressionKind = null;
  state.catchUpPublicationsSuppressed = false;
  state.publicTurnStateSuppressed = false;
  state.catchUpPending = false;
  return {
    released: true,
    publication,
    kind,
    targetOffset,
  };
}

function deferCodexSourceProofRelease(state, request) {
  if (!state || !request || state.scanning !== true) {
    return { deferred: false, request };
  }
  state.sourceWriterProofReleasePending = { ...request };
  return {
    deferred: true,
    request: state.sourceWriterProofReleasePending,
  };
}

function takeCodexSourceProofReleaseAtScanBoundary(state) {
  if (!state || state.scanning === true) return null;
  const request = state.sourceWriterProofReleasePending || null;
  state.sourceWriterProofReleasePending = null;
  return request;
}

function prepareCodexSourceProofReplay(state, {
  kind = 'source-proof-replay',
} = {}) {
  if (!state) return { prepared: false, error: 'missing-state' };
  const targetOffset = Number(state.offset);
  if (!Number.isFinite(targetOffset) || targetOffset < 0) {
    return { prepared: false, error: 'invalid-target-offset' };
  }

  const launchId = state.sourceObservationLaunchId || null;
  const replayOffset = Number.isFinite(state.sourceWriterReplayOffset)
    ? Number(state.sourceWriterReplayOffset)
    : null;
  const replayPartial = typeof state.sourceWriterReplayPartial === 'string'
    ? state.sourceWriterReplayPartial
    : '';
  const replayPartialStartOffset = Number.isFinite(state.sourceWriterReplayPartialStartOffset)
    ? Number(state.sourceWriterReplayPartialStartOffset)
    : replayOffset;

  state.sourceObservationLaunchId = null;
  state.sourceWriterProofPending = false;
  state.sourceWriterProofReleasePending = null;
  state.sourceWriterReplayOffset = null;
  state.sourceWriterReplayPartial = null;
  state.sourceWriterReplayPartialStartOffset = null;
  // Audit-only parsing is allowed while the source lifecycle is withheld.
  // Once ownership is proven, the exact held byte range is replayed through
  // the normal parser, so its separate partial buffer must not leak across the
  // ownership boundary.
  state.sourceAuditPartial = '';
  state.sourceAuditPartialStartOffset = targetOffset;
  state.catchUpGeneration = Number(state.catchUpGeneration || 0) + 1;
  if (replayOffset != null) {
    state.offset = Math.min(targetOffset, replayOffset);
    state.partial = replayPartial;
    state.partialStartOffset = Number.isFinite(replayPartialStartOffset)
      ? replayPartialStartOffset
      : state.offset;
    state.needsScan = true;
  }
  const armed = armCodexSuppressedCatchUpRelease(state, {
    targetOffset,
    kind,
  });
  if (!armed) {
    return { prepared: false, error: 'release-not-armed' };
  }
  return {
    prepared: true,
    launchId,
    replayOffset,
    targetOffset,
  };
}

module.exports = {
  armCodexSuppressedCatchUpRelease,
  CODEX_NO_FINAL_RESULT_REASON,
  classifyCodexTurnRecord,
  classifyCodexTurnEvent,
  completeCodexSuppressedCatchUpRelease,
  configureCodexCatchUpSuppression,
  codexRecordEventType,
  codexRecordTurnId,
  codexRootFinalAnswerText,
  deferCodexSourceProofRelease,
  describeCodexTurnEndContradiction,
  hasNonEmptyCodexFinalResult,
  isCodexInputReadyTurnEndEvent,
  observeCodexTurnRecord,
  prepareCodexSourceProofReplay,
  projectCodexSuppressedCatchUpPublication,
  reduceCodexTurnOutcomeSummary,
  takeCodexSourceProofReleaseAtScanBoundary,
  trackerHasFinalResultForEvent,
};
