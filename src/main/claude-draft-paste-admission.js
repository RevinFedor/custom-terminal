'use strict';

const positivePid = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null;

function claudeDraftPasteScopeFailure(expected, current) {
  if (!expected?.terminal || current?.terminal !== expected.terminal) return 'claude_terminal_generation_changed';
  if (!(expected.runSeq > 0) || current.runSeq !== expected.runSeq) return 'claude_process_generation_changed';
  if (!expected.lifecycleGeneration || current.lifecycleGeneration !== expected.lifecycleGeneration) {
    return 'claude_terminal_generation_changed';
  }
  if ((current.launchGeneration || null) !== (expected.launchGeneration || null)) {
    return 'claude_launch_generation_changed';
  }
  if (expected.stopping || current.stopping) return 'claude_process_stopping';
  if (expected.processRunning !== true || current.processRunning !== true) return 'claude_process_not_running';
  if (expected.processIdentityConflict || current.processIdentityConflict) return 'claude_process_identity_unknown';
  const expectedPid = positivePid(expected.processId);
  const currentPid = positivePid(current.processId);
  if (expectedPid && currentPid && expectedPid !== currentPid) return 'claude_process_generation_changed';
  return null;
}

// A first-turn process may acquire its PID proof during the entry's existing
// async discovery. Bind it once only within the original physical generation;
// never replace an already captured PID with a newer process's identity.
function createClaudeDraftPasteAdmission(expected, current, matches = []) {
  const reason = claudeDraftPasteScopeFailure(expected, current);
  if (reason) return { available: false, reason, token: null };
  const candidates = [...new Set(matches.map(item => positivePid(item?.pid)).filter(Boolean))];
  const processId = positivePid(expected.processId) || positivePid(current.processId)
    || (candidates.length === 1 ? candidates[0] : null);
  if (!processId) return { available: false, reason: 'claude_process_identity_unknown', token: null };
  return { available: true, reason: null, token: Object.freeze({ ...expected, processId }) };
}

function validateClaudeDraftPasteAdmission(expected, current, {
  processAlive = false, expectedInputRevision = null,
} = {}) {
  const reason = claudeDraftPasteScopeFailure(expected, current);
  if (reason) return { valid: false, reason };
  if (!positivePid(expected.processId)) return { valid: false, reason: 'claude_process_identity_unknown' };
  if (!processAlive) return { valid: false, reason: 'claude_process_not_running' };
  if (expectedInputRevision !== null && current.inputRevision !== expectedInputRevision) {
    return { valid: false, reason: 'claude_input_ownership_changed' };
  }
  return { valid: true, reason: null };
}

module.exports = { createClaudeDraftPasteAdmission, validateClaudeDraftPasteAdmission };
