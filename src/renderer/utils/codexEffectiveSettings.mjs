import nativePickerProof from '../../shared/codex-native-picker-proof.cjs';

export const { stripCodexTerminalControls, isCodexSettingsPickerVisible,
  parseCodexModelChangeAcknowledgement } = nativePickerProof;
const CODEX_WRITER_DEPENDENT_PICKER_SOURCES = new Set(['model', 'effort', 'quick']);

export function hasCodexNextLaunchSettingsIntent({
  model,
  effort,
  proofAt,
  proofSessionId,
  modelMigrationPending = false,
} = {}) {
  const cleanModel = typeof model === 'string' ? model.trim() : '';
  const cleanEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  const owner = typeof proofSessionId === 'string' ? proofSessionId.trim() : '';
  return modelMigrationPending !== true
    && !!cleanModel
    && !!cleanEffort
    && cleanEffort !== 'ultra'
    && Number(proofAt || 0) > 0
    && !owner;
}

/**
 * A newly started Codex process consumes the selected tab/global fallback
 * settings. Continue and fork instead resolve settings from their source
 * rollout, so persisting their launch payload would briefly (and after a
 * crash, durably) claim settings which the new writer has not proved.
 */
export function planCodexLaunchSettingsPersistence({
  command,
  result,
  payload,
} = {}) {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  const isFreshLaunch = normalizedCommand === 'codex'
    || (normalizedCommand === 'codex-c' && payload?.materializedFresh === true);
  const wasAccepted = result?.success !== false && result?.accepted !== false;
  if (!isFreshLaunch || !wasAccepted) return null;

  const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
  const effort = typeof payload?.effort === 'string' ? payload.effort.trim() : '';
  const patch = {
    ...(model ? { codexModel: model } : {}),
    ...(effort ? { codexEffort: effort } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

export function planCodexSettingsControlAvailability({
  isCodex,
  isCommandRunning: _isCommandRunning,
  effectiveSettingsKnown: _effectiveSettingsKnown,
} = {}) {
  if (!isCodex) {
    return {
      modelMenuDisabled: false,
      partialSettingDisabled: false,
      explicitPairDisabled: false,
      quickDisabled: false,
    };
  }
  // Every Codex control writes a complete revisioned desired pair. A stopped
  // process, a starting launch and a ready composer without its first rollout
  // writer are all queueable states, not reasons to disable the UI. Main owns
  // when that latest intent may physically enter the native picker.
  return {
    modelMenuDisabled: false,
    partialSettingDisabled: false,
    explicitPairDisabled: false,
    quickDisabled: false,
  };
}

/**
 * Convert the exact launch-owned runtime proof into the transient tab overlay.
 * This is a level-triggered projection: callers may apply it on every presence
 * snapshot, so a tui-ready event emitted before renderer subscription cannot
 * leave Model/Effort disabled for the lifetime of the tab.
 */
export function projectCodexProvisionalSettingsOverlay(snapshot = {}) {
  snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const live = snapshot.liveSettings;
  if (snapshot.liveLifecycle === true && live?.source === 'committed-composer-footer'
    && live.ownerId && live.model && live.effort) {
    return { codexLiveModel: live.model, codexLiveEffort: live.effort,
      codexLiveSettingsSessionId: live.ownerId, codexLiveSettingsProofAt: live.proofAt };
  }
  const owner = String(snapshot?.codexProvisionalSettingsOwnerId || '').trim();
  const model = String(snapshot?.codexProvisionalModel || '').trim();
  const effort = String(snapshot?.codexProvisionalEffort || '').trim().toLowerCase();
  if (
    snapshot?.liveLifecycle !== true
    || snapshot?.provenWriterSessionId
    || !owner.startsWith('launch:')
    || !model
    || !effort
  ) {
    return null;
  }
  return {
    codexLiveModel: model,
    codexLiveEffort: effort,
    codexLiveSettingsSessionId: owner,
  };
}

/**
 * ControlBar always sends the native picker a model+effort pair, but its
 * one-knob actions still inherit the other value from renderer state. Quick
 * apply/restore also captures and later reuses the current writer's pair.
 * Those actions therefore need a writer CAS after the global picker queue;
 * only an explicitly selected model+effort pair is writer-independent.
 */
export function planCodexPickerWriterPrecondition({
  source,
  currentProofSessionId,
} = {}) {
  const requiresWriterCas = CODEX_WRITER_DEPENDENT_PICKER_SOURCES.has(source);
  const proofSessionId = typeof currentProofSessionId === 'string'
    ? (currentProofSessionId.trim() || null)
    : null;
  return {
    allowed: !requiresWriterCas || !!proofSessionId,
    expectedWriterSessionId: requiresWriterCas ? proofSessionId : null,
  };
}

/**
 * Ultra belongs to one live Codex conversation. Persistent model/effort are
 * only the fallback for a future process. A stale live pair stays in memory
 * for forensics, but is never displayed after the tab binds another writer.
 */
export function resolveCodexEffectiveSettings({
  codexSessionId,
  codexModel,
  codexEffort,
  codexLiveModel,
  codexLiveEffort,
  codexLiveSettingsSessionId,
} = {}) {
  const sessionId = typeof codexSessionId === 'string' ? codexSessionId.trim() : '';
  const liveOwner = typeof codexLiveSettingsSessionId === 'string'
    ? codexLiveSettingsSessionId.trim()
    : '';
  // A Resume/Fork keeps the saved source session visible until the first new
  // rollout user_message proves the child writer. The exact launch-generation
  // settings must still outrank that historical binding during this window.
  const launchOwned = /^launch:.+/.test(liveOwner);
  const liveOwned = (!!sessionId && liveOwner === sessionId) || launchOwned;
  return {
    model: liveOwned && codexLiveModel ? codexLiveModel : codexModel,
    effort: liveOwned && codexLiveEffort ? codexLiveEffort : codexEffort,
    liveOwned,
    source: launchOwned
      ? 'verified-launch-composer'
      : liveOwned
        ? 'live-conversation'
        : 'persistent-fallback',
  };
}

/**
 * Convert one proven native-picker result into two independent mutations:
 * durable fallback settings and the current conversation overlay.
 */
export function planCodexPickerStateApplication({
  result,
  requestedModel,
  requestedEffort,
  liveSessionId,
  currentPersistentModel,
  currentPersistentEffort,
} = {}) {
  const applicationMode = result?.applicationMode === 'conversation-only'
    ? 'conversation-only'
    : 'persistent-default';
  const model = String(result?.model || requestedModel || '').trim();
  const effort = result?.effortSkipped
    ? ''
    : String(result?.effort || requestedEffort || '').trim().toLowerCase();
  const provisionalOwner = String(result?.codexProvisionalSettingsOwnerId || '').trim();

  if (!model) {
    return { allowed: false, code: 'codex_picker_model_missing' };
  }

  if (applicationMode === 'conversation-only') {
    const owner = String(
      result?.codexSettingsProofSessionId
      || provisionalOwner
      || liveSessionId
      || '',
    ).trim();
    if (!owner) {
      return { allowed: false, code: 'codex_conversation_settings_owner_missing' };
    }
    if (!effort) {
      return { allowed: false, code: 'codex_conversation_effort_missing' };
    }
    const persistentModel = String(result?.persistentModel || '').trim();
    const persistentEffort = String(result?.persistentEffort || '').trim().toLowerCase();
    return {
      allowed: true,
      applicationMode,
      model,
      effort,
      persistentPatch: {
        ...(persistentModel ? { codexModel: persistentModel } : {}),
        ...(persistentEffort && persistentEffort !== 'ultra'
          ? { codexEffort: persistentEffort }
          : {}),
        ...(persistentModel || (persistentEffort && persistentEffort !== 'ultra')
          ? { codexSettingsProofSessionId: undefined }
          : {}),
      },
      livePatch: {
        codexLiveModel: model,
        codexLiveEffort: effort,
        codexLiveSettingsSessionId: owner,
        ...(Number(result?.proofAt) > 0 ? { codexLiveSettingsProofAt: Number(result.proofAt) } : {}),
      },
    };
  }

  if (effort === 'ultra') {
    return { allowed: false, code: 'codex_ultra_requires_live_conversation' };
  }
  const resolvedEffort = effort || currentPersistentEffort || '';
  return {
    allowed: true,
    applicationMode,
    model,
    effort: resolvedEffort,
    persistentPatch: {
      codexModel: model || currentPersistentModel,
      ...(effort ? { codexEffort: effort } : {}),
      codexSettingsProofSessionId: provisionalOwner
        ? undefined
        : result?.codexSettingsProofSessionId || undefined,
    },
    livePatch: provisionalOwner
      ? {
        codexLiveModel: model,
        codexLiveEffort: resolvedEffort,
        codexLiveSettingsSessionId: provisionalOwner,
        ...(Number(result?.proofAt) > 0 ? { codexLiveSettingsProofAt: Number(result.proofAt) } : {}),
      }
      : {
        codexLiveModel: undefined,
        codexLiveEffort: undefined,
        codexLiveSettingsSessionId: undefined,
      },
  };
}

/**
 * Full History emits slash rows from structured rollout settings records.
 * Reading the last exact /model and /effort rows therefore reuses the existing
 * JSONL parser instead of trying to infer state from visible prose.
 */
export function deriveCodexEffectiveSettingsFromHistory(entries) {
  let model = '';
  let effort = '';
  let proofAt = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.role !== 'slash') continue;
    const content = String(entry.content || '').trim();
    const modelMatch = content.match(/^\/model\s+([a-z0-9][a-z0-9_.-]*)$/i);
    if (modelMatch) {
      model = modelMatch[1];
      const timestamp = Date.parse(String(entry.timestamp || ''));
      if (Number.isFinite(timestamp)) proofAt = Math.max(proofAt, timestamp);
      continue;
    }
    const effortMatch = content.match(/^\/effort\s+(none|minimal|low|medium|high|xhigh|max|ultra)$/i);
    if (effortMatch) {
      effort = effortMatch[1].toLowerCase();
      const timestamp = Date.parse(String(entry.timestamp || ''));
      if (Number.isFinite(timestamp)) proofAt = Math.max(proofAt, timestamp);
    }
  }
  if (!model && !effort) return null;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    proofAt,
    proof: 'rollout-turn-context',
  };
}

