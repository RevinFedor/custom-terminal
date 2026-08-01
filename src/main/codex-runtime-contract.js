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

function advanceOscCommandGeneration({
  runSeq = 0,
  preclaimedRunSeq = null,
  sameTerminal = false,
  sameLaunch = false,
} = {}) {
  const current = Number(runSeq) || 0;
  const exactPreclaim = Number.isInteger(Number(preclaimedRunSeq))
    && Number(preclaimedRunSeq) === current
    && sameTerminal === true
    && sameLaunch === true;
  return {
    runSeq: exactPreclaim ? current : current + 1,
    consumed: exactPreclaim,
  };
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

function classifyCodexLaunchPreparationResult(result) {
  const explicitlyAccepted = result?.accepted === true;
  const admittedPending = result?.success === true
    && result?.accepted == null
    && result?.acceptancePending === true;
  const accepted = explicitlyAccepted || admittedPending;
  return {
    accepted,
    reason: explicitlyAccepted
      ? 'launch-accepted'
      : admittedPending
        ? 'launch-pending'
        : 'launch-rejected',
    error: accepted ? null : (result?.error || result?.reason || null),
  };
}

function planCodexLaunchSettings({
  requestedModel = null,
  requestedEffort = null,
  modelSource = null,
  effortSource = null,
  durableDefaultModel = null,
  durableDefaultEffort = null,
  modelMigrationPending = false,
} = {}) {
  if (modelMigrationPending === true) {
    return {
      model: null,
      effort: null,
      modelSource: 'migration-recovery',
      effortSource: 'migration-recovery',
    };
  }
  const modelFromGlobal = modelSource === 'global';
  const effortFromGlobal = effortSource === 'global';
  const model = modelFromGlobal
    ? (durableDefaultModel || null)
    : (requestedModel || durableDefaultModel || null);
  const effort = effortFromGlobal
    ? (durableDefaultEffort || null)
    : (requestedEffort || durableDefaultEffort || null);
  return {
    model,
    effort,
    modelSource: modelFromGlobal
      ? (durableDefaultModel ? 'global' : 'native')
      : (requestedModel ? 'tab-or-explicit' : (durableDefaultModel ? 'global' : 'native')),
    effortSource: effortFromGlobal
      ? (durableDefaultEffort ? 'global' : 'native')
      : (requestedEffort ? 'tab-or-explicit' : (durableDefaultEffort ? 'global' : 'native')),
  };
}

function planCodexCommandLaunchSettings({
  command = 'codex',
  model = null,
  effort = null,
  preferRequestedSettings = false,
  sourceSettingsStatus = 'absent',
  sourceModel = null,
  sourceEffort = null,
} = {}) {
  if (command === 'codex-c' && preferRequestedSettings === true) {
    const requestedModel = typeof model === 'string' ? model.trim() : '';
    const requestedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    if (!requestedModel || !requestedEffort || requestedEffort === 'ultra') {
      return {
        allowed: false,
        error: requestedEffort === 'ultra'
          ? 'codex_resume_intent_ultra_not_persistent'
          : 'codex_resume_intent_settings_incomplete',
        settingsSource: 'resume-tab-intent',
      };
    }
    return {
      allowed: true,
      model: requestedModel,
      effort: requestedEffort,
      settingsSource: 'resume-tab-intent',
    };
  }
  if (command === 'codex-c' || command === 'codex-f') {
    const sourceKind = command === 'codex-c' ? 'resume' : 'fork';
    if (sourceSettingsStatus !== 'found' || !sourceModel || !sourceEffort) {
      return {
        allowed: false,
        error: sourceSettingsStatus === 'invalid'
          ? 'codex_' + sourceKind + '_source_settings_invalid'
          : 'codex_' + sourceKind + '_source_settings_unproven',
        settingsSource: sourceKind + '-source-jsonl',
      };
    }
    return {
      allowed: true,
      model: sourceModel,
      effort: sourceEffort,
      settingsSource: sourceKind + '-source-jsonl',
    };
  }
  const normalizedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  return {
    allowed: true,
    model: model || null,
    // Ultra is a live conversation mode, never a default for a new thread.
    effort: normalizedEffort === 'ultra' ? null : (effort || null),
    settingsSource: normalizedEffort === 'ultra'
      ? 'new-thread-without-conversation-only-effort'
      : 'persistent-fallback',
  };
}

function verifyCodexNextLaunchSettings({
  settingsIntent = null,
  requestedModel = null,
  requestedEffort = null,
  composerModel = null,
  composerEffort = null,
} = {}) {
  if (settingsIntent !== 'next-launch') {
    return { required: false, matches: true, error: null };
  }
  const requested = {
    model: String(requestedModel || '').trim(),
    effort: String(requestedEffort || '').trim().toLowerCase(),
  };
  const observed = {
    model: String(composerModel || '').trim(),
    effort: String(composerEffort || '').trim().toLowerCase(),
  };
  if (!requested.model || !requested.effort || !observed.model || !observed.effort) {
    return {
      required: true,
      matches: false,
      error: 'codex_next_launch_settings_unproven',
      requested,
      observed,
    };
  }
  const matches = requested.model === observed.model
    && requested.effort === observed.effort;
  return {
    required: true,
    matches,
    error: matches ? null : 'codex_next_launch_settings_mismatch',
    requested,
    observed,
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
  stopping = false,
  inputRevision = null,
} = {}) {
  const revision = inputRevision === null
    ? {}
    : { inputRevision: Number(inputRevision) };
  if (stopping === true) {
    return {
      available: false,
      reason: 'codex_process_stopping',
      runSeq: Number(runSeq) || 0,
      ...revision,
    };
  }
  if (processRunning !== true) {
    return {
      available: false,
      reason: 'codex_process_not_running',
      runSeq: Number(runSeq) || 0,
      ...revision,
    };
  }
  if (hasLiveCodexEvidence !== true) {
    return {
      available: false,
      reason: 'codex_tui_not_established',
      runSeq: Number(runSeq) || 0,
      ...revision,
    };
  }
  return {
    available: true,
    reason: null,
    runSeq: Number(runSeq) || 0,
    ...revision,
  };
}

function validateCodexPtySubmitAdmission(token, current = {}) {
  if (!token?.available) return { valid: false, reason: token?.reason || 'codex_submit_not_admitted' };
  const next = createCodexPtySubmitAdmission(current);
  if (!next.available) return { valid: false, reason: next.reason };
  if (next.runSeq !== token.runSeq) return { valid: false, reason: 'codex_process_generation_changed' };
  if (
    token.inputRevision !== undefined
    && Number(next.inputRevision) !== Number(token.inputRevision)
  ) {
    return { valid: false, reason: 'codex_input_ownership_changed' };
  }
  return { valid: true, reason: null };
}

function planCodexPickerMovement(selectedIndex, targetIndex) {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) {
    return {
      allowed: false,
      reason: 'codex_picker_selection_unknown',
      pressCount: 0,
      key: null,
    };
  }
  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    return {
      allowed: false,
      reason: 'codex_picker_target_unknown',
      pressCount: 0,
      key: null,
    };
  }
  const delta = targetIndex - selectedIndex;
  return {
    allowed: true,
    reason: null,
    pressCount: Math.abs(delta),
    key: delta > 0 ? '\x1b[B' : delta < 0 ? '\x1b[A' : null,
  };
}

