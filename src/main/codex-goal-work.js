'use strict';

const STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const id = value => typeof value === 'string' && value.length > 0 ? value : null;

// This is a projection of the native producer, not a second Goal store. Native
// 0.162 accounts/publishes the participating Goal before task_complete. Bind
// that evidence to its physical thread AND turn; an older paused/cleared Goal
// must not seize the next independent user request. Never inspect tool prose.
function observeCodexGoalWork(tracker, record) {
  if (record?.type !== 'event_msg') return;
  const payload = record.payload;
  if (payload?.type === 'task_started' || payload?.type === 'thread_rolled_back') {
    tracker.codexGoalForTurn = null;
    return;
  }
  if (payload?.type !== 'thread_goal_updated') return;
  const sessionId = id(tracker.sessionId);
  const threadId = id(payload.threadId);
  const turnId = id(payload.turnId);
  if (!sessionId || threadId !== sessionId || payload.goal?.threadId !== sessionId || !turnId) return;
  if (tracker.currentTurnId && tracker.currentTurnId !== turnId) return;
  const previous = tracker.codexGoalForTurn;
  if (previous?.sessionId === sessionId && previous.turnId === turnId
    && Number.isSafeInteger(previous.sourceOffset) && Number.isSafeInteger(record.__byteOffset)
    && record.__byteOffset <= previous.sourceOffset) return;
  const goal = payload.goal;
  tracker.codexGoalForTurn = {
    version: 1, sessionId, turnId,
    status: STATUSES.has(goal.status) ? goal.status : 'unknown',
    createdAt: Number.isSafeInteger(goal.createdAt) ? goal.createdAt : null,
    updatedAt: Number.isSafeInteger(goal.updatedAt) ? goal.updatedAt : null,
    sourceOffset: Number.isSafeInteger(record.__byteOffset) ? record.__byteOffset : null,
  };
}

function codexGoalWorkForOutcome(tracker, outcome) {
  const goal = tracker.codexGoalForTurn;
  if (!goal || outcome?.busy !== false || outcome.reason !== 'task_complete'
    || goal.sessionId !== tracker.sessionId || !outcome.turnId || goal.turnId !== outcome.turnId) return null;
  return { ...goal, pending: goal.status !== 'complete',
    phase: goal.status === 'active' ? 'continuing'
      : goal.status === 'complete' ? 'complete' : 'attention' };
}

module.exports = { observeCodexGoalWork, codexGoalWorkForOutcome };
