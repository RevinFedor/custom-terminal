'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceOscCommandGeneration,
  attachCodexSettingsProofOwner,
  authorizeCodexServiceTierProofOwnerHandoff,
  codexLiveSlashAllowsTurnBusy,
  codexPromptOrTurnInFlightFromSignals,
  codexSlashCommandAllowsTurnBusy,
  codexSessionIdFromAuthoritativeStatus,
  classifyCodexLaunchPreparationResult,
  consumePendingCodexSettingsProofHandoff,
  createCodexLaunchSettingsObservationCandidate,
  createCodexReadIdentitySubmitBarrier,
  createCodexResumeReadIdentityLease,
  createCodexLaunchPendingResult,
  createPendingCodexSettingsProofHandoff,
  createCodexPtySubmitAdmission,
  createCodexServiceTierProof,
  isCodexComposerReadyForGuardedSend,
  liveLifecycleFromCodexWriterStatus,
  planCodexCommandLaunchSettings,
  planCodexLaunchSettings,
  planCodexPickerMovement,
  preserveCodexServiceTierProofForTurnEnd,
  projectPendingCodexSettingsProofOwner,
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
} = require('./codex-runtime-contract');

test('history action availability separates stopped history, idle Resume, confirmed writer, and in-flight send', () => {
  assert.deepEqual(projectCodexHistoryActionAvailability({
    liveLifecycle: false,
    savedSessionId: 'stopped-a',
  }), {
    canNativeRewind: true,
    canRewriteHistory: true,
    canDeleteHistory: true,
    reason: null,
  });

  assert.deepEqual(projectCodexHistoryActionAvailability({
    liveLifecycle: false,
    savedSessionId: 'metadata-only',
    conversationMaterialized: false,
  }), {
    canNativeRewind: false,
    canRewriteHistory: false,
    canDeleteHistory: false,
    reason: 'history-session-empty',
  });

  assert.deepEqual(projectCodexHistoryActionAvailability({
    liveLifecycle: true,
    savedSessionId: 'resume-a',
    inputReady: true,
    provisionalResumeAvailable: true,
  }), {
    canNativeRewind: true,
    canRewriteHistory: false,
    canDeleteHistory: false,
    reason: 'provisional-resume-rewind-only',
  });

  assert.deepEqual(projectCodexHistoryActionAvailability({
    liveLifecycle: true,
    savedSessionId: 'writer-a',
    inputReady: true,
    writerUsableForMutation: true,
  }), {
    canNativeRewind: true,
    canRewriteHistory: true,
    canDeleteHistory: true,
    reason: null,
  });

  assert.deepEqual(projectCodexHistoryActionAvailability({
    liveLifecycle: true,
    savedSessionId: 'resume-a',
    inputReady: true,
    provisionalResumeAvailable: true,
    promptOrTurnInFlight: true,
  }), {
    canNativeRewind: false,
    canRewriteHistory: false,
    canDeleteHistory: false,
    reason: 'submit-or-turn-in-flight',
  });
});

function provisionalResumeReadIdentity(overrides = {}) {
  const terminalToken = overrides.terminalToken || { pty: 'resume-terminal-a' };
  const tabId = overrides.tabId || 'tab-a';
  const sourceSessionId = overrides.sourceSessionId || 'source-a';
  const launchId = overrides.launchId || 'launch-a';
  const terminalRunSeq = overrides.terminalRunSeq || 7;
  const terminalLifecycleGeneration = overrides.terminalLifecycleGeneration || 'terminal-a:7';
  const base = {
    tabId,
    liveLifecycle: true,
    savedSessionId: sourceSessionId,
    persistedSessionId: sourceSessionId,
    provenWriterSessionId: null,
    writerConfirmed: false,
    writerUsableForMutation: false,
    writerProof: null,
    writerStatus: 'provisional-source',
    observedWriterSessionId: sourceSessionId,
    resumeSourceSessionId: sourceSessionId,
    launch: {
      command: 'codex-c',
      tabId,
      sessionId: sourceSessionId,
      launchId,
      terminalToken,
      runSeq: terminalRunSeq,
      lifecycleGeneration: terminalLifecycleGeneration,
    },
    intent: {
      sourceMode: 'resume',
      sourceSessionId,
      launchId,
      sourceRunSeq: terminalRunSeq,
      sourceLifecycleGeneration: terminalLifecycleGeneration,
    },
    resumeLease: { sourceSessionId, tabId, launchId },
    sourceTurn: {
      sessionId: sourceSessionId,
      sourceObservationLaunchId: launchId,
      processGeneration: terminalLifecycleGeneration,
    },
    terminalToken,
    terminalRunSeq,
    terminalLifecycleGeneration,
    processRunning: true,
    processPids: [101],
    promptOrTurnInFlight: false,
    provisionalSubmitReserved: false,
    submitResolutionPending: null,
  };
  return { ...base, ...overrides };
}

test('same-owner turn completion preserves the exact priority proof byte-for-byte', () => {
  const terminalToken = { pty: 'terminal-a' };
  const identity = {
    ownerId: 'session-a',
    terminalToken,
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: 'launch-a',
  };
  const proof = createCodexServiceTierProof({
    ...identity,
    serviceTier: 'priority',
    proofAt: 1785681000123,
    source: 'tui-service-tier-feedback',
  });
  const serializedBefore = JSON.stringify(proof);
  const result = preserveCodexServiceTierProofForTurnEnd(proof, identity);

  assert.equal(result.preserved, true);
  assert.equal(result.reason, 'same-live-owner-generation');
  assert.strictEqual(result.proof, proof);
  assert.equal(JSON.stringify(result.proof), serializedBefore);
  assert.equal(result.proof.fast, true);
  assert.equal(serializedBefore.includes('terminal-a'), false);
});

test('turn completion drops a service-tier proof on terminal, lifecycle, run, launch, or owner change', () => {
  const terminalToken = { pty: 'terminal-a' };
  const identity = {
    ownerId: 'session-a',
    terminalToken,
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: 'launch-a',
  };
  const proof = createCodexServiceTierProof({
    ...identity,
    serviceTier: 'priority',
    proofAt: 1785681000123,
  });
  const mismatches = [
    [{ terminalToken: { pty: 'terminal-b' } }, 'terminal-object-changed'],
    [{ terminalLifecycleGeneration: 'terminal-epoch-b:7' }, 'terminal-lifecycle-changed'],
    [{ terminalRunSeq: 8 }, 'terminal-run-changed'],
    [{ launchId: 'launch-b' }, 'launch-generation-changed'],
    [{ ownerId: 'session-b' }, 'proof-owner-changed'],
  ];
  for (const [patch, reason] of mismatches) {
    const result = preserveCodexServiceTierProofForTurnEnd(proof, {
      ...identity,
      ...patch,
    });
    assert.deepEqual(result, { preserved: false, proof: null, reason });
  }
});

