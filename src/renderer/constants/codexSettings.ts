// Single renderer-side source of truth for Codex launch/UI settings.
// Codex itself reads model/effort at process start via CLI flags; live running
// processes still use the main-process `/model` picker automation.

export interface CodexModelOption {
  id: string;
  label: string;
  defaultEffort?: string;
  /** Levels selected by the user for this row. */
  efforts?: string[];
  /** Account/model capability list; separate from the selected checkboxes. */
  supportedEfforts?: string[];
  /** Hidden models stay configured but are omitted from ordinary pickers. */
  visible?: boolean;
}

/** A user-owned row in the Codex effort catalog. */
export interface CodexEffortOption {
  /** Stable identity survives a command/value rename. */
  key: string;
  /** Value sent to Codex when the row is enabled for a model. */
  id: string;
  /** Human-facing name shown in settings and pickers. */
  label: string;
}

export interface CodexSettings {
  models: CodexModelOption[];
  /** Editable catalog; per-model checkboxes only enable its supported rows. */
  effortOptions?: CodexEffortOption[];
  /** Legacy flat catalog kept for backward-compatible migration. */
  efforts: string[];
  /** One globally configured pair for the ControlBar quick-switch button. */
  quickModel?: string | null;
  quickEffort?: string | null;
  /** Rows explicitly removed by the user must not be re-added from the catalog. */
  removedModelIds?: string[];
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_EFFORT = 'xhigh';

// The live `codex debug models` catalog remains authoritative. These values
// cover offline and manual configuration, including model-specific max/ultra.
export const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CODEX_PERSISTENT_EFFORT_LEVELS = CODEX_EFFORT_LEVELS.filter(
  (level) => level !== 'ultra',
);
export type CodexEffortLevel = typeof CODEX_EFFORT_LEVELS[number];

export const DEFAULT_CODEX_EFFORT_OPTIONS: CodexEffortOption[] = CODEX_EFFORT_LEVELS.map((id) => ({
  key: `builtin:${id}`,
  id,
  label: id,
}));

export const CODEX_EFFORT_LABELS: Record<CodexEffortLevel, string> = {
  minimal: 'min',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
  max: 'max',
  ultra: 'ultra',
};

export const DEFAULT_CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  {
    id: DEFAULT_CODEX_MODEL,
    label: DEFAULT_CODEX_MODEL,
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  { id: 'gpt-5.4', label: 'GPT-5.4', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'xhigh'], supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
];

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  models: DEFAULT_CODEX_MODEL_OPTIONS,
  effortOptions: DEFAULT_CODEX_EFFORT_OPTIONS.map((option) => ({ ...option })),
  efforts: [...CODEX_EFFORT_LEVELS],
  quickModel: null,
  quickEffort: null,
  removedModelIds: [],
};

// 'none' is our app-level sentinel for "do not add a Codex launch override".
// Real Codex model ids are free-form strings from `codex debug models`.
export type DefaultCodexModel = string;
export type DefaultCodexEffort = string;

export const codexEffortLabel = (level: string): string => {
  if (level === 'none') return 'none';
  return (CODEX_EFFORT_LABELS as Record<string, string>)[level] || level;
};

const normalizeCodexEffortList = (raw: unknown): string[] => (
  Array.isArray(raw)
    ? raw.map((value) => String(value || '').trim()).filter((value, index, values) => value && values.indexOf(value) === index)
    : []
);

export const normalizeCodexRemovedModelIds = (raw: unknown): string[] => (
  Array.isArray(raw)
    ? raw.map((value) => String(value || '').trim()).filter((value, index, values) => value && values.indexOf(value) === index)
    : []
);

/** The full, model-specific checkbox list; `efforts` is only the selection. */
export const codexSupportedEffortsForModel = (
  model: Pick<CodexModelOption, 'id' | 'efforts' | 'supportedEfforts'> | undefined,
): string[] => {
  const explicit = normalizeCodexEffortList(model?.supportedEfforts);
  if (explicit.length > 0) return explicit;
  const bundled = DEFAULT_CODEX_MODEL_OPTIONS.find((candidate) => candidate.id === model?.id);
  const bundledEfforts = normalizeCodexEffortList(bundled?.supportedEfforts || bundled?.efforts);
  if (bundledEfforts.length > 0) return bundledEfforts;
  const selected = normalizeCodexEffortList(model?.efforts);
  return selected.length > 0 ? selected : [...CODEX_EFFORT_LEVELS];
};

export const normalizeCodexModelOptions = (
  raw: unknown,
  includeFallback = true,
  preferRawEffortsAsSupported = false,
): CodexModelOption[] => {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = list
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const id = String((m as any).id || '').trim();
      if (!id) return null;
      const label = String((m as any).label || id).trim() || id;
      const rawEfforts = normalizeCodexEffortList((m as any).efforts);
      const rawSupportedEfforts = normalizeCodexEffortList((m as any).supportedEfforts);
      const supportedEfforts = rawSupportedEfforts.length > 0
        ? rawSupportedEfforts
        : (preferRawEffortsAsSupported && rawEfforts.length > 0
          ? rawEfforts
          : codexSupportedEffortsForModel({ id, efforts: rawEfforts }));
      const efforts = rawEfforts.length > 0
        ? rawEfforts.filter((effort) => supportedEfforts.includes(effort))
        : [...supportedEfforts];
      const defaultEffort = String((m as any).defaultEffort || DEFAULT_CODEX_EFFORT).trim() || DEFAULT_CODEX_EFFORT;
      return {
        id,
        label,
        defaultEffort,
        efforts: efforts.length > 0 ? efforts : [...supportedEfforts],
        supportedEfforts,
        visible: (m as any).visible !== false,
      };
    })
    .filter(Boolean) as CodexModelOption[];

  if (includeFallback && !normalized.some((m) => m.id === DEFAULT_CODEX_MODEL)) {
    const configuredIds = new Set(normalized.map((model) => model.id));
    normalized.unshift(
      ...DEFAULT_CODEX_MODEL_OPTIONS
        .filter((model) => !configuredIds.has(model.id))
        .map((model) => ({
          ...model,
          efforts: [...(model.efforts || [])],
          supportedEfforts: [...(model.supportedEfforts || model.efforts || [])],
        })),
    );
  }
  return normalized.length > 0 ? normalized : (includeFallback ? DEFAULT_CODEX_MODEL_OPTIONS : []);
};

