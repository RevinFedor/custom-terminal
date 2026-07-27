import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasCodexNextLaunchSettingsIntent,
  deriveCodexEffectiveSettingsFromHistory,
  isCodexSettingsPickerVisible,
  parseCodexModelChangeAcknowledgement,
  planCodexLaunchSettingsPersistence,
  planCodexPickerStateApplication,
  planCodexHistorySettingsProjection,
  planCodexPickerWriterPrecondition,
  planCodexSettingsControlAvailability,
  resolveCodexEffectiveSettings,
  stripCodexTerminalControls,
} from './codexEffectiveSettings.mjs';

test('stopped Codex intent is complete, persistent, and has no old writer owner', () => {
  assert.equal(hasCodexNextLaunchSettingsIntent({
    model: 'gpt-5.6-terra',
    effort: 'high',
    proofAt: 123,
    proofSessionId: undefined,
  }), true);
  assert.equal(hasCodexNextLaunchSettingsIntent({
    model: 'gpt-5.6-terra',
    effort: 'high',
    proofAt: 123,
    proofSessionId: 'old-writer',
  }), false);
  assert.equal(hasCodexNextLaunchSettingsIntent({
    model: 'gpt-5.6-terra',
    effort: 'ultra',
    proofAt: 123,
  }), false);
});

test('persists selected settings only after an accepted fresh Codex launch', () => {
  assert.deepEqual(planCodexLaunchSettingsPersistence({
    command: '  codex  ',
    result: { success: true, accepted: true },
    payload: { model: 'gpt-5.6-sol', effort: 'max' },
  }), {
    codexModel: 'gpt-5.6-sol',
    codexEffort: 'max',
  });
  assert.deepEqual(planCodexLaunchSettingsPersistence({
    command: 'codex',
    result: { success: true, accepted: true },
    payload: { model: '  gpt-5.6-luna  ', effort: '   ' },
  }), {
    codexModel: 'gpt-5.6-luna',
  });
});

test('does not persist launch payload for Continue, Fork, failure, or rejection', () => {
  const payload = { model: 'gpt-5.6-sol', effort: 'max' };
  assert.equal(planCodexLaunchSettingsPersistence({
    command: 'codex-c',
    result: { success: true, accepted: true },
    payload,
  }), null);
  assert.equal(planCodexLaunchSettingsPersistence({
    command: 'codex-f',
    result: { success: true, accepted: true },
    payload,
  }), null);
  assert.equal(planCodexLaunchSettingsPersistence({
    command: 'codex',
    result: { success: false, accepted: true },
    payload,
  }), null);
  assert.equal(planCodexLaunchSettingsPersistence({
    command: 'codex',
    result: { success: true, accepted: false },
    payload,
  }), null);
});

test('ControlBar inherited and quick-toggle settings CAS their owner while explicit pairs do not', () => {
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'model',
    currentProofSessionId: 'writer-a',
  }), {
    allowed: true,
    expectedWriterSessionId: 'writer-a',
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'effort',
    currentProofSessionId: 'writer-a',
  }), {
    allowed: true,
    expectedWriterSessionId: 'writer-a',
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'quick',
    currentProofSessionId: 'writer-a',
  }), {
    allowed: true,
    expectedWriterSessionId: 'writer-a',
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'pair',
    currentProofSessionId: 'stale-writer',
  }), {
    allowed: true,
    expectedWriterSessionId: null,
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'model',
    currentProofSessionId: null,
  }), {
    allowed: false,
    expectedWriterSessionId: null,
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'quick',
    currentProofSessionId: null,
  }), {
    allowed: false,
    expectedWriterSessionId: null,
  });
});

test('live Codex keeps explicit-pair recovery UI available without a settings owner proof', () => {
  assert.deepEqual(planCodexSettingsControlAvailability({
    isCodex: true,
    isCommandRunning: true,
    effectiveSettingsKnown: false,
  }), {
    modelMenuDisabled: false,
    partialSettingDisabled: true,
    explicitPairDisabled: false,
    quickDisabled: true,
  });
  assert.deepEqual(planCodexSettingsControlAvailability({
    isCodex: true,
    isCommandRunning: false,
    effectiveSettingsKnown: false,
  }), {
    modelMenuDisabled: false,
    partialSettingDisabled: false,
    explicitPairDisabled: false,
    quickDisabled: false,
  });
});

test('recognizes explicit and clipped Codex settings pickers, not generic confirmation', () => {
  assert.equal(isCodexSettingsPickerVisible(
    'Select Model and Effort\n› 1. gpt-5.6-sol\nPress enter to confirm or esc to go back'
  ), true);
  assert.equal(isCodexSettingsPickerVisible(
    '[… 2 lines] ctrl + a view all\n› 6. gpt-5.4-mini\nPress enter to confirm or esc to go back'
  ), true);
  assert.equal(isCodexSettingsPickerVisible(
    'Delete this session?\n› 1. Yes\n2. No\nPress enter to confirm or esc to go back'
  ), false);
});

