const CODEX_EFFORT_VALUES = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const CODEX_PICKER_FOOTER_RE = /Press enter to confirm or esc to go back/i;
const CODEX_PICKER_HEADER_RE = /(?:Select Model and Effort|Select Model(?!\s+and\s+Effort)|Select Reasoning Level|Advanced Reasoning|Apply reasoning change)/i;
const CODEX_CLIPPED_MODEL_PICKER_RE = /\[…\s*\d+\s+lines?\]\s*ctrl\s*\+\s*a\s+view all/i;
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
  const isFreshLaunch = typeof command === 'string' && command.trim() === 'codex';
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
  isCommandRunning,
  effectiveSettingsKnown,
} = {}) {
  if (!isCodex) {
    return {
      modelMenuDisabled: false,
      partialSettingDisabled: false,
      explicitPairDisabled: false,
      quickDisabled: false,
    };
  }
  const processUnavailable = isCommandRunning !== true;
  if (processUnavailable) {
    // With no live writer, every action is a durable next-launch choice. It
    // must not require ownership proof from the stopped source conversation.
    return {
      modelMenuDisabled: false,
      partialSettingDisabled: false,
      explicitPairDisabled: false,
      quickDisabled: false,
    };
  }
  const partialSettingDisabled = effectiveSettingsKnown !== true;
  return {
    // Recovery path: the model catalog remains reachable while Codex is live
    // so the user can choose an explicit model+effort pair without inheriting
    // stale renderer state.
    modelMenuDisabled: false,
    partialSettingDisabled,
    explicitPairDisabled: false,
    quickDisabled: partialSettingDisabled,
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
 * This is intentionally a narrow terminal-control stripper, not a generic
 * "make terminal text readable" heuristic. It only exists so an exact Codex
 * acknowledgement can survive ANSI sequences split across PTY chunks.
 */
export function stripCodexTerminalControls(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[(\d*)C/g, (_match, count) => (
      ' '.repeat(Math.min(512, Math.max(1, Number(count) || 1)))
    ))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * A native picker confirmation is user-owned only when Enter was pressed while
 * an actual Codex model/effort picker was visible. Numbered confirmations share
 * the footer, so a clipped header is accepted only with Codex's exact
 * "ctrl + a view all" model-list hint.
 */
export function isCodexSettingsPickerVisible(visibleText) {
  const clean = stripCodexTerminalControls(visibleText);
  if (!CODEX_PICKER_FOOTER_RE.test(clean)) return false;
  return CODEX_PICKER_HEADER_RE.test(clean) || CODEX_CLIPPED_MODEL_PICKER_RE.test(clean);
}

/**
 * Parse the latest exact acknowledgement produced by Codex after a native
 * model picker confirmation. Callers must independently prove that this output
 * follows a user Enter on the picker; the sentence alone can occur in ordinary
 * assistant text and is therefore not sufficient ownership proof.
 */
export function parseCodexModelChangeAcknowledgement(output) {
  const clean = stripCodexTerminalControls(output).replace(/\u00a0/g, ' ');
  const pattern = /(?:^|\n)\s*•\s*Model\s+changed\s+to\s+([a-z0-9][a-z0-9_.-]*)(?:\s+(none|minimal|low|medium|high|xhigh|max|ultra))?(\s+for\s+this\s+conversation)?(?=\s|[.!]|$)/gi;
  let latest = null;

  for (const match of clean.matchAll(pattern)) {
    const model = String(match[1] || '').trim();
    const effort = String(match[2] || '').trim().toLowerCase();
    const conversationOnly = !!match[3];
    if (!model) continue;
    // Codex 0.145's Ultra contract is conversation-only. An old or unrelated
    // "model ... ultra" sentence without that suffix is not application proof.
    if (effort === 'ultra' && !conversationOnly) continue;
    if (effort && !CODEX_EFFORT_VALUES.has(effort)) continue;
    latest = {
      model,
      ...(effort ? { effort } : {}),
      applicationMode: conversationOnly ? 'conversation-only' : 'persistent-default',
      proof: conversationOnly ? 'tui-conversation-ack' : 'tui-model-ack',
    };
  }

  return latest;
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
      }
      : {
        codexLiveModel: undefined,
        codexLiveEffort: undefined,
        codexLiveSettingsSessionId: undefined,
      },
  };
}

/**
 * Full History emits slash rows only from rollout `turn_context` records.
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
