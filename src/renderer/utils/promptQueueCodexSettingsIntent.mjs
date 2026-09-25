export function classifyQueuedCodexSettingsIntent(
  state,
  { revision: expectedRevision, model, effort },
) {
  if (!state || typeof state !== 'object') return { kind: 'ignore' };
  const revision = Number(state.codexSettingsIntentRevision || 0);
  if (revision > expectedRevision) return { kind: 'replaced' };
  if (revision !== expectedRevision) return { kind: 'ignore' };

  const intentModel = String(state.codexSettingsIntentModel || '').trim();
  const intentEffort = String(state.codexSettingsIntentEffort || '').trim().toLowerCase();
  if (intentModel !== model || intentEffort !== effort) return { kind: 'different-pair' };

  const error = String(state.codexSettingsIntentError || '').trim();
  const applied = Number(state.codexSettingsIntentAppliedRevision || 0) === expectedRevision;
  if (!applied) return { kind: 'pending', error };
  return error ? { kind: 'failed', error } : { kind: 'applied' };
}
