'use strict';

const CODEX_SERVICE_TIER_PROOF_TERMINAL_TOKEN = Symbol(
  'codex-service-tier-proof-terminal-token',
);

function normalizeCodexServiceTier(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'priority' || normalized === 'default'
    ? normalized
    : null;
}

function createCodexServiceTierProof({
  ownerId = null,
  serviceTier = null,
  proofAt = Date.now(),
  source = 'tui',
  terminalToken = null,
  terminalLifecycleGeneration = null,
  terminalRunSeq = 0,
  launchId = null,
  generationMode = null,
  generationId = null,
} = {}) {
  const normalizedOwnerId = typeof ownerId === 'string' ? ownerId.trim() : '';
  const normalizedTier = normalizeCodexServiceTier(serviceTier);
  const normalizedLifecycle = typeof terminalLifecycleGeneration === 'string'
    ? terminalLifecycleGeneration.trim()
    : '';
  const normalizedRunSeq = Number(terminalRunSeq);
  const normalizedLaunchId = typeof launchId === 'string' ? launchId.trim() : '';
  const normalizedGenerationMode = generationMode === 'terminal-run'
    ? 'terminal-run'
    : 'launch';
  const normalizedGenerationId = typeof generationId === 'string' && generationId.trim()
    ? generationId.trim()
    : normalizedGenerationMode === 'launch'
      ? normalizedLaunchId
      : normalizedLifecycle;
  const normalizedProofAt = Number(proofAt);
  if (!normalizedOwnerId
    || !normalizedTier
    || !terminalToken
    || !normalizedLifecycle
    || !Number.isInteger(normalizedRunSeq)
    || normalizedRunSeq <= 0
    || !normalizedGenerationId
    || (normalizedGenerationMode === 'launch'
      && (!normalizedLaunchId || normalizedGenerationId !== normalizedLaunchId))
    || (normalizedGenerationMode === 'terminal-run' && normalizedLaunchId)
    || !Number.isFinite(normalizedProofAt)
    || normalizedProofAt <= 0) {
    return null;
  }
  const proof = {
    ownerId: normalizedOwnerId,
    serviceTier: normalizedTier,
    fast: normalizedTier === 'priority',
    proofAt: normalizedProofAt,
    source: String(source || 'tui'),
    terminalLifecycleGeneration: normalizedLifecycle,
    terminalRunSeq: normalizedRunSeq,
    generationMode: normalizedGenerationMode,
    generationId: normalizedGenerationId,
    launchId: normalizedLaunchId || null,
  };
  // The PTY object is the strongest part of the identity, but it must never be
  // sent through Electron IPC. Keep it on the proof itself as non-enumerable
  // main-process identity rather than introducing a second cache.
  Object.defineProperty(proof, CODEX_SERVICE_TIER_PROOF_TERMINAL_TOKEN, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: terminalToken,
  });
  return Object.freeze(proof);
}

