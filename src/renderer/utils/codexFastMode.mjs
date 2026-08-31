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
  desiredFast,
} = {}) {
  const current = typeof currentSessionId === 'string' ? currentSessionId.trim() : '';
  const owner = typeof serviceTierSessionId === 'string' ? serviceTierSessionId.trim() : '';
  const normalizedTier = normalizeCodexServiceTier(serviceTier);
  const desiredKnown = typeof desiredFast === 'boolean';
  const liveKnown = !!current && owner === current && !!normalizedTier;
  const liveActive = liveKnown && normalizedTier === 'priority';

  if (desiredKnown) {
    return {
      known: liveKnown,
      active: desiredFast,
      state: desiredFast ? 'on' : 'off',
      serviceTier: liveKnown ? normalizedTier : null,
      intentKnown: true,
      desiredFast,
      pending: !liveKnown || liveActive !== desiredFast,
    };
  }

  if (!liveKnown) {
    return {
      known: false,
      active: false,
      state: 'unknown',
      serviceTier: null,
    };
  }

  const active = liveActive;
  return {
    known: true,
    active,
    state: active ? 'on' : 'off',
    serviceTier: normalizedTier,
  };
}
