'use strict';

function classifyTerminalPasteProfile(input = {}) {
  if (input.submit !== true || input.liveClaude !== true) {
    return { allowed: true, profile: 'raw-or-non-claude' };
  }
  const safe = input.fast === false
    && input.verifyClaudeVisibleDraftBeforePaste === true
    && input.awaitClaudeUserMessageAudit === true
    && typeof input.handoffId === 'string'
    && input.handoffId.trim().length > 0
    && typeof input.source === 'string'
    && input.source.trim().length > 0;
  if (safe) return { allowed: true, profile: 'claude-semantic-send' };
  return {
    allowed: false,
    profile: 'ambiguous-claude-submit',
    error: 'claude_semantic_submit_required',
  };
}

module.exports = { classifyTerminalPasteProfile };