test('an explicit default or priority observation replaces the exact live tier without inference', () => {
  const identity = {
    ownerId: 'session-a',
    terminalToken: { pty: 'terminal-a' },
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: 'launch-a',
  };
  const priority = createCodexServiceTierProof({
    ...identity,
    serviceTier: 'priority',
    proofAt: 1785681000123,
    source: 'first-feedback',
  });
  const defaultTier = createCodexServiceTierProof({
    ...identity,
    serviceTier: 'default',
    proofAt: 1785681000456,
    source: 'replacement-feedback',
  });

  assert.notStrictEqual(defaultTier, priority);
  assert.deepEqual(
    { tier: priority.serviceTier, fast: priority.fast },
    { tier: 'priority', fast: true },
  );
  assert.deepEqual(
    { tier: defaultTier.serviceTier, fast: defaultTier.fast },
    { tier: 'default', fast: false },
  );
  assert.strictEqual(
    preserveCodexServiceTierProofForTurnEnd(defaultTier, identity).proof,
    defaultTier,
  );
});

test('a provisional launch tier follows only its exact first writer in the same live generation', () => {
  const terminalToken = { pty: 'terminal-a' };
  const generation = {
    terminalToken,
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: 'launch-a',
  };
  const proof = createCodexServiceTierProof({
    ...generation,
    ownerId: 'launch:launch-a',
    serviceTier: 'priority',
    proofAt: 1785681000123,
  });
  const admitted = authorizeCodexServiceTierProofOwnerHandoff(proof, {
    ...generation,
    sourceOwnerId: 'launch:launch-a',
    targetOwnerId: 'writer-a',
  });
  assert.equal(admitted.allowed, true);
  assert.strictEqual(admitted.proof, proof);
  assert.equal(admitted.serviceTier, 'priority');
  assert.equal(admitted.targetOwnerId, 'writer-a');

  for (const patch of [
    { terminalToken: { pty: 'terminal-b' } },
    { terminalLifecycleGeneration: 'terminal-epoch-b:7' },
    { terminalRunSeq: 8 },
    { launchId: 'launch-b' },
    { sourceOwnerId: 'launch:foreign' },
    { targetOwnerId: 'launch:launch-a' },
  ]) {
    assert.equal(authorizeCodexServiceTierProofOwnerHandoff(proof, {
      ...generation,
      sourceOwnerId: 'launch:launch-a',
      targetOwnerId: 'writer-a',
      ...patch,
    }).allowed, false);
  }
});

test('a consumed launch tier becomes writer-owned and survives an ordinary completed turn', () => {
  const terminalToken = { pty: 'terminal-a' };
  const launchGeneration = {
    terminalToken,
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: 'launch-a',
    generationMode: 'launch',
    generationId: 'launch-a',
  };
  const launchProof = createCodexServiceTierProof({
    ...launchGeneration,
    ownerId: 'launch:launch-a',
    serviceTier: 'priority',
    proofAt: 1785681000123,
  });
  const handoff = authorizeCodexServiceTierProofOwnerHandoff(launchProof, {
    ...launchGeneration,
    sourceOwnerId: 'launch:launch-a',
    targetOwnerId: 'writer-a',
  });
  assert.equal(handoff.allowed, true);

  // The launch receipt has now been consumed. From this point the exact live
  // writer and PTY run own the state, so dropping one-shot launch metadata
  // during a later process revalidation must not clear FAST.
  const writerGeneration = {
    ownerId: handoff.targetOwnerId,
    terminalToken,
    terminalLifecycleGeneration: 'terminal-epoch-a:7',
    terminalRunSeq: 7,
    launchId: null,
    generationMode: 'terminal-run',
    generationId: 'terminal-epoch-a:7',
  };
  const writerProof = createCodexServiceTierProof({
    ...writerGeneration,
    serviceTier: handoff.serviceTier,
    proofAt: 1785681000456,
    source: 'exact-first-writer-service-tier-handoff',
  });
  assert.equal(writerProof.ownerId, 'writer-a');
  assert.equal(writerProof.launchId, null);
  assert.strictEqual(
    preserveCodexServiceTierProofForTurnEnd(writerProof, writerGeneration).proof,
    writerProof,
  );
  assert.equal(preserveCodexServiceTierProofForTurnEnd(writerProof, {
    ...writerGeneration,
    terminalRunSeq: 8,
  }).reason, 'terminal-run-changed');
  assert.equal(preserveCodexServiceTierProofForTurnEnd(writerProof, {
    ...writerGeneration,
    ownerId: 'writer-b',
  }).reason, 'proof-owner-changed');
});

test('a launchless live Codex run uses exact terminal-run ownership and hands it to only that writer', () => {
  const terminalToken = { pty: 'manual-terminal' };
  const generation = {
    terminalToken,
    terminalLifecycleGeneration: 'manual-terminal-epoch:3',
    terminalRunSeq: 3,
    launchId: null,
    generationMode: 'terminal-run',
    generationId: 'manual-terminal-epoch:3',
  };
  const proof = createCodexServiceTierProof({
    ...generation,
    ownerId: 'terminal-run:manual-terminal-epoch:3',
    serviceTier: 'priority',
    proofAt: 1785681000999,
  });
  assert.equal(proof.launchId, null);
  assert.equal(proof.generationMode, 'terminal-run');
  assert.strictEqual(
    preserveCodexServiceTierProofForTurnEnd(proof, {
      ...generation,
      ownerId: proof.ownerId,
    }).proof,
    proof,
  );
  const handoff = authorizeCodexServiceTierProofOwnerHandoff(proof, {
    ...generation,
    sourceOwnerId: proof.ownerId,
    targetOwnerId: 'manual-writer',
  });
  assert.equal(handoff.allowed, true);
  assert.equal(handoff.targetOwnerId, 'manual-writer');
  assert.equal(authorizeCodexServiceTierProofOwnerHandoff(proof, {
    ...generation,
    terminalRunSeq: 4,
    sourceOwnerId: proof.ownerId,
    targetOwnerId: 'manual-writer',
  }).allowed, false);
  assert.equal(authorizeCodexServiceTierProofOwnerHandoff(proof, {
    ...generation,
    terminalLifecycleGeneration: 'replacement-terminal:3',
    generationId: 'replacement-terminal:3',
    sourceOwnerId: proof.ownerId,
    targetOwnerId: 'manual-writer',
  }).allowed, false);
});

