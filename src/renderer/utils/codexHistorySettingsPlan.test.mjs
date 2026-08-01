import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexSettingsProofMatchesActiveWriter,
  codexSettingsProofMatchesRuntimeOwner,
  isCompleteCodexSettingsRequest,
  planCodexHistorySettings,
  resolveCodexSettingsRuntimeProof,
} from './codexHistorySettingsPlan.mjs';

const LIVE_WRITER = {
  liveLifecycle: true,
  writerConfirmed: true,
  provenWriterSessionId: 'writer-a',
};

test('model-only live request inherits effort only from settings proven for the active writer', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentModel: 'gpt-5.5',
    currentEffort: 'max',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.6-sol',
    effort: 'max',
  });
});

test('effort-only live request inherits model only from settings proven for the active writer', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedEffort: 'ultra',
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'max',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
});

test('complete settings request does not depend on saved current values', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedModel: 'gpt-5.6-terra',
    requestedEffort: 'high',
    statusAtSend: 'active',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.6-terra',
    effort: 'high',
  });
});

test('complete live settings request remains allowed when writer settings proof is stale', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedModel: 'gpt-5.6-terra',
    requestedEffort: 'high',
    currentModel: 'gpt-5.5',
    currentEffort: 'low',
    currentProofSessionId: 'old-writer',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.6-terra',
    effort: 'high',
  });
});

test('partial live request blocks when proof belongs to another writer', () => {
  const plan = planCodexHistorySettings({
    requestedEffort: 'ultra',
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'max',
    currentProofSessionId: 'resume-source',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.code, 'codex_current_settings_unproven');
  assert.equal(plan.proofReason, 'settings-proof-owner-mismatch');
  assert.match(plan.error, /send both model and effort/);
});

test('partial live request blocks while the active writer is not proven', () => {
  const plan = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentEffort: 'max',
    currentProofSessionId: 'resume-source',
    runtimeSnapshot: {
      liveLifecycle: true,
      writerConfirmed: false,
      provenWriterSessionId: 'resume-source',
    },
    statusAtSend: 'active',
  });
  assert.equal(plan.code, 'codex_current_settings_unproven');
  assert.equal(plan.proofReason, 'active-writer-unconfirmed');
});

test('partial request inherits the other setting from the exact provisional launch', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentModel: 'stale-saved-model',
    currentEffort: 'low',
    currentProofSessionId: 'resume-source',
    runtimeSnapshot: {
      liveLifecycle: true,
      writerConfirmed: false,
      provenWriterSessionId: null,
      codexProvisionalSettingsOwnerId: 'launch:resume-7',
      codexProvisionalModel: 'gpt-5.6-luna',
      codexProvisionalEffort: 'medium',
    },
    statusAtSend: 'active',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.6-sol',
    effort: 'medium',
  });
});

test('incomplete provisional launch proof cannot authorize partial settings inheritance', () => {
  const plan = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentEffort: 'medium',
    runtimeSnapshot: {
      liveLifecycle: true,
      writerConfirmed: false,
      codexProvisionalSettingsOwnerId: 'launch:resume-7',
      codexProvisionalModel: 'gpt-5.6-luna',
    },
    statusAtSend: 'active',
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.code, 'codex_current_settings_unproven');
});

test('partial request blocks on unknown lifecycle instead of treating it as stopped config', () => {
  const plan = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentEffort: 'max',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: null,
    statusAtSend: 'active',
  });
  assert.equal(plan.code, 'codex_current_settings_unproven');
  assert.equal(plan.proofReason, 'runtime-owner-unknown');
});

test('stopped future config keeps partial inheritance without a live-writer proof', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedEffort: 'max',
    currentModel: 'gpt-5.5',
    currentEffort: 'medium',
    currentProofSessionId: 'historical-session',
    runtimeSnapshot: { liveLifecycle: false },
    statusAtSend: 'inactive',
  }), {
    hasRequestedSettings: true,
    blocked: false,
    model: 'gpt-5.5',
    effort: 'max',
  });
});

