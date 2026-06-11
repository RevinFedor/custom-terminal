import React from 'react';
import { ClaudeSparkle } from './CopySessionButton';
import { DeepSeekIcon, ZenIcon } from '../icons/ProviderIcons';
import { DEFAULT_CLAUDE_CODE_MODELS } from '../../constants/claudeLevels';

export type ProviderId = 'anthropic' | 'zen' | 'deepseek';

export interface ProviderEntry {
  id: ProviderId;
  label: string;
  title: string;
  tint: string;
  Icon: React.FC<{ size?: number; color?: string }>;
  models: { id: string; label: string; cmd?: boolean }[];
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    title: 'Anthropic subscription (direct)',
    tint: '#DA7756',
    Icon: ClaudeSparkle,
    models: DEFAULT_CLAUDE_CODE_MODELS.filter((m) => !m.id.startsWith('claude-fable-5')),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    title: 'DeepSeek (Anthropic-compatible at /anthropic)',
    tint: '#4D6BFE',
    Icon: DeepSeekIcon,
    models: [
      { id: 'deepseek-v4-flash', label: 'V4F' },
      { id: 'deepseek-v4-pro[1m]', label: 'V4P' },
    ],
  },
  {
    id: 'zen',
    label: 'Zen',
    title: 'OpenCode Zen (Anthropic-compatible)',
    tint: '#a78bfa',
    Icon: ZenIcon,
    models: [
      { id: 'minimax-m2.5', label: 'MM2.5' },
      { id: 'minimax-m2.7', label: 'MM2.7' },
    ],
  },
];

// Our UI alias → the KEY used in the SDK caps map. The caps map is built from
// `supportedModels()`, whose `value` field is the selectable alias the binary
// ships — verified live as: default / sonnet / sonnet[1m] / haiku / opus[1m]
// (NO bare 'opus', NO full ids). So the effort-gating lookup must use those
// exact alias keys, not full model ids — a full id misses the map entirely and
// gating silently falls through. Our 'opus' selection maps to 'opus[1m]'
// (Opus 4.8, 1M). 'default' returns null → no gating (binary picks the model).
export const SDK_ALIAS_TO_MODEL_ID: Record<string, string | null> = {
  default: null,
  sonnet: 'sonnet',
  opus: 'opus[1m]',
  haiku: 'haiku',
};

// Returns the set of effort levels the active SDK model accepts.
//   • null  → DON'T gate (caps not loaded yet, or 'default' alias where the
//             binary picks the model itself — we can't know its efforts).
//   • Set   → gate to exactly these. An EMPTY set is meaningful: the model
//             supports NO effort at all (e.g. Haiku) → the UI hides the whole
//             effort cluster. Distinguishing empty-set from null is the whole
//             point: caps[haiku] = [] (loaded, zero efforts) must NOT read as
//             "don't gate / show everything" (the prior bug).
export function getSupportedEffortsForAlias(
  alias: string | undefined,
  caps: Record<string, string[]>
): Set<string> | null {
  const modelId = SDK_ALIAS_TO_MODEL_ID[alias || 'default'];
  if (!modelId) return null;                 // default alias → no gating
  const list = caps[modelId];
  if (!Array.isArray(list)) return null;     // model not in caps yet → no gating
  return new Set(list);                      // includes the empty-set case
}
