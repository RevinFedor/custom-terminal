'use strict';

function persistCodexWriterBinding({
  projectId,
  tabId,
  sessionId,
  readBinding,
  writeBinding,
} = {}) {
  if (!projectId) return { success: false, error: 'codex_tab_project_unresolved', retryable: true };
  if (!tabId || !sessionId) return { success: false, error: 'codex_writer_identity_invalid', retryable: false };
  if (typeof readBinding !== 'function' || typeof writeBinding !== 'function') {
    return { success: false, error: 'scoped_codex_persistence_unavailable', retryable: true };
  }

  try {
    const currentSessionId = readBinding(projectId, tabId);
    if (currentSessionId === undefined) {
      return { success: false, error: 'codex_tab_row_missing', retryable: true };
    }
    if (currentSessionId === sessionId) {
      return { success: true, updated: false, currentSessionId };
    }
    const updated = writeBinding(projectId, tabId, sessionId);
    if (updated !== true) {
      return { success: false, error: 'codex_writer_binding_not_committed', retryable: true };
    }
    return { success: true, updated: true, currentSessionId };
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
      retryable: true,
    };
  }
}

/**
 * Process ownership and durable tab ownership are different proofs.
 *
 * A manually typed shell command has no app-owned launch intent.  When the
 * tab already points at another stopped conversation, merely finding a
 * writable rollout is therefore not permission to replace that binding.  A
 * same-session writer and a direct child of the bound session are safe; an
 * exact app launch is also explicit user intent.  Every other manual writer
 * stays live but quarantined until a post-observation user_message proves the
 * user actually started working in it.
 */
function classifyCodexWriterBindingAdmission({
  persistedSessionId = null,
  candidateSessionId = null,
  candidateForkedFromId = null,
  explicitLaunchGenerationCurrent = false,
} = {}) {
  const persisted = String(persistedSessionId || '').trim() || null;
  const candidate = String(candidateSessionId || '').trim() || null;
  const parent = String(candidateForkedFromId || '').trim() || null;

  if (!candidate) {
    return { allowed: false, status: 'unknown', reason: 'candidate-session-missing' };
  }
  if (!persisted) {
    return { allowed: true, status: 'commit', reason: 'tab-binding-empty' };
  }
  if (candidate === persisted) {
    return { allowed: true, status: 'commit', reason: 'same-session' };
  }
  if (explicitLaunchGenerationCurrent === true) {
    return { allowed: true, status: 'commit', reason: 'explicit-launch-generation' };
  }
  if (parent === persisted) {
    return { allowed: true, status: 'commit', reason: 'direct-child-of-bound-session' };
  }
  return {
    allowed: false,
    status: 'await-user-message',
    reason: 'manual-writer-unrelated-to-bound-session',
    persistedSessionId: persisted,
    candidateSessionId: candidate,
  };
}

function classifyCodexManualBindingPromotion({
  sameTerminal = false,
  sameRunSeq = false,
  sameWriter = false,
  recordByteOffset = null,
  observationByteOffset = null,
  persistedBindingMatches = false,
} = {}) {
  if (sameTerminal !== true) return { allowed: false, reason: 'terminal-generation-changed' };
  if (sameRunSeq !== true) return { allowed: false, reason: 'command-generation-changed' };
  if (sameWriter !== true) return { allowed: false, reason: 'writer-changed' };
  const recordOffset = Number(recordByteOffset);
  const boundary = Number(observationByteOffset);
  if (!Number.isFinite(recordOffset) || !Number.isFinite(boundary) || recordOffset < boundary) {
    return { allowed: false, reason: 'user-message-precedes-observation' };
  }
  if (persistedBindingMatches !== true) {
    return { allowed: false, reason: 'persisted-binding-changed' };
  }
  return { allowed: true, reason: 'exact-post-observation-user-message' };
}

/**
 * Resolve the generation that owns a native Rewind action.
 *
 * A confirmed writer can legitimately outlive the launch observer that first
 * discovered it.  Once that transient launch proof is gone, the exact live
 * terminal lifecycle + command run remains the authoritative generation.  A
 * renderer-provided launch id is deliberately not accepted here: destructive
 * authority must be minted from main-owned state only.
 *
 * Provisional Resume callers must not use the live-run fallback. They still
 * require the exact launch-scoped source lease before the first action.
 */
function resolveCodexNativeRewindActionGeneration({
  writerActionGeneration = null,
  writerLaunchId = null,
  lifecycleGeneration = null,
  runSeq = null,
  allowLiveRunFallback = false,
} = {}) {
  const explicit = String(writerActionGeneration || writerLaunchId || '').trim();
  if (explicit) return explicit;
  const lifecycle = String(lifecycleGeneration || '').trim();
  const run = Number(runSeq);
  if (allowLiveRunFallback !== true
    || !lifecycle
    || !Number.isInteger(run)
    || run <= 0) {
    return null;
  }
  return 'live-run:' + lifecycle + ':run:' + run;
}

