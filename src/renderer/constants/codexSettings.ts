// Single renderer-side source of truth for Codex launch/UI settings.
// Codex itself reads model/effort at process start via CLI flags; live running
// processes still use the main-process `/model` picker automation.

export interface CodexModelOption {
  id: string;
  label: string;
  defaultEffort?: string;
  efforts?: string[];
}

export interface CodexSettings {
  models: CodexModelOption[];
  efforts: string[];
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_EFFORT = 'xhigh';

export const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexEffortLevel = typeof CODEX_EFFORT_LEVELS[number];

export const CODEX_EFFORT_LABELS: Record<CodexEffortLevel, string> = {
  minimal: 'min',
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhi',
};

export const DEFAULT_CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  {
    id: DEFAULT_CODEX_MODEL,
    label: DEFAULT_CODEX_MODEL,
    defaultEffort: DEFAULT_CODEX_EFFORT,
    efforts: [...CODEX_EFFORT_LEVELS],
  },
];

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  models: DEFAULT_CODEX_MODEL_OPTIONS,
  efforts: [...CODEX_EFFORT_LEVELS],
};

// 'none' is our app-level sentinel for "do not add a Codex launch override".
// Real Codex model ids are free-form strings from `codex debug models`.
export type DefaultCodexModel = string;
export type DefaultCodexEffort = string;

export const codexEffortLabel = (level: string): string => {
  if (level === 'none') return 'none';
  return (CODEX_EFFORT_LABELS as Record<string, string>)[level] || level;
};

export const normalizeCodexModelOptions = (raw: unknown): CodexModelOption[] => {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = list
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      const id = String((m as any).id || '').trim();
      if (!id) return null;
      const label = String((m as any).label || id).trim() || id;
      const efforts = Array.isArray((m as any).efforts)
        ? (m as any).efforts.map((v: unknown) => String(v || '').trim()).filter(Boolean)
        : [...CODEX_EFFORT_LEVELS];
      const defaultEffort = String((m as any).defaultEffort || DEFAULT_CODEX_EFFORT).trim() || DEFAULT_CODEX_EFFORT;
      return { id, label, defaultEffort, efforts };
    })
    .filter(Boolean) as CodexModelOption[];

  if (!normalized.some((m) => m.id === DEFAULT_CODEX_MODEL)) {
    normalized.unshift(...DEFAULT_CODEX_MODEL_OPTIONS);
  }
  return normalized.length > 0 ? normalized : DEFAULT_CODEX_MODEL_OPTIONS;
};

export const normalizeCodexEfforts = (raw: unknown): string[] => {
  const efforts = Array.isArray(raw)
    ? raw.map((v) => String(v || '').trim()).filter((v, index, arr) => v && arr.indexOf(v) === index)
    : [];
  return efforts.length > 0 ? efforts : [...CODEX_EFFORT_LEVELS];
};
