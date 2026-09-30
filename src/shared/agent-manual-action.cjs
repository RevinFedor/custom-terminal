'use strict';

// The known provider choice is an action for the user, not a readiness
// timeout. Main API wait and desktop Send consume the same typed snapshot.
function describeAgentManualAction(status) {
  if (!status || typeof status !== 'object') return null;
  const blockers = Array.isArray(status.lastNotReady?.blockers) ? status.lastNotReady.blockers : [];
  if (status.manualActionRequired !== true && !blockers.includes('auth-required')) return null;
  const type = status.manualActionType;
  if (type === 'claude-startup-settings') return null;
  const policyDialog = ['resume-goal', 'usage-exhaustion'].includes(type);
  const code = policyDialog ? 'codex_' + type.replace(/-/g, '_') + '_action_required' : 'codex_auth_required';
  return { code, manualActionRequired: true, manualActionType: policyDialog ? type : 'auth-required',
    message: policyDialog ? status.lastNotReady?.message || code : code };
}

function isAgentManualActionPreSubmit(failure) {
  const receipt = failure?.sendReceipt || failure;
  return failure?.manualActionRequired === true
    && ['codex_resume_goal_action_required', 'codex_usage_exhaustion_action_required', 'codex_auth_required'].includes(failure.code)
    && receipt?.submitted === false && receipt?.pasteWritten === false && receipt?.enterWritten === false;
}

module.exports = { describeAgentManualAction, isAgentManualActionPreSubmit };
