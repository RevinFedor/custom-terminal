'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inferAgentModelProvider,
  resolveAgentProvider,
  validateAgentProviderModel,
} = require('./agent-provider-model-contract');

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
