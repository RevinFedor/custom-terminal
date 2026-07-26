// Single source of truth for Claude TUI option lists that Anthropic ships and rev'es.
// Effort levels and model names change between Claude Code versions (May 2026:
// auto removed, xhigh added between high and max). Anything that hardcodes these
// strings must import from here so a future rev = one file edit.
//
// DeepSeek uses its own scale ('off' as off-state) — kept separate intentionally.

// 'ultracode' (May 2026, Opus 4.8) is NOT a model effort level — it's a Claude
// Code SESSION mode = xhigh effort + standing dynamic-workflow orchestration
// (Claude auto-decides when to spin up a workflow, no "workflow" keyword needed).
// The CLI accepts it as an `/effort ultracode` argument (binary ships the menu
// `[low|medium|high|xhigh|max|ultracode|auto]`) and the SDK forwards
// `options.effort` to `--effort` with no enum check — so it works identically on
// PTY and SDK tabs. Sits last (heaviest). Requires an xhigh-capable model.
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number];

// ultracode gets special UI treatment: purple accent + "this turns on
// auto-workflows" tooltip. Branch on this, don't hardcode. SDK transport
// differs: ultracode → effort=xhigh + settings.ultracode (the --effort flag's
// enum rejects 'ultracode').
export const CLAUDE_ULTRACODE: ClaudeEffortLevel = 'ultracode';

// 'none' is our own UI sentinel meaning "don't auto-inject /effort at all".
// Stored in user prefs alongside real levels.
export const CLAUDE_EFFORT_LEVELS_WITH_NONE = ['none', ...CLAUDE_EFFORT_LEVELS] as const;
export type DefaultClaudeEffort = string;

// Neutral default selected by click-toggle-off (clicking an already-active pill).
// Used to be 'auto' before Claude removed it; now the lowest level acts as deselect.
// DeepSeek has its own 'off' state — handled separately in InfoPanel.
export const CLAUDE_EFFORT_TOGGLE_OFF: ClaudeEffortLevel = 'low';

// Short labels for narrow pill buttons (e.g. "medium" → "med" to fit 5-pill row).
export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
  max: 'max',
  ultracode: 'ultra',
};

// DeepSeek's effort scale — distinct from Claude's because it includes an off-state.
// Proxy injects { thinking: { type: 'disabled' } } when 'off', or output_config.effort
// for the other three.
export const DEEPSEEK_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type DeepSeekEffortLevel = typeof DEEPSEEK_EFFORT_LEVELS[number];

export interface ClaudeCodeModelOption {
  /**
   * Stable identity of the configured row. `id` is the command sent to Claude
   * and users are allowed to edit it, so it cannot safely be used to decide
   * whether a built-in row has disappeared during migration.
   */
  key?: string;
  id: string;
  label: string;
  /** Levels the user chose to expose for this specific model. */
  efforts?: string[];
  /**
   * Hard capability limit for the row. This is deliberately separate from
   * `efforts`: turning a checkbox off must not make the level disappear from
   * settings, while a model such as Haiku must never offer unsupported levels.
   */
  supportedEfforts?: string[];
  /** Hidden models stay configured but are omitted from ordinary pickers. */
  visible?: boolean;
  cmd?: boolean;
}

/**
 * A provider-owned effort row. `key` stays stable while its command is edited,
 * exactly like the stable key on a Claude model row.
 */
export interface ClaudeEffortOption {
  key: string;
  /** Value passed to `/effort`. */
  id: string;
  /** Name shown in settings and pickers. */
  label: string;
}

export interface ClaudeCodeSettings {
  models: ClaudeCodeModelOption[];
  /** Editable Claude Code effort catalog; model checkboxes only select from it. */
  effortOptions?: ClaudeEffortOption[];
  /** Built-in rows explicitly removed by the user must not be re-added. */
  deletedModelKeys?: string[];
  /** One model/effort pair for the Claude ControlBar quick-switch button. */
  quickModel?: string | null;
  quickEffort?: string | null;
  /** Legacy global list, accepted only while migrating older saved settings. */
  efforts?: string[];
}

const DEFAULT_CLAUDE_EFFORTS = [...CLAUDE_EFFORT_LEVELS];
const DEFAULT_HAIKU_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export const DEFAULT_CLAUDE_EFFORT_OPTIONS: ClaudeEffortOption[] = CLAUDE_EFFORT_LEVELS.map((id) => ({
  key: `builtin:${id}`,
  id,
  label: id,
}));