function resolveCodexPickerCurrentWriterSessionId({
  provenWriterSessionId = null,
  provisionalWriterSessionId = null,
  provisionalAuthorized = false,
  sameTerminal = false,
  sameRunSeq = false,
  sameLaunch = false,
  sameDiscovery = false,
  sameLease = false,
  hasInflight = false,
} = {}) {
  const proven = typeof provenWriterSessionId === 'string'
    ? (provenWriterSessionId.trim() || null)
    : null;
  if (proven) return proven;

  const provisional = typeof provisionalWriterSessionId === 'string'
    ? (provisionalWriterSessionId.trim() || null)
    : null;
  if (!provisional
    || provisionalAuthorized !== true
    || sameTerminal !== true
    || sameRunSeq !== true
    || sameLaunch !== true
    || sameDiscovery !== true
    || sameLease !== true
    || hasInflight === true) {
    return null;
  }
  return provisional;
}

function validateCodexPickerRuntimeAdmission({
  sameTerminal = false,
  expectedRunSeq = 0,
  currentRunSeq = 0,
  expectedInputRevision = null,
  currentInputRevision = null,
  expectedWriterSessionId = null,
  currentWriterSessionId = null,
  processRunning = false,
  hasLiveCodexEvidence = false,
  tuiReady = false,
  stopping = false,
  turnBusy = false,
  allowTurnBusy = false,
  hasDraft = null,
} = {}) {
  if (sameTerminal !== true) {
    return { allowed: false, reason: 'codex_terminal_generation_changed' };
  }
  if (Number(currentRunSeq) !== Number(expectedRunSeq)) {
    return { allowed: false, reason: 'codex_process_generation_changed' };
  }
  if (expectedInputRevision !== null
    && Number(currentInputRevision) !== Number(expectedInputRevision)) {
    return { allowed: false, reason: 'codex_input_ownership_changed' };
  }
  if (typeof expectedWriterSessionId === 'string'
    && expectedWriterSessionId.length > 0
    && currentWriterSessionId !== expectedWriterSessionId) {
    return { allowed: false, reason: 'codex_settings_writer_changed' };
  }
  if (stopping === true) {
    return { allowed: false, reason: 'codex_process_stopping' };
  }
  if (processRunning !== true) {
    return { allowed: false, reason: 'codex_process_not_running' };
  }
  if (hasLiveCodexEvidence !== true) {
    return { allowed: false, reason: 'codex_process_not_established' };
  }
  if (tuiReady !== true) {
    return { allowed: false, reason: 'codex_tui_not_ready' };
  }
  if (hasDraft !== true && hasDraft !== false) {
    return { allowed: false, reason: 'codex_draft_state_unknown' };
  }
  if (turnBusy === true && hasDraft === true) {
    return { allowed: false, reason: 'codex_busy_with_draft' };
  }
  if (turnBusy === true && allowTurnBusy !== true) {
    return { allowed: false, reason: 'codex_turn_busy' };
  }
  return { allowed: true, reason: null };
}

