import React from 'react';
import { ClaudeSparkle } from './CopySessionButton';
import { DeepSeekIcon, ZenIcon } from '../icons/ProviderIcons';

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
    models: [
      { id: 'default', label: 'default', cmd: true },
      { id: 'sonnet', label: 'sonnet', cmd: true },
      { id: 'opus', label: 'opus', cmd: true },
      { id: 'haiku', label: 'haiku', cmd: true },
    ],
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

// SDK alias → real model id used by the SDK caps map.
export const SDK_ALIAS_TO_MODEL_ID: Record<string, string | null> = {
  default: null,
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
};

// Returns the set of effort levels the active SDK model accepts, or null when
// gating cannot be applied (default alias / caps unloaded / model not in caps).
export function getSupportedEffortsForAlias(
  alias: string | undefined,
  caps: Record<string, string[]>
): Set<string> | null {
  const modelId = SDK_ALIAS_TO_MODEL_ID[alias || 'default'];
  if (!modelId) return null;
  const list = caps[modelId];
  if (!Array.isArray(list) || list.length === 0) return null;
  return new Set(list);
}