/** A History read is an observation of the past, not a new settings action. */
export function isNewerCodexHistorySettingsProof({ currentTab, historySessionId, historyEffective } = {}) {
  if (!currentTab || !historySessionId || currentTab.codexSessionId !== historySessionId) return false;
  const historyAt = Number(historyEffective?.proofAt || 0);
  if (!(historyAt > 0)) return false;
  const persistentOwner = currentTab.codexSettingsProofSessionId;
  const persistentAt = !persistentOwner || persistentOwner === historySessionId
    ? Number(currentTab.codexSettingsProofAt || 0) : 0;
  const liveAt = currentTab.codexLiveSettingsSessionId === historySessionId
    || String(currentTab.codexLiveSettingsSessionId || '').startsWith('launch:')
    ? Number(currentTab.codexLiveSettingsProofAt || 0) : 0;
  return historyAt > Math.max(persistentAt, liveAt);
}

export function canApplyCodexConversationFallback(tab, liveProof) {
  return !!tab && !!liveProof?.codexLiveSettingsSessionId
    && tab.codexSessionId === liveProof.codexLiveSettingsSessionId
    && tab.codexLiveSettingsSessionId === liveProof.codexLiveSettingsSessionId
    && tab.codexLiveModel === liveProof.codexLiveModel
    && tab.codexLiveEffort === liveProof.codexLiveEffort
    && Number(tab.codexLiveSettingsProofAt || 0) === Number(liveProof.codexLiveSettingsProofAt || 0);
}

