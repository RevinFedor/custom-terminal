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
