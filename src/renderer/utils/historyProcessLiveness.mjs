const ALIVE_AGENT_PROCESS_STATUSES = new Set(['active', 'busy', 'starting']);

/**
 * Presence is three-valued.  `unknown` means the lookup has not established a
 * new fact, so it keeps the last answer for this tab.  Every other status is a
 * claim and may replace the prior answer.
 */
export function foldHistoryAgentProcessLiveness(status, previous = false) {
  if (status === 'unknown') return previous === true;
  return ALIVE_AGENT_PROCESS_STATUSES.has(status);
}

/**
 * A durable Monitor/background-Bash card is history, not a live-process
 * authority. Only the main-owned snapshot for this exact tab/session/process
 * generation may put the task in the live strip; a terminal tombstone or a
 * dead host process always wins.
 */
export function isHistoryBackgroundTaskLive({
  processAlive,
  exactActive,
  terminal = false,
} = {}) {
  return processAlive === true && exactActive === true && terminal !== true;
}
