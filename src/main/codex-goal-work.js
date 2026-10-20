'use strict';

const STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const id = value => typeof value === 'string' && value.length > 0 ? value : null;
const offset = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const goalTrigger = payload => payload?.turn_attribution?.turn_trigger === 'goal';

function goalProjection(sessionId, turnId, status, sourceOffset, origin, createdAt = null, updatedAt = null) {
  return { version: 1, sessionId, turnId, status, createdAt, updatedAt, sourceOffset, origin };
}

// Only the canonical sequential rollout reader owns this projection. Do not
// infer goal membership from prose, idle duration or an older tab's Goal.
function observeCodexGoalWork(tracker, record) {
  if (record?.type !== 'event_msg') return;
  const payload = record.payload;
  const event = payload?.type;
  const recordOffset = offset(record.__byteOffset);
  if (event === 'thread_rolled_back') {
    tracker.codexGoalForTurn = null;
    tracker.codexGoalThreadState = null;
    tracker.codexGoalTurnStartOffset = null;
    tracker.codexGoalDecision = 'rollback';
    return;
  }
  if (event === 'task_started') {
    const turnId = id(payload.turn_id);
    const sessionId = id(tracker.sessionId);
    const continued = goalTrigger(payload);
    const prior = tracker.codexGoalThreadState;
    tracker.codexGoalTurnStartOffset = recordOffset;
    tracker.codexGoalForTurn = null;
    if (continued && turnId && sessionId) {
      // Native 0.162.0 explicitly stamps automatic Goal continuation. A
      // previously observed *active* Goal can supply status when accounting
      // reported Unchanged; without a status update, the trigger itself still
      // establishes Goal participation, but never success.
      const knownActive = prior?.sessionId === sessionId && prior.status === 'active';
      tracker.codexGoalForTurn = goalProjection(sessionId, turnId,
        knownActive ? 'active' : 'unknown', knownActive ? prior.sourceOffset : recordOffset,
        knownActive ? 'goal-trigger-active' : 'goal-trigger-status-unknown',
        knownActive ? prior.createdAt : null, knownActive ? prior.updatedAt : null);
      tracker.codexGoalDecision = tracker.codexGoalForTurn.origin;
    } else {
      tracker.codexGoalDecision = continued ? 'goal-trigger-owner-unresolved' : 'ordinary-turn';
      // A distinct regular user turn cannot inherit an old paused/active Goal.
      tracker.codexGoalThreadState = null;
    }
    return;
  }
  if (event !== 'thread_goal_updated') return;
  const sessionId = id(tracker.sessionId);
  const threadId = id(payload.threadId);
  const turnId = id(payload.turnId);
  const currentTurnId = id(tracker.currentTurnId);
  const previous = tracker.codexGoalThreadState;
  const reject = reason => { tracker.codexGoalDecision = reason; };
  if (!sessionId || threadId !== sessionId || payload.goal?.threadId !== sessionId) {
    reject('goal-owner-mismatch'); return;
  }
  if (payload.turnId != null && !turnId) {
    reject('goal-turn-invalid'); return;
  }
  if (turnId && currentTurnId && turnId !== currentTurnId) {
    reject('goal-turn-mismatch'); return;
  }
  // A stale callback cannot move status backwards, even if it claims another
  // turn or is missing turnId. Unknown offset may be used for ordered tail
  // replays, but cannot supersede a positively located newer event.
  if (previous?.sessionId === sessionId && previous.sourceOffset != null
    && (recordOffset == null || recordOffset <= previous.sourceOffset)) {
    reject('goal-offset-not-newer'); return;
  }
  if (!turnId && currentTurnId && recordOffset != null
    && tracker.codexGoalTurnStartOffset != null
    && recordOffset <= tracker.codexGoalTurnStartOffset) {
    reject('goal-before-current-turn'); return;
  }
  const goal = payload.goal;
  const status = STATUSES.has(goal.status) ? goal.status : 'unknown';
  const bindingTurnId = turnId || currentTurnId;
  const projected = goalProjection(sessionId, bindingTurnId, status, recordOffset,
    turnId ? 'native-turn' : 'native-thread',
    Number.isSafeInteger(goal.createdAt) ? goal.createdAt : null,
    Number.isSafeInteger(goal.updatedAt) ? goal.updatedAt : null);
  tracker.codexGoalThreadState = projected;
  // No-turn updates are thread-scoped. Only attach one to the currently
  // observed turn, not a previous completed turn or a later independent turn.
  if (bindingTurnId && (!currentTurnId || bindingTurnId === currentTurnId)) {
    tracker.codexGoalForTurn = projected;
    tracker.codexGoalDecision = turnId ? 'native-turn-attached' : 'native-thread-attached';
  } else {
    tracker.codexGoalDecision = 'native-thread-only';
  }
}

function codexGoalWorkForOutcome(tracker, outcome) {
  const goal = tracker.codexGoalForTurn;
  if (!goal || outcome?.busy !== false || outcome.reason !== 'task_complete'
    || goal.sessionId !== tracker.sessionId || !outcome.turnId || goal.turnId !== outcome.turnId) return null;
  return { ...goal, pending: goal.status !== 'complete',
    phase: goal.status === 'active' ? 'continuing'
      : goal.status === 'complete' ? 'complete' : 'attention' };
}