test('only the native FAST service-tier command is admitted during an active turn', () => {
  assert.equal(codexLiveSlashAllowsTurnBusy('/fast'), true);
  assert.equal(codexLiveSlashAllowsTurnBusy('  /FAST  '), true);
  assert.equal(codexLiveSlashAllowsTurnBusy('/fast now'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('/model'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('/fastest'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('fast'), false);
});

test('an owned History slash command may enter the provider queue without widening control-bar commands', () => {
  assert.equal(codexSlashCommandAllowsTurnBusy({
    command: '/status',
    queuedHistoryCommand: true,
  }), true);
  assert.equal(codexSlashCommandAllowsTurnBusy({
    command: '/compact',
    queuedHistoryCommand: true,
  }), true);
  assert.equal(codexSlashCommandAllowsTurnBusy({
    command: '/status',
    queuedHistoryCommand: false,
  }), false);
  assert.equal(codexSlashCommandAllowsTurnBusy({
    command: '/fast',
    queuedHistoryCommand: false,
  }), true);
});

test('first exact OSC command-start confirms the launch-preclaimed generation once', () => {
  assert.deepEqual(advanceOscCommandGeneration({
    runSeq: 13,
    preclaimedRunSeq: 13,
    sameTerminal: true,
    sameLaunch: true,
  }), {
    runSeq: 13,
    consumed: true,
  });

  assert.deepEqual(advanceOscCommandGeneration({
    runSeq: 13,
  }), {
    runSeq: 14,
    consumed: false,
  });
});

test('stale launch generation cannot suppress a real OSC command generation', () => {
  for (const mismatch of [
    { preclaimedRunSeq: 12, sameTerminal: true, sameLaunch: true },
    { preclaimedRunSeq: 13, sameTerminal: false, sameLaunch: true },
    { preclaimedRunSeq: 13, sameTerminal: true, sameLaunch: false },
  ]) {
    assert.deepEqual(advanceOscCommandGeneration({
      runSeq: 13,
      ...mismatch,
    }), {
      runSeq: 14,
      consumed: false,
    });
  }
});

test('durable migration marker suppresses every explicit model and effort fallback', () => {
  assert.deepEqual(planCodexLaunchSettings({
    requestedModel: 'gpt-5.4-mini',
    requestedEffort: 'max',
    modelSource: 'tab',
    effortSource: 'tab',
    durableDefaultModel: 'gpt-5.6-sol',
    durableDefaultEffort: 'max',
    modelMigrationPending: true,
  }), {
    model: null,
    effort: null,
    modelSource: 'migration-recovery',
    effortSource: 'migration-recovery',
  });
});

test('main-owned global settings outrank a stale renderer localStorage mirror', () => {
  assert.deepEqual(planCodexLaunchSettings({
    requestedModel: 'gpt-5.4-mini',
    requestedEffort: 'max',
    modelSource: 'global',
    effortSource: 'global',
    durableDefaultModel: 'gpt-5.6-luna',
    durableDefaultEffort: 'medium',
  }), {
    model: 'gpt-5.6-luna',
    effort: 'medium',
    modelSource: 'global',
    effortSource: 'global',
  });
});

test('command launch settings restore both Resume and Fork from proven source settings', () => {
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    sourceSettingsStatus: 'found',
    sourceModel: 'gpt-5.6-sol',
    sourceEffort: 'ultra',
  }), {
    allowed: true,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    settingsSource: 'resume-source-jsonl',
  });
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-f',
    sourceSettingsStatus: 'found',
    sourceModel: 'gpt-5.6-sol',
    sourceEffort: 'ultra',
  }), {
    allowed: true,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    settingsSource: 'fork-source-jsonl',
  });
  assert.equal(planCodexCommandLaunchSettings({
    command: 'codex-f',
    sourceSettingsStatus: 'absent',
  }).allowed, false);
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    sourceSettingsStatus: 'invalid',
  }), {
    allowed: false,
    error: 'codex_resume_source_settings_invalid',
    settingsSource: 'resume-source-jsonl',
  });
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  }), {
    allowed: true,
    model: 'gpt-5.6-sol',
    effort: null,
    settingsSource: 'new-thread-without-conversation-only-effort',
  });
});

test('metadata-only Resume uses new-thread settings without source turn context', () => {
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    materializedFresh: true,
    sourceSettingsStatus: 'absent',
    model: 'gpt-5.6-terra',
    effort: 'max',
  }), {
    allowed: true,
    model: 'gpt-5.6-terra',
    effort: 'max',
    settingsSource: 'materialized-new-thread',
  });
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    materializedFresh: true,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  }), {
    allowed: true,
    model: 'gpt-5.6-sol',
    effort: null,
    settingsSource: 'materialized-new-thread-without-conversation-only-effort',
  });
});

test('an explicit stopped-tab pair overrides Resume source settings exactly once', () => {
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    model: 'gpt-5.6-terra',
    effort: 'high',
    preferRequestedSettings: true,
    sourceSettingsStatus: 'found',
    sourceModel: 'gpt-5.6-sol',
    sourceEffort: 'max',
  }), {
    allowed: true,
    model: 'gpt-5.6-terra',
    effort: 'high',
    settingsSource: 'resume-tab-intent',
  });
  assert.equal(planCodexCommandLaunchSettings({
    command: 'codex-c',
    model: 'gpt-5.6-terra',
    preferRequestedSettings: true,
  }).allowed, false);
  assert.deepEqual(planCodexCommandLaunchSettings({
    command: 'codex-c',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    preferRequestedSettings: true,
  }), {
    allowed: false,
    error: 'codex_resume_intent_ultra_not_persistent',
    settingsSource: 'resume-tab-intent',
  });
});

test('next-launch Codex readiness requires the composer to prove the requested pair', () => {
  assert.deepEqual(verifyCodexNextLaunchSettings({
    settingsIntent: 'next-launch',
    requestedModel: 'gpt-5.6-terra',
    requestedEffort: 'high',
    composerModel: 'gpt-5.6-terra',
    composerEffort: 'high',
  }), {
    required: true,
    matches: true,
    error: null,
    requested: { model: 'gpt-5.6-terra', effort: 'high' },
    observed: { model: 'gpt-5.6-terra', effort: 'high' },
  });
  assert.equal(verifyCodexNextLaunchSettings({
    settingsIntent: 'next-launch',
    requestedModel: 'gpt-5.6-terra',
    requestedEffort: 'high',
    composerModel: 'gpt-5.6-sol',
    composerEffort: 'max',
  }).error, 'codex_next_launch_settings_mismatch');
  assert.deepEqual(verifyCodexNextLaunchSettings({
    settingsIntent: null,
  }), { required: false, matches: true, error: null });
});

