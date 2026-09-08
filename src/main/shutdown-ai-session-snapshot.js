'use strict';

/**
 * Reduces causally-linked runtime identities to one exact auto-resume target.
 * Two providers or two session ids are ambiguity, never a best-effort choice.
 */
function resolveExactShutdownTarget(candidates = []) {
  const exact = new Map();
  for (const candidate of candidates || []) {
    const engine = candidate?.engine;
    const sessionId = String(candidate?.sessionId || '');
    if ((engine !== 'claude' && engine !== 'codex') || !sessionId) continue;
    exact.set(engine + ':' + sessionId, { engine, sessionId });
  }
  if (exact.size !== 1) {
    return { target: null, ambiguous: exact.size > 1, identities: [...exact.values()] };
  }
  return { target: [...exact.values()][0], ambiguous: false, identities: [...exact.values()] };
}

/**
 * A bridge-less process may reuse an accepted Claude Resume identity only when
 * every causal boundary still names the same terminal/generation/session.
 * Process liveness confirms this candidate; it never supplies the session id.
 */
function resolveAcceptedClaudeResumeShutdownTarget({
  provider,
  processFound,
  intentSessionId,
  intentFresh,
  intentTerminalMatches,
  launchMode,
  launchSessionId,
  generationMatches,
  runGenerationMatches,
  persistedSessionId,
} = {}) {
  const sessionId = String(intentSessionId || '');
  if (provider !== 'claude' || processFound !== true) return null;
  if (!sessionId || intentFresh !== true || intentTerminalMatches !== true) return null;
  if (launchMode !== 'resume' || String(launchSessionId || '') !== sessionId) return null;
  if (generationMatches !== true || runGenerationMatches !== true) return null;
  if (String(persistedSessionId || '') !== sessionId) return null;
  return { engine: 'claude', sessionId };
}

/**
 * A shutdown recovery permission is not writer authority. An untouched Resume
 * may restart its exact process-open source, but only the full idle read lease
 * can prove that no unresolved first submit may already own a different child.
 */
function resolveCodexShutdownTarget({
  inspection,
  writerSessionId = null,
  readIdentity = null,
  allowIdleResume = false,
  exactCandidates = [],
} = {}) {
  let candidate = null;
  let source = null;
  if (inspection?.status === 'adopted'
    && writerSessionId
    && writerSessionId === inspection.sessionId) {
    candidate = { engine: 'codex', sessionId: writerSessionId };
    source = 'writer-reconciled';
  } else if (inspection?.status === 'provisional-source'
    && allowIdleResume === true
    && readIdentity?.available === true
    && readIdentity.source === 'resume-source'
    && readIdentity.reason === 'exact-idle-resume-source'
    && readIdentity.mutationSafe === false
    && readIdentity.sessionId === inspection.sessionId) {
    candidate = { engine: 'codex', sessionId: readIdentity.sessionId };
    source = 'accepted-idle-resume-source';
  }
  if (!candidate) {
    return { target: null, reason: readIdentity?.reason || inspection?.status || 'writer-unresolved' };
  }
  const resolved = resolveExactShutdownTarget([...exactCandidates, candidate]);
  return resolved.target
    ? { target: resolved.target, source, reason: source }
    : { target: null, reason: 'exact-identity-conflict' };
}

function isCodexShutdownScopeCurrent(expected, current) {
  if (!expected?.terminalToken || !expected.projectId || !expected.lifecycleGeneration
    || !Number.isInteger(expected.runSeq) || expected.runSeq <= 0) return false;
  return [
    'terminalToken', 'projectId', 'runSeq', 'lifecycleGeneration', 'launchId',
    'inputRevision', 'writerObservationGeneration', 'exitObserverGeneration',
  ].every((key) => expected[key] === current?.[key]);
}

/**
 * One canonical writer observation, bounded by the remaining shared shutdown
 * budget. A deadline is only failure evidence; a late observation cannot edit
 * the caller's frozen target set or authorize the weaker source fallback.
 */
async function reconcileCodexShutdownTarget({
  processFound = false,
  isCurrent,
  reconcileWriter,
  readCurrentEvidence,
  timeoutMs = 0,
} = {}) {
  if (processFound !== true) return { target: null, reason: 'process-not-found' };
  if (!isCurrent()) return { target: null, reason: 'shutdown-generation-changed' };
  if (!(timeoutMs > 0)) return { target: null, reason: 'shutdown-proof-budget-exhausted' };
  let deadline;
  try {
    const inspection = await Promise.race([
      Promise.resolve().then(reconcileWriter),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ status: 'shutdown-proof-timeout' }), timeoutMs);
      }),
    ]);
    if (!isCurrent()) return { target: null, reason: 'shutdown-generation-changed' };
    if (inspection?.status !== 'adopted' && inspection?.status !== 'provisional-source') {
      return { target: null, reason: inspection?.status || 'writer-unresolved', error: inspection?.error || null };
    }
    return resolveCodexShutdownTarget({ inspection, ...readCurrentEvidence(inspection) });
  } catch (error) {
    return { target: null, reason: 'shutdown-proof-failed', error: error?.message || String(error) };
  } finally {
    clearTimeout(deadline);
  }
}

module.exports = {
  isCodexShutdownScopeCurrent,
  reconcileCodexShutdownTarget,
  resolveAcceptedClaudeResumeShutdownTarget,
  resolveCodexShutdownTarget,
  resolveExactShutdownTarget,
};
