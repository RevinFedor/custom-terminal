const intentKeys = ['codexSettingsIntentModel', 'codexSettingsIntentEffort', 'codexSettingsIntentRevision',
  'codexSettingsIntentAppliedRevision', 'codexSettingsIntentAppliedOwnerId', 'codexSettingsIntentControl', 'codexSettingsIntentError', 'codexSettingsIntentStateVersion'];

export function mergeTabProviderSnapshot(previous, tabId, next) {
  if (!next || typeof next !== 'object') return previous;
  if (previous?.tabId !== tabId) return { tabId, state: { ...next } };
  const old = previous.state;
  const state = { ...next };
  if (Number(old.codexFastIntentRevision || 0) > Number(next.codexFastIntentRevision || 0)) {
    state.codexFastIntent = old.codexFastIntent;
    state.codexFastIntentRevision = old.codexFastIntentRevision;
  }
  const oldRevision = Number(old.codexSettingsIntentRevision || 0);
  const revision = Number(next.codexSettingsIntentRevision || 0);
  if (oldRevision > revision || (oldRevision === revision
    && Number(old.codexSettingsIntentStateVersion || 0) > Number(next.codexSettingsIntentStateVersion || 0))) {
    for (const key of intentKeys) state[key] = old[key];
  } else if (oldRevision === revision
    && Number(old.codexSettingsIntentAppliedRevision || 0) > Number(next.codexSettingsIntentAppliedRevision || 0)) {
    state.codexSettingsIntentAppliedRevision = old.codexSettingsIntentAppliedRevision;
    state.codexSettingsIntentAppliedOwnerId = old.codexSettingsIntentAppliedOwnerId;
    state.codexSettingsIntentError = old.codexSettingsIntentError;
  }
  return { tabId, state };
}

export function codexSettingsIntentIsWaiting({ isCodex, isCommandRunning, providerState } = {}) {
  const revision = Number(providerState?.codexSettingsIntentRevision || 0);
  return !!isCodex && !!isCommandRunning && revision > 0
    && revision !== Number(providerState?.codexSettingsIntentAppliedRevision || 0)
    && !providerState?.codexSettingsIntentError;
}

export function settingsPresentation({ localBusy, localTarget, activity, intentWaiting, intentTarget } = {}) {
  const busy = !!localBusy || activity?.busy === true || !!intentWaiting;
  return { busy, target: localBusy ? localTarget : activity?.busy ? activity.target : intentWaiting ? intentTarget || 'model' : null };
}