test('fresh absence beats cached runtime state outside exact launch admission', () => {
  assert.equal(shouldHoldCodexStartingOnAbsent({}), false);
  assert.equal(shouldHoldCodexStartingOnAbsent({ launchObservationPending: true }), true);
  assert.equal(shouldHoldCodexStartingOnAbsent({ launchAcceptancePending: true }), true);
  assert.equal(shouldHoldCodexStartingOnAbsent({ startupFailureLatched: true }), true);
});

test('Codex launch admission returns pending instead of inventing process acceptance', () => {
  assert.deepEqual(createCodexLaunchPendingResult({
    launchId: 'launch-7',
    tabId: 'tab-7',
    command: 'codex-c',
    resumeSourceSessionId: 'source-session',
  }), {
    success: true,
    accepted: null,
    acceptancePending: true,
    lifecyclePreserved: true,
    launchId: 'launch-7',
    tabId: 'tab-7',
    command: 'codex-c',
    sessionId: null,
    resumeSourceSessionId: 'source-session',
    writerConfirmed: false,
  });
});

test('pending Codex launch admission clears preparation without inventing rejection', () => {
  assert.deepEqual(classifyCodexLaunchPreparationResult({
    success: true,
    accepted: null,
    acceptancePending: true,
  }), {
    accepted: true,
    reason: 'launch-pending',
    error: null,
  });
  assert.deepEqual(classifyCodexLaunchPreparationResult({
    success: true,
    accepted: true,
  }), {
    accepted: true,
    reason: 'launch-accepted',
    error: null,
  });
  assert.deepEqual(classifyCodexLaunchPreparationResult({
    success: false,
    accepted: false,
    error: 'shell_busy',
  }), {
    accepted: false,
    reason: 'launch-rejected',
    error: 'shell_busy',
  });
});

test('launch pending cleanup cannot clear a newer generation', () => {
  assert.equal(shouldClearCodexLaunchPending('launch-7', 'launch-7'), true);
  assert.equal(shouldClearCodexLaunchPending('launch-8', 'launch-7'), false);
  assert.equal(shouldClearCodexLaunchPending('launch-8'), true);
  assert.equal(shouldClearCodexLaunchPending(null, 'launch-7'), false);
});

test('startup timeout belongs to one launch generation and is only a failure guard', () => {
  const base = {
    expectedLaunchId: 'launch-2',
    currentLaunchId: 'launch-2',
    expectedStartedAt: 1_000,
    currentStartedAt: 1_000,
    now: 61_000,
    timeoutMs: 60_000,
  };
  assert.equal(shouldSurfaceCodexStartupTimeout(base), true);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, currentLaunchId: 'launch-3' }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, currentStartedAt: 2_000 }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, inputReady: true }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, promptOrTurnInFlight: true }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, manualActionRequired: true }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, blockers: ['auth-required'] }), false);
  assert.equal(shouldSurfaceCodexStartupTimeout({ ...base, now: 60_999 }), false);
});

test('one writer reconciliation result determines lifecycle without another process scan', () => {
  assert.equal(liveLifecycleFromCodexWriterStatus('absent'), false);
  assert.equal(liveLifecycleFromCodexWriterStatus('revalidation-absent'), false);
  assert.equal(liveLifecycleFromCodexWriterStatus('absent', { holdStartingOnAbsent: true }), true);
  assert.equal(liveLifecycleFromCodexWriterStatus('unknown'), null);
  assert.equal(liveLifecycleFromCodexWriterStatus('revalidation-unknown'), null);
  assert.equal(liveLifecycleFromCodexWriterStatus('pending'), true);
  assert.equal(liveLifecycleFromCodexWriterStatus('provisional-source'), true);
  assert.equal(liveLifecycleFromCodexWriterStatus('owned-by-other-tab'), true);
  assert.equal(liveLifecycleFromCodexWriterStatus('adopted'), true);
});

test('PTY submit admission is event-driven and invalidates on process generation change', () => {
  const token = createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
  });
  assert.equal(token.available, true);
  assert.deepEqual(validateCodexPtySubmitAdmission(token, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
  }), { valid: true, reason: null });
  assert.equal(validateCodexPtySubmitAdmission(token, {
    processRunning: false,
    hasLiveCodexEvidence: true,
    runSeq: 7,
  }).reason, 'codex_process_not_running');
  assert.equal(validateCodexPtySubmitAdmission(token, {
    processRunning: true,
    hasLiveCodexEvidence: false,
    runSeq: 7,
  }).reason, 'codex_tui_not_established');
  assert.equal(validateCodexPtySubmitAdmission(token, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 8,
  }).reason, 'codex_process_generation_changed');
});

test('PTY submit admission invalidates when manual input changes at the write boundary', () => {
  const admission = createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 12,
    inputRevision: 41,
  });

  assert.deepEqual(validateCodexPtySubmitAdmission(admission, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 12,
    inputRevision: 42,
  }), {
    valid: false,
    reason: 'codex_input_ownership_changed',
  });
});

test('PTY submit admission cannot cross a late readiness-proof boundary', () => {
  assert.deepEqual(createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 12,
    inputRevision: 41,
    inputReadinessProofPending: true,
  }), {
    available: false,
    reason: 'codex_input_readiness_proof_pending',
    runSeq: 12,
    inputRevision: 41,
  });

  const admission = createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 12,
    inputRevision: 41,
  });
  assert.deepEqual(validateCodexPtySubmitAdmission(admission, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 12,
    inputRevision: 41,
    inputReadinessProofPending: true,
  }), {
    valid: false,
    reason: 'codex_input_readiness_proof_pending',
  });
});

test('PTY submit admission is unavailable and current admission becomes invalid while stopping', () => {
  assert.deepEqual(createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
    stopping: true,
  }), {
    available: false,
    reason: 'codex_process_stopping',
    runSeq: 7,
  });

  const token = createCodexPtySubmitAdmission({
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
  });
  assert.deepEqual(validateCodexPtySubmitAdmission(token, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
    stopping: true,
  }), {
    valid: false,
    reason: 'codex_process_stopping',
  });
  assert.deepEqual(validateCodexPtySubmitAdmission(token, {
    processRunning: true,
    hasLiveCodexEvidence: true,
    runSeq: 7,
    stopping: false,
  }), {
    valid: true,
    reason: null,
  });
});

test('picker movement fails closed without a selected physical row', () => {
  assert.deepEqual(planCodexPickerMovement(-1, 3), {
    allowed: false,
    reason: 'codex_picker_selection_unknown',
    pressCount: 0,
    key: null,
  });
  assert.deepEqual(planCodexPickerMovement(2, -1), {
    allowed: false,
    reason: 'codex_picker_target_unknown',
    pressCount: 0,
    key: null,
  });
  assert.deepEqual(planCodexPickerMovement(2, 4), {
    allowed: true,
    reason: null,
    pressCount: 2,
    key: '\x1b[B',
  });
  assert.deepEqual(planCodexPickerMovement(2, 0), {
    allowed: true,
    reason: null,
    pressCount: 2,
    key: '\x1b[A',
  });
});

