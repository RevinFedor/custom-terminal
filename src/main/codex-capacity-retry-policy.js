// Pure, serializable policy. The caller owns live-event admission, persistence,
// delivery and notification. A progress event means verified assistant output
// or a tool invocation, never a provider start/complete/user/service record.
const DEFAULT_CODEX_CAPACITY_RETRY_SETTINGS = Object.freeze({
  codexCapacityRetryEnabled: true,
  codexCapacityRetryLimit: 1,
  codexCapacityRetryDelaysMs: Object.freeze([]),
});

function normalizeCodexCapacityRetrySettings(value = {}) {
  const limit = Number(value?.codexCapacityRetryLimit);
  return {
    codexCapacityRetryEnabled: value?.codexCapacityRetryEnabled !== false,
    codexCapacityRetryLimit: Number.isFinite(limit)
      ? Math.max(1, Math.min(10, Math.trunc(limit)))
      : DEFAULT_CODEX_CAPACITY_RETRY_SETTINGS.codexCapacityRetryLimit,
    codexCapacityRetryDelaysMs: Array.isArray(value?.codexCapacityRetryDelaysMs)
      ? value.codexCapacityRetryDelaysMs.slice(0, 10)
        .filter(ms => typeof ms === 'number' && Number.isFinite(ms))
        .map(ms => Math.max(60_000, Math.min(7 * 24 * 3600_000, Math.round(ms / 60_000) * 60_000)))
      : [],
  };
}

function eventTime(value) {
  const at = typeof value === 'string' ? Date.parse(value) : value;
  return typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : null;
}

function createState(scopeKey, at = null) {
  return {
    version: 1,
    scopeKey,
    attempts: 0,
    resetAt: at,
    lastCapacityAt: null,
    lastProgressAt: null,
    lastProgressEventId: null,
    seenErrorIds: [],
    cancelled: false,
    exhausted: false,
    pendingEffectId: null,
  };
}

function effectFor(type, state, event) {
  // Length-safe JSON tuple keeps IDs deterministic and collision-free even
  // when a scope/error identifier itself contains punctuation or separators.
  const handoffId = `codex-capacity-retry:${JSON.stringify([state.scopeKey, event.errorId])}`;
  return {
    type,
    scopeKey: state.scopeKey,
    errorId: event.errorId,
    attempt: state.attempts,
    handoffId,
  };
}

function isAfter(at, boundary) {
  return boundary == null || at > boundary;
}

/**
 * Events:
 * - capacity { scopeKey, errorId, at }: a new, typed live capacity failure.
 * - progress { scopeKey, eventId, at }: verified, nonempty assistant/tool work.
 * - cancel { scopeKey }: stop/cancel/disable; invalidates outstanding effects.
 * - reset { scopeKey, at? }: explicit new source/run; old scopes cannot select
 *   themselves by sending a late capacity/progress event.
 *
 * Persist state before performing effect. Before delivery, re-read current
 * state/settings and call isCodexCapacityRetryEffectCurrent. Cancellation of
 * an already queued send belongs to the caller's common scenario layer.
 */
function reduceCodexCapacityRetry(previousState, event, settings = {}) {
  const unchanged = () => ({ state: previousState ?? null, effect: null });
  if (!event || typeof event.scopeKey !== 'string' || !event.scopeKey) return unchanged();
  if (event.type === 'reset') {
    return { state: createState(event.scopeKey, eventTime(event.at)), effect: null };
  }
  if (!['capacity', 'progress', 'cancel'].includes(event.type)) return unchanged();
  if (previousState && previousState.scopeKey !== event.scopeKey) return unchanged();
  const state = previousState || createState(event.scopeKey);

  if (event.type === 'cancel') {
    return { state: { ...state, cancelled: true, pendingEffectId: null }, effect: null };
  }
  if (state.cancelled) return unchanged();
  const at = eventTime(event.at);
  if (at == null || !isAfter(at, state.resetAt)) return unchanged();

  if (event.type === 'progress') {
    if (typeof event.eventId !== 'string' || !event.eventId
      || event.eventId === state.lastProgressEventId
      || !isAfter(at, state.lastCapacityAt)
      || !isAfter(at, state.lastProgressAt)) return unchanged();
    return {
      state: {
        ...state,
        attempts: 0,
        lastProgressAt: at,
        lastProgressEventId: event.eventId,
        exhausted: false,
        pendingEffectId: null,
      },
      effect: null,
    };
  }

  if (typeof event.errorId !== 'string' || !event.errorId
    || state.seenErrorIds.includes(event.errorId)
    || (state.lastCapacityAt != null && at < state.lastCapacityAt)
    || !isAfter(at, state.lastProgressAt)) return unchanged();

  const config = normalizeCodexCapacityRetrySettings(settings);
  if (!config.codexCapacityRetryEnabled) {
    return {
      state: {
        ...state,
        lastCapacityAt: at,
        seenErrorIds: [...state.seenErrorIds, event.errorId],
        pendingEffectId: null,
      },
      effect: null,
    };
  }
  const delayIndex = state.attempts - config.codexCapacityRetryLimit;
  const delayMs = delayIndex < 0 ? 0 : config.codexCapacityRetryDelaysMs[delayIndex];
  const canContinue = state.attempts < config.codexCapacityRetryLimit || Number.isFinite(delayMs);
  const next = {
    ...state,
    attempts: state.attempts + (canContinue ? 1 : 0),
    lastCapacityAt: at,
    seenErrorIds: [...state.seenErrorIds, event.errorId],
    exhausted: !canContinue,
    pendingEffectId: null,
  };
  // Once exhausted, notify only once until genuine work replenishes the
  // budget. Disabled recovery does not own or emit failure notifications.
  const effect = canContinue || !state.exhausted
    ? effectFor(canContinue ? 'continue' : 'exhausted', next, event)
    : null;
  if (effect?.type === 'continue' && delayMs > 0) {
    effect.delayMs = delayMs;
    effect.delayIndex = delayIndex;
  }
  next.pendingEffectId = effect?.handoffId
    || (!canContinue && state.exhausted ? state.pendingEffectId : null);
  return { state: next, effect };
}

function isCodexCapacityRetryEffectCurrent(state, effect, settings = {}) {
  const config = normalizeCodexCapacityRetrySettings(settings);
  if (!state || !effect || state.cancelled
    || !config.codexCapacityRetryEnabled
    || state.scopeKey !== effect.scopeKey
    || state.pendingEffectId !== effect.handoffId
    || state.attempts !== effect.attempt) return false;
  if (effect.type === 'exhausted') return state.exhausted;
  return effect.type === 'continue' && !state.exhausted
    && (effect.delayMs > 0
      ? effect.delayIndex === state.attempts - config.codexCapacityRetryLimit - 1
        && config.codexCapacityRetryDelaysMs[effect.delayIndex] === effect.delayMs
      : state.attempts <= config.codexCapacityRetryLimit);
}

module.exports = {
  DEFAULT_CODEX_CAPACITY_RETRY_SETTINGS,
  normalizeCodexCapacityRetrySettings,
  reduceCodexCapacityRetry,
  isCodexCapacityRetryEffectCurrent,
};
