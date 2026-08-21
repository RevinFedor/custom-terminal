import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveVisibleClaudeModelId,
  selectSessionOwnedSettings,
  settingProofNeedsAttention,
} from './confirmedAgentSettings.mjs';

test('state from the previous tab cannot leak into the current session', () => {
  assert.deepEqual(selectSessionOwnedSettings({
    sessionId: 'session-b',
    stateOwnerSessionId: 'session-a',
    stateModel: 'claude-opus-5',
    stateEffort: 'max',
  }), {
    model: null,
    effort: undefined,
    source: 'unknown',
    proven: false,
  });
});

test('disabled Claude default never flashes over a concrete 1M model', () => {
  const models = [
    { id: 'default', label: 'Default', visible: false },
    { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)', visible: true },
    { id: 'claude-fable-5', label: 'Fable 5', visible: true },
  ];
  assert.equal(resolveVisibleClaudeModelId({
    value: 'Opus 5 (1M context)',
    models,
    configuredFallback: 'none',
  }), 'claude-opus-5[1m]');
  assert.equal(resolveVisibleClaudeModelId({
    value: null,
    models,
    configuredFallback: 'none',
  }), 'claude-opus-5[1m]');
});

test('current-session seed wins synchronously while the component is reused', () => {
  assert.deepEqual(selectSessionOwnedSettings({
    sessionId: 'session-b',
    stateOwnerSessionId: 'session-a',
    stateModel: 'old-model',
    stateEffort: 'low',
    seed: { model: 'claude-opus-5[1m]', effort: 'max' },
  }), {
    model: 'claude-opus-5[1m]',
    effort: 'max',
    source: 'seed',
    proven: true,
  });
});

test('unproven and mismatched settings request attention', () => {
  assert.equal(settingProofNeedsAttention({
    sessionBound: true,
    confirmedValue: null,
  }), true);
  assert.equal(settingProofNeedsAttention({
    sessionBound: true,
    confirmedValue: 'max',
    pendingValue: 'low',
  }), true);
  assert.equal(settingProofNeedsAttention({
    sessionBound: true,
    confirmedValue: 'max',
    pendingValue: 'max',
  }), false);
  assert.equal(settingProofNeedsAttention({
    sessionBound: false,
    confirmedValue: null,
  }), false);
});
