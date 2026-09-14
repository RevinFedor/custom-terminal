'use strict';
const { claudeProviderFailureFromRecord } = require('../shared/claude-provider-failure.cjs');

function isResumeNoResponseRecord(record) {
  const content = record?.message?.content;
  return record?.message?.model === '<synthetic>' && Array.isArray(content)
    && content.length === 1 && content[0]?.type === 'text'
    && content[0].text?.trim() === 'No response requested.';
}

function latestClaudeCompletionFailure(turn, recordMap) {
  const uuids = turn?.completionAssistantUuids || turn?.assistantUuids || [];
  for (const uuid of [...uuids].reverse()) {
    const record = recordMap?.get?.(uuid);
    const failure = claudeProviderFailureFromRecord(record);
    if (failure) return failure;
    // Resume may append the synthetic "No response requested." bookkeeping
    // after a failed turn. It neither retries that turn nor makes it succeed.
    if (isResumeNoResponseRecord(record)) continue;
    if (record?.type === 'assistant') return null;
  }
  return null;
}

function collectAssistantText(turn, recordMap) {
  const blocks = [];
  for (const uuid of turn?.assistantUuids || []) {
    const record = recordMap?.get?.(uuid);
    if (record?.isApiErrorMessage === true || isResumeNoResponseRecord(record)) continue;
    const content = record?.message?.content;
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
  if (latestClaudeCompletionFailure(turn, recordMap)) return false;
  const completionUuids = Array.isArray(turn?.completionAssistantUuids)
    ? turn.completionAssistantUuids
    : (turn?.assistantUuids || []);
  for (const uuid of completionUuids) {
    const record = recordMap?.get?.(uuid);
    if (record?.isApiErrorMessage === true || isResumeNoResponseRecord(record)) continue;
    const stopReason = String(record?.message?.stop_reason || '').trim();
    if (stopReason && stopReason !== 'tool_use' && stopReason !== 'pause_turn') return true;
  }
  return false;
}

function materializeClaudeOrchestrationTurn(turn, recordMap, maxChars = 100_000) {
  const failure = latestClaudeCompletionFailure(turn, recordMap);
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
    ...(failure ? { terminalEvent: 'provider_error', terminalOutcomeReason: failure.code,
      hasFinalResult: false, proofDefinitive: true, errorCode: failure.code, error: failure.message } : {}),
  };
}

function collectClaudeOrchestrationExecutionTurns(
  turns,
  startTurnIndex,
  { resultBeforeAt = null } = {},
) {
  const rows = Array.isArray(turns) ? turns : [];
  if (!Number.isInteger(startTurnIndex) || startTurnIndex < 0 || startTurnIndex >= rows.length) {
    return {
      turns: [],
      startTurnIndex: null,
      endTurnIndex: null,
      boundaryReason: 'start-turn-unavailable',
    };
  }

  const upperBound = Number(resultBeforeAt) > 0 ? Number(resultBeforeAt) : 0;
  const executionTurns = [rows[startTurnIndex]];
  let endTurnIndex = startTurnIndex;
  let boundaryReason = 'end-of-transcript';

  for (let index = startTurnIndex + 1; index < rows.length; index += 1) {
    const candidate = rows[index];
    if (candidate?.kind !== 'queued_command') {
      boundaryReason = 'new-logical-turn';
      break;
    }
    if (upperBound) {
      const promptAt = Date.parse(candidate.userTimestamp || '');
      if (!Number.isFinite(promptAt) || promptAt > upperBound) {
        boundaryReason = 'completion-upper-bound';
        break;
      }
    }
    executionTurns.push(candidate);
    endTurnIndex = index;
  }

  return {
    turns: executionTurns,
    startTurnIndex,
    endTurnIndex,
    boundaryReason,
  };
}

function materializeClaudeOrchestrationExecution({
  turns,
  startTurnIndex,
  recordMap,
  resultBeforeAt = null,
  maxChars = 100_000,
}) {
  const execution = collectClaudeOrchestrationExecutionTurns(
    turns,
    startTurnIndex,
    { resultBeforeAt },
  );
  if (execution.turns.length === 0) {
    return {
      complete: false,
      assistantText: '',
      assistantChars: 0,
      truncated: false,
      assistantBlockCount: 0,
      internalContinuationCount: 0,
      queuedContinuationCount: 0,
      ...execution,
    };
  }

  const latestTurn = execution.turns.at(-1);
  const mergedTurn = {
    assistantUuids: execution.turns.flatMap((turn) => turn?.assistantUuids || []),
    // A completion before a later queued user message is not the completion of
    // the physical execution. Only the newest queued slice may close it.
    completionAssistantUuids: Array.isArray(latestTurn?.completionAssistantUuids)
      ? latestTurn.completionAssistantUuids
      : (latestTurn?.assistantUuids || []),
    internalContinuationCount: execution.turns.reduce(
      (total, turn) => total + Math.max(0, Number(turn?.internalContinuationCount) || 0),
      0,
    ),
  };
  return {
    ...materializeClaudeOrchestrationTurn(mergedTurn, recordMap, maxChars),
    queuedContinuationCount: Math.max(0, execution.turns.length - 1),
    startTurnIndex: execution.startTurnIndex,
    endTurnIndex: execution.endTurnIndex,
    boundaryReason: execution.boundaryReason,
  };
}

module.exports = {
  collectClaudeOrchestrationExecutionTurns,
  hasCompletionAfterLatestInternalContinuation,
  materializeClaudeOrchestrationExecution,
  materializeClaudeOrchestrationTurn,
};