// Claude model name list — same memoization concern, ships from Anthropic.
// Haiku deliberately stops at xhigh: the current CLI metadata does not expose
// max for it, and ultracode is not an available choice for that row.
export const DEFAULT_CLAUDE_CODE_MODELS: ClaudeCodeModelOption[] = [
  { key: 'default', id: 'default', label: 'default', efforts: [...DEFAULT_CLAUDE_EFFORTS], supportedEfforts: [...DEFAULT_CLAUDE_EFFORTS], visible: true, cmd: true },
  { key: 'sonnet', id: 'sonnet', label: 'sonnet', efforts: [...DEFAULT_CLAUDE_EFFORTS], supportedEfforts: [...DEFAULT_CLAUDE_EFFORTS], visible: true, cmd: true },
  { key: 'opus', id: 'opus', label: 'opus', efforts: [...DEFAULT_CLAUDE_EFFORTS], supportedEfforts: [...DEFAULT_CLAUDE_EFFORTS], visible: true, cmd: true },
  { key: 'haiku', id: 'haiku', label: 'haiku', efforts: [...DEFAULT_HAIKU_EFFORTS], supportedEfforts: [...DEFAULT_HAIKU_EFFORTS], visible: true, cmd: true },
  { key: 'fable', id: 'claude-fable-5[1m]', label: 'fable', efforts: [...DEFAULT_CLAUDE_EFFORTS], supportedEfforts: [...DEFAULT_CLAUDE_EFFORTS], visible: true, cmd: true },
];

export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  models: DEFAULT_CLAUDE_CODE_MODELS.map((model) => ({
    ...model,
    efforts: [...(model.efforts || [])],
    supportedEfforts: [...(model.supportedEfforts || [])],
  })),
  effortOptions: DEFAULT_CLAUDE_EFFORT_OPTIONS.map((option) => ({ ...option })),
  deletedModelKeys: [],
  quickModel: null,
  quickEffort: null,
};

const normalizeClaudeEffortValues = (raw: unknown): string[] => (
  Array.isArray(raw)
    ? raw
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
    : []
);

const normalizeClaudeEffortList = (raw: unknown, fallback: string[]): string[] => {
  const efforts = normalizeClaudeEffortValues(raw);
  return efforts.length > 0 ? efforts : [...fallback];
};

