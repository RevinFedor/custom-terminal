export function isHistoryTaskBackgroundLive({
  subagentStatus,
  actionProcessGeneration,
  currentProcessGeneration,
  agentProcessAlive,
  inLastTurn,
  isTurnBusy,
  hasResult,
}) {
  // Codex subagents are process-scoped. A durable `running` record is not a
  // lease on every future Codex process which happens to reuse the tab.
  if (subagentStatus) {
    return subagentStatus === 'running'
      && agentProcessAlive === true
      && !!actionProcessGeneration
      && actionProcessGeneration === currentProcessGeneration;
  }

  // Claude Task cards remain turn-scoped: an unfinished card is live only in
  // the currently busy last turn.
  return inLastTurn === true && isTurnBusy === true && hasResult !== true;
}
