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
  pendingApplication = false,
  valuesMatch = null,
} = {}) {
  // A saved next-launch choice is not applied to any running process yet,
  // even if it equals a historical value or no session ID exists at all.
  const pending = normalized(pendingValue);
  const hasPending = !!pending && pending !== 'none';
  if (pendingApplication && hasPending) return true;
  if (!sessionBound) return false;
  if (!normalized(confirmedValue)) return true;
  if (!hasPending) return false;
  if (typeof valuesMatch === 'boolean') return !valuesMatch;
  return normalized(confirmedValue) !== pending;
}

export function resolveVisibleClaudeModelId({
  value = null,
  models = [],
  configuredFallback = null,
} = {}) {
  const rows = Array.isArray(models) ? models : [];
  const requested = normalized(value);
  const nonDefault = rows.filter((model) => normalized(model?.id) !== 'default');
  const exact = nonDefault.find((model) => {
    const id = normalized(model?.id);
    const label = normalized(model?.label);
    return !!requested && ((id && requested.includes(id)) || (label && requested.includes(label)));
  });
  if (exact?.id) return exact.id;

  const fallback = normalized(configuredFallback);
  if (fallback && fallback !== 'none' && fallback !== 'default') {
    const configured = nonDefault.find((model) => normalized(model?.id) === fallback);
    if (configured?.id) return configured.id;
  }
  const visible = nonDefault.find((model) => model?.visible !== false);
  if (visible?.id) return visible.id;
  if (nonDefault[0]?.id) return nonDefault[0].id;

  const defaultRow = rows.find((model) => normalized(model?.id) === 'default');
  return defaultRow?.visible !== false ? (defaultRow?.id || '') : '';
}
