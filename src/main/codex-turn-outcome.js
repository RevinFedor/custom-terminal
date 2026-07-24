'use strict';

const CODEX_NO_FINAL_RESULT_REASON = 'codex-no-final-result';

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

function classifyCodexTurnRecord(tracker, record) {
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

module.exports = {
  CODEX_NO_FINAL_RESULT_REASON,
  classifyCodexTurnRecord,
  classifyCodexTurnEvent,
  codexRecordEventType,
  codexRecordTurnId,
  codexRootFinalAnswerText,
  hasNonEmptyCodexFinalResult,
  observeCodexTurnRecord,
  projectCodexSuppressedCatchUpPublication,
  reduceCodexTurnOutcomeSummary,
  trackerHasFinalResultForEvent,
};
