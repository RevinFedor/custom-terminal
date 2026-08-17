const PTY_AGENT_COMMAND_TYPES = new Set(['claude', 'codex']);

const hasSessionBinding = (sessionId) => (
  typeof sessionId === 'string' ? sessionId.length > 0 : sessionId != null
);

/**
 * Resolve which PTY agent owns a tab without trusting a stale command label over
 * the only concrete session binding.
 *
 * A single session binding is authoritative. Two bindings are an unresolved
 * conflict. Only a fresh tab with no bindings may use its explicit
 * Claude/Codex command type as launch intent.
 */
export function resolvePtyAgentOwner({
  commandType = null,
  claudeSessionId = null,
  codexSessionId = null,
} = {}) {
  const hasClaudeSession = hasSessionBinding(claudeSessionId);
  const hasCodexSession = hasSessionBinding(codexSessionId);

  if (hasClaudeSession !== hasCodexSession) {
    return hasClaudeSession ? 'claude' : 'codex';
  }

  // Two bindings are corruption/unfinished handoff, not permission to trust a
  // mutable label. Destructive callers must ask main for live runtime proof.
  if (hasClaudeSession && hasCodexSession) return null;

  return PTY_AGENT_COMMAND_TYPES.has(commandType) ? commandType : null;
}

/**
 * Terminal screen text may be interpreted as a shell command only when no
 * foreground process owns input and xterm is not showing an alternate buffer.
 * A live TUI therefore always receives Enter transparently.
 */
export function shouldInterpretPtyScreenAsShellCommand({
  foregroundProcessAlive,
  bufferType = null,
} = {}) {
  return foregroundProcessAlive === false && bufferType !== 'alternate';
}
