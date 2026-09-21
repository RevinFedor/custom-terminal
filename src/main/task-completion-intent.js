const crypto = require('crypto');
const { isPromptLoopAutomationSource } = require('./prompt-queue-source');
const { hasTaskCompletionProtocol } = require('../shared/task-completion-protocol.cjs');

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProcessId(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  return normalize(value);
}

function loopTaskCompletionEligibility({ source, prompt } = {}) {
  const text = typeof prompt === 'string' ? prompt : '';
  const eligible = isPromptLoopAutomationSource(source)
    && hasTaskCompletionProtocol(text);
  return {
    eligible,
    source: eligible ? 'prompt-loop' : null,
  };
}

function sameTurnIdentity(state, {
  provider = null,
  sessionId = null,
  turnId = null,
  processId = null,
} = {}) {
  const normalizedProvider = normalize(provider);
  const normalizedSessionId = normalize(sessionId);
  const normalizedTurnId = normalize(turnId);
  const normalizedProcessId = normalizeProcessId(processId);
  if (normalizedProvider && state.provider !== normalizedProvider) return false;
  if (normalizedSessionId && state.sessionId && state.sessionId !== normalizedSessionId) return false;
  if (normalizedTurnId && state.externalTurnId && state.externalTurnId !== normalizedTurnId) return false;
  if (normalizedProcessId && state.processId && state.processId !== normalizedProcessId) return false;
  return true;
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
    providerPromptId = null,
    reuseExactTurn = false,
    completionEligible = false,
    completionSource = null,
  }) {
    const normalizedTabId = normalize(tabId);
    const normalizedProvider = normalize(provider);
    const normalizedSessionId = normalize(sessionId) || null;
    const normalizedTurnId = normalize(turnId) || null;
    const normalizedProcessId = normalizeProcessId(processId) || null;
    if (!normalizedTabId) throw new Error('tabId required');
    if (!normalizedProvider) throw new Error('provider required');

    const current = this.turns.get(normalizedTabId);
    if (reuseExactTurn
      && current?.active === true
      && current.provider === normalizedProvider
      && current.sessionId === normalizedSessionId
      && current.externalTurnId === normalizedTurnId
      && current.processId === normalizedProcessId) {
      if (completionEligible === true) {
        current.completionEligible = true;
        current.completionSource = normalize(completionSource) || 'prompt-loop';
      }
      return this.snapshot(current);
    }

    const state = {
      tabId: normalizedTabId,
      provider: normalizedProvider,
      sessionId: normalizedSessionId,
      externalTurnId: normalizedTurnId,
      processId: normalizedProcessId,
      providerPromptId: normalize(providerPromptId) || null,
      generation: ++this.nextGeneration,
      active: true,
      startedAt: this.now(),
      intentId: null,
      intentRequestedAt: null,
      completionEligible: completionEligible === true,
      completionSource: completionEligible === true
        ? (normalize(completionSource) || 'prompt-loop')
        : null,
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
    if (state.completionEligible !== true) {
      return { ok: false, code: 'completion_protocol_not_active' };
    }
    if (state.intentId) {
      return { ok: true, idempotent: true, turn: this.snapshot(state) };
    }

    state.intentId = this.createId();
    state.intentRequestedAt = this.now();
    return { ok: true, idempotent: false, turn: this.snapshot(state) };
  }

  authorizeCompletion({ tabId, source = 'prompt-loop', ...identity } = {}) {
    const normalizedTabId = normalize(tabId);
    const state = this.turns.get(normalizedTabId);
    if (!state?.active) return { ok: false, code: 'no_active_turn' };
    if (!sameTurnIdentity(state, identity)) {
      return { ok: false, code: 'turn_identity_mismatch' };
    }
    state.completionEligible = true;
    state.completionSource = normalize(source) || 'prompt-loop';
    return { ok: true, turn: this.snapshot(state) };
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

    if (!sameTurnIdentity(state, { provider, sessionId, turnId, processId })) {
      return { matched: false, explicitTaskComplete: false };
    }

    this.turns.delete(normalizedTabId);
    const explicitTaskComplete = success === true
      && state.completionEligible === true
      && !!state.intentId;
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
      ...(state.providerPromptId ? { providerPromptId: state.providerPromptId } : {}),
      generation: state.generation,
      active: state.active,
      startedAt: state.startedAt,
      completionEligible: state.completionEligible === true,
      completionSource: state.completionSource || null,
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
  loopTaskCompletionEligibility,
};