function codexLiveSlashAllowsTurnBusy(command) {
  return /^\/fast$/i.test(String(command || '').trim());
}

function attachCodexSettingsProofOwner(result, currentWriterSessionId = null) {
  const projectedResult = result && typeof result === 'object'
    ? result
    : { success: false, error: 'Codex picker returned no result' };
  const applicationProven = isCodexSettingsApplicationProven(projectedResult);
  const normalizedWriterSessionId = typeof currentWriterSessionId === 'string'
    ? (currentWriterSessionId.trim() || null)
    : null;
  return {
    ...projectedResult,
    codexSettingsProofSessionId: applicationProven
      ? normalizedWriterSessionId
      : null,
  };
}

function isCodexSettingsApplicationProven(result) {
  return !!result && typeof result === 'object' && (
    result.success === true
    || (result.applied === true
      && !!(result.applicationProofSource || result.configProofSource))
  );
}

/**
 * A fresh Codex TUI can accept an exact model/effort picker selection before it
 * creates its first rollout. Keep that proof volatile until process ownership
 * identifies the first writer, but bind it to the exact PTY/process/discovery
 * generation so a restart, Resume replacement, or another tab cannot inherit it.
 */
function createPendingCodexSettingsProofHandoff({
  result = null,
  terminalToken = null,
  runSeq = 0,
  launchId = null,
  allowTerminalRunGeneration = false,
  appliedAt = Date.now(),
} = {}) {
  const normalizedLaunchId = typeof launchId === 'string'
    ? launchId.trim()
    : '';
  const normalizedRunSeq = Number(runSeq);
  const model = typeof result?.model === 'string' ? result.model.trim() : '';
  const effort = typeof result?.effort === 'string' ? result.effort.trim().toLowerCase() : '';
  const proofAt = Number(result?.proofAt) || Number(appliedAt) || Date.now();
  const proofSource = String(
    result?.applicationProofSource
    || result?.configProofSource
    || 'exact-picker-success',
  ).trim();
  const launchRequestOnly = new Set([
    'fresh-launch-command-line',
    'persistent-fallback',
    'new-thread-without-conversation-only-effort',
    'tab-or-explicit',
    'global',
    'native',
  ]).has(proofSource);
  if (!isCodexSettingsApplicationProven(result)
    || result?.codexSettingsProofSessionId
    || launchRequestOnly
    || !model
    || !effort
    || !Number.isFinite(proofAt)
    || proofAt <= 0
    || !terminalToken
    || !Number.isInteger(normalizedRunSeq)
    || normalizedRunSeq <= 0
    || (!normalizedLaunchId && allowTerminalRunGeneration !== true)) {
    return null;
  }
  return {
    terminalToken,
    runSeq: normalizedRunSeq,
    launchId: normalizedLaunchId || null,
    generationMode: normalizedLaunchId ? 'launch' : 'terminal-run',
    proofAt,
    model,
    effort,
    ...(typeof result?.fast === 'boolean' ? { fast: result.fast } : {}),
    applicationProofSource: proofSource,
  };
}

