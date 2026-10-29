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

module.exports = { normalizeAgentLocalCommand, isLocalSlashCommandPrompt };