test('picker runtime admission is generation-bound and draft-aware', () => {
  const base = {
    sameTerminal: true,
    expectedRunSeq: 7,
    currentRunSeq: 7,
    expectedInputRevision: 11,
    currentInputRevision: 11,
    processRunning: true,
    hasLiveCodexEvidence: true,
    tuiReady: true,
    stopping: false,
    turnBusy: false,
    hasDraft: false,
  };
  assert.deepEqual(validateCodexPickerRuntimeAdmission(base), {
    allowed: true,
    reason: null,
  });
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    sameTerminal: false,
  }).reason, 'codex_terminal_generation_changed');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    currentRunSeq: 8,
  }).reason, 'codex_process_generation_changed');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    currentInputRevision: 12,
  }).reason, 'codex_input_ownership_changed');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    stopping: true,
  }).reason, 'codex_process_stopping');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    processRunning: false,
  }).reason, 'codex_process_not_running');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    hasLiveCodexEvidence: false,
  }).reason, 'codex_process_not_established');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    tuiReady: false,
  }).reason, 'codex_tui_not_ready');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    hasDraft: null,
  }).reason, 'codex_draft_state_unknown');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    turnBusy: true,
    hasDraft: true,
  }).reason, 'codex_busy_with_draft');
  assert.deepEqual(validateCodexPickerRuntimeAdmission({
    ...base,
    turnBusy: true,
    hasDraft: false,
    allowTurnBusy: true,
  }), {
    allowed: true,
    reason: null,
  });
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    turnBusy: true,
    hasDraft: false,
  }).reason, 'codex_turn_busy');
  assert.deepEqual(validateCodexPickerRuntimeAdmission({
    ...base,
    turnBusy: false,
    hasDraft: true,
  }), {
    allowed: true,
    reason: null,
  });
});

test('a programmatic compact does not classify its own pending identity as turn busy', () => {
  assert.equal(codexPromptOrTurnInFlightFromSignals({
    pendingCompactOperationId: 'compact-a',
    ignoredPendingCompactOperationId: 'compact-a',
  }), false);
  assert.equal(codexPromptOrTurnInFlightFromSignals({
    pendingCompactOperationId: 'compact-b',
    ignoredPendingCompactOperationId: 'compact-a',
  }), true, 'a competing compact remains a blocker');
  assert.equal(codexPromptOrTurnInFlightFromSignals({
    pendingCompactOperationId: 'compact-a',
    ignoredPendingCompactOperationId: 'compact-a',
    turnBusy: true,
  }), true, 'ignoring the own reservation never hides a real turn');
});

test('partial picker admission CAS-checks the active writer while full pairs need no writer precondition', () => {
  const base = {
    sameTerminal: true,
    expectedRunSeq: 7,
    currentRunSeq: 7,
    expectedInputRevision: 11,
    currentInputRevision: 11,
    processRunning: true,
    hasLiveCodexEvidence: true,
    tuiReady: true,
    stopping: false,
    turnBusy: false,
    hasDraft: false,
  };
  assert.deepEqual(validateCodexPickerRuntimeAdmission({
    ...base,
    expectedWriterSessionId: 'writer-a',
    currentWriterSessionId: 'writer-a',
  }), {
    allowed: true,
    reason: null,
  });
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    expectedWriterSessionId: 'writer-a',
    currentWriterSessionId: 'writer-b',
  }).reason, 'codex_settings_writer_changed');
  assert.equal(validateCodexPickerRuntimeAdmission({
    ...base,
    expectedWriterSessionId: 'writer-a',
    currentWriterSessionId: null,
  }).reason, 'codex_settings_writer_changed');
  assert.deepEqual(validateCodexPickerRuntimeAdmission({
    ...base,
    expectedWriterSessionId: null,
    currentWriterSessionId: 'writer-b',
  }), {
    allowed: true,
    reason: null,
  });
});

test('picker writer CAS accepts only the exact idle provisional Resume authorization', () => {
  const provisional = {
    provisionalWriterSessionId: 'source-a',
    provisionalAuthorized: true,
    sameTerminal: true,
    sameRunSeq: true,
    sameLaunch: true,
    sameDiscovery: true,
    sameLease: true,
    hasInflight: false,
  };
  assert.equal(resolveCodexPickerCurrentWriterSessionId(provisional), 'source-a');
  for (const key of [
    'provisionalAuthorized',
    'sameTerminal',
    'sameRunSeq',
    'sameLaunch',
    'sameDiscovery',
    'sameLease',
  ]) {
    assert.equal(resolveCodexPickerCurrentWriterSessionId({
      ...provisional,
      [key]: false,
    }), null, key);
  }
  assert.equal(resolveCodexPickerCurrentWriterSessionId({
    ...provisional,
    hasInflight: true,
  }), null);
  assert.equal(resolveCodexPickerCurrentWriterSessionId({
    ...provisional,
    provenWriterSessionId: 'child-b',
    sameLease: false,
    hasInflight: true,
  }), 'child-b');
});

test('picker proof is owned by the writer observed after queued application', () => {
  assert.deepEqual(attachCodexSettingsProofOwner({
    success: true,
    model: 'gpt-5.6-sol',
    effort: 'max',
  }, 'writer-b'), {
    success: true,
    model: 'gpt-5.6-sol',
    effort: 'max',
    codexSettingsProofSessionId: 'writer-b',
  });
  assert.equal(attachCodexSettingsProofOwner({
    success: false,
    applied: true,
    applicationProofSource: 'tui-conversation-ack',
    error: 'draft restore failed',
  }, 'writer-b').codexSettingsProofSessionId, 'writer-b');
  assert.equal(attachCodexSettingsProofOwner({
    success: false,
    applied: true,
    error: 'unproven failure',
  }, 'writer-b').codexSettingsProofSessionId, null);
  assert.equal(attachCodexSettingsProofOwner({
    success: true,
  }, null).codexSettingsProofSessionId, null);
});

