'use strict';

// Shared by Desktop Settings/ControlBar and external API pickers. These are
// offline compatibility values; newly offered account models come from liveRaw.
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT = 'xhigh';
const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: DEFAULT_CODEX_MODEL, label: DEFAULT_CODEX_MODEL, defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', label: 'GPT-5.4', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
];

const normalizeCodexEffortList = (raw) => (
  Array.isArray(raw)
    ? raw.map((value) => String(value || '').trim()).filter((value, index, values) => value && values.indexOf(value) === index)
    : []
);
const normalizeCodexRemovedModelIds = normalizeCodexEffortList;

function codexSupportedEffortsForModel(model) {
  const explicit = normalizeCodexEffortList(model?.supportedEfforts);
  if (explicit.length > 0) return explicit;
  const bundled = DEFAULT_CODEX_MODEL_OPTIONS.find((candidate) => candidate.id === model?.id);
  const bundledEfforts = normalizeCodexEffortList(bundled?.supportedEfforts || bundled?.efforts);
  if (bundledEfforts.length > 0) return bundledEfforts;
  const selected = normalizeCodexEffortList(model?.efforts);
  return selected.length > 0 ? selected : [...CODEX_EFFORT_LEVELS];
}

function normalizeCodexModelOptions(raw, includeFallback = true, preferRawEffortsAsSupported = false) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = list.map((model) => {
    if (!model || typeof model !== 'object') return null;
    const id = String(model.id || '').trim();
    if (!id) return null;
    const label = String(model.label || id).trim() || id;
    const rawEfforts = normalizeCodexEffortList(model.efforts);
    const rawSupportedEfforts = normalizeCodexEffortList(model.supportedEfforts);
    const supportedEfforts = rawSupportedEfforts.length > 0
      ? rawSupportedEfforts
      : (preferRawEffortsAsSupported && rawEfforts.length > 0
        ? rawEfforts
        : codexSupportedEffortsForModel({ id, efforts: rawEfforts }));
    const efforts = rawEfforts.length > 0
      ? rawEfforts.filter((effort) => supportedEfforts.includes(effort))
      : [...supportedEfforts];
    const defaultEffort = String(model.defaultEffort || DEFAULT_CODEX_EFFORT).trim() || DEFAULT_CODEX_EFFORT;
    return {
      id,
      label,
      defaultEffort,
      efforts: efforts.length > 0 ? efforts : [...supportedEfforts],
      supportedEfforts,
      visible: model.visible !== false,
    };
  }).filter(Boolean);

  if (includeFallback && !normalized.some((model) => model.id === DEFAULT_CODEX_MODEL)) {
    const configuredIds = new Set(normalized.map((model) => model.id));
    normalized.unshift(...DEFAULT_CODEX_MODEL_OPTIONS.filter((model) => !configuredIds.has(model.id)).map((model) => ({
      ...model,
      efforts: [...(model.efforts || [])],
      supportedEfforts: [...(model.supportedEfforts || model.efforts || [])],
    })));
  }
  return normalized.length > 0 ? normalized : (includeFallback ? DEFAULT_CODEX_MODEL_OPTIONS : []);
}

function mergeCodexModelOptions(liveRaw, configuredRaw, removedModelIds = []) {
  const removed = new Set(normalizeCodexRemovedModelIds(removedModelIds));
  const live = normalizeCodexModelOptions(liveRaw, false, true).filter((model) => !removed.has(model.id));
  const configured = normalizeCodexModelOptions(configuredRaw, !removed.has(DEFAULT_CODEX_MODEL)).filter((model) => !removed.has(model.id));
  const liveById = new Map(live.map((model) => [model.id, model]));
  const result = [];
  const seen = new Set();
  for (const configuredModel of configured) {
    const liveModel = liveById.get(configuredModel.id);
    if (!liveModel) {
      // Manually added models remain usable; the native picker confirms whether
      // the current account accepts them. Discovery is not a closed allowlist.
      result.push(configuredModel);
      seen.add(configuredModel.id);
      continue;
    }
    const requestedEfforts = configuredModel.efforts || [];
    const supportedEfforts = codexSupportedEffortsForModel(liveModel);
    const efforts = supportedEfforts.filter((effort) => requestedEfforts.includes(effort));
    const effectiveEfforts = efforts.length > 0 ? efforts : [...supportedEfforts];
    result.push({
      ...liveModel,
      label: configuredModel.label || liveModel.label,
      visible: configuredModel.visible !== false,
      efforts: effectiveEfforts,
      supportedEfforts,
      defaultEffort: effectiveEfforts.includes(configuredModel.defaultEffort || '')
        ? configuredModel.defaultEffort
        : (effectiveEfforts.includes(liveModel.defaultEffort || '') ? liveModel.defaultEffort : effectiveEfforts[0]),
    });
    seen.add(configuredModel.id);
  }
  for (const liveModel of live) {
    if (!seen.has(liveModel.id)) result.push(liveModel);
  }
  return result;
}

function projectCodexModelOptions(models) {
  return models.filter((model) => model.visible !== false).map((model) => {
    const efforts = [...(model.efforts || [])];
    const defaultEffort = efforts.includes(model.defaultEffort) ? model.defaultEffort
      : efforts.includes(DEFAULT_CODEX_EFFORT) ? DEFAULT_CODEX_EFFORT : efforts[0] || '';
    return { id: model.id, label: model.label, defaultEffort, efforts };
  });
}

module.exports = {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_EFFORT,
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  normalizeCodexRemovedModelIds,
  codexSupportedEffortsForModel,
  normalizeCodexModelOptions,
  mergeCodexModelOptions,
  projectCodexModelOptions,
};
