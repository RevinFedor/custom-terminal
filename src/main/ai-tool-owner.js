'use strict';

const AI_TOOL_TYPES = new Set(['claude', 'codex', 'gemini']);

function resolveAiToolOwner({
  runtimeOwners = [],
  claudeSessionId = null,
  codexSessionId = null,
  fallback = null,
  storedCommandType = null,
} = {}) {
  const live = [...new Set((Array.isArray(runtimeOwners) ? runtimeOwners : [])
    .filter((owner) => AI_TOOL_TYPES.has(owner)))];
  if (live.length === 1) return live[0];
  if (live.length > 1) return null;

  const hasClaude = !!claudeSessionId;
  const hasCodex = !!codexSessionId;
  if (hasClaude !== hasCodex) return hasClaude ? 'claude' : 'codex';
  if (hasClaude && hasCodex) return null;

  if (AI_TOOL_TYPES.has(fallback)) return fallback;
  return AI_TOOL_TYPES.has(storedCommandType) ? storedCommandType : null;
}

module.exports = { resolveAiToolOwner };
