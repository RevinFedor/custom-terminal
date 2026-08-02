'use strict';

const path = require('path');

function normalizeDirectoryTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const target = path.resolve(value.trim());
  return path.isAbsolute(target) ? target : null;
}

class TerminalCwdChangeProofRegistry {
  constructor({
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    idFactory = null,
  } = {}) {
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._idFactory = idFactory;
    this._seq = 0;
    this._byTab = new Map();
  }

  begin({ tabId, terminalToken, fromCwd = null, targetCwd, timeoutMs = 10_000 }) {
    const normalizedTarget = normalizeDirectoryTarget(targetCwd);
    if (!tabId || !terminalToken || !normalizedTarget) {
      return {
        success: false,
        error: 'invalid_cwd_change_request',
      };
    }

    this.cancel(tabId, null, 'superseded');
    const operationId = this._idFactory
      ? this._idFactory()
      : `cwd-change-${this._now()}-${++this._seq}`;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const state = {
      tabId,
      terminalToken,
      operationId,
      fromCwd: normalizeDirectoryTarget(fromCwd),
      targetCwd: normalizedTarget,
      startedAt: this._now(),
      timer: null,
      settled: false,
      resolve: resolvePromise,
      promise,
    };
    const settle = (result) => {
      if (state.settled) return false;
      state.settled = true;
      if (state.timer) this._clearTimer(state.timer);
      if (this._byTab.get(tabId) === state) this._byTab.delete(tabId);
      state.resolve({
        operationId,
        fromCwd: state.fromCwd,
        targetCwd: state.targetCwd,
        waitedMs: Math.max(0, this._now() - state.startedAt),
        ...result,
      });
      return true;
    };
    state.settle = settle;
    this._byTab.set(tabId, state);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      state.timer = this._setTimer(() => {
        settle({
          success: false,
          accepted: false,
          error: 'cwd_change_proof_timeout',
          reason: 'exact_osc7_proof_not_observed',
        });
      }, timeoutMs);
    }
    return {
      success: true,
      operationId,
      targetCwd: normalizedTarget,
      promise,
    };
  }

  observe({ tabId, terminalToken, cwd, persisted = false }) {
    const state = this._byTab.get(tabId);
    if (!state) return { matched: false, reason: 'no_pending_change' };
    if (state.terminalToken !== terminalToken) {
      return { matched: false, reason: 'terminal_generation_changed' };
    }
    const normalizedCwd = normalizeDirectoryTarget(cwd);
    if (!normalizedCwd || normalizedCwd !== state.targetCwd) {
      return {
        matched: false,
        reason: 'different_cwd',
        expectedCwd: state.targetCwd,
        observedCwd: normalizedCwd,
      };
    }
    state.settle({
      success: true,
      accepted: true,
      cwd: normalizedCwd,
      proof: 'live-process-osc7',
      persisted: persisted === true,
    });
    return { matched: true, operationId: state.operationId, cwd: normalizedCwd };
  }

  cancel(tabId, operationId = null, reason = 'cancelled') {
    const state = this._byTab.get(tabId);
    if (!state) return false;
    if (operationId && state.operationId !== operationId) return false;
    return state.settle({
      success: false,
      accepted: false,
      error: reason,
      reason,
    });
  }

  snapshot(tabId) {
    const state = this._byTab.get(tabId);
    if (!state) return null;
    return {
      operationId: state.operationId,
      fromCwd: state.fromCwd,
      targetCwd: state.targetCwd,
      startedAt: state.startedAt,
    };
  }
}

module.exports = {
  normalizeDirectoryTarget,
  TerminalCwdChangeProofRegistry,
};
