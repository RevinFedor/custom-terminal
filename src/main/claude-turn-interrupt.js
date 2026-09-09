'use strict';

// An API interrupt owns one already-running Claude turn (or an independently
// identified local command), not the tab's next recipient of a raw Escape.
// Keep physical keyboard handling independent.
function createClaudeTurnInterrupt({ getSnapshot, withWriteLock, writeEscape, now = Date.now, dedupMs = 700 }) {
  const requested = new WeakMap();
  const debounceMs = Number.isFinite(dedupMs) ? Math.max(0, dedupMs) : 700;
  const skipped = (reason, detail, turnId = null) => ({
    success: true,
    interrupted: false,
    interruptRequested: false,
    interruptConfirmed: false,
    status: 'skipped',
    skipped: reason,
    reason: detail,
    ...(turnId ? { turnId } : {}),
  });
  const refused = (error) => ({
    success: false,
    interrupted: false,
    interruptRequested: false,
    interruptConfirmed: false,
    status: 'rejected',
    error,
  });
  const sameProcess = (left, right) => left?.terminal === right?.terminal
    && left?.runSeq === right?.runSeq
    && left?.lifecycleGeneration === right?.lifecycleGeneration
    && left?.launchGeneration === right?.launchGeneration
    && left?.processId === right?.processId;

  return async function interrupt(tabId) {
    if (!tabId) return refused('tabId required');
    // Debounce explicit request times, as the old renderer did. Time spent
    // behind another PTY operation must not turn a double-click into a retry.
    const requestedAt = now();
    // Copy the values: snapshot providers may reuse a mutable state object.
    const before = { ...getSnapshot(tabId) };
    if (!before.terminal) return refused('no_terminal');
    if (before.stopping) return refused('claude_stopping');
    if (before.busy !== true) return skipped('idle-composer', 'turn-already-idle');
    if (!before.turnId) return refused('claude_turn_identity_pending');
    if (!Number.isInteger(before.runSeq) || before.runSeq <= 0 || !before.lifecycleGeneration) {
      return refused('claude_terminal_identity_pending');
    }

    return withWriteLock(before.terminal, () => {
      const current = { ...getSnapshot(tabId) };
      if (!sameProcess(current, before)) return refused('claude_terminal_generation_changed');
      if (current.stopping) return refused('claude_stopping');
      if (current.busy !== true) return skipped('idle-composer', 'turn-already-idle', before.turnId);
      if (!current.turnId) return refused('claude_turn_identity_pending');
      if (current.turnId !== before.turnId) {
        return skipped('target-turn-changed', 'target-turn-finished', before.turnId);
      }
      const previous = requested.get(current.terminal);
      const sincePrevious = requestedAt - previous?.requestedAt;
      if (sameProcess(previous, current) && previous.turnId === current.turnId
        && sincePrevious >= 0 && sincePrevious < debounceMs) {
        return skipped('interrupt-already-requested', 'interrupt-already-requested', current.turnId);
      }

      // The adapter performs the synchronous PTY write at this exact queue
      // boundary. Do not gate a proven busy turn on an idle-composer frame:
      // the first turn may legitimately start before that readiness edge.
      // Keep only the old 700ms double-click debounce, not a permanent per-turn
      // lock: Escape may merely close a modal or be ignored. A later explicit
      // request can retry after all the same current-owner checks above. Time
      // never proves a turn ended and never schedules another key itself.
      writeEscape(tabId, current);
      requested.set(current.terminal, { ...current, requestedAt });
      return {
        success: true,
        // Legacy API acknowledgement of request delivery, not turn completion.
        interrupted: true,
        interruptRequested: true,
        interruptConfirmed: false,
        status: 'requested',
        reason: 'interrupt-request-delivered',
        turnId: current.turnId,
      };
    }, { kind: 'claude-turn-interrupt', source: 'claude-interrupt-turn', tabId });
  };
}

module.exports = { createClaudeTurnInterrupt };
