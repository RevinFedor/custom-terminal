'use strict';

function collectAssistantText(turn, recordMap) {
  const blocks = [];
  for (const uuid of turn?.assistantUuids || []) {
    const content = recordMap?.get?.(uuid)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = part.text.trim();
        if (text) blocks.push(text);
      }
    }
  }
  return blocks;
}

function hasCompletionAfterLatestInternalContinuation(turn, recordMap) {
  const completionUuids = Array.isArray(turn?.completionAssistantUuids)
    ? turn.completionAssistantUuids
    : (turn?.assistantUuids || []);
  for (const uuid of completionUuids) {
    const stopReason = String(recordMap?.get?.(uuid)?.message?.stop_reason || '').trim();
    if (stopReason && stopReason !== 'tool_use' && stopReason !== 'pause_turn') return true;
  }
  return false;
}

function materializeClaudeOrchestrationTurn(turn, recordMap, maxChars = 100_000) {
  const blocks = collectAssistantText(turn, recordMap);
  const joined = blocks.join('\n\n');
  const limit = Math.max(500, Math.min(250_000, Number(maxChars) || 100_000));
  const truncated = joined.length > limit;
  const assistantText = !truncated
    ? joined
    : joined.slice(0, Math.floor(limit * 0.4)).trimEnd()
      + '\n…\n'
      + joined.slice(-(limit - Math.floor(limit * 0.4) - 3)).trimStart();
  return {
    complete: hasCompletionAfterLatestInternalContinuation(turn, recordMap),
    assistantText,
    assistantChars: joined.length,
    truncated,
    assistantBlockCount: blocks.length,
    internalContinuationCount: Number(turn?.internalContinuationCount || 0),
  };
}

module.exports = {
  hasCompletionAfterLatestInternalContinuation,
  materializeClaudeOrchestrationTurn,
};
