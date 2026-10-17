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

// Main owns this data. Keep only a revision-ordered renderer projection so a
// synchronous Fork click can capture the same choice as its ControlBar. This
// neither persists provider settings nor emits a second workspace publication.
export function projectTabProviderSnapshot(openProjects, tabId, next) {
  let target;
  for (const workspace of openProjects.values()) {
    const tab = workspace.tabs.get(tabId);
    if (tab) { if (target) return false; target = tab; }
  }
  if (!target || !next || typeof next !== 'object') return false;
  target.providerState = mergeTabProviderSnapshot({ tabId, state: target.providerState || {} }, tabId, next).state;
  return true;
}

export function codexSettingsIntentIsWaiting({ isCodex, isCommandRunning, providerState } = {}) {
  const revision = Number(providerState?.codexSettingsIntentRevision || 0);
  return !!isCodex && !!isCommandRunning && revision > 0
    && revision !== Number(providerState?.codexSettingsIntentAppliedRevision || 0)
    && !providerState?.codexSettingsIntentError;
}

// Desired choice is labelled pending by the existing spinner; it is not live
// application proof. A late source/composer observation cannot rename that
// choice while the same revision is still waiting for the native picker.
export function codexSettingsSelection({ isCommandRunning, providerState, effectiveSettings,
  persistentModel, persistentEffort } = {}) {
  const desired = !providerState?.codexSettingsIntentError
    && (!isCommandRunning || codexSettingsIntentIsWaiting({ isCodex: true, isCommandRunning, providerState }))
    && Number(providerState?.codexSettingsIntentRevision || 0) > 0
    && providerState?.codexSettingsIntentModel && providerState?.codexSettingsIntentEffort;
  return {
    model: desired ? providerState.codexSettingsIntentModel : effectiveSettings?.model || persistentModel,
    effort: desired ? providerState.codexSettingsIntentEffort : effectiveSettings?.effort || persistentEffort,
  };
}

export function settingsPresentation({ localBusy, localTarget, activity, intentWaiting, intentTarget } = {}) {
  const busy = !!localBusy || activity?.busy === true || !!intentWaiting;
  return { busy, target: localBusy ? localTarget : activity?.busy ? activity.target : intentWaiting ? intentTarget || 'model' : null };
}
