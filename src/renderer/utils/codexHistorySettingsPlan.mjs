const normalizeRequestedSetting = (value) => {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized !== 'none' ? normalized : '';
};

const normalizeCurrentSetting = (value) => normalizeRequestedSetting(value);

const normalizeSessionId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export function resolveCodexSettingsRuntimeProof(runtimeSnapshot) {
  const liveLifecycle = runtimeSnapshot?.liveLifecycle;
  const runtimeState = liveLifecycle === true
    ? 'live'
    : liveLifecycle === false
      ? 'stopped'
      : 'unknown';
  const activeWriterSessionId = runtimeSnapshot?.writerConfirmed === true
    ? normalizeSessionId(runtimeSnapshot?.provenWriterSessionId)
    : '';
  const provisionalOwner = normalizeSessionId(
    runtimeSnapshot?.codexProvisionalSettingsOwnerId,
  );
  const provisionalModel = normalizeCurrentSetting(
    runtimeSnapshot?.codexProvisionalModel,
  );
  const provisionalEffort = normalizeCurrentSetting(
    runtimeSnapshot?.codexProvisionalEffort,
  );
  const provisionalSettingsProven = runtimeState === 'live'
    && !activeWriterSessionId
    && provisionalOwner.startsWith('launch:')
    && !!provisionalModel
    && !!provisionalEffort;
  return {
    runtimeState,
    activeWriterSessionId,
    currentSettingsOwnerId: activeWriterSessionId
      || (provisionalSettingsProven ? provisionalOwner : ''),
    currentSettingsModel: provisionalSettingsProven ? provisionalModel : '',
    currentSettingsEffort: provisionalSettingsProven ? provisionalEffort : '',
    provisionalSettingsProven,
  };
}

export function codexSettingsProofMatchesActiveWriter({
  currentProofSessionId,
  runtimeSnapshot,
} = {}) {
  const { runtimeState, activeWriterSessionId } = resolveCodexSettingsRuntimeProof(runtimeSnapshot);
  return runtimeState === 'live'
    && !!activeWriterSessionId
    && normalizeSessionId(currentProofSessionId) === activeWriterSessionId;
}

/**
 * Before the first rollout user_message exists, a verified launch composer is
 * the exact settings owner for that PTY generation. It is not yet a writer
 * session, but it is sufficient to inherit the other half of a partial
 * model/effort request without falling back to stale renderer/global state.
 */
export function codexSettingsProofMatchesRuntimeOwner({
  currentProofSessionId,
  runtimeSnapshot,
} = {}) {
  const { runtimeState, currentSettingsOwnerId } = resolveCodexSettingsRuntimeProof(
    runtimeSnapshot,
  );
  return runtimeState === 'live'
    && !!currentSettingsOwnerId
    && normalizeSessionId(currentProofSessionId) === currentSettingsOwnerId;
}

export function isCompleteCodexSettingsRequest({
  requestedModel,
  requestedEffort,
} = {}) {
  return !!normalizeRequestedSetting(requestedModel)
    && !!normalizeRequestedSetting(requestedEffort);
}

/**
 * Resolve a partial Project API / History settings request into the complete
 * model+effort pair that the live Codex picker requires.
 *
 * Settings are never deferred with a busy prompt: applying them now and
 * queueing the text for later would make the queued prompt's runtime
 * configuration timing-dependent.
 */
export function planCodexHistorySettings({
  requestedModel,
  requestedEffort,
  currentModel,
  currentEffort,
  currentProofSessionId,
  runtimeSnapshot,
  statusAtSend,
  queue,
} = {}) {
  const modelRequested = normalizeRequestedSetting(requestedModel);
  const effortRequested = normalizeRequestedSetting(requestedEffort);
  const hasRequestedSettings = !!(modelRequested || effortRequested);
  const runtimeProof = resolveCodexSettingsRuntimeProof(runtimeSnapshot);
  const effectiveModel = runtimeProof.provisionalSettingsProven
    ? runtimeProof.currentSettingsModel
    : normalizeCurrentSetting(currentModel);
  const effectiveEffort = runtimeProof.provisionalSettingsProven
    ? runtimeProof.currentSettingsEffort
    : normalizeCurrentSetting(currentEffort);
  const willQueue = queue === true || statusAtSend === 'busy';
  const completeRequest = isCompleteCodexSettingsRequest({
    requestedModel,
    requestedEffort,
  });

  if (!hasRequestedSettings) {
    return {
      hasRequestedSettings: false,
      blocked: false,
      model: effectiveModel,
      effort: effectiveEffort,
    };
  }

  if (willQueue) {
    return {
      hasRequestedSettings: true,
      blocked: true,
      code: 'codex_settings_change_requires_idle',
      error: 'Codex model/effort cannot change while a turn is busy; prompt was not sent',
      model: modelRequested || effectiveModel,
      effort: effortRequested || effectiveEffort,
    };
  }

  if (!completeRequest) {
    const {
      runtimeState,
      activeWriterSessionId,
      currentSettingsOwnerId,
      provisionalSettingsProven,
    } = runtimeProof;
    const proofSessionId = normalizeSessionId(currentProofSessionId);
    const proofMatchesActiveWriter = codexSettingsProofMatchesActiveWriter({
      currentProofSessionId: proofSessionId,
      runtimeSnapshot,
    });
    const proofMatchesProvisionalLaunch = provisionalSettingsProven
      && currentSettingsOwnerId.startsWith('launch:');
    if (
      runtimeState !== 'stopped'
      && !proofMatchesActiveWriter
      && !proofMatchesProvisionalLaunch
    ) {
      const proofReason = runtimeState !== 'live'
        ? 'runtime-owner-unknown'
        : !activeWriterSessionId
          ? 'active-writer-unconfirmed'
          : 'settings-proof-owner-mismatch';
      return {
        hasRequestedSettings: true,
        blocked: true,
        code: 'codex_current_settings_unproven',
        error: 'Current Codex model/effort is not proven for the active conversation; send both model and effort',
        proofReason,
        model: modelRequested || effectiveModel,
        effort: effortRequested || effectiveEffort,
      };
    }
  }

  const model = modelRequested || effectiveModel;
  const effort = effortRequested || effectiveEffort;
  if (!model) {
    return {
      hasRequestedSettings: true,
      blocked: true,
      code: 'codex_current_model_unknown',
      error: 'Current Codex model is unknown; prompt was not sent',
      model,
      effort,
    };
  }
  if (!effort) {
    return {
      hasRequestedSettings: true,
      blocked: true,
      code: 'codex_current_effort_unknown',
      error: 'Current Codex effort is unknown; prompt was not sent',
      model,
      effort,
    };
  }

  return {
    hasRequestedSettings: true,
    blocked: false,
    model,
    effort,
  };
}