test('fresh picker proof follows only the first writer from the exact PTY generation', () => {
  const terminalToken = {};
  const ultraProof = attachCodexSettingsProofOwner({
    success: true,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    applicationProofSource: 'tui-conversation-ack',
  }, null);
  const pending = createPendingCodexSettingsProofHandoff({
    result: ultraProof,
    terminalToken,
    runSeq: 7,
    launchId: 'launch-7',
    appliedAt: 123,
  });
  assert.deepEqual(pending, {
    terminalToken,
    runSeq: 7,
    launchId: 'launch-7',
    generationMode: 'launch',
    proofAt: 123,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    applicationProofSource: 'tui-conversation-ack',
  });
  assert.deepEqual(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 7,
    launchId: 'launch-7',
    writerSessionId: 'writer-first',
  }), {
    carry: true,
    reason: 'same-live-generation-first-writer',
    proof: { model: 'gpt-5.6-sol', effort: 'ultra', proofAt: 123 },
    nextPending: null,
  });
});

test('late launch-card observation keeps only exact launch identity and expires on every generation change', () => {
  const terminalToken = {};
  const candidate = createCodexLaunchSettingsObservationCandidate({
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
    createdAt: 1234,
  });
  assert.deepEqual(candidate, {
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
    createdAt: 1234,
  });
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
    writerPresent: false,
  }).valid, true);
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-other',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
  }).reason, 'launch-generation-changed');
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-late-card',
    terminalToken: {},
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
  }).reason, 'terminal-generation-changed');
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 18,
    terminalLifecycleGeneration: 'pty-generation-4',
  }).reason, 'process-generation-changed');
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-5',
  }).reason, 'terminal-lifecycle-changed');
  assert.equal(validateCodexLaunchSettingsObservationCandidate(candidate, {
    launchId: 'launch-late-card',
    terminalToken,
    runSeq: 17,
    terminalLifecycleGeneration: 'pty-generation-4',
    writerPresent: true,
  }).reason, 'writer-already-present');
  assert.equal(createCodexLaunchSettingsObservationCandidate({
    launchId: 'launch-without-generation',
    terminalToken,
    runSeq: 0,
    terminalLifecycleGeneration: null,
  }), null);
});

test('verified fresh-composer settings become owned by the first writer of that launch', () => {
  const terminalToken = {};
  const pending = createPendingCodexSettingsProofHandoff({
    result: {
      success: true,
      model: 'gpt-5.6-sol',
      effort: 'max',
      fast: true,
      applicationProofSource: 'verified-composer-footer',
    },
    terminalToken,
    runSeq: 4,
    launchId: 'launch-fresh',
    appliedAt: 1234,
  });
  assert.deepEqual(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 4,
    launchId: 'launch-fresh',
    writerSessionId: 'writer-fresh',
  }), {
    carry: true,
    reason: 'same-live-generation-first-writer',
    proof: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      proofAt: 1234,
      fast: true,
    },
    nextPending: null,
  });
  assert.deepEqual(projectPendingCodexSettingsProofOwner(pending, {
    terminalToken,
    runSeq: 4,
  }), {
    ownerId: 'launch:launch-fresh',
    launchId: 'launch-fresh',
    model: 'gpt-5.6-sol',
    effort: 'max',
    fast: true,
    proofAt: 1234,
    applicationProofSource: 'verified-composer-footer',
  });
  assert.equal(projectPendingCodexSettingsProofOwner(pending, {
    terminalToken,
    runSeq: 5,
  }), null);
  assert.equal(projectPendingCodexSettingsProofOwner(pending, {
    terminalToken: {},
    runSeq: 4,
  }), null);
  assert.equal(projectPendingCodexSettingsProofOwner(pending, {
    terminalToken,
    runSeq: 4,
    expectedOwnerId: 'launch:another-launch',
  }), null);
});

test('fresh launch arguments and defaults are requests, not settings proof', () => {
  for (const applicationProofSource of [
    'fresh-launch-command-line',
    'persistent-fallback',
    'tab-or-explicit',
    'global',
    'native',
  ]) {
    assert.equal(createPendingCodexSettingsProofHandoff({
      result: {
        success: true,
        model: 'gpt-5.6-sol',
        effort: 'max',
        applicationProofSource,
      },
      terminalToken: {},
      runSeq: 4,
      launchId: 'launch-unproven',
    }), null, applicationProofSource);
  }
});

test('Resume/Fork source settings proof transfers only to the first exact launch writer', () => {
  const terminalToken = {};
  const pending = createPendingCodexSettingsProofHandoff({
    result: {
      success: true,
      applied: true,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      applicationProofSource: 'resume-source-jsonl',
      codexSettingsProofSessionId: null,
    },
    terminalToken,
    runSeq: 13,
    launchId: 'resume-launch-13',
  });

  assert.deepEqual(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 13,
    launchId: 'resume-launch-13',
    writerSessionId: 'resumed-child-writer',
  }), {
    carry: true,
    reason: 'same-live-generation-first-writer',
    proof: {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      proofAt: pending.proofAt,
    },
    nextPending: null,
  });
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 13,
    launchId: 'different-launch',
    writerSessionId: 'different-child-writer',
  }).carry, false);
});

test('projected launch settings keep Fast unknown when source proof has no service tier', () => {
  const terminalToken = {};
  const pending = createPendingCodexSettingsProofHandoff({
    result: {
      success: true,
      applied: true,
      model: 'gpt-5.6-sol',
      effort: 'high',
      applicationProofSource: 'resume-source-jsonl',
      codexSettingsProofSessionId: null,
    },
    terminalToken,
    runSeq: 21,
    launchId: 'resume-launch-21',
  });

  assert.deepEqual(projectPendingCodexSettingsProofOwner(pending, {
    terminalToken,
    runSeq: 21,
  }), {
    ownerId: 'launch:resume-launch-21',
    launchId: 'resume-launch-21',
    model: 'gpt-5.6-sol',
    effort: 'high',
    proofAt: pending.proofAt,
    applicationProofSource: 'resume-source-jsonl',
  });
});

test('fresh picker proof is one-generation only and never comes from an unproven picker result', () => {
  const terminalToken = {};
  const pending = createPendingCodexSettingsProofHandoff({
    result: attachCodexSettingsProofOwner({
      success: true,
      model: 'gpt-5.6-sol',
      effort: 'max',
      applicationProofSource: 'config:initial-read',
    }, null),
    terminalToken,
    runSeq: 8,
    launchId: 'launch-8',
  });
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken: {},
    runSeq: 8,
    launchId: 'launch-8',
    writerSessionId: 'writer-first',
  }).reason, 'terminal-generation-changed');
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 9,
    launchId: 'launch-8',
    writerSessionId: 'writer-first',
  }).reason, 'process-generation-changed');
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 8,
    launchId: 'launch-9',
    writerSessionId: 'writer-first',
  }).reason, 'launch-generation-changed');
  assert.equal(createPendingCodexSettingsProofHandoff({
    result: {
      success: false,
      applied: true,
      error: 'unproven failure',
      codexSettingsProofSessionId: null,
    },
    terminalToken,
    runSeq: 8,
    launchId: 'launch-8',
  }), null);
});

