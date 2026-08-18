export function selectSessionOwnedSettings({
  sessionId = null,
  stateOwnerSessionId = null,
  stateModel = null,
  stateEffort = undefined,
  seed = null,
} = {}) {
  const current = String(sessionId || '').trim();
  if (!current) {
    return { model: null, effort: undefined, source: 'none', proven: false };
  }
  if (String(stateOwnerSessionId || '').trim() === current) {
    return {
      model: stateModel || null,
      effort: stateEffort || undefined,
      source: 'state',
      proven: !!stateModel || !!stateEffort,
    };
  }
  if (seed) {
    return {
      model: seed.model || null,
      effort: seed.effort || undefined,
      source: 'seed',
      proven: !!seed.model || !!seed.effort,
    };
  }
  return { model: null, effort: undefined, source: 'unknown', proven: false };
}

const normalized = (value) => String(value || '').trim().toLowerCase();

export function settingProofNeedsAttention({
  sessionBound = false,
  confirmedValue = null,
  pendingValue = null,
  valuesMatch = null,
} = {}) {
  if (!sessionBound) return false;
  if (!normalized(confirmedValue)) return true;
  if (!normalized(pendingValue)) return false;
  if (typeof valuesMatch === 'boolean') return !valuesMatch;
  return normalized(confirmedValue) !== normalized(pendingValue);
}

