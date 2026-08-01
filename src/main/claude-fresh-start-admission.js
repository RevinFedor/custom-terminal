'use strict';

/**
 * A plain Claude start must not silently replace a stopped tab's durable
 * conversation. The caller may explicitly opt in only after a user-facing
 * confirmation; all ordinary API/UI/IPC paths stay protected.
 */
function evaluateClaudeFreshStartAdmission({
  command,
  allowNewOverExisting = false,
  boundSessionId = null,
  materialization = null,
} = {}) {
  if (String(command || '') !== 'claude' || allowNewOverExisting === true) {
    return { allowed: true, reason: 'not-protected-fresh-start' };
  }
  const sessionId = String(boundSessionId || '').trim() || null;
  if (!sessionId) return { allowed: true, reason: 'no-bound-session' };
  if (!materialization || materialization.success === false) {
    return {
      allowed: false,
      error: 'claude_session_materialization_unknown',
      reason: materialization?.reason || 'materialization-check-failed',
      sessionId,
    };
  }
  if (materialization.materialized === true
    || materialization.conversationMaterialized === true) {
    return {
      allowed: false,
      error: 'tab_has_resumable_session',
      reason: 'plain_claude_start_blocked_by_materialized_session',
      sessionId,
      conversationMaterialized: true,
      canResume: true,
      canCopySessionId: true,
      timelineCount: Number.isFinite(materialization.timelineCount)
        ? materialization.timelineCount
        : null,
      materializationReason: materialization.reason || 'timeline-has-entries',
    };
  }
  return {
    allowed: true,
    reason: materialization.reason || 'bound-session-not-materialized',
    sessionId,
  };
}

module.exports = { evaluateClaudeFreshStartAdmission };
