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

function aliasToken(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
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

function inferredClaudeDisplayAliases(modelId) {
  const normalized = aliasToken(modelId);
  const match = normalized.match(/^claude-([a-z0-9]+)-([0-9]+(?:-[0-9]+)*)(?:\[([^\]]+)\])?$/);
  if (!match) return [];
  const family = match[1];
  const version = match[2];
  const context = match[3] || '';
  const versions = new Set([
    version.replace(/-/g, ' '),
    version.replace(/-/g, '.'),
  ]);
  const aliases = new Set();
  for (const displayVersion of versions) {
    const base = `${family} ${displayVersion}`;
    aliases.add(base);
    aliases.add(`claude ${base}`);
    if (context) {
      aliases.add(`${base} ${context}`);
      aliases.add(`${base} (${context} context)`);
      aliases.add(`claude ${base} (${context} context)`);
    }
  }
  return Array.from(aliases);
}

function normalizeConfiguredModels(configuredModels) {
  if (!Array.isArray(configuredModels)) return [];
  const rows = [];
  for (const value of configuredModels) {
    if (!value || typeof value !== 'object') continue;
    const id = clean(value.id);
    if (!id) continue;
    const aliases = [
      value.key,
      value.label,
      ...(Array.isArray(value.aliases) ? value.aliases : []),
      ...inferredClaudeDisplayAliases(id),
    ]
      .map(aliasToken)
      .filter(Boolean);
    rows.push({
      id,
      idToken: aliasToken(id),
      aliases: Array.from(new Set(aliases)),
    });
  }
  return rows;
}

function uniqueModelRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

function resolveConfiguredAgentModel({
  provider,
  model,
  configuredModels,
} = {}) {
  const resolvedProvider = resolveAgentProvider({ provider, fallback: '' });
  const requestedModel = clean(model);
  if (!requestedModel) {
    const validated = validateAgentProviderModel({ provider: resolvedProvider, model: '' });
    return {
      ...validated,
      requestedModel: '',
      resolution: 'unspecified',
    };
  }

  const rows = normalizeConfiguredModels(configuredModels);
  if (rows.length === 0) {
    const validated = validateAgentProviderModel({ provider: resolvedProvider, model: requestedModel });
    return {
      ...validated,
      requestedModel,
      resolution: 'runtime-id',
    };
  }

  const requestedToken = aliasToken(requestedModel);
  const exactRows = uniqueModelRows(rows.filter((row) => row.idToken === requestedToken));
  if (exactRows.length === 1) {
    const validated = validateAgentProviderModel({
      provider: resolvedProvider,
      model: exactRows[0].id,
    });
    return {
      ...validated,
      requestedModel,
      resolution: 'settings-exact-id',
    };
  }

  const aliasRows = uniqueModelRows(rows.filter((row) => row.aliases.includes(requestedToken)));
  if (aliasRows.length === 1) {
    const validated = validateAgentProviderModel({
      provider: resolvedProvider,
      model: aliasRows[0].id,
    });
    return {
      ...validated,
      requestedModel,
      resolution: 'settings-alias',
    };
  }
  if (aliasRows.length > 1) {
    const candidates = aliasRows.map((row) => row.id).sort();
    throw agentContractError(
      'agent_model_alias_ambiguous',
      `Model alias '${requestedModel}' matches multiple configured ${providerLabel(resolvedProvider)} models: ${candidates.join(', ')}. Pass an exact model ID.`,
      {
        provider: resolvedProvider,
        model: requestedModel,
        candidates,
      },
    );
  }

  const validated = validateAgentProviderModel({ provider: resolvedProvider, model: requestedModel });
  return {
    ...validated,
    requestedModel,
    resolution: 'runtime-id',
  };
}

function assertAgentProviderModel(input) {
  return validateAgentProviderModel(input);
}

module.exports = {
  assertAgentProviderModel,
  inferAgentModelProvider,
  resolveConfiguredAgentModel,
  resolveAgentProvider,
  validateAgentProviderModel,
};