test('settings request while busy fails explicitly and cannot queue a prompt', () => {
  const plan = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentModel: 'gpt-5.5',
    currentEffort: 'medium',
    statusAtSend: 'busy',
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.code, 'codex_settings_change_requires_idle');
  assert.match(plan.error, /prompt was not sent/);
});

test('explicit queue with settings is rejected even if caller supplied active status', () => {
  const plan = planCodexHistorySettings({
    requestedEffort: 'max',
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'medium',
    statusAtSend: 'active',
    queue: true,
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.code, 'codex_settings_change_requires_idle');
});

test('busy prompt without settings remains eligible for the normal queue flow', () => {
  assert.deepEqual(planCodexHistorySettings({
    requestedModel: 'none',
    requestedEffort: ' none ',
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'medium',
    statusAtSend: 'busy',
    queue: true,
  }), {
    hasRequestedSettings: false,
    blocked: false,
    model: 'gpt-5.6-sol',
    effort: 'medium',
  });
});

test('partial request fails closed when the inherited effective value is unknown', () => {
  const missingEffort = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentModel: 'gpt-5.5',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  });
  assert.equal(missingEffort.code, 'codex_current_effort_unknown');

  const missingModel = planCodexHistorySettings({
    requestedEffort: 'max',
    currentEffort: 'medium',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  });
  assert.equal(missingModel.code, 'codex_current_model_unknown');

  const launchSentinelIsNotEffectiveState = planCodexHistorySettings({
    requestedModel: 'gpt-5.6-sol',
    currentEffort: 'none',
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
    statusAtSend: 'active',
  });
  assert.equal(launchSentinelIsNotEffectiveState.code, 'codex_current_effort_unknown');
});

test('runtime proof resolver accepts only the explicitly confirmed live writer', () => {
  assert.deepEqual(resolveCodexSettingsRuntimeProof(LIVE_WRITER), {
    runtimeState: 'live',
    activeWriterSessionId: 'writer-a',
    currentSettingsOwnerId: 'writer-a',
    currentSettingsModel: '',
    currentSettingsEffort: '',
    provisionalSettingsProven: false,
  });
  assert.deepEqual(resolveCodexSettingsRuntimeProof({
    liveLifecycle: true,
    writerConfirmed: false,
    provenWriterSessionId: 'provisional-source',
  }), {
    runtimeState: 'live',
    activeWriterSessionId: '',
    currentSettingsOwnerId: '',
    currentSettingsModel: '',
    currentSettingsEffort: '',
    provisionalSettingsProven: false,
  });
  assert.deepEqual(resolveCodexSettingsRuntimeProof({ liveLifecycle: false }), {
    runtimeState: 'stopped',
    activeWriterSessionId: '',
    currentSettingsOwnerId: '',
    currentSettingsModel: '',
    currentSettingsEffort: '',
    provisionalSettingsProven: false,
  });
  assert.equal(codexSettingsProofMatchesActiveWriter({
    currentProofSessionId: 'writer-a',
    runtimeSnapshot: LIVE_WRITER,
  }), true);
  assert.equal(codexSettingsProofMatchesActiveWriter({
    currentProofSessionId: 'old-writer',
    runtimeSnapshot: LIVE_WRITER,
  }), false);
  assert.equal(codexSettingsProofMatchesRuntimeOwner({
    currentProofSessionId: 'launch:resume-7',
    runtimeSnapshot: {
      liveLifecycle: true,
      writerConfirmed: false,
      codexProvisionalSettingsOwnerId: 'launch:resume-7',
      codexProvisionalModel: 'gpt-5.6-luna',
      codexProvisionalEffort: 'medium',
    },
  }), true);
  assert.equal(isCompleteCodexSettingsRequest({
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: 'max',
  }), true);
  assert.equal(isCompleteCodexSettingsRequest({
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: 'none',
  }), false);
});
