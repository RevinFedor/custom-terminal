export function normalizeCodexServiceTier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'fast') return 'priority';
  return normalized === 'priority' || normalized === 'default'
    ? normalized
    : null;
}

export function resolveCodexFastModeState({
  currentSessionId,
  serviceTierSessionId,
  serviceTier,
} = {}) {
  const current = typeof currentSessionId === 'string' ? currentSessionId.trim() : '';
  const owner = typeof serviceTierSessionId === 'string' ? serviceTierSessionId.trim() : '';
  const normalizedTier = normalizeCodexServiceTier(serviceTier);

  if (!current || owner !== current || !normalizedTier) {
    return {
      known: false,
      active: false,
      state: 'unknown',
      serviceTier: null,
    };
  }

  const active = normalizedTier === 'priority';
  return {
    known: true,
    active,
    state: active ? 'on' : 'off',
    serviceTier: normalizedTier,
  };
}
