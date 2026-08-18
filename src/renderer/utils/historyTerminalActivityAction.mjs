/**
 * The terminal activity control has one semantic axis: act on the agent.
 * Copying diagnostics is deliberately not a primary action — it belongs to
 * the context menu. A transient/unknown state therefore stays pending instead
 * of silently changing what an ordinary click means.
 */
export function resolveHistoryTerminalActivityAction({
  canInterruptTurn = false,
  canStopProcess = false,
  canStartOrResume = false,
} = {}) {
  if (canInterruptTurn || canStopProcess) return 'stop';
  if (canStartOrResume) return 'start';
  return 'pending';
}
