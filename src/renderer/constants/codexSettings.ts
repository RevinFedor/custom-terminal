// Single renderer-side source of truth for Codex launch/UI settings.
// Codex itself reads model/effort at process start via CLI flags; live running
// processes still use the main-process `/model` picker automation.

import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_EFFORT,
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  normalizeCodexRemovedModelIds,
  codexSupportedEffortsForModel,
  normalizeCodexModelOptions,
  mergeCodexModelOptions,
} from '../../shared/codex-model-catalog.mjs';

export {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_EFFORT,
  CODEX_EFFORT_LEVELS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  normalizeCodexRemovedModelIds,
  codexSupportedEffortsForModel,
  normalizeCodexModelOptions,
  mergeCodexModelOptions,
};

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
