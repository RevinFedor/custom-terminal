'use strict';

/**
 * Remove every re-queryable AskUserQuestion marker owned by a Claude PTY.
 *
 * The process-exit path must clear both maps together. Clearing only the busy
 * flag lets a later History refresh fetch the old question from main and
 * resurrect an interactive picker for a process that no longer exists.
 */
function clearClaudeQuestionStateOnProcessExit({
  tabId,
  awaitingByTab,
  pendingQuestionByTab,
} = {}) {
  if (!tabId) {
    return {
      changed: false,
      wasAwaiting: false,
      hadAwaitingState: false,
      hadPendingQuestion: false,
    };
  }
  if (!(awaitingByTab instanceof Map) || !(pendingQuestionByTab instanceof Map)) {
    throw new TypeError('Claude question lifecycle requires Map state');
  }

  const wasAwaiting = awaitingByTab.get(tabId) === true;
  const hadAwaitingState = awaitingByTab.delete(tabId);
  const hadPendingQuestion = pendingQuestionByTab.delete(tabId);

  return {
    changed: hadAwaitingState || hadPendingQuestion,
    wasAwaiting,
    hadAwaitingState,
    hadPendingQuestion,
  };
}

module.exports = {
  clearClaudeQuestionStateOnProcessExit,
};
