const ACTIVE_AGENT_STATUSES = new Set(['active', 'busy', 'starting', 'stopping']);

export function planWorkingDirectoryChange({
  toolType = null,
  sessionId = null,
  presenceStatus = 'inactive',
  conversationMaterialized = false,
} = {}) {
  const supportedTool = toolType === 'claude' || toolType === 'codex';
  const hasLiveProcess = supportedTool && ACTIVE_AGENT_STATUSES.has(presenceStatus);
  const hasResumableConversation = supportedTool
    && !!sessionId
    && conversationMaterialized === true;

  return {
    supportedTool,
    waitForTurn: hasLiveProcess && presenceStatus === 'busy',
    stopProcess: hasLiveProcess,
    restartMode: hasResumableConversation
      ? 'fork'
      : hasLiveProcess
        ? 'fresh'
        : 'none',
    requiresConfirmation: hasLiveProcess || !!sessionId,
  };
}

export function directoryChangeEventNames(toolType) {
  return toolType === 'codex'
    ? ['codex:busy-state', 'terminal:command-finished']
    : toolType === 'claude'
      ? ['claude:busy-state', 'claude:turn-state', 'terminal:command-finished']
      : ['terminal:command-finished'];
}
