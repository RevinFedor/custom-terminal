const crypto = require('crypto');

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

class TaskCompletionIntentRegistry {
  constructor(options = {}) {
    this.turns = new Map();
    this.nextGeneration = 0;
    this.now = options.now || Date.now;
    this.createId = options.createId || crypto.randomUUID;
  }

  beginTurn({
    tabId,
    provider,
    sessionId = null,
    turnId = null,
    processId = null,
    reuseExactTurn = false,
  }) {
    const normalizedTabId = normalize(tabId);
    const normalizedProvider = normalize(provider);
    const normalizedSessionId = normalize(sessionId) || null;
    const normalizedTurnId = normalize(turnId) || null;
    const normalizedProcessId = normalize(processId) || null;
    if (!normalizedTabId) throw new Error('tabId required');
    if (!normalizedProvider) throw new Error('provider required');

    const current = this.turns.get(normalizedTabId);
    if (reuseExactTurn
      && current?.active === true
      && current.provider === normalizedProvider
      && current.sessionId === normalizedSessionId
      && current.externalTurnId === normalizedTurnId
      && current.processId === normalizedProcessId) {
      return this.snapshot(current);
    }

    const state = {
      tabId: normalizedTabId,
      provider: normalizedProvider,
      sessionId: normalizedSessionId,
      externalTurnId: normalizedTurnId,
      processId: normalizedProcessId,
      generation: ++this.nextGeneration,
      active: true,
      startedAt: this.now(),
      intentId: null,
      intentRequestedAt: null,
    };
    this.turns.set(normalizedTabId, state);
    return this.snapshot(state);
  }

  requestCompletion({ tabId, sourceTabId = null }) {
    const normalizedTabId = normalize(tabId);
    const normalizedSourceTabId = normalize(sourceTabId) || normalizedTabId;
    if (!normalizedTabId) return { ok: false, code: 'tab_required' };
    if (normalizedSourceTabId !== normalizedTabId) {
      return { ok: false, code: 'source_tab_mismatch' };
    }

    const state = this.turns.get(normalizedTabId);
    if (!state?.active) return { ok: false, code: 'no_active_turn' };
    if (state.intentId) {
      return { ok: true, idempotent: true, turn: this.snapshot(state) };
    }

    state.intentId = this.createId();
    state.intentRequestedAt = this.now();
    return { ok: true, idempotent: false, turn: this.snapshot(state) };
  }

  finishTurn({
    tabId,
    provider = null,
    sessionId = null,
    turnId = null,
    processId = null,
    success = false,
  }) {
    const normalizedTabId = normalize(tabId);
    const state = this.turns.get(normalizedTabId);
    if (!state?.active) return { matched: false, explicitTaskComplete: false };

    const normalizedProvider = normalize(provider);
    const normalizedSessionId = normalize(sessionId);
    const normalizedTurnId = normalize(turnId);
    const normalizedProcessId = normalize(processId);
    if (normalizedProvider && state.provider !== normalizedProvider) {
      return { matched: false, explicitTaskComplete: false };
    }
    if (normalizedSessionId && state.sessionId && state.sessionId !== normalizedSessionId) {
      return { matched: false, explicitTaskComplete: false };
    }
    if (normalizedTurnId && state.externalTurnId && state.externalTurnId !== normalizedTurnId) {
      return { matched: false, explicitTaskComplete: false };
    }
    if (normalizedProcessId && state.processId && state.processId !== normalizedProcessId) {
      return { matched: false, explicitTaskComplete: false };
    }

    this.turns.delete(normalizedTabId);
    const explicitTaskComplete = success === true && !!state.intentId;
    return {
      matched: true,
      explicitTaskComplete,
      taskCompletionIntentId: explicitTaskComplete ? state.intentId : null,
      taskCompletionRequestedAt: explicitTaskComplete ? state.intentRequestedAt : null,
      turn: this.snapshot(state),
    };
  }

  abortTurn(tabId) {
    const normalizedTabId = normalize(tabId);
    const state = this.turns.get(normalizedTabId);
    if (!state) return false;
    this.turns.delete(normalizedTabId);
    return true;
  }

  getTurn(tabId) {
    const state = this.turns.get(normalize(tabId));
    return state ? this.snapshot(state) : null;
  }

  snapshot(state) {
    return {
      tabId: state.tabId,
      provider: state.provider,
      sessionId: state.sessionId,
      turnId: state.externalTurnId,
      ...(state.processId ? { processId: state.processId } : {}),
      generation: state.generation,
      active: state.active,
      startedAt: state.startedAt,
      intentId: state.intentId,
      intentRequestedAt: state.intentRequestedAt,
    };
  }
}

function findTaskCompletionBlockers(runs, tabId) {
  const normalizedTabId = normalize(tabId);
  if (!normalizedTabId) return [];
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run?.sourceTabId === normalizedTabId)
    .map((run) => ({
      runId: run.runId || null,
      status: run.status || 'unknown',
      targetTabId: run.targetTabId || null,
      notificationStatus: run.notificationStatus || null,
    }));
}

module.exports = {
  TaskCompletionIntentRegistry,
  findTaskCompletionBlockers,
};