function preserveCodexServiceTierProofForTurnEnd(proof, {
  ownerId = null,
  terminalToken = null,
  terminalLifecycleGeneration = null,
  terminalRunSeq = 0,
  launchId = null,
  generationMode = null,
  generationId = null,
} = {}) {
  if (!proof || typeof proof !== 'object') {
    return { preserved: false, proof: null, reason: 'proof-missing' };
  }
  if (!normalizeCodexServiceTier(proof.serviceTier)
    || !proof.ownerId
    || !proof.terminalLifecycleGeneration
    || !Number.isInteger(Number(proof.terminalRunSeq))
    || !['launch', 'terminal-run'].includes(proof.generationMode)
    || !proof.generationId
    || (proof.generationMode === 'launch' && !proof.launchId)
    || (proof.generationMode === 'terminal-run' && proof.launchId)
    || !proof[CODEX_SERVICE_TIER_PROOF_TERMINAL_TOKEN]) {
    return { preserved: false, proof: null, reason: 'proof-identity-incomplete' };
  }
  if (!terminalToken
    || proof[CODEX_SERVICE_TIER_PROOF_TERMINAL_TOKEN] !== terminalToken) {
    return { preserved: false, proof: null, reason: 'terminal-object-changed' };
  }
  if (!terminalLifecycleGeneration
    || proof.terminalLifecycleGeneration !== terminalLifecycleGeneration) {
    return { preserved: false, proof: null, reason: 'terminal-lifecycle-changed' };
  }
  if (!Number.isInteger(Number(terminalRunSeq))
    || Number(proof.terminalRunSeq) !== Number(terminalRunSeq)) {
    return { preserved: false, proof: null, reason: 'terminal-run-changed' };
  }
  const observedLaunchId = typeof launchId === 'string' ? launchId.trim() : '';
  const observedGenerationMode = generationMode === 'terminal-run'
    ? 'terminal-run'
    : 'launch';
  const observedGenerationId = typeof generationId === 'string' && generationId.trim()
    ? generationId.trim()
    : observedGenerationMode === 'launch'
      ? observedLaunchId
      : terminalLifecycleGeneration;
  if (proof.generationMode !== observedGenerationMode) {
    return { preserved: false, proof: null, reason: 'generation-mode-changed' };
  }
  if (observedGenerationMode === 'launch'
    && (!observedLaunchId || proof.launchId !== observedLaunchId)) {
    return { preserved: false, proof: null, reason: 'launch-generation-changed' };
  }
  if (!observedGenerationId || proof.generationId !== observedGenerationId) {
    return { preserved: false, proof: null, reason: 'action-generation-changed' };
  }
  if (!ownerId || proof.ownerId !== ownerId) {
    return { preserved: false, proof: null, reason: 'proof-owner-changed' };
  }
  return {
    preserved: true,
    proof,
    reason: 'same-live-owner-generation',
  };
}