test('pending handoff rejects an otherwise proven result without an exact model and effort pair', () => {
  assert.equal(createPendingCodexSettingsProofHandoff({
    result: {
      success: true,
      applicationProofSource: 'resume-source-jsonl',
      model: 'gpt-5.6-sol',
      codexSettingsProofSessionId: null,
    },
    terminalToken: {},
    runSeq: 8,
    launchId: 'launch-8',
  }), null);
});

test('manually adopted Codex process carries settings proof by terminal and run generation', () => {
  const terminalToken = {};
  const pending = createPendingCodexSettingsProofHandoff({
    result: {
      success: true,
      model: 'gpt-5.6-luna',
      effort: 'medium',
      applied: true,
      applicationProofSource: 'startup-model-migration-ack',
      codexSettingsProofSessionId: null,
    },
    terminalToken,
    runSeq: 12,
    launchId: null,
    allowTerminalRunGeneration: true,
  });
  assert.equal(pending.generationMode, 'terminal-run');
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 12,
    launchId: null,
    writerSessionId: 'manual-writer',
  }).carry, true);
  assert.equal(consumePendingCodexSettingsProofHandoff(pending, {
    terminalToken,
    runSeq: 13,
    launchId: null,
    writerSessionId: 'replacement-writer',
  }).reason, 'process-generation-changed');
});

test('ready live composer is active before the first rollout identity exists', () => {
  const status = projectCodexRuntimeStatus({
    liveLifecycle: true,
    inputReady: true,
    writerUsableForMutation: false,
    hasEstablishedLifecycle: true,
  });
  assert.equal(status, 'active');
  assert.equal(isCodexComposerReadyForGuardedSend({ toolType: 'codex', status, inputReady: true }), true);
});

test('late input proof keeps an established Codex lifecycle active while writes stay closed', () => {
  assert.deepEqual(projectCodexPublicRuntimeProjection({
    liveLifecycle: null,
    tuiInputReady: false,
    tuiLifecycleEstablished: true,
    inputProofPending: true,
    writerUsableForMutation: true,
    writerUiLifecycleEstablished: true,
    hasEstablishedLifecycle: true,
  }), {
    sessionStatus: 'active',
    busy: false,
    inputReady: false,
  });
  assert.equal(projectCodexRuntimeStatus({
    liveLifecycle: true,
    inputReady: false,
    composerEstablished: true,
    inputProofPending: true,
    writerUsableForMutation: true,
    writerUiLifecycleEstablished: true,
    hasEstablishedLifecycle: true,
  }), 'active');
});

test('failed Stop cannot promote raw TUI readiness without writer lifecycle proof', () => {
  assert.deepEqual(projectCodexPublicRuntimeProjection({
    liveLifecycle: null,
    tuiInputReady: true,
    writerUsableForMutation: false,
    writerUiLifecycleEstablished: false,
    hasEstablishedLifecycle: true,
  }), {
    sessionStatus: 'starting',
    busy: false,
    inputReady: true,
  });

  assert.equal(projectCodexPublicRuntimeProjection({
    liveLifecycle: null,
    tuiInputReady: true,
    writerUsableForMutation: true,
    writerUiLifecycleEstablished: true,
    hasEstablishedLifecycle: true,
  }).sessionStatus, 'active');
});

test('lookup outage preserves proven visual lifecycle without restoring identity', () => {
  assert.equal(projectCodexRuntimeStatus({
    liveLifecycle: null,
    inputReady: true,
    writerUiLifecycleEstablished: true,
    hasEstablishedLifecycle: true,
  }), 'active');
  assert.equal(codexSessionIdFromAuthoritativeStatus({
    toolType: 'codex',
    status: 'active',
    inputReady: true,
    sessionId: null,
    savedSessionId: 'old-history',
    writerConfirmed: false,
  }), null);
});

test('only explicit inactive may expose history and live status never falls back', () => {
  assert.equal(codexSessionIdFromAuthoritativeStatus({
    toolType: 'codex',
    status: 'inactive',
    sessionId: 'saved-history',
  }), 'saved-history');
  assert.equal(codexSessionIdFromAuthoritativeStatus({
    toolType: 'codex',
    status: 'starting',
    sessionId: null,
    codexSessionId: null,
    previousSessionId: 'stale-run',
  }), null);
  assert.equal(codexSessionIdFromAuthoritativeStatus({
    toolType: 'codex',
    status: 'active',
    sessionId: 'writer',
    codexWriterConfirmed: true,
    codexWriterUsableForMutation: true,
  }), 'writer');
});

test('idle provisional Resume exposes only an exact read identity, never writer authority', () => {
  assert.deepEqual(resolveCodexReadIdentity(provisionalResumeReadIdentity()), {
    available: true,
    sessionId: 'source-a',
    source: 'resume-source',
    mutationSafe: false,
    reason: 'exact-idle-resume-source',
  });
});

test('verified composer refresh may clear startup payload without clearing exact Resume copy identity', () => {
  const beforeRefresh = provisionalResumeReadIdentity();
  const resumeReadLease = createCodexResumeReadIdentityLease({
    tabId: beforeRefresh.tabId,
    sourceSessionId: beforeRefresh.resumeSourceSessionId,
    launchId: beforeRefresh.launch.launchId,
    terminalToken: beforeRefresh.terminalToken,
    terminalRunSeq: beforeRefresh.terminalRunSeq,
    terminalLifecycleGeneration: beforeRefresh.terminalLifecycleGeneration,
  });
  assert.ok(resumeReadLease);

  // finishCodexStartupLifecycle removes the startup-only payload after the
  // verified composer refresh. The independently captured read lease remains.
  const afterComposerRefresh = {
    ...beforeRefresh,
    launch: null,
    resumeReadLease,
    resumeSourceSessionId: null,
  };
  assert.deepEqual(resolveCodexReadIdentity(afterComposerRefresh), {
    available: true,
    sessionId: 'source-a',
    source: 'resume-source',
    mutationSafe: false,
    reason: 'exact-idle-resume-source',
  });
});