// Native 0.162 code-mode Goal mutations can omit thread_goal_updated from the
// rollout. Read the native service, never arbitrary exec/function output JSON.
async function readNativeCodexGoal({ sessionId, codexHome }) {
  const { CodexAppServerClient } = require('./codex-account-profiles');
  const client = new CodexAppServerClient({ codexHome,
    initializeCapabilities: { experimentalApi: true } });
  try {
    await client.start();
    return await client.request('thread/goal/get', { threadId: sessionId });
  } finally { client.close(); }
}

const completionReads = new WeakMap();

// Called once after publishing a successful turn boundary with pending Goal.
// Main still owns busy/readiness/physical identity; this only adapts typed Goal
// state to the existing Goal lifetime projection. Transport failure is UNKNOWN.
function reconcileCodexGoalCompletion({ tracker, outcome, record, codexHome,
  isCurrent, readGoal = readNativeCodexGoal, log = () => {} }) {
  const key = [tracker.sessionId, outcome?.turnId, record?.__byteOffset, record?.timestamp].join(':');
  const existing = completionReads.get(tracker);
  if (existing?.key === key) return isCurrent() ? existing.promise : Promise.resolve(null);
  const goal = tracker.codexGoalForTurn;
  const prior = tracker.codexGoalThreadState;
  const sessionId = id(tracker.sessionId);
  const turnId = id(outcome?.turnId);
  const sourceOffset = offset(record?.__byteOffset);
  const endMs = Date.parse(record?.timestamp || '');
  const admissionRefusal = outcome?.busy !== false || outcome.reason !== 'task_complete'
    || outcome.hasFinalResult !== true ? 'not-successful-turn'
    : outcome.goalWork?.pending !== true ? 'no-pending-goal'
    : !sessionId || !turnId || tracker.currentTurnId !== turnId ? 'turn-owner-unresolved'
    : goal?.sessionId !== sessionId || goal.turnId !== turnId ? 'goal-owner-mismatch'
    : !Number.isSafeInteger(goal.createdAt) || !Number.isSafeInteger(goal.updatedAt) ? 'goal-version-unknown'
    : sourceOffset == null || goal.sourceOffset == null || sourceOffset <= goal.sourceOffset ? 'boundary-not-newer'
    : !Number.isFinite(endMs) ? 'timestamp-unknown'
    : !isCurrent() ? 'physical-owner-changed' : null;
  if (admissionRefusal) { log('native-read-skipped-' + admissionRefusal); return Promise.resolve(outcome); }

  const current = () => isCurrent() && tracker.sessionId === sessionId
    && tracker.currentTurnId === turnId && tracker.codexGoalForTurn === goal
    && tracker.codexGoalThreadState === prior;
  // Install admission synchronously, before starting the RPC or its first await.
  const entry = { key, promise: null };
  completionReads.set(tracker, entry);
  entry.promise = Promise.resolve().then(async () => {
    try {
      if (!current()) return null;
      log('native-read-issued');
      const response = await readGoal({ sessionId, codexHome });
      if (!current()) { log('native-read-owner-changed'); return null; }
      const native = response?.goal;
      // get is thread-scoped, not turn-scoped. Join only the already observed
      // Goal incarnation, with a status committed no later than this turn end.
      // Null/clear, future incarnation/status and missing identity never release.
      const refusal = !native ? 'no-goal-proof'
        : native.threadId !== sessionId ? 'thread-mismatch'
        : native.createdAt !== goal.createdAt ? 'incarnation-mismatch'
        : !Number.isSafeInteger(native.updatedAt) ? 'updated-at-invalid'
        : native.updatedAt < goal.updatedAt ? 'status-older-than-observed'
        : native.updatedAt > Math.floor(endMs / 1000) ? 'status-after-turn-end'
        : native.status !== 'complete' ? 'status-' + (STATUSES.has(native.status) ? native.status : 'unknown')
        : null;
      if (refusal) { log('native-read-' + refusal); return outcome; }
      const projected = goalProjection(sessionId, turnId, 'complete', sourceOffset,
        'native-goal-read', native.createdAt, native.updatedAt);
      tracker.codexGoalForTurn = projected;
      tracker.codexGoalThreadState = projected;
      tracker.codexGoalDecision = 'native-goal-read-attached';
      log('native-read-complete');
      return { ...outcome, goalWork: codexGoalWorkForOutcome(tracker, outcome) };
    } catch (error) {
      if (!current()) { log('native-read-owner-changed'); return null; }
      const reason = error?.code === -32601 ? 'api-unsupported'
        : error?.code === 'ENOENT' ? 'cli-unavailable'
        : /timed out/i.test(error?.message || '') ? 'timeout' : 'transport-error';
      log('native-read-unknown-' + reason); return outcome;
    }
  });
  return entry.promise;
}

module.exports = { observeCodexGoalWork, codexGoalWorkForOutcome,
  readNativeCodexGoal, reconcileCodexGoalCompletion };
