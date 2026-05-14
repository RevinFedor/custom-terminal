// Single source of truth for Claude TUI option lists that Anthropic ships and rev'es.
// Effort levels and model names change between Claude Code versions (May 2026:
// auto removed, xhigh added between high and max). Anything that hardcodes these
// strings must import from here so a future rev = one file edit.
//
// DeepSeek uses its own scale ('off' as off-state) — kept separate intentionally.

export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number];

// 'none' is our own UI sentinel meaning "don't auto-inject /effort at all".
// Stored in user prefs alongside real levels.
export const CLAUDE_EFFORT_LEVELS_WITH_NONE = ['none', ...CLAUDE_EFFORT_LEVELS] as const;
export type DefaultClaudeEffort = typeof CLAUDE_EFFORT_LEVELS_WITH_NONE[number];

// Neutral default selected by click-toggle-off (clicking an already-active pill).
// Used to be 'auto' before Claude removed it; now the lowest level acts as deselect.
// DeepSeek has its own 'off' state — handled separately in InfoPanel.
export const CLAUDE_EFFORT_TOGGLE_OFF: ClaudeEffortLevel = 'low';

// Short labels for narrow pill buttons (e.g. "medium" → "med" to fit 5-pill row).
export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffortLevel, string> = {
  low: 'low',
  medium: 'med',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

// DeepSeek's effort scale — distinct from Claude's because it includes an off-state.
// Proxy injects { thinking: { type: 'disabled' } } when 'off', or output_config.effort
// for the other three.
export const DEEPSEEK_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type DeepSeekEffortLevel = typeof DEEPSEEK_EFFORT_LEVELS[number];

// Claude model name list — same memoization concern, ships from Anthropic.
export const CLAUDE_MODELS = ['default', 'sonnet', 'opus', 'haiku'] as const;
export type ClaudeModel = typeof CLAUDE_MODELS[number];
