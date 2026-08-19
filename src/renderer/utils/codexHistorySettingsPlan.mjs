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

/**
 * History has two different operations that used to share the same loose
 * model/effort fields:
 *
 * - a normal prompt, where the control bar / launch path already owns settings;
 * - record-without-reply, which stops and resumes the writer and therefore must
 *   carry the exact pair across that lifecycle boundary.
 *
 * Ambient values shown by the control bar are never a per-prompt settings
 * request. Keeping this projection explicit prevents a busy prompt from being
 * rejected as if the user had asked to reopen the model picker.
 */
export function resolveCodexHistoryRestartSettingsState({
  recordWithoutReply,
  mutationProof,
  launchSettings,
} = {}) {
  if (recordWithoutReply !== true) return null;
  const proofModel = normalizeRequestedSetting(mutationProof?.model);
  const proofEffort = normalizeRequestedSetting(mutationProof?.effort);
  const exactProofAvailable = !!proofModel
    && !!proofEffort
    && !!normalizeSessionId(mutationProof?.sessionId)
    && Number.isFinite(Number(mutationProof?.proofAt))
    && Number(mutationProof.proofAt) > 0;
  const model = exactProofAvailable
    ? proofModel
    : normalizeRequestedSetting(launchSettings?.model);
  const effort = exactProofAvailable
    ? proofEffort
    : normalizeRequestedSetting(launchSettings?.effort);
  if (!model || !effort) {
    return {
      source: 'unavailable',
      reason: launchSettings?.modelMigrationPending === true
        ? 'model-migration-pending'
        : 'pair-missing',
    };
  }
  return {
    source: exactProofAvailable && proofEffort !== 'ultra'
      ? 'exact-session-proof'
      : exactProofAvailable
        ? 'unavailable'
        : 'launch-intent',
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(exactProofAvailable && proofEffort !== 'ultra' ? {
      ownerKind: 'writer',
      ownerId: normalizeSessionId(mutationProof.sessionId),
      proofAt: Number(mutationProof.proofAt),
    } : exactProofAvailable ? {
      reason: 'live-proof-required',
    } : {
      ...(launchSettings?.modelSource ? { modelSource: launchSettings.modelSource } : {}),
      ...(launchSettings?.effortSource ? { effortSource: launchSettings.effortSource } : {}),
    }),
  };
}

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
  const confirmedSettingsOwner = normalizeSessionId(
    runtimeSnapshot?.codexCurrentSettingsOwnerId,
  );
  const confirmedSettingsModel = normalizeCurrentSetting(
    runtimeSnapshot?.codexCurrentModel,
  );
  const confirmedSettingsEffort = normalizeCurrentSetting(
    runtimeSnapshot?.codexCurrentEffort,
  );
  const confirmedSettingsProofAt = Number(runtimeSnapshot?.codexCurrentSettingsProofAt || 0);
  const confirmedWriterSettingsProven = runtimeState === 'live'
    && !!activeWriterSessionId
    && confirmedSettingsOwner === activeWriterSessionId
    && !!confirmedSettingsModel
    && !!confirmedSettingsEffort;
  const provisionalOwner = normalizeSessionId(
    runtimeSnapshot?.codexProvisionalSettingsOwnerId,
  );
  const provisionalModel = normalizeCurrentSetting(
    runtimeSnapshot?.codexProvisionalModel,
  );
  const provisionalEffort = normalizeCurrentSetting(
    runtimeSnapshot?.codexProvisionalEffort,
  );
  const provisionalSettingsProofAt = Number(
    runtimeSnapshot?.codexProvisionalSettingsProofAt || 0,
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
      ? (confirmedWriterSettingsProven ? activeWriterSessionId : '')
      : (provisionalSettingsProven ? provisionalOwner : ''),
    currentSettingsModel: confirmedWriterSettingsProven
      ? confirmedSettingsModel
      : (provisionalSettingsProven ? provisionalModel : ''),
    currentSettingsEffort: confirmedWriterSettingsProven
      ? confirmedSettingsEffort
      : (provisionalSettingsProven ? provisionalEffort : ''),
    currentSettingsProofAt: confirmedWriterSettingsProven
      ? confirmedSettingsProofAt
      : (provisionalSettingsProven ? provisionalSettingsProofAt : 0),
    currentSettingsOwnerKind: confirmedWriterSettingsProven
      ? 'writer'
      : (provisionalSettingsProven ? 'launch' : ''),
    confirmedWriterSettingsProven,
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
  const effectiveModel = runtimeProof.currentSettingsOwnerId
    ? runtimeProof.currentSettingsModel
    : normalizeCurrentSetting(currentModel);
  const effectiveEffort = runtimeProof.currentSettingsOwnerId
    ? runtimeProof.currentSettingsEffort
    : normalizeCurrentSetting(currentEffort);
  const willQueue = queue === true || statusAtSend === 'busy';
  const completeRequest = isCompleteCodexSettingsRequest({
    requestedModel,
    requestedEffort,
  });
  const requestedSettingsAlreadyApplied = hasRequestedSettings
    && !!runtimeProof.currentSettingsOwnerId
    && (!modelRequested || modelRequested === effectiveModel)
    && (!effortRequested || effortRequested === effectiveEffort);

  if (!hasRequestedSettings) {
    return {
      hasRequestedSettings: false,
      blocked: false,
      model: effectiveModel,
      effort: effectiveEffort,
    };
  }

  if (willQueue) {
    if (requestedSettingsAlreadyApplied) {
      return {
        hasRequestedSettings: false,
        settingsAlreadyApplied: true,
        blocked: false,
        model: effectiveModel,
        effort: effectiveEffort,
      };
    }
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
