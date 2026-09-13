'use strict';

// A programmatic interrupt targets one live turn. Physical Escape still keeps
// its native editor/backtrack meaning; callers must not implement this action
// by pretending to be an unclassified physical key.
function createCodexTurnInterrupt({ getSnapshot, refreshReady, withWriteLock, writeEscape }) {
  const requested = new WeakMap();
  return async function interrupt(tabId) {
    const before = { ...getSnapshot(tabId) };
    if (!before?.terminal) return { success: false, interrupted: false, error: 'no_terminal' };
    if (before.busy !== true) {
      return { success: true, interrupted: false, skipped: 'idle-composer', reason: 'turn-already-idle' };
    }
    // Goal can begin a turn before the startup observer has recorded its first
    // composer. Reconcile the actual current screen/process, not a cached false
    // flag. This never grants permission by itself: all checks below still run.
    if (!before.inputReady && typeof refreshReady === 'function') await refreshReady(tabId);
    return withWriteLock(before.terminal, () => {
      const current = { ...getSnapshot(tabId) };
      if (current?.terminal !== before.terminal
        || current.runSeq !== before.runSeq
        || current.lifecycleGeneration !== before.lifecycleGeneration) {
        return { success: false, interrupted: false, error: 'codex_terminal_generation_changed' };
      }
      if (current.stopping || !current.inputReady) {
        return { success: false, interrupted: false, error: 'codex_input_not_ready' };
      }
      if (current.busy !== true) {
        return { success: true, interrupted: false, skipped: 'idle-composer', reason: 'turn-already-idle' };
      }
      if (!current.turnId) {
        return { success: false, interrupted: false, error: 'codex_turn_identity_pending' };
      }
      if (current.turnId !== before.turnId) {
        return { success: true, interrupted: false, skipped: 'target-turn-changed', reason: 'target-turn-finished' };
      }
      const prior = requested.get(current.terminal);
      if (prior?.terminal === current.terminal
        && prior.runSeq === current.runSeq
        && prior.lifecycleGeneration === current.lifecycleGeneration
        && prior.turnId === current.turnId) {
        return { success: true, interrupted: false, skipped: 'interrupt-already-requested', turnId: current.turnId };
      }
      writeEscape(tabId, current);
      requested.set(current.terminal, current);
      return { success: true, interrupted: true, interruptRequested: true, turnId: current.turnId };
    }, { kind: 'codex-turn-interrupt', source: 'codex-interrupt-turn', tabId });
  };
}

module.exports = { createCodexTurnInterrupt };
