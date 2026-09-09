'use strict';

function isPureEscape(value) {
  return typeof value === 'string' && value.length > 0 && /^\x1b+$/.test(value);
}

/**
 * A manual Escape may end turn A and make Codex immediately start an already
 * committed native queued prompt B. Capture that fact before the key reaches
 * the PTY. This grants no write; it only classifies the later turn_aborted.
 */
function captureManualCodexQueueInterrupt({
  data,
  turnBusy,
  turnId,
  pendingPrompt,
  terminal,
  lifecycleGeneration,
  runSeq,
  promptGeneration,
  inputRevision,
  capturedAt = Date.now(),
} = {}) {
  if (!isPureEscape(data) || turnBusy !== true || !turnId || !terminal) return null;
  if (!pendingPrompt || pendingPrompt.source !== 'manual-terminal-enter'
    || !String(pendingPrompt.text || '').trim()
    || pendingPrompt.terminal !== terminal
    || pendingPrompt.lifecycleGeneration !== lifecycleGeneration
    || Number(pendingPrompt.promptGeneration) !== Number(promptGeneration)
    || !Number.isInteger(Number(runSeq)) || Number(runSeq) <= 0
    || !Number.isInteger(Number(inputRevision)) || Number(inputRevision) < 0) {
    return null;
  }
  return Object.freeze({
    terminal,
    lifecycleGeneration,
    runSeq: Number(runSeq),
    promptGeneration: Number(promptGeneration),
    inputRevision: Number(inputRevision),
    turnId: String(turnId),
    pendingPrompt,
    capturedAt: Number(capturedAt),
    sourceSequence: Number(pendingPrompt.sourceSequence || 0),
    sourceByteOffset: Number(pendingPrompt.sourceByteOffset || 0),
  });
}

function classifyManualCodexQueueInterruptOutcome(token, {
  reason,
  turnId,
  pendingPrompt,
  terminal,
  lifecycleGeneration,
  runSeq,
  promptGeneration,
  inputRevision,
  outcomeTs,
} = {}) {
  const deny = reasonCode => ({ expectedContinuation: false, reason: reasonCode });
  if (!token) return deny('manual-queue-interrupt-not-armed');
  if (reason !== 'turn_aborted') return deny('outcome-not-turn-aborted');
  if (!turnId || String(turnId) !== token.turnId) return deny('turn-changed');
  if (pendingPrompt !== token.pendingPrompt) return deny('queued-prompt-changed');
  if (terminal !== token.terminal) return deny('terminal-changed');
  if (lifecycleGeneration !== token.lifecycleGeneration) return deny('lifecycle-changed');
  if (Number(runSeq) !== token.runSeq) return deny('run-changed');
  if (Number(promptGeneration) !== token.promptGeneration) return deny('prompt-generation-changed');
  if (Number(inputRevision) !== token.inputRevision) return deny('input-revision-changed');
  if (!Number.isFinite(Number(outcomeTs)) || Number(outcomeTs) < token.capturedAt) {
    return deny('outcome-precedes-escape');
  }
  return {
    expectedContinuation: true,
    reason: 'manual-escape-submits-native-queue',
    queuedPromptSourceSequence: token.sourceSequence,
    queuedPromptSourceByteOffset: token.sourceByteOffset,
  };
}

module.exports = {
  captureManualCodexQueueInterrupt,
  classifyManualCodexQueueInterruptOutcome,
};