test('parses exact Max and conversation-only Ultra acknowledgements across ANSI', () => {
  assert.deepEqual(
    parseCodexModelChangeAcknowledgement('\x1b[32m• Model changed to gpt-5.6-sol max\x1b[0m'),
    {
      model: 'gpt-5.6-sol',
      effort: 'max',
      applicationMode: 'persistent-default',
      proof: 'tui-model-ack',
    },
  );
  assert.deepEqual(
    parseCodexModelChangeAcknowledgement(
      '• Model changed to gpt-5.6-sol ul' + '\x1b[0m' + 'tra for this conversation'
    ),
    {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      applicationMode: 'conversation-only',
      proof: 'tui-conversation-ack',
    },
  );
  assert.equal(
    parseCodexModelChangeAcknowledgement('• Model changed to gpt-5.6-sol ultra'),
    null,
  );
  assert.equal(
    parseCodexModelChangeAcknowledgement('The assistant says: • Model changed to gpt-5.6-sol max'),
    null,
    'an inline assistant sentence is not a native acknowledgement row',
  );
});

test('keeps model-only preset acknowledgement partial instead of inventing effort', () => {
  assert.deepEqual(
    parseCodexModelChangeAcknowledgement('• Model changed to codex-auto-review'),
    {
      model: 'codex-auto-review',
      applicationMode: 'persistent-default',
      proof: 'tui-model-ack',
    },
  );
});

test('live Codex settings overlay is visible only to its exact writer', () => {
  assert.deepEqual(resolveCodexEffectiveSettings({
    codexSessionId: 'session-b',
    codexModel: 'gpt-5.6-sol',
    codexEffort: 'max',
    codexLiveModel: 'gpt-5.6-luna',
    codexLiveEffort: 'ultra',
    codexLiveSettingsSessionId: 'session-b',
  }), {
    model: 'gpt-5.6-luna',
    effort: 'ultra',
    liveOwned: true,
    source: 'live-conversation',
  });
  assert.deepEqual(resolveCodexEffectiveSettings({
    codexSessionId: 'session-c',
    codexModel: 'gpt-5.6-sol',
    codexEffort: 'max',
    codexLiveModel: 'gpt-5.6-luna',
    codexLiveEffort: 'ultra',
    codexLiveSettingsSessionId: 'session-b',
  }), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    liveOwned: false,
    source: 'persistent-fallback',
  });
});

test('live-owned effective pair enables inherited controls without persistent tab fields', () => {
  const effective = resolveCodexEffectiveSettings({
    codexSessionId: 'session-live',
    codexModel: 'gpt-5.6-terra',
    codexEffort: 'high',
    codexLiveModel: 'gpt-5.6-sol',
    codexLiveEffort: 'ultra',
    codexLiveSettingsSessionId: 'session-live',
  });
  const effectiveSettingsKnown = effective.liveOwned
    && !!effective.model
    && !!effective.effort;

  assert.deepEqual(planCodexSettingsControlAvailability({
    isCodex: true,
    isCommandRunning: true,
    effectiveSettingsKnown,
  }), {
    modelMenuDisabled: false,
    partialSettingDisabled: false,
    explicitPairDisabled: false,
    quickDisabled: false,
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'effort',
    currentProofSessionId: 'session-live',
  }), {
    allowed: true,
    expectedWriterSessionId: 'session-live',
  });
});

test('verified launch composer owns transient settings before the first writer exists', () => {
  const effective = resolveCodexEffectiveSettings({
    codexSessionId: undefined,
    codexModel: 'stale-default',
    codexEffort: 'medium',
    codexLiveModel: 'gpt-5.6-sol',
    codexLiveEffort: 'max',
    codexLiveSettingsSessionId: 'launch:fresh-7',
  });
  assert.deepEqual(effective, {
    model: 'gpt-5.6-sol',
    effort: 'max',
    liveOwned: true,
    source: 'verified-launch-composer',
  });
  assert.deepEqual(planCodexPickerWriterPrecondition({
    source: 'effort',
    currentProofSessionId: 'launch:fresh-7',
  }), {
    allowed: true,
    expectedWriterSessionId: 'launch:fresh-7',
  });
});

test('launch owner remains transient when picker state is applied', () => {
  assert.deepEqual(planCodexPickerStateApplication({
    result: {
      success: true,
      model: 'gpt-5.6-sol',
      effort: 'max',
      applicationMode: 'persistent-default',
      codexSettingsProofSessionId: null,
      codexProvisionalSettingsOwnerId: 'launch:fresh-7',
    },
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: 'max',
  }), {
    allowed: true,
    applicationMode: 'persistent-default',
    model: 'gpt-5.6-sol',
    effort: 'max',
    persistentPatch: {
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'max',
      codexSettingsProofSessionId: undefined,
    },
    livePatch: {
      codexLiveModel: 'gpt-5.6-sol',
      codexLiveEffort: 'max',
      codexLiveSettingsSessionId: 'launch:fresh-7',
    },
  });
});