test('Enter barrier survives task_started and audit timeout until exact child adoption', () => {
  const base = provisionalResumeReadIdentity();
  const resumeReadLease = createCodexResumeReadIdentityLease({
    tabId: base.tabId,
    sourceSessionId: base.resumeSourceSessionId,
    launchId: base.launch.launchId,
    terminalToken: base.terminalToken,
    terminalRunSeq: base.terminalRunSeq,
    terminalLifecycleGeneration: base.terminalLifecycleGeneration,
  });
  let barrier = createCodexReadIdentitySubmitBarrier({
    tabId: base.tabId,
    resumeReadLease,
    terminalToken: base.terminalToken,
    terminalRunSeq: base.terminalRunSeq,
    terminalLifecycleGeneration: base.terminalLifecycleGeneration,
  });
  assert.ok(barrier);
  barrier.enterWritten = true;

  const applyLifecycleEvent = (event) => {
    if (shouldClearCodexReadIdentitySubmitBarrier(barrier, event)) barrier = null;
  };
  applyLifecycleEvent('task-started');
  assert.ok(barrier, 'generic task_started must retain the post-Enter barrier');
  applyLifecycleEvent('audit-timeout');
  assert.ok(barrier, 'audit timeout must retain causal uncertainty');
  assert.equal(resolveCodexReadIdentity({
    ...base,
    launch: null,
    resumeReadLease,
    resumeSourceSessionId: null,
    promptOrTurnInFlight: false,
    provisionalSubmitReserved: false,
    submitResolutionPending: barrier,
  }).reason, 'submit-resolution-pending');

  applyLifecycleEvent('writer-adopted');
  assert.equal(barrier, null);
  const adopted = resolveCodexReadIdentity({
    ...base,
    launch: null,
    resumeReadLease,
    resumeSourceSessionId: null,
    persistedSessionId: 'child-b',
    savedSessionId: 'child-b',
    writerStatus: 'adopted',
    provenWriterSessionId: 'child-b',
    writerConfirmed: true,
    writerUsableForMutation: true,
    writerProof: 'resumed-submit-causal-writer',
    submitResolutionPending: barrier,
  });
  assert.equal(adopted.sessionId, 'child-b');
  assert.equal(adopted.source, 'live-writer');
  assert.equal(adopted.mutationSafe, true);
});

test('first submit start and pending audit revoke provisional copy until writer resolution', () => {
  assert.deepEqual(resolveCodexReadIdentity(provisionalResumeReadIdentity({
    promptOrTurnInFlight: true,
  })), {
    available: false,
    sessionId: null,
    source: 'unresolved',
    mutationSafe: false,
    reason: 'submit-inflight',
  });
  assert.equal(resolveCodexReadIdentity(provisionalResumeReadIdentity({
    provisionalSubmitReserved: true,
  })).reason, 'submit-reserved');

  const base = provisionalResumeReadIdentity();
  const persistentBarrier = {
    tabId: base.tabId,
    sourceSessionId: base.resumeSourceSessionId,
    launchId: base.launch.launchId,
    terminalToken: base.terminalToken,
    runSeq: base.terminalRunSeq,
    lifecycleGeneration: base.terminalLifecycleGeneration,
    enterWritten: true,
  };
  assert.equal(resolveCodexReadIdentity({
    ...base,
    promptOrTurnInFlight: false,
    provisionalSubmitReserved: false,
    submitResolutionPending: persistentBarrier,
  }).reason, 'submit-resolution-pending');
  assert.equal(resolveCodexReadIdentity({
    ...base,
    submitResolutionPending: {
      ...persistentBarrier,
      terminalToken: { pty: 'foreign-terminal' },
    },
  }).reason, 'submit-resolution-generation-mismatch');
});

test('exact source-in-place and source-to-child adoption restore writer-backed copy', () => {
  const sourceWriter = resolveCodexReadIdentity(provisionalResumeReadIdentity({
    writerStatus: 'adopted',
    provenWriterSessionId: 'source-a',
    writerConfirmed: true,
    writerUsableForMutation: true,
    writerProof: 'resumed-submit-causal-writer',
  }));
  assert.deepEqual(sourceWriter, {
    available: true,
    sessionId: 'source-a',
    source: 'live-writer',
    mutationSafe: true,
    reason: 'exact-adopted-writer',
  });

  const childWriter = resolveCodexReadIdentity(provisionalResumeReadIdentity({
    persistedSessionId: 'child-b',
    savedSessionId: 'child-b',
    writerStatus: 'adopted',
    provenWriterSessionId: 'child-b',
    writerConfirmed: true,
    writerUsableForMutation: true,
    writerProof: 'resumed-submit-causal-writer',
  }));
  assert.equal(childWriter.sessionId, 'child-b');
  assert.equal(childWriter.source, 'live-writer');
  assert.equal(childWriter.mutationSafe, true);
});

test('stale, foreign, ambiguous, competing, and replacement generations get no read identity', () => {
  const base = provisionalResumeReadIdentity();
  const replacementTerminal = { pty: 'replacement' };
  const cases = [
    [
      { intent: { ...base.intent, launchId: 'launch-stale' } },
      'intent-launch-mismatch',
    ],
    [
      { writerStatus: 'owned-by-other-tab' },
      'writer-not-provisional-source',
    ],
    [
      { writerStatus: 'ambiguous' },
      'writer-not-provisional-source',
    ],
    [
      { resumeLease: { ...base.resumeLease, launchId: 'launch-competing' } },
      'lease-launch-mismatch',
    ],
    [
      { terminalToken: replacementTerminal },
      'launch-terminal-replaced',
    ],
    [
      { terminalLifecycleGeneration: 'terminal-a:8' },
      'launch-lifecycle-mismatch',
    ],
    [
      { persistedSessionId: null },
      'persisted-source-mismatch',
    ],
    [
      { sourceTurn: null },
      'source-turn-mismatch',
    ],
  ];
  for (const [patch, reason] of cases) {
    const result = resolveCodexReadIdentity({ ...base, ...patch });
    assert.equal(result.available, false, reason);
    assert.equal(result.sessionId, null, reason);
    assert.equal(result.reason, reason);
  }
});

test('provisional read bindings are isolated per tab and stopped Codex remains readable', () => {
  const tabA = provisionalResumeReadIdentity();
  const tabB = provisionalResumeReadIdentity({
    tabId: 'tab-b',
    sourceSessionId: 'source-b',
    launchId: 'launch-b',
    terminalToken: { pty: 'resume-terminal-b' },
    terminalRunSeq: 11,
    terminalLifecycleGeneration: 'terminal-b:11',
  });
  assert.equal(resolveCodexReadIdentity(tabA).sessionId, 'source-a');
  assert.equal(resolveCodexReadIdentity(tabB).sessionId, 'source-b');
  assert.equal(resolveCodexReadIdentity({
    ...tabA,
    resumeLease: tabB.resumeLease,
  }).available, false);

  assert.deepEqual(resolveCodexReadIdentity({
    liveLifecycle: false,
    savedSessionId: 'stopped-session',
  }), {
    available: true,
    sessionId: 'stopped-session',
    source: 'stopped-history',
    mutationSafe: false,
    reason: 'stopped-history',
  });
});
