import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyQueuedCodexSettingsIntent } from './promptQueueCodexSettingsIntent.mjs';

const expected = { revision: 8, model: 'gpt-6-astra', effort: 'max' };
const state = (patch = {}) => ({
  codexSettingsIntentRevision: 8,
  codexSettingsIntentModel: 'gpt-6-astra',
  codexSettingsIntentEffort: 'max',
  ...patch,
});

test('a retryable error remains pending until the same revision is applied', () => {
  assert.deepEqual(classifyQueuedCodexSettingsIntent(state({
    codexSettingsIntentError: 'codex_settings_observation_changed',
  }), expected), {
    kind: 'pending',
    error: 'codex_settings_observation_changed',
  });
  assert.deepEqual(classifyQueuedCodexSettingsIntent(state({
    codexSettingsIntentAppliedRevision: 8,
    codexSettingsIntentAppliedOwnerId: 'writer',
    codexSettingsIntentError: null,
  }), expected), { kind: 'applied' });
});

test('replacement, pair corruption and a failed applied revision remain terminal', () => {
  assert.deepEqual(classifyQueuedCodexSettingsIntent(state({
    codexSettingsIntentRevision: 9,
  }), expected), { kind: 'replaced' });
  assert.deepEqual(classifyQueuedCodexSettingsIntent(state({
    codexSettingsIntentModel: 'gpt-6-sol',
  }), expected), { kind: 'different-pair' });
  assert.deepEqual(classifyQueuedCodexSettingsIntent(state({
    codexSettingsIntentAppliedRevision: 8,
    codexSettingsIntentError: 'native-settings-persistence-failed',
  }), expected), { kind: 'failed', error: 'native-settings-persistence-failed' });
});