const normalizeClaudeEffortOptions = (raw: unknown, legacyRaw: unknown): ClaudeEffortOption[] => {
  const candidates = Array.isArray(raw)
    ? raw
    : (Array.isArray(legacyRaw) ? legacyRaw : DEFAULT_CLAUDE_EFFORT_OPTIONS);
  const options: ClaudeEffortOption[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  candidates.forEach((value, index) => {
    const item = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : { id: value };
    const id = String(item.id || '').trim();
    if (!id) return;
    const fallback = DEFAULT_CLAUDE_EFFORT_OPTIONS.find((option) => option.id === id);
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
    : DEFAULT_CLAUDE_EFFORT_OPTIONS.map((option) => ({ ...option }));
};

const defaultClaudeModelForKey = (key: string | undefined): ClaudeCodeModelOption | undefined => (
  DEFAULT_CLAUDE_CODE_MODELS.find((model) => model.key === key)
);

const inferClaudeModelKey = (raw: Record<string, unknown>, index: number): string => {
  const explicit = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (explicit) return explicit;

  const id = String(raw.id || '').trim().toLowerCase();
  const label = String(raw.label || '').trim().toLowerCase();
  if (id === 'claude-fable-5' || id === 'claude-fable-5[1m]' || id === 'fable' || label === 'fable') return 'fable';
  for (const model of DEFAULT_CLAUDE_CODE_MODELS) {
    if (id === model.id || label === model.label) return model.key || model.id;
  }

  // Older versions had a fixed, non-reorderable list. Preserve the user's
  // edited command by assigning the row its original stable identity.
  const positional = DEFAULT_CLAUDE_CODE_MODELS[index]?.key;
  if (positional && !explicit) return positional;
  return explicit || `custom:${id || index}`;
};

const normalizeDeletedClaudeModelKeys = (raw: unknown): string[] => (
  Array.isArray(raw)
    ? raw
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
    : []
);

/** The full model-specific list rendered as checkbox choices in settings. */
export const claudeSupportedEffortsForModel = (
  model: Pick<ClaudeCodeModelOption, 'key' | 'supportedEfforts'> | undefined,
): string[] => {
  const shipped = defaultClaudeModelForKey(model?.key);
  const candidate = normalizeClaudeEffortValues(model?.supportedEfforts);
  if (candidate.length > 0) return candidate;
  const shippedCandidate = normalizeClaudeEffortValues(shipped?.supportedEfforts || shipped?.efforts);
  return shippedCandidate.length > 0 ? shippedCandidate : [...DEFAULT_CLAUDE_EFFORTS];
};

/**
 * Accept the old global-effort shape and migrate it into per-model rows.
 * Stable keys prevent an edited command from being mistaken for deletion and
 * causing a shipped default to be appended.
 */
export const normalizeClaudeCodeSettings = (raw: unknown): ClaudeCodeSettings => {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const effortOptions = normalizeClaudeEffortOptions(obj.effortOptions, obj.efforts);
  const availableEfforts = new Set(effortOptions.map((option) => option.id));
  const legacyEfforts = normalizeClaudeEffortList(obj.efforts, DEFAULT_CLAUDE_EFFORTS)
    .filter((effort) => availableEfforts.has(effort));
  const rawModels = Array.isArray(obj.models) ? obj.models : [];
  const deletedModelKeys = normalizeDeletedClaudeModelKeys(obj.deletedModelKeys);
  const deleted = new Set(deletedModelKeys);
  const models: ClaudeCodeModelOption[] = [];
  const seen = new Set<string>();

  rawModels.forEach((value, index) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const key = inferClaudeModelKey(item, index);
    if (seen.has(key) || deleted.has(key)) return;

    const fallback = defaultClaudeModelForKey(key);
    const id = String(item.id || '').trim();
    if (!id) return;
    const label = String(item.label || fallback?.label || id).trim() || id;
    const supportedEfforts = claudeSupportedEffortsForModel({
      key,
      supportedEfforts: normalizeClaudeEffortValues(item.supportedEfforts),
    }).filter((effort) => availableEfforts.has(effort));
    const fallbackEfforts = (fallback?.efforts || DEFAULT_CLAUDE_EFFORTS)
      .filter((effort) => legacyEfforts.includes(effort) && supportedEfforts.includes(effort));
    const requestedEfforts = normalizeClaudeEffortList(
      item.efforts,
      fallbackEfforts.length > 0 ? fallbackEfforts : supportedEfforts,
    ).filter((effort) => supportedEfforts.includes(effort));
    models.push({
      key,
      id,
      label,
      efforts: requestedEfforts.length > 0 ? requestedEfforts : [...supportedEfforts],
      supportedEfforts,
      visible: item.visible !== false,
      cmd: true,
    });
    seen.add(key);
  });

  for (const fallback of DEFAULT_CLAUDE_CODE_MODELS) {
    const key = fallback.key || fallback.id;
    if (seen.has(key) || deleted.has(key)) continue;
    const supportedEfforts = (fallback.supportedEfforts || fallback.efforts || DEFAULT_CLAUDE_EFFORTS)
      .filter((effort) => availableEfforts.has(effort));
    models.push({
      ...fallback,
      efforts: (fallback.efforts || DEFAULT_CLAUDE_EFFORTS)
        .filter((effort) => supportedEfforts.includes(effort)),
      supportedEfforts,
      visible: fallback.visible !== false,
    });
  }

  const resolvedModels = models.length > 0 || Array.isArray(obj.models) || deletedModelKeys.length > 0
    ? models
    : DEFAULT_CLAUDE_CODE_SETTINGS.models.map((model) => ({
      ...model,
      efforts: [...(model.efforts || [])],
      supportedEfforts: [...(model.supportedEfforts || [])],
    }));
  const requestedQuickModel = typeof obj.quickModel === 'string' ? obj.quickModel.trim() : '';
  const quickModel = requestedQuickModel && resolvedModels.some((model) => model.id === requestedQuickModel)
    ? requestedQuickModel
    : null;
  const quickEffort = quickModel
    ? resolveClaudeEffortForModel(resolvedModels.find((model) => model.id === quickModel), obj.quickEffort)
    : null;
  return { models: resolvedModels, effortOptions, deletedModelKeys, quickModel, quickEffort };
};

export const claudeEffortsForModel = (
  model: Pick<ClaudeCodeModelOption, 'key' | 'efforts' | 'supportedEfforts'> | undefined,
): string[] => {
  const supported = claudeSupportedEffortsForModel(model);
  const efforts = normalizeClaudeEffortList(model?.efforts, supported)
    .filter((effort) => supported.includes(effort));
  return efforts.length > 0 ? efforts : [...supported];
};

export const resolveClaudeEffortForModel = (
  model: Pick<ClaudeCodeModelOption, 'key' | 'efforts' | 'supportedEfforts'> | undefined,
  requested: unknown,
): string | null => {
  const efforts = claudeEffortsForModel(model);
  if (efforts.length === 0) return null;
  const target = typeof requested === 'string' ? requested.trim() : '';
  if (target && efforts.includes(target)) return target;
  if (efforts.includes('medium')) return 'medium';
  return efforts[0] || null;
};

export const CLAUDE_MODELS = DEFAULT_CLAUDE_CODE_MODELS.map((m) => m.id);
export type ClaudeModel = typeof CLAUDE_MODELS[number];

// 'none' is our app-level sentinel for "do not auto-apply /model on Claude
// startup". Real Claude Code accepts `/model default`, so "default" stays a
// normal selectable model, distinct from opt-out.
export type DefaultClaudeModel = string;
