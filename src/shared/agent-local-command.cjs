'use strict';

// One lexical contract for the composer, deferred context and delivery audit.
// A leading slash alone is not a command: /Users/... and multiline prompts
// are ordinary messages and must retain their attachments and audit observer.
function normalizeAgentLocalCommand(rawPrompt) {
  if (typeof rawPrompt !== 'string') return null;
  const normalized = rawPrompt.trim();
  if (!normalized || normalized.includes('\n') || normalized.includes('\r')) return null;
  return /^\/[^\s/]+(?:[ \t].*)?$/.test(normalized) ? normalized : null;
}

function isLocalSlashCommandPrompt(rawPrompt) {
  return normalizeAgentLocalCommand(rawPrompt) !== null;
}

// Desktop /compact can enter the existing application FIFO. Its native
// executor/causal task-start proof remain distinct from an ordinary user Send.
// Other slash commands and external callers keep their existing contract.
function isDesktopCodexCompactQueueRequest(request) {
  const provider = request?.toolType || request?.provider;
  if (provider !== 'codex' || request?.source !== 'history-panel'
    || request?.recordWithoutReply === true
    || normalizeAgentLocalCommand(request?.prompt) !== '/compact') return false;
  if (request.provider && request.toolType && request.provider !== request.toolType) return false;
  const presentation = request.presentationSnapshot;
  if (presentation != null && (typeof presentation !== 'object' || Array.isArray(presentation))) return false;
  const transport = presentation?.authoringTransport;
  if (transport != null && (typeof transport !== 'object' || Array.isArray(transport))) return false;
  const authoring = request.authoringSnapshot;
  if (authoring != null && (typeof authoring !== 'object' || Array.isArray(authoring))) return false;
  // The public typed-authoring envelope is not this desktop command DTO.
  // Its parts must not be silently discarded to acquire the private route.
  if (request.authoring != null) return false;
  for (const values of [presentation?.imagePaths, presentation?.promptChips,
    transport?.imageRanges, transport?.fileRanges, authoring?.chips, authoring?.imagePaths]) {
    if (values != null && (!Array.isArray(values) || values.length !== 0)) return false;
  }
  return true;
}

module.exports = { normalizeAgentLocalCommand, isLocalSlashCommandPrompt, isDesktopCodexCompactQueueRequest };
