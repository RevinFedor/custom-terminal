'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inferAgentModelProvider,
  resolveConfiguredAgentModel,
  resolveAgentProvider,
  validateAgentProviderModel,
} = require('./agent-provider-model-contract');

const configuredClaudeModels = [
  {
    key: 'opus-200k',
    id: 'claude-opus-5',
    label: 'Opus 5 (200K context)',
  },
  {
    key: 'opus',
    id: 'claude-opus-5[1m]',
    label: 'Opus 5 (1M context)',
  },
];

test('known Claude and Codex model families are identified without a closed model allowlist', () => {
  assert.equal(inferAgentModelProvider('claude-opus-5[1m]'), 'claude');
  assert.equal(inferAgentModelProvider('haiku'), 'claude');
  assert.equal(inferAgentModelProvider('gpt-5.6-luna'), 'codex');
  assert.equal(inferAgentModelProvider('o4-mini'), 'codex');
  assert.equal(inferAgentModelProvider('private-router-model'), null);
});

test('known cross-provider model pairs fail before any runtime mutation', () => {
  assert.throws(
    () => validateAgentProviderModel({ provider: 'claude', model: 'gpt-5.6-luna' }),
    (error) => error?.code === 'agent_model_provider_mismatch'
      && error?.statusCode === 400
      && error?.modelProvider === 'codex',
  );
  assert.throws(
    () => validateAgentProviderModel({ provider: 'codex', model: 'claude-opus-5[1m]' }),
    (error) => error?.code === 'agent_model_provider_mismatch'
      && error?.modelProvider === 'claude',
  );
});

test('valid and unknown provider-scoped model ids preserve existing capabilities', () => {
  assert.equal(
    validateAgentProviderModel({ provider: 'claude', model: 'claude-sonnet-4-5' }).provider,
    'claude',
  );
  assert.equal(
    validateAgentProviderModel({ provider: 'codex', model: 'gpt-5.6-luna' }).provider,
    'codex',
  );
  assert.equal(
    validateAgentProviderModel({ provider: 'claude', model: 'private-router-model' }).modelProvider,
    null,
    'custom model ids stay available and are left to the selected provider runtime',
  );
});

test('provider aliases cannot conflict or silently fall back from invalid input', () => {
  assert.equal(resolveAgentProvider({ toolType: 'codex' }), 'codex');
  assert.equal(resolveAgentProvider({ provider: 'claude' }), 'claude');
  assert.throws(
    () => resolveAgentProvider({ toolType: 'claude', provider: 'codex' }),
    (error) => error?.code === 'conflicting_agent_provider',
  );
  assert.throws(
    () => resolveAgentProvider({ toolType: 'gemini' }),
    (error) => error?.code === 'invalid_agent_provider',
  );
});

test('exact configured Claude ids preserve the 200K versus 1M variant', () => {
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'claude-opus-5',
    configuredModels: configuredClaudeModels,
  }).model, 'claude-opus-5');
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'claude-opus-5[1m]',
    configuredModels: configuredClaudeModels,
  }).model, 'claude-opus-5[1m]');
});

test('a unique Settings key or display name resolves to its exact model id', () => {
  assert.deepEqual(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'opus',
    configuredModels: configuredClaudeModels,
  }), {
    ok: true,
    provider: 'claude',
    model: 'claude-opus-5[1m]',
    modelProvider: 'claude',
    requestedModel: 'opus',
    resolution: 'settings-alias',
  });
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'Opus 5 (1M context)',
    configuredModels: configuredClaudeModels,
  }).model, 'claude-opus-5[1m]');
});

test('a Settings key is resolved before provider validation of the exact model id', () => {
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'gpt-shaped-user-key',
    configuredModels: [{
      key: 'gpt-shaped-user-key',
      id: 'claude-opus-5[1m]',
      label: 'Private Opus',
    }],
  }).model, 'claude-opus-5[1m]');
});

test('an ambiguous display alias fails instead of choosing a context variant', () => {
  const sameDisplayName = configuredClaudeModels.map((row) => ({
    ...row,
    label: 'Opus 5',
  }));
  assert.throws(
    () => resolveConfiguredAgentModel({
      provider: 'claude',
      model: 'Opus 5',
      configuredModels: sameDisplayName,
    }),
    (error) => error?.code === 'agent_model_alias_ambiguous'
      && error?.statusCode === 400
      && error?.candidates?.includes('claude-opus-5')
      && error?.candidates?.includes('claude-opus-5[1m]'),
  );
});

test('an exact configured id wins over an alias collision and unknown custom ids remain available', () => {
  const catalog = [
    { key: 'native-opus', id: 'opus', label: 'Native alias' },
    { key: 'opus', id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  ];
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'opus',
    configuredModels: catalog,
  }).model, 'opus');
  assert.equal(resolveConfiguredAgentModel({
    provider: 'claude',
    model: 'private-router-model',
    configuredModels: configuredClaudeModels,
  }).model, 'private-router-model');
});
