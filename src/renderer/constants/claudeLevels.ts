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
// auto-workflows" tooltip. Branch on this, don't hardcode. NOT gated by model
// (effort gating was reverted — real Claude Code offers every level to every
// model, incl. Haiku). SDK transport differs: ultracode → effort=xhigh +
// settings.ultracode (the --effort flag's enum rejects 'ultracode').
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
  id: string;
  label: string;
  cmd?: boolean;
}

export interface ClaudeCodeSettings {
  models: ClaudeCodeModelOption[];
  efforts: string[];
}

// Claude model name list — same memoization concern, ships from Anthropic.
export const DEFAULT_CLAUDE_CODE_MODELS: ClaudeCodeModelOption[] = [
  { id: 'default', label: 'default', cmd: true },
  { id: 'sonnet', label: 'sonnet', cmd: true },
  { id: 'opus', label: 'opus', cmd: true },
  { id: 'haiku', label: 'haiku', cmd: true },
  { id: 'claude-fable-5[1m]', label: 'fable', cmd: true },
];

export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  models: DEFAULT_CLAUDE_CODE_MODELS,
  efforts: [...CLAUDE_EFFORT_LEVELS],
};

export const CLAUDE_MODELS = DEFAULT_CLAUDE_CODE_MODELS.map((m) => m.id);
export type ClaudeModel = typeof CLAUDE_MODELS[number];

// 'none' is our app-level sentinel for "do not auto-apply /model on Claude
// startup". Real Claude Code accepts `/model default`, so "default" stays a
// normal selectable model, distinct from opt-out.
export type DefaultClaudeModel = string;
