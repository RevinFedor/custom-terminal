import {
  isStandaloneAgentLocalCommand,
  normalizeAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from './agentLocalCommand.mjs';

export const normalizeCodexLocalSlashCommand = normalizeAgentLocalCommand;

export function isStandaloneCodexLocalSlashCommand({
  prompt,
  imageCount = 0,
  chipCount = 0,
} = {}) {
  return isStandaloneAgentLocalCommand({ prompt, imageCount, chipCount });
}

/**
 * Codex local slash commands are TUI actions, not conversation turns. Their
 * exact proof is: the specialized slash transaction observed the complete
 * command in the current composer frame and then wrote Enter. They must never
 * wait for an event_msg.user_message that Codex does not produce.
 */
export function projectCodexLocalSlashSendResult({
  candidate = false,
  result = null,
} = {}) {
  const projected = projectAgentLocalCommandSendResult({ candidate, result });
  if (projected.reason === 'agent-local-command-submitted') {
    return { ...projected, reason: 'codex-local-slash-submitted' };
  }
  if (projected.reason === 'agent-local-command-submit-outcome-unknown') {
    return { ...projected, reason: 'codex-local-slash-submit-outcome-unknown' };
  }
  return projected;
}