export const normalizeCodexEfforts = (raw: unknown): string[] => {
  const efforts = Array.isArray(raw)
    ? raw.map((v) => String(v || '').trim()).filter((v, index, arr) => v && arr.indexOf(v) === index)
    : [];
  return efforts.length > 0 ? efforts : [...CODEX_EFFORT_LEVELS];
};

/**
 * The catalog is provider-owned configuration, not a live capability list.
 * A new Codex value can be prepared here, while the live picker still decides
 * which individual model is actually allowed to use it.
 */
export const normalizeCodexEffortOptions = (
  raw: unknown,
  legacyRaw: unknown = undefined,
): CodexEffortOption[] => {
  const candidates = Array.isArray(raw)
    ? raw
    : (Array.isArray(legacyRaw) ? legacyRaw : DEFAULT_CODEX_EFFORT_OPTIONS);
  const options: CodexEffortOption[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  candidates.forEach((value, index) => {
    const item = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : { id: value };
    const id = String(item.id || '').trim();
    if (!id) return;
    const fallback = DEFAULT_CODEX_EFFORT_OPTIONS.find((option) => option.id === id);
    const explicitKey = String(item.key || '').trim();
    const key = explicitKey || fallback?.key || `custom:${id || index}`;
    if (seenKeys.has(key) || seenIds.has(id)) return;
    options.push({
      key,
      id,
      label: String(item.label || fallback?.label || id).trim() || id,
    });
    seenKeys.add(key);
    seenIds.add(id);
  });

  return options.length > 0
    ? options
    : DEFAULT_CODEX_EFFORT_OPTIONS.map((option) => ({ ...option }));
};

export const resolveCodexEffortForModel = (
  model: Pick<CodexModelOption, 'efforts' | 'defaultEffort'> | undefined,
  requested: unknown,
): string | null => {
  const efforts = model?.efforts?.filter(Boolean) || [...CODEX_EFFORT_LEVELS];
  if (efforts.length === 0) return null;
  const target = typeof requested === 'string' ? requested.trim() : '';
  if (target && efforts.includes(target)) return target;
  if (model?.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  if (efforts.includes(DEFAULT_CODEX_EFFORT)) return DEFAULT_CODEX_EFFORT;
  return efforts[0] || null;
};

export const resolveCodexPersistentEffortForModel = (
  model: Pick<CodexModelOption, 'efforts' | 'defaultEffort'> | undefined,
  requested: unknown,
): string | null => {
  const efforts = (model?.efforts?.filter(Boolean) || [...CODEX_EFFORT_LEVELS])
    .filter((effort) => effort !== 'ultra');
  if (efforts.length === 0) return null;
  const target = typeof requested === 'string' ? requested.trim() : '';
  if (target && target !== 'ultra' && efforts.includes(target)) return target;
  if (model?.defaultEffort
    && model.defaultEffort !== 'ultra'
    && efforts.includes(model.defaultEffort)) {
    return model.defaultEffort;
  }
  if (efforts.includes(DEFAULT_CODEX_EFFORT)) return DEFAULT_CODEX_EFFORT;
  return efforts[0] || null;
};

// The account-scoped catalog remains the source of truth for which model and
// effort Codex will accept. Saved settings may rename/reorder models and hide
// unwanted effort choices, but cannot manufacture an unsupported runtime pair.
export const mergeCodexModelOptions = (
  liveRaw: unknown,
  configuredRaw: unknown,
  removedModelIds: unknown = [],
): CodexModelOption[] => {
  const removed = new Set(normalizeCodexRemovedModelIds(removedModelIds));
  const live = normalizeCodexModelOptions(liveRaw, false, true).filter((model) => !removed.has(model.id));
  const configured = normalizeCodexModelOptions(
    configuredRaw,
    !removed.has(DEFAULT_CODEX_MODEL),
  ).filter((model) => !removed.has(model.id));
  const liveById = new Map(live.map((model) => [model.id, model]));
  const result: CodexModelOption[] = [];
  const seen = new Set<string>();

  for (const configuredModel of configured) {
    const liveModel = liveById.get(configuredModel.id);
    if (!liveModel) {
      // Keep a manually added model visible. Native picker confirmation still
      // decides whether the current Codex account can actually use it.
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
        : (effectiveEfforts.includes(liveModel.defaultEffort || '')
          ? liveModel.defaultEffort
          : effectiveEfforts[0]),
    });
    seen.add(configuredModel.id);
  }

  for (const liveModel of live) {
    if (!seen.has(liveModel.id)) result.push(liveModel);
  }
  return result;
};
