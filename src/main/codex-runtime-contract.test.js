'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./codex-runtime-contract');

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
    hasLiveCodexEvidence: true,
    runSeq: 8,
  }).reason, 'codex_process_generation_changed');
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
