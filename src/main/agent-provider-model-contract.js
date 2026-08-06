'use strict';

const AGENT_PROVIDERS = new Set(['claude', 'codex']);
const CLAUDE_MODEL_ALIASES = new Set([
  'default',
  'sonnet',
  'opus',
  'haiku',
  'fable',
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function providerLabel(provider) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function inferAgentModelProvider(modelInput) {
  const model = clean(modelInput).toLowerCase();
  if (!model) return null;
  if (CLAUDE_MODEL_ALIASES.has(model) || model.startsWith('claude-')) return 'claude';
  if (
    model.startsWith('gpt-')
    || model.startsWith('codex-')
    || /^o\d(?:-|$)/.test(model)
  ) return 'codex';
  return null;
}

function agentContractError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  error.statusCode = 400;
  Object.assign(error, details);
  return error;
}

function resolveAgentProvider({ toolType, provider, fallback = 'claude' } = {}) {
  const requestedTool = clean(toolType).toLowerCase();
  const requestedProvider = clean(provider).toLowerCase();
  for (const [field, value] of [['toolType', requestedTool], ['provider', requestedProvider]]) {
    if (value && !AGENT_PROVIDERS.has(value)) {
      throw agentContractError(
        'invalid_agent_provider',
        `${field} must be claude or codex`,
        { field, value },
      );
    }
  }
  if (requestedTool && requestedProvider && requestedTool !== requestedProvider) {
    throw agentContractError(
      'conflicting_agent_provider',
      `toolType=${requestedTool} conflicts with provider=${requestedProvider}`,
      { toolType: requestedTool, provider: requestedProvider },
    );
  }
  const resolved = requestedTool || requestedProvider || clean(fallback).toLowerCase();
  if (!AGENT_PROVIDERS.has(resolved)) {
    throw agentContractError('invalid_agent_provider', 'agent provider must be claude or codex');
  }
  return resolved;
}

function validateAgentProviderModel({ provider, model } = {}) {
  const resolvedProvider = resolveAgentProvider({ provider, fallback: '' });
  const normalizedModel = clean(model);
  if (!normalizedModel) {
    return {
      ok: true,
      provider: resolvedProvider,
      model: '',
      modelProvider: null,
    };
  }
  const modelProvider = inferAgentModelProvider(normalizedModel);
  if (modelProvider && modelProvider !== resolvedProvider) {
    throw agentContractError(
      'agent_model_provider_mismatch',
      `Model '${normalizedModel}' belongs to ${providerLabel(modelProvider)} and cannot be used with ${providerLabel(resolvedProvider)}.`,
      {
        provider: resolvedProvider,
        model: normalizedModel,
        modelProvider,
      },
    );
  }
  return {
    ok: true,
    provider: resolvedProvider,
    model: normalizedModel,
    modelProvider,
  };
}

function assertAgentProviderModel(input) {
  return validateAgentProviderModel(input);
}

module.exports = {
  assertAgentProviderModel,
  inferAgentModelProvider,
  resolveAgentProvider,
  validateAgentProviderModel,
};
