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

module.exports = {
  resolveAcceptedClaudeResumeShutdownTarget,
  resolveExactShutdownTarget,
};
