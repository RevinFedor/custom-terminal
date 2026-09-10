'use strict';

const { mergeCodexModelOptions, projectCodexModelOptions } = require('../shared/codex-model-catalog.cjs');

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

function uniqueCleanStrings(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(clean)
    .filter((value, index, rows) => value && rows.indexOf(value) === index);
}

/**
 * Use the same effective catalog as Desktop: configured order/labels/visibility
 * and effort choices, then newly discovered live models. A configured-only
 * projection made new account models visible in Desktop but absent from iOS and
 * Voice Record. Hidden rows and removal tombstones still win over discovery.
 */
function projectConfiguredAgentModels({ liveModels, configuredSettings } = {}) {
  return projectCodexModelOptions(mergeCodexModelOptions(
    liveModels,
    configuredSettings?.models,
    configuredSettings?.removedModelIds,
  ));
}

function projectConfiguredClaudeModels({ configuredSettings, fallbackModels = [] } = {}) {
  const configured = Array.isArray(configuredSettings?.models)
    ? configuredSettings.models
    : null;
  if (!configured) return fallbackModels.map((row) => ({ ...row }));
  return configured.flatMap((row) => {
    if (!row || typeof row !== 'object' || row.visible === false) return [];
    const runtimeId = clean(row.id);
    const key = clean(row.key);
    const id = key || runtimeId;
    if (!id) return [];
    const label = clean(row.label) || id;
    const aliases = uniqueCleanStrings([
      id,
      key,
      runtimeId,
      label,
      ...(Array.isArray(row.aliases) ? row.aliases : []),
      ...inferredClaudeDisplayAliases(runtimeId),
    ]);
    return [{
      id,
      label,
      ...(runtimeId && runtimeId !== id ? { runtimeId } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(Array.isArray(row.efforts) ? { efforts: uniqueCleanStrings(row.efforts) } : {}),
    }];
  });
}

function resolveConfiguredAgentQuickPair(configuredSettings, projectedModels) {
  if (!configuredSettings || typeof configuredSettings !== 'object') return null;
  const model = clean(configuredSettings.quickModel);
  if (!model) return null;
  const row = (Array.isArray(projectedModels) ? projectedModels : []).find((candidate) => candidate?.id === model);
  if (!row) return null;
  const efforts = uniqueCleanStrings(row.efforts);
  const requestedEffort = clean(configuredSettings.quickEffort);
  const effort = efforts.includes(requestedEffort)
    ? requestedEffort
    : (efforts.includes(clean(row.defaultEffort)) ? clean(row.defaultEffort) : (efforts[0] || ''));
  if (!effort) return null;
  return { model, effort };
}

function resolveConfiguredAgentDefaultPair(defaultModel, defaultEffort, projectedModels) {
  const model = clean(defaultModel);
  if (!model || model === 'none') return null;
  const row = (Array.isArray(projectedModels) ? projectedModels : []).find((candidate) => candidate?.id === model);
  if (!row) return null;
  const efforts = uniqueCleanStrings(row.efforts).filter((effort) => effort !== 'ultra');
  const requestedEffort = clean(defaultEffort);
  const effort = requestedEffort !== 'none' && efforts.includes(requestedEffort)
    ? requestedEffort
    : (efforts.includes(clean(row.defaultEffort)) ? clean(row.defaultEffort) : (efforts[0] || ''));
  if (!effort) return null;
  return { model, effort };
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

function resolveAgentModelRequest({
  provider,
  model,
  modelSelection,
  configuredModels,
  catalogModels,
} = {}) {
  const legacyModel = clean(model);
  if (!modelSelection) {
    return resolveConfiguredAgentModel({ provider, model: legacyModel, configuredModels });
  }
  if (legacyModel) {
    throw agentContractError(
      'conflicting_agent_model_selection',
      'Pass either legacy model or modelSelection, not both.',
    );
  }
  if (typeof modelSelection !== 'object' || Array.isArray(modelSelection)) {
    throw agentContractError('invalid_agent_model_selection', 'modelSelection must be an object');
  }
  const kind = clean(modelSelection.kind).toLowerCase();
  const id = clean(modelSelection.id);
  if (!['catalog', 'custom'].includes(kind) || !id) {
    throw agentContractError(
      'invalid_agent_model_selection',
      'modelSelection requires kind=catalog|custom and a non-empty id',
    );
  }
  if (kind === 'custom') {
    const validated = validateAgentProviderModel({ provider, model: id });
    return {
      ...validated,
      requestedModel: id,
      resolution: 'explicit-custom',
      modelSelection: { kind, id },
    };
  }

  const rows = Array.isArray(catalogModels) ? catalogModels : [];
  const selectedRows = rows.filter((row) => clean(row?.id) === id);
  if (selectedRows.length !== 1) {
    throw agentContractError(
      selectedRows.length > 1 ? 'agent_model_catalog_id_ambiguous' : 'agent_model_catalog_id_not_found',
      selectedRows.length > 1
        ? `Model selection '${id}' is duplicated in the current ${providerLabel(provider)} catalog.`
        : `Model selection '${id}' is not present in the current ${providerLabel(provider)} catalog.`,
      {
        provider,
        model: id,
        candidates: rows.map((row) => clean(row?.id)).filter(Boolean),
      },
    );
  }
  const selected = selectedRows[0];
  const runtimeId = clean(selected.runtimeId) || clean(selected.id);
  const validated = validateAgentProviderModel({ provider, model: runtimeId });
  return {
    ...validated,
    requestedModel: id,
    resolution: 'catalog-selection',
    modelSelection: { kind, id },
  };
}

function assertAgentProviderModel(input) {
  return validateAgentProviderModel(input);
}

module.exports = {
  assertAgentProviderModel,
  inferAgentModelProvider,
  projectConfiguredAgentModels,
  projectConfiguredClaudeModels,
  resolveAgentModelRequest,
  resolveConfiguredAgentDefaultPair,
  resolveConfiguredAgentModel,
  resolveConfiguredAgentQuickPair,
  resolveAgentProvider,
  validateAgentProviderModel,
};