/**
 * Choose the transcript that a native Rewind is operating on without
 * conflating it with the tab's durable binding.
 *
 * A normal proven writer is both the runtime source and the durable owner. A
 * quarantined manual writer is different: the TUI is operating on the manual
 * candidate, while SQLite must remain on the previously saved conversation
 * until the exact Rewind child is proven. The caller supplies the generation
 * checks because terminal tokens are process-local objects.
 */
function classifyCodexNativeRewindSource({
  persistedSessionId = null,
  provenWriterSessionId = null,
  quarantinedCandidateSessionId = null,
  quarantinedPersistedSessionId = null,
  quarantinedSameTerminal = false,
  quarantinedSameRunSeq = false,
  quarantinedSameWriter = false,
} = {}) {
  const persisted = String(persistedSessionId || '').trim() || null;
  const proven = String(provenWriterSessionId || '').trim() || null;
  const candidate = String(quarantinedCandidateSessionId || '').trim() || null;
  const conflictBinding = String(quarantinedPersistedSessionId || '').trim() || null;

  // A newly observed exact manual writer wins over a stale proof left by the
  // previous shell command.  This does not publish the manual writer: it only
  // identifies which live TUI the native Rewind action is operating on.
  if (candidate || conflictBinding) {
    if (!candidate || !conflictBinding) {
      return { allowed: false, reason: 'quarantined-rewind-context-incomplete' };
    }
    if (persisted !== conflictBinding) {
      return { allowed: false, reason: 'persisted-binding-changed' };
    }
    if (quarantinedSameTerminal !== true) {
      return { allowed: false, reason: 'terminal-generation-changed' };
    }
    if (quarantinedSameRunSeq !== true) {
      return { allowed: false, reason: 'command-generation-changed' };
    }
    if (quarantinedSameWriter !== true) {
      return { allowed: false, reason: 'quarantined-writer-changed' };
    }
    return {
      allowed: true,
      mode: 'quarantined-manual-writer',
      runtimeSourceSessionId: candidate,
      expectedPersistedSessionId: conflictBinding,
    };
  }

  if (proven) {
    if (!persisted || persisted !== proven) {
      return { allowed: false, reason: 'proven-writer-binding-mismatch' };
    }
    return {
      allowed: true,
      mode: 'confirmed-writer',
      runtimeSourceSessionId: proven,
      expectedPersistedSessionId: persisted,
    };
  }

  return { allowed: false, reason: 'rewind-runtime-source-unproven' };
}

/**
 * Final policy gate immediately before a native-Rewind binding commit.
 * Lineage/action proof is produced by the writer resolver; this helper adds
 * the exact PTY generation and durable-binding checks. It deliberately allows
 * A -> C2 when the runtime source is quarantined C1, but never A -> C1 merely
 * because C1 stayed open or rolled back in place.
 */
function classifyCodexNativeRewindBindingCommit({
  runtimeSourceSessionId = null,
  expectedPersistedSessionId = null,
  candidateSessionId = null,
  currentPersistedSessionId = null,
  lineageRelation = null,
  exactActionProof = false,
  sameTerminal = false,
  sameRunSeq = false,
} = {}) {
  const source = String(runtimeSourceSessionId || '').trim() || null;
  const expected = String(expectedPersistedSessionId || '').trim() || null;
  const candidate = String(candidateSessionId || '').trim() || null;
  const current = String(currentPersistedSessionId || '').trim() || null;
  if (!source || !expected || !candidate) {
    return { allowed: false, reason: 'rewind-binding-context-missing' };
  }
  if (exactActionProof !== true) {
    return { allowed: false, reason: 'exact-rewind-action-proof-missing' };
  }
  if (sameTerminal !== true) {
    return { allowed: false, reason: 'terminal-generation-changed' };
  }
  if (sameRunSeq !== true) {
    return { allowed: false, reason: 'command-generation-changed' };
  }
  if (current !== expected && current !== candidate) {
    return { allowed: false, reason: 'persisted-binding-changed' };
  }

  if (candidate === source) {
    if (source !== expected) {
      return { allowed: false, reason: 'quarantined-stable-source-not-publishable' };
    }
    if (lineageRelation !== 'stable-source') {
      return { allowed: false, reason: 'stable-source-proof-missing' };
    }
    return { allowed: true, mode: 'stable-source', reason: 'exact-stable-source' };
  }

  if (lineageRelation !== 'direct-child'
    && lineageRelation !== 'descendant'
    && lineageRelation !== 'rewind-replacement') {
    return { allowed: false, reason: 'runtime-source-lineage-unproven' };
  }
  return {
    allowed: true,
    mode: lineageRelation === 'rewind-replacement'
      ? (source === expected ? 'bound-source-replacement' : 'quarantined-source-replacement')
      : (source === expected ? 'bound-source-child' : 'quarantined-source-child'),
    reason: lineageRelation === 'rewind-replacement'
      ? 'exact-runtime-source-replacement'
      : 'exact-runtime-source-child',
  };
}

module.exports = {
  classifyCodexManualBindingPromotion,
  classifyCodexNativeRewindBindingCommit,
  classifyCodexNativeRewindSource,
  classifyCodexWriterBindingAdmission,
  persistCodexWriterBinding,
  resolveCodexNativeRewindActionGeneration,
};