function projectPendingCodexSettingsProofOwner(pending, {
  terminalToken = null,
  runSeq = 0,
  expectedOwnerId = null,
} = {}) {
  if (!pending || pending.generationMode !== 'launch' || !pending.launchId) {
    return null;
  }
  const ownerId = 'launch:' + pending.launchId;
  if (expectedOwnerId && expectedOwnerId !== ownerId) return null;
  if (!terminalToken || pending.terminalToken !== terminalToken) return null;
  if (Number(pending.runSeq) !== Number(runSeq)) return null;
  if (!pending.model || !pending.effort) return null;
  return {
    ownerId,
    launchId: pending.launchId,
    model: pending.model,
    effort: pending.effort,
    ...(typeof pending.fast === 'boolean' ? { fast: pending.fast } : {}),
    proofAt: pending.proofAt,
    applicationProofSource: pending.applicationProofSource,
  };
}

function consumePendingCodexSettingsProofHandoff(pending, {
  terminalToken = null,
  runSeq = 0,
  launchId = null,
  writerSessionId = null,
} = {}) {
  if (!pending) {
    return { carry: false, reason: 'pending-proof-missing', nextPending: null };
  }
  const normalizedLaunchId = typeof launchId === 'string' ? launchId.trim() : '';
  const normalizedWriterSessionId = typeof writerSessionId === 'string'
    ? writerSessionId.trim()
    : '';
  let reason = null;
  if (!terminalToken || pending.terminalToken !== terminalToken) {
    reason = 'terminal-generation-changed';
  } else if (Number(pending.runSeq) !== Number(runSeq)) {
    reason = 'process-generation-changed';
  } else if (pending.generationMode !== 'terminal-run'
    && (!normalizedLaunchId || pending.launchId !== normalizedLaunchId)) {
    reason = 'launch-generation-changed';
  } else if (!normalizedWriterSessionId) {
    reason = 'writer-session-unproven';
  }
  return {
    carry: reason === null,
    reason: reason || 'same-live-generation-first-writer',
    proof: reason === null
      ? {
        model: pending.model,
        effort: pending.effort,
        proofAt: pending.proofAt,
        ...(typeof pending.fast === 'boolean' ? { fast: pending.fast } : {}),
      }
      : null,
    // Every first-writer admission consumes or invalidates the one-shot proof.
    nextPending: null,
  };
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
  advanceOscCommandGeneration,
  attachCodexSettingsProofOwner,
  codexLiveSlashAllowsTurnBusy,
  codexSessionIdFromAuthoritativeStatus,
  classifyCodexLaunchPreparationResult,
  consumePendingCodexSettingsProofHandoff,
  createCodexLaunchPendingResult,
  createPendingCodexSettingsProofHandoff,
  createCodexPtySubmitAdmission,
  isCodexSettingsApplicationProven,
  isCodexComposerReadyForGuardedSend,
  liveLifecycleFromCodexWriterStatus,
  planCodexCommandLaunchSettings,
  planCodexLaunchSettings,
  planCodexPickerMovement,
  projectPendingCodexSettingsProofOwner,
  projectCodexPublicRuntimeProjection,
  projectCodexRuntimeStatus,
  resolveCodexPickerCurrentWriterSessionId,
  shouldClearCodexLaunchPending,
  shouldHoldCodexStartingOnAbsent,
  shouldSurfaceCodexStartupTimeout,
  validateCodexPickerRuntimeAdmission,
  validateCodexPtySubmitAdmission,
  verifyCodexNextLaunchSettings,
};
