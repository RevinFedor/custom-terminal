'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceOscCommandGeneration,
  attachCodexSettingsProofOwner,
  codexLiveSlashAllowsTurnBusy,
  codexSessionIdFromAuthoritativeStatus,
  consumePendingCodexSettingsProofHandoff,
  createCodexLaunchPendingResult,
  createPendingCodexSettingsProofHandoff,
  createCodexPtySubmitAdmission,
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
} = require('./codex-runtime-contract');

test('only the native FAST service-tier command is admitted during an active turn', () => {
  assert.equal(codexLiveSlashAllowsTurnBusy('/fast'), true);
  assert.equal(codexLiveSlashAllowsTurnBusy('  /FAST  '), true);
  assert.equal(codexLiveSlashAllowsTurnBusy('/fast now'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('/model'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('/fastest'), false);
  assert.equal(codexLiveSlashAllowsTurnBusy('fast'), false);
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
