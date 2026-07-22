'use strict';

function shouldHoldCodexStartingOnAbsent({
  launchObservationPending = false,
  launchAcceptancePending = false,
  startupFailureLatched = false,
} = {}) {
  return launchObservationPending === true
    || launchAcceptancePending === true
    || startupFailureLatched === true;
}

function shouldClearCodexLaunchPending(currentLaunchId, expectedLaunchId = null) {
  if (!currentLaunchId) return false;
  return !expectedLaunchId || currentLaunchId === expectedLaunchId;
}

function createCodexLaunchPendingResult({
  launchId,
  tabId,
  command,
  resumeSourceSessionId = null,
  sessionId = null,
  writerConfirmed = false,
} = {}) {
  return {
    success: true,
    accepted: null,
    acceptancePending: true,
    lifecyclePreserved: true,
    launchId: launchId || null,
    tabId: tabId || null,
    command: command || null,
    sessionId: sessionId || null,
    resumeSourceSessionId: resumeSourceSessionId || null,
    writerConfirmed: writerConfirmed === true,
  };
}

function shouldSurfaceCodexStartupTimeout({
  expectedLaunchId = null,
  currentLaunchId = null,
  expectedStartedAt = 0,
  currentStartedAt = 0,
  startedAt = 0,
  now = Date.now(),
  timeoutMs = 0,
  inputReady = false,
  promptOrTurnInFlight = false,
  manualActionRequired = false,
  blockers = [],
} = {}) {
  if (!expectedLaunchId || currentLaunchId !== expectedLaunchId) return false;
  if (expectedStartedAt > 0 && currentStartedAt !== expectedStartedAt) return false;
  const effectiveStartedAt = currentStartedAt || startedAt;
  if (!Number.isFinite(effectiveStartedAt) || effectiveStartedAt <= 0) return false;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  if (inputReady || promptOrTurnInFlight || manualActionRequired) return false;
  if (Array.isArray(blockers) && blockers.length > 0) return false;
  return now - effectiveStartedAt >= timeoutMs;
}

function liveLifecycleFromCodexWriterStatus(status, {
  holdStartingOnAbsent = false,
} = {}) {
  if (status === 'absent' || status === 'revalidation-absent') {
    return holdStartingOnAbsent ? true : false;
  }
  if (!status || status === 'unknown' || status === 'revalidation-unknown') {
    return null;
  }
  // Every remaining reconciliation result was reached only after a complete
  // process snapshot found a Codex descendant. Identity may still be pending,
  // provisional, ambiguous, or changing, but lifecycle is live.
  return true;
}

function createCodexPtySubmitAdmission({
  processRunning = false,
  hasLiveCodexEvidence = false,
  runSeq = 0,
} = {}) {
  if (processRunning !== true) {
    return { available: false, reason: 'codex_process_not_running', runSeq: Number(runSeq) || 0 };
  }
  if (hasLiveCodexEvidence !== true) {
    return { available: false, reason: 'codex_tui_not_established', runSeq: Number(runSeq) || 0 };
  }
  return { available: true, reason: null, runSeq: Number(runSeq) || 0 };
}

function validateCodexPtySubmitAdmission(token, current = {}) {
  if (!token?.available) return { valid: false, reason: token?.reason || 'codex_submit_not_admitted' };
  const next = createCodexPtySubmitAdmission(current);
  if (!next.available) return { valid: false, reason: next.reason };
  if (next.runSeq !== token.runSeq) return { valid: false, reason: 'codex_process_generation_changed' };
  return { valid: true, reason: null };
}

function projectCodexRuntimeStatus({
  liveLifecycle = null,
  stopping = false,
  busy = false,
  inputReady = false,
  writerUsableForMutation = false,
  writerUiLifecycleEstablished = false,
  hasEstablishedLifecycle = false,
} = {}) {
  if (liveLifecycle === false) return 'inactive';
  if (stopping) return 'stopping';
  if (busy) return 'busy';
  // Readiness and transcript identity are separate axes. A fresh Codex run has
  // no rollout/session id until its first user message, but once the current
  // PTY generation has a real composer it is no longer "starting". Identity-
  // dependent actions stay gated by writerUsableForMutation/canCopySessionId.
  if (liveLifecycle === true && inputReady) return 'active';
  // A fallible lookup may revoke identity without erasing an already-proven
  // visual lifecycle. This branch never restores the public session ID.
  if (inputReady && writerUiLifecycleEstablished) return 'active';
  if (liveLifecycle === true || hasEstablishedLifecycle) return 'starting';
  return 'unknown';
}

function projectCodexPublicRuntimeProjection({
  liveLifecycle = null,
  stopping = false,
  turnBusy = false,
  tuiInputReady = false,
  writerUsableForMutation = false,
  writerUiLifecycleEstablished = false,
  hasEstablishedLifecycle = true,
} = {}) {
  const inputReady = liveLifecycle !== false
    && stopping !== true
    && turnBusy !== true
    && tuiInputReady === true;
  const sessionStatus = projectCodexRuntimeStatus({
    liveLifecycle,
    stopping,
    busy: turnBusy,
    inputReady,
    writerUsableForMutation,
    writerUiLifecycleEstablished,
    hasEstablishedLifecycle,
  });
  return {
    sessionStatus,
    busy: sessionStatus === 'busy' || sessionStatus === 'stopping',
    inputReady: sessionStatus === 'inactive' ? false : inputReady,
  };
}

function codexSessionIdFromAuthoritativeStatus(status) {
  if (!status || status.toolType !== 'codex') return null;
  const candidate = String(status.sessionId || status.codexSessionId || '').trim() || null;
  const runtimeStatus = status.status || status.sessionStatus || 'unknown';
  if (runtimeStatus === 'inactive') return candidate;
  const writerConfirmed = status.writerConfirmed === true || status.codexWriterConfirmed === true;
  const writerUsable = status.writerUsableForMutation === true
    || status.codexWriterUsableForMutation === true;
  return writerConfirmed && writerUsable ? candidate : null;
}

function isCodexComposerReadyForGuardedSend(status) {
  if (!status || status.toolType !== 'codex' || status.inputReady !== true) return false;
  return status.status === 'active'
    || status.status === 'busy'
    || status.status === 'starting';
}

module.exports = {
  codexSessionIdFromAuthoritativeStatus,
  createCodexLaunchPendingResult,
  createCodexPtySubmitAdmission,
  isCodexComposerReadyForGuardedSend,
  liveLifecycleFromCodexWriterStatus,
  projectCodexPublicRuntimeProjection,
  projectCodexRuntimeStatus,
  shouldClearCodexLaunchPending,
  shouldHoldCodexStartingOnAbsent,
  shouldSurfaceCodexStartupTimeout,
  validateCodexPtySubmitAdmission,
};
