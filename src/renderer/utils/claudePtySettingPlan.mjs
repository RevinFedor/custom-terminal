function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isExactConfirmedSetting({
  kind,
  requested,
  confirmed,
  currentSessionId,
}) {
  const value = clean(requested);
  const sessionId = clean(currentSessionId);
  if (!value || !sessionId || confirmed?.success !== true) return false;
  if (clean(confirmed.sessionId) !== sessionId) return false;
  if (clean(confirmed.latestSessionId) !== sessionId) return false;
  if (clean(confirmed[kind]) !== value) return false;
  return Number(confirmed[kind + 'ProofAt']) > 0;
}

export function planClaudePtySettings({
  requestedModel,
  requestedEffort,
  confirmed,
  currentSessionId,
} = {}) {
  const model = clean(requestedModel);
  const effort = clean(requestedEffort);
  const wantsModel = !!model && model !== 'none';
  const wantsEffort = !!effort && effort !== 'none';
  return {
    model,
    effort,
    applyModel: wantsModel && !isExactConfirmedSetting({
      kind: 'model',
      requested: model,
      confirmed,
      currentSessionId,
    }),
    applyEffort: wantsEffort && !isExactConfirmedSetting({
      kind: 'effort',
      requested: effort,
      confirmed,
      currentSessionId,
    }),
  };
}
