/**
 * Convert one authoritative main-process batch snapshot into renderer busy
 * updates. A live busy/idle event that arrived after the request wins over the
 * snapshot: applying the older reply would otherwise resurrect or erase a
 * loader during renderer restore.
 */
export function collectAgentBusyHydration({ tabs = [], states = {}, eventObserved = new Set() } = {}) {
  const updates = [];
  for (const tab of tabs) {
    const tabId = typeof tab === 'string' ? tab : tab?.tabId;
    if (!tabId || eventObserved?.has?.(tabId)) continue;
    const state = states?.[tabId];
    if (!state) continue;

    if (
      state.resolvedToolType === 'claude'
      && typeof state.claudePresence?.isBusy === 'boolean'
    ) {
      updates.push({
        tabId,
        engine: 'claude',
        busy: state.claudePresence.isBusy,
        reason: state.claudePresence.isBusy
          ? 'renderer-restore:claude-turn'
          : 'renderer-restore:claude-idle',
      });
      continue;
    }

    const codexTurn = state.codexTurn;
    if (
      state.resolvedToolType === 'codex'
      && codexTurn?.hasWatcher === true
      && codexTurn?.catchUpPending !== true
    ) {
      updates.push({
        tabId,
        engine: 'codex',
        busy: codexTurn.busy === true,
        reason: codexTurn.busy === true
          ? 'task_started'
          : (codexTurn.outcomeKnown && codexTurn.lastOutcomeReason
            ? codexTurn.lastOutcomeReason
            : 'codex-outcome-unknown'),
      });
    }
  }
  return updates;
}