function authorizeCodexServiceTierProofOwnerHandoff(proof, {
  sourceOwnerId = null,
  targetOwnerId = null,
  terminalToken = null,
  terminalLifecycleGeneration = null,
  terminalRunSeq = 0,
  launchId = null,
  generationMode = null,
  generationId = null,
} = {}) {
  const normalizedSourceOwnerId = typeof sourceOwnerId === 'string'
    ? sourceOwnerId.trim()
    : '';
  const normalizedTargetOwnerId = typeof targetOwnerId === 'string'
    ? targetOwnerId.trim()
    : '';
  if (!normalizedSourceOwnerId
    || !normalizedTargetOwnerId
    || normalizedSourceOwnerId === normalizedTargetOwnerId) {
    return { allowed: false, proof: null, reason: 'owner-handoff-invalid' };
  }
  const preserved = preserveCodexServiceTierProofForTurnEnd(proof, {
    ownerId: normalizedSourceOwnerId,
    terminalToken,
    terminalLifecycleGeneration,
    terminalRunSeq,
    launchId,
    generationMode,
    generationId,
  });
  if (!preserved.preserved) {
    return { allowed: false, proof: null, reason: preserved.reason };
  }
  return {
    allowed: true,
    proof: preserved.proof,
    sourceOwnerId: normalizedSourceOwnerId,
    targetOwnerId: normalizedTargetOwnerId,
    serviceTier: preserved.proof.serviceTier,
    reason: 'exact-live-generation-owner-handoff',
  };
}

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
  materializedFresh = false,
} = {}) {
  if (command === 'codex-c' && materializedFresh === true) {
    const normalizedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    return {
      allowed: true,
      model: model || null,
      effort: normalizedEffort === 'ultra' ? null : (effort || null),
      settingsSource: normalizedEffort === 'ultra'
        ? 'materialized-new-thread-without-conversation-only-effort'
        : 'materialized-new-thread',
    };
  }
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

/**
 * A valid writer proof is already the result of the expensive
 * process -> descriptor -> rollout ownership transaction.  Read-only status
 * callers must project that event-owned fact instead of re-running lsof on
 * every render/API refresh.  The proof is reusable only inside the exact PTY
 * lifecycle/run that produced it; lifecycle actions still request a fresh
 * reconciliation at their own mutation boundary.
 */
function projectCodexWriterInspectionFromProof({
  proof = null,
  knownSessionId = null,
  terminalToken = null,
  currentTerminalToken = null,
  lifecycleGeneration = null,
  currentLifecycleGeneration = null,
  runSeq = 0,
  currentRunSeq = 0,
  commandRunning = false,
} = {}) {
  const sessionId = String(proof?.sessionId || '').trim();
  if (!sessionId
    || proof?.valid !== true
    || String(knownSessionId || '').trim() !== sessionId
    || !terminalToken
    || terminalToken !== currentTerminalToken
    || !lifecycleGeneration
    || lifecycleGeneration !== currentLifecycleGeneration
    || !Number.isInteger(Number(runSeq))
    || Number(runSeq) <= 0
    || Number(runSeq) !== Number(currentRunSeq)
    || commandRunning !== true) {
    return null;
  }
  return {
    status: 'adopted',
    sessionId,
    filePath: proof.filePath || null,
    pids: Array.isArray(proof.pids) ? proof.pids : [],
    sourceMatch: proof.sourceMatch || null,
    sourceSessionId: proof.sourceSessionId || null,
    forkedFromId: proof.forkedFromId || null,
    launchId: proof.launchId || null,
    proofKind: proof.kind || null,
    preserveWriterProof: true,
    projectionSource: 'event-owned-writer-proof',
  };
}

function createCodexPtySubmitAdmission({
  processRunning = false,
  hasLiveCodexEvidence = false,
  runSeq = 0,
  stopping = false,
  inputReadinessProofPending = false,
  inputRevision = null,
} = {}) {
  const revision = inputRevision === null
    ? {}
    : { inputRevision: Number(inputRevision) };
  if (inputReadinessProofPending === true) {
    return {
      available: false,
      reason: 'codex_input_readiness_proof_pending',
      runSeq: Number(runSeq) || 0,
      ...revision,
    };
  }
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

function codexSlashCommandAllowsTurnBusy({
  command,
  queuedHistoryCommand = false,
} = {}) {
  return codexLiveSlashAllowsTurnBusy(command) || queuedHistoryCommand === true;
}

function codexPromptOrTurnInFlightFromSignals({
  promptInFlight = false,
  turnBusy = false,
  pendingCompactOperationId = null,
  ignoredPendingCompactOperationId = null,
  activityOpen = false,
  awaitingAudit = false,
} = {}) {
  const pendingCompact = String(pendingCompactOperationId || '').trim();
  const ignoredCompact = String(ignoredPendingCompactOperationId || '').trim();
  const competingCompact = !!pendingCompact
    && (!ignoredCompact || pendingCompact !== ignoredCompact);
  return promptInFlight === true
    || turnBusy === true
    || competingCompact
    || activityOpen === true
    || awaitingAudit === true;
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
 * Keep only the identity needed to attribute a late-painted startup card to the
 * exact Codex launch. The full launch payload has watchdog/startup semantics
 * and is intentionally disposable as soon as the composer becomes ready; this
 * receipt survives that cleanup but contains no requested settings that could
 * be mistaken for observed settings.
 */
function createCodexLaunchSettingsObservationCandidate({
  launchId = null,
  terminalToken = null,
  runSeq = 0,
  terminalLifecycleGeneration = null,
  createdAt = Date.now(),
} = {}) {
  const normalizedLaunchId = typeof launchId === 'string' ? launchId.trim() : '';
  const normalizedRunSeq = Number(runSeq);
  const normalizedLifecycleGeneration = String(terminalLifecycleGeneration || '').trim();
  const normalizedCreatedAt = Number(createdAt);
  if (!normalizedLaunchId
    || !terminalToken
    || !Number.isInteger(normalizedRunSeq)
    || normalizedRunSeq <= 0
    || !normalizedLifecycleGeneration
    || !Number.isFinite(normalizedCreatedAt)
    || normalizedCreatedAt <= 0) {
    return null;
  }
  return {
    launchId: normalizedLaunchId,
    terminalToken,
    runSeq: normalizedRunSeq,
    terminalLifecycleGeneration: normalizedLifecycleGeneration,
    createdAt: normalizedCreatedAt,
  };
}

function validateCodexLaunchSettingsObservationCandidate(candidate, {
  launchId = null,
  terminalToken = null,
  runSeq = 0,
  terminalLifecycleGeneration = null,
  writerPresent = false,
} = {}) {
  if (!candidate) return { valid: false, reason: 'candidate-missing' };
  const expectedLaunchId = typeof launchId === 'string' ? launchId.trim() : '';
  const currentLifecycleGeneration = String(terminalLifecycleGeneration || '').trim();
  if (writerPresent === true) return { valid: false, reason: 'writer-already-present' };
  if (expectedLaunchId && candidate.launchId !== expectedLaunchId) {
    return { valid: false, reason: 'launch-generation-changed' };
  }
  if (!terminalToken || candidate.terminalToken !== terminalToken) {
    return { valid: false, reason: 'terminal-generation-changed' };
  }
  if (Number(candidate.runSeq) !== Number(runSeq)) {
    return { valid: false, reason: 'process-generation-changed' };
  }
  if (!currentLifecycleGeneration
    || candidate.terminalLifecycleGeneration !== currentLifecycleGeneration) {
    return { valid: false, reason: 'terminal-lifecycle-changed' };
  }
  return { valid: true, reason: 'exact-launch-generation', candidate };
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

function createCodexResumeReadIdentityLease({
  tabId = null,
  sourceSessionId = null,
  launchId = null,
  terminalToken = null,
  terminalRunSeq = 0,
  terminalLifecycleGeneration = null,
} = {}) {
  const clean = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
  );
  const normalizedTabId = clean(tabId);
  const normalizedSourceSessionId = clean(sourceSessionId);
  const normalizedLaunchId = clean(launchId);
  const normalizedLifecycleGeneration = clean(terminalLifecycleGeneration);
  const runSeq = Number(terminalRunSeq);
  if (!normalizedTabId
    || !normalizedSourceSessionId
    || !normalizedLaunchId
    || !terminalToken
    || !Number.isInteger(runSeq)
    || runSeq <= 0
    || !normalizedLifecycleGeneration) return null;
  return {
    command: 'codex-c',
    tabId: normalizedTabId,
    sessionId: normalizedSourceSessionId,
    launchId: normalizedLaunchId,
    terminalToken,
    runSeq,
    lifecycleGeneration: normalizedLifecycleGeneration,
  };
}

function createCodexReadIdentitySubmitBarrier({
  tabId = null,
  resumeReadLease = null,
  terminalToken = null,
  terminalRunSeq = 0,
  terminalLifecycleGeneration = null,
} = {}) {
  const clean = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
  );
  const normalizedTabId = clean(tabId);
  const runSeq = Number(terminalRunSeq);
  const lifecycleGeneration = clean(terminalLifecycleGeneration);
  if (!normalizedTabId
    || resumeReadLease?.command !== 'codex-c'
    || resumeReadLease.tabId !== normalizedTabId
    || !clean(resumeReadLease.sessionId)
    || !clean(resumeReadLease.launchId)
    || resumeReadLease.terminalToken !== terminalToken
    || Number(resumeReadLease.runSeq) !== runSeq
    || clean(resumeReadLease.lifecycleGeneration) !== lifecycleGeneration) return null;
  return {
    tabId: normalizedTabId,
    sourceSessionId: clean(resumeReadLease.sessionId),
    launchId: clean(resumeReadLease.launchId),
    terminalToken,
    runSeq,
    lifecycleGeneration,
    enterWritten: false,
  };
}

function shouldClearCodexReadIdentitySubmitBarrier(
  barrier,
  resolution = 'pre-enter-cancel',
) {
  if (!barrier) return false;
  if (resolution === 'pre-enter-cancel') return barrier.enterWritten !== true;
  return resolution === 'writer-adopted'
    || resolution === 'lifecycle-replaced'
    || resolution === 'resume-lease-released'
    || resolution === 'authority-revoked';
}

/**
 * Resolve the one session identity that read-only/copy surfaces may expose.
 *
 * This contract is intentionally distinct from writer authority. A resumed
 * Codex process can prove that it currently has its persisted source rollout
 * open before the first post-Resume submit decides whether Codex will append
 * to that source or create a child. That exact, idle launch-scoped source is
 * safe to read/copy, but it is never mutation authority. Once submit starts,
 * only a durably adopted writer becomes readable again.
 */
function resolveCodexReadIdentity({
  tabId = null,
  liveLifecycle = null,
  savedSessionId = null,
  persistedSessionId = null,
  provenWriterSessionId = null,
  writerConfirmed = false,
  writerUsableForMutation = false,
  writerProof = null,
  writerStatus = null,
  observedWriterSessionId = null,
  resumeSourceSessionId = null,
  launch = null,
  resumeReadLease = null,
  intent = null,
  resumeLease = null,
  sourceTurn = null,
  terminalToken = null,
  terminalRunSeq = 0,
  terminalLifecycleGeneration = null,
  processRunning = false,
  processPids = [],
  promptOrTurnInFlight = false,
  provisionalSubmitReserved = false,
  submitResolutionPending = null,
} = {}) {
  const cleanId = (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
  );
  const unavailable = (reason) => ({
    available: false,
    sessionId: null,
    source: 'unresolved',
    mutationSafe: false,
    reason,
  });
  const available = (sessionId, source, mutationSafe, reason) => ({
    available: true,
    sessionId,
    source,
    mutationSafe,
    reason,
  });

  if (liveLifecycle === false) {
    const stoppedSessionId = cleanId(savedSessionId);
    return stoppedSessionId
      ? available(stoppedSessionId, 'stopped-history', false, 'stopped-history')
      : unavailable('stopped-history-missing');
  }
  if (liveLifecycle !== true) return unavailable('lifecycle-unresolved');

  const persisted = cleanId(persistedSessionId);
  const provenWriter = cleanId(provenWriterSessionId);
  const exactWriterProof = typeof writerProof === 'string' && writerProof.trim().length > 0;
  if (writerStatus === 'adopted' || writerConfirmed === true) {
    if (writerStatus !== 'adopted') return unavailable('writer-not-adopted');
    if (writerConfirmed !== true) return unavailable('writer-unconfirmed');
    if (writerUsableForMutation !== true) return unavailable('writer-mutation-proof-unusable');
    if (!exactWriterProof) return unavailable('writer-proof-missing');
    if (!provenWriter) return unavailable('writer-session-missing');
    if (persisted !== provenWriter) return unavailable('writer-persisted-binding-mismatch');
    return available(provenWriter, 'live-writer', true, 'exact-adopted-writer');
  }

  if (writerStatus !== 'provisional-source') {
    return unavailable('writer-not-provisional-source');
  }

  const readLaunch = launch || resumeReadLease;
  const sourceSessionId = cleanId(resumeSourceSessionId)
    || cleanId(readLaunch?.sessionId);
  const observedWriter = cleanId(observedWriterSessionId);
  const launchId = cleanId(readLaunch?.launchId);
  const lifecycleGeneration = cleanId(terminalLifecycleGeneration);
  const runSeq = Number(terminalRunSeq);
  if (submitResolutionPending) {
    const exactPendingGeneration = submitResolutionPending.tabId === tabId
      && cleanId(submitResolutionPending.sourceSessionId) === sourceSessionId
      && cleanId(submitResolutionPending.launchId) === launchId
      && submitResolutionPending.terminalToken === terminalToken
      && Number(submitResolutionPending.runSeq) === runSeq
      && cleanId(submitResolutionPending.lifecycleGeneration) === lifecycleGeneration;
    return unavailable(exactPendingGeneration
      ? 'submit-resolution-pending'
      : 'submit-resolution-generation-mismatch');
  }
  const checks = [
    ['tab-missing', !!cleanId(tabId)],
    ['resume-source-missing', !!sourceSessionId],
    ['persisted-source-mismatch', persisted === sourceSessionId],
    ['observed-source-mismatch', observedWriter === sourceSessionId],
    ['launch-command-mismatch', readLaunch?.command === 'codex-c'],
    ['launch-tab-mismatch', readLaunch?.tabId === tabId],
    ['launch-source-mismatch', cleanId(readLaunch?.sessionId) === sourceSessionId],
    ['launch-generation-missing', !!launchId],
    ['terminal-missing', !!terminalToken],
    ['terminal-run-invalid', Number.isInteger(runSeq) && runSeq > 0],
    ['terminal-lifecycle-missing', !!lifecycleGeneration],
    ['launch-terminal-replaced', readLaunch?.terminalToken === terminalToken],
    ['launch-run-mismatch', Number(readLaunch?.runSeq) === runSeq],
    ['launch-lifecycle-mismatch', cleanId(readLaunch?.lifecycleGeneration) === lifecycleGeneration],
    ['intent-mode-mismatch', intent?.sourceMode === 'resume'],
    ['intent-source-mismatch', cleanId(intent?.sourceSessionId) === sourceSessionId],
    ['intent-launch-mismatch', cleanId(intent?.launchId) === launchId],
    ['intent-run-mismatch', Number(intent?.sourceRunSeq) === runSeq],
    ['intent-lifecycle-mismatch', cleanId(intent?.sourceLifecycleGeneration) === lifecycleGeneration],
    ['lease-source-mismatch', cleanId(resumeLease?.sourceSessionId) === sourceSessionId],
    ['lease-tab-mismatch', resumeLease?.tabId === tabId],
    ['lease-launch-mismatch', cleanId(resumeLease?.launchId) === launchId],
    ['source-turn-mismatch', cleanId(sourceTurn?.sessionId) === sourceSessionId],
    ['source-turn-launch-mismatch', cleanId(sourceTurn?.sourceObservationLaunchId) === launchId],
    ['source-turn-lifecycle-mismatch', cleanId(sourceTurn?.processGeneration) === lifecycleGeneration],
    ['process-not-running', processRunning === true],
    ['process-writer-not-open', Array.isArray(processPids) && processPids.length > 0],
    ['submit-inflight', promptOrTurnInFlight !== true],
    ['submit-reserved', provisionalSubmitReserved !== true],
  ];
  const failed = checks.find(([, passed]) => !passed);
  if (failed) return unavailable(failed[0]);
  return available(sourceSessionId, 'resume-source', false, 'exact-idle-resume-source');
}

function projectCodexRuntimeStatus({
  liveLifecycle = null,
  stopping = false,
  busy = false,
  inputReady = false,
  composerEstablished = false,
  inputProofPending = false,
  writerUsableForMutation = false,
  writerUiLifecycleEstablished = false,
  hasEstablishedLifecycle = false,
} = {}) {
  if (liveLifecycle === false) return 'inactive';
  if (stopping) return 'stopping';
  if (busy) return 'busy';
  // A short exact proof gate may temporarily close writes after a composer was
  // already established. It is not a new process launch: keep the visible
  // lifecycle active while input/action admission remains false.
  if (inputProofPending === true && composerEstablished === true) return 'active';
  // Readiness and writer identity are separate axes. App-created Fresh already
  // owns a metadata-only session id, but that still does not prove which
  // rollout the live process will write after its first user message. Once the
  // current PTY generation has a real composer it is no longer "starting";
  // mutations remain gated by writerUsableForMutation.
  if (liveLifecycle === true && inputReady) return 'active';
  // A fallible lookup may revoke identity without erasing an already-proven
  // visual lifecycle. This branch never restores the public session ID.
  if (inputReady && writerUiLifecycleEstablished) return 'active';
  if (liveLifecycle === true || hasEstablishedLifecycle) return 'starting';
  return 'unknown';
}

function projectCodexHistoryActionAvailability({
  liveLifecycle = null,
  savedSessionId = null,
  inputReady = false,
  busy = false,
  stopping = false,
  promptOrTurnInFlight = false,
  writerUsableForMutation = false,
  provisionalResumeAvailable = false,
  conversationMaterialized = true,
} = {}) {
  const hasSavedHistory = conversationMaterialized === true
    && typeof savedSessionId === 'string'
    && savedSessionId.trim().length > 0;
  if (liveLifecycle === false) {
    const allowed = hasSavedHistory;
    return {
      canNativeRewind: allowed,
      canRewriteHistory: allowed,
      canDeleteHistory: allowed,
      reason: allowed
        ? null
        : conversationMaterialized === false
          ? 'history-session-empty'
          : 'history-session-missing',
    };
  }
  if (liveLifecycle !== true) {
    return {
      canNativeRewind: false,
      canRewriteHistory: false,
      canDeleteHistory: false,
      reason: 'runtime-identity-unknown',
    };
  }
  if (stopping) {
    return {
      canNativeRewind: false,
      canRewriteHistory: false,
      canDeleteHistory: false,
      reason: 'process-stopping',
    };
  }
  if (busy || promptOrTurnInFlight) {
    return {
      canNativeRewind: false,
      canRewriteHistory: false,
      canDeleteHistory: false,
      reason: promptOrTurnInFlight ? 'submit-or-turn-in-flight' : 'turn-busy',
    };
  }
  if (!inputReady) {
    return {
      canNativeRewind: false,
      canRewriteHistory: false,
      canDeleteHistory: false,
      reason: 'composer-not-ready',
    };
  }
  if (conversationMaterialized === false) {
    return {
      canNativeRewind: false,
      canRewriteHistory: false,
      canDeleteHistory: false,
      reason: 'history-session-empty',
    };
  }
  const confirmedWriter = writerUsableForMutation === true;
  const exactIdleResume = provisionalResumeAvailable === true;
  return {
    canNativeRewind: confirmedWriter || exactIdleResume,
    canRewriteHistory: confirmedWriter,
    canDeleteHistory: confirmedWriter,
    reason: confirmedWriter
      ? null
      : exactIdleResume
        ? 'provisional-resume-rewind-only'
        : 'writer-not-mutation-safe',
  };
}

function projectCodexPublicRuntimeProjection({
  liveLifecycle = null,
  stopping = false,
  turnBusy = false,
  tuiInputReady = false,
  tuiLifecycleEstablished = false,
  inputProofPending = false,
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
    composerEstablished: tuiLifecycleEstablished,
    inputProofPending,
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
  authorizeCodexServiceTierProofOwnerHandoff,
  attachCodexSettingsProofOwner,
  codexLiveSlashAllowsTurnBusy,
  codexPromptOrTurnInFlightFromSignals,
  codexSlashCommandAllowsTurnBusy,
  codexSessionIdFromAuthoritativeStatus,
  classifyCodexLaunchPreparationResult,
  consumePendingCodexSettingsProofHandoff,
  createCodexLaunchSettingsObservationCandidate,
  createCodexReadIdentitySubmitBarrier,
  createCodexResumeReadIdentityLease,
  createCodexServiceTierProof,
  createCodexLaunchPendingResult,
  createPendingCodexSettingsProofHandoff,
  createCodexPtySubmitAdmission,
  isCodexSettingsApplicationProven,
  isCodexComposerReadyForGuardedSend,
  liveLifecycleFromCodexWriterStatus,
  planCodexCommandLaunchSettings,
  planCodexLaunchSettings,
  planCodexPickerMovement,
  preserveCodexServiceTierProofForTurnEnd,
  projectPendingCodexSettingsProofOwner,
  projectCodexWriterInspectionFromProof,
  projectCodexHistoryActionAvailability,
  projectCodexPublicRuntimeProjection,
  projectCodexRuntimeStatus,
  resolveCodexReadIdentity,
  resolveCodexPickerCurrentWriterSessionId,
  shouldClearCodexLaunchPending,
  shouldClearCodexReadIdentitySubmitBarrier,
  shouldHoldCodexStartingOnAbsent,
  shouldSurfaceCodexStartupTimeout,
  validateCodexPickerRuntimeAdmission,
  validateCodexLaunchSettingsObservationCandidate,
  validateCodexPtySubmitAdmission,
  verifyCodexNextLaunchSettings,
};
