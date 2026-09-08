function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isExactConfirmedSetting({ kind, requested, confirmed, currentSessionId }) {
  const value = clean(requested);
  const sessionId = clean(currentSessionId);
  if (!value || !sessionId || confirmed?.success !== true) return false;
  if (clean(confirmed.sessionId) !== sessionId) return false;
  if (clean(confirmed.latestSessionId) !== sessionId) return false;
  if (clean(confirmed[kind]) !== value) return false;
  if (kind === 'effort' && confirmed.effortCurrentRuntime !== true) return false;
  return Number(confirmed[kind + 'ProofAt']) > 0;
}

function planClaudePtySettings({ requestedModel, requestedEffort, confirmed, currentSessionId } = {}) {
  const model = clean(requestedModel);
  const effort = clean(requestedEffort);
  return {
    model,
    effort,
    applyModel: !!model && model !== 'none' && !isExactConfirmedSetting({
      kind: 'model', requested: model, confirmed, currentSessionId,
    }),
    applyEffort: !!effort && effort !== 'none' && !isExactConfirmedSetting({
      kind: 'effort', requested: effort, confirmed, currentSessionId,
    }),
  };
}

module.exports = { planClaudePtySettings };