test('conversation-only picker keeps Ultra transient and updates only an explicit fallback', () => {
  assert.deepEqual(planCodexPickerStateApplication({
    result: {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      applicationMode: 'conversation-only',
      codexSettingsProofSessionId: 'session-a',
      persistentModel: 'gpt-5.6-sol',
      persistentEffort: 'max',
    },
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: 'ultra',
    liveSessionId: 'session-a',
    currentPersistentModel: 'gpt-5.6-terra',
    currentPersistentEffort: 'high',
  }), {
    allowed: true,
    applicationMode: 'conversation-only',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    persistentPatch: {
      codexModel: 'gpt-5.6-sol',
      codexEffort: 'max',
      codexSettingsProofSessionId: undefined,
    },
    livePatch: {
      codexLiveModel: 'gpt-5.6-sol',
      codexLiveEffort: 'ultra',
      codexLiveSettingsSessionId: 'session-a',
    },
  });
  assert.deepEqual(planCodexPickerStateApplication({
    result: {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      applicationMode: 'conversation-only',
    },
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: 'ultra',
  }), {
    allowed: false,
    code: 'codex_conversation_settings_owner_missing',
  });
});

test('derives latest effective state only from exact parser-owned slash rows', () => {
  assert.deepEqual(
    deriveCodexEffectiveSettingsFromHistory([
      { role: 'slash', content: '/model gpt-5.5', timestamp: '2026-07-23T10:00:00.000Z' },
      { role: 'user', content: '/model fake-from-user-text' },
      { role: 'slash', content: '/effort low', timestamp: '2026-07-23T10:00:01.000Z' },
      { role: 'slash', content: '/model gpt-5.6-sol', timestamp: '2026-07-23T10:01:00.000Z' },
      { role: 'slash', content: '/effort ultra', timestamp: '2026-07-23T10:01:01.000Z' },
    ]),
    {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      proofAt: Date.parse('2026-07-23T10:01:01.000Z'),
      proof: 'rollout-turn-context',
    },
  );
  assert.equal(deriveCodexEffectiveSettingsFromHistory([
    { role: 'assistant', content: '/model gpt-5.6-sol' },
  ]), null);
});

test('older History refresh cannot roll back a newer picker proof', () => {
  const oldHistory = {
    model: 'gpt-5.5',
    effort: 'low',
    proofAt: Date.parse('2026-07-23T10:00:00.000Z'),
  };
  const pickerAppliedAt = Date.parse('2026-07-23T10:01:00.000Z');
  assert.equal(planCodexHistorySettingsProjection({
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'ultra',
    currentProofAt: pickerAppliedAt,
    currentProofSessionId: 'session-a',
    historySessionId: 'session-a',
    historyEffective: oldHistory,
  }), null);

  assert.equal(planCodexHistorySettingsProjection({
    currentModel: 'gpt-5.6-luna',
    currentEffort: 'medium',
    currentProofAt: pickerAppliedAt,
    currentProofSessionId: undefined,
    historySessionId: 'resume-source',
    historyEffective: oldHistory,
  }), null, 'a pre-rollout migration proof must outrank the older resume transcript');

  assert.equal(planCodexHistorySettingsProjection({
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'ultra',
    currentProofAt: pickerAppliedAt,
    currentProofSessionId: 'session-a',
    historySessionId: 'session-a',
    historyEffective: {
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      proofAt: Date.parse('2026-07-23T10:02:00.000Z'),
    },
  }), null, 'conversation-only Ultra must never project into durable tab settings');

  assert.deepEqual(planCodexHistorySettingsProjection({
    currentModel: 'gpt-5.6-sol',
    currentEffort: 'ultra',
    currentProofAt: pickerAppliedAt,
    currentProofSessionId: 'session-a',
    historySessionId: 'session-b',
    historyEffective: oldHistory,
  }), {
    codexModel: 'gpt-5.5',
    codexEffort: 'low',
    codexSettingsProofAt: oldHistory.proofAt,
    codexSettingsProofSessionId: 'session-b',
  });
});

test('terminal stripping does not destroy the acknowledgement words', () => {
  assert.equal(
    stripCodexTerminalControls('\x1b[?25l• Model\x1b[31m changed\x1b[0m to gpt-5.6-sol max\x1b[?25h'),
    '• Model changed to gpt-5.6-sol max',
  );
  assert.equal(
    stripCodexTerminalControls('Model\x1b[2Cchanged\x1b[1Cto gpt-5.6-luna\x1b[1Cmedium'),
    'Model  changed to gpt-5.6-luna medium',
  );
});