/**
 * A persisted live-picker/launch proof outranks older rollout context. History
 * may correct legacy unproven values, and a later turn_context may confirm or
 * advance them, but a cached refresh must never roll a just-applied picker
 * choice back to the previous turn.
 */
export function planCodexHistorySettingsProjection({
  currentModel,
  currentEffort,
  currentProofAt,
  currentProofSessionId,
  historySessionId,
  historyEffective,
} = {}) {
  if (!historyEffective) return null;
  // Ultra is a live-conversation fact. The HistoryPanel projects this case
  // through updateCodexLiveState with the exact JSONL/session owner instead.
  if (historyEffective.effort === 'ultra') return null;
  const historyProofAt = Number(historyEffective.proofAt) || 0;
  const storedProofAt = Number(currentProofAt) || 0;
  const sameOwner = !!historySessionId
    && String(currentProofSessionId || '') === String(historySessionId);
  const exactProofAwaitingFirstWriter = storedProofAt > 0 && !currentProofSessionId;
  if ((sameOwner || exactProofAwaitingFirstWriter) && historyProofAt <= storedProofAt) return null;
  return {
    codexModel: historyEffective.model || currentModel,
    codexEffort: historyEffective.effort || currentEffort,
    codexSettingsProofAt: historyProofAt,
    codexSettingsProofSessionId: historySessionId || undefined,
  };
}
