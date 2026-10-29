export function deriveCodexEffectiveSettingsFromHistory(entries: unknown): {
  model?: string;
  effort?: string;
  proofAt: number;
  proof: 'rollout-turn-context';
} | null;
