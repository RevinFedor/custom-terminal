'use strict';

const CODEX_SETTINGS_WRITER_ADOPTED_EVENT = 'codex:settings-writer-adopted-internal';

const clean = (value) => typeof value === 'string' ? value.trim() : '';

function launchIdFromOwner(ownerId) {
  const value = clean(ownerId);
  return value.startsWith('launch:') ? value.slice('launch:'.length) : '';
}

/**
 * A one-knob picker request inherits the other setting from one exact owner.
 * The only ownership change it may cross is launch:X -> writer Y when Y was
 * adopted by that same launch and PTY/process generation. Every later/different
 * writer remains a real CAS conflict.
 */
function classifyCodexSettingsWriterTransition({
  expectedOwnerId = null,
  currentOwnerId = null,
  currentWriterLaunchId = null,
  sameTerminal = false,
  sameRunSeq = false,
  sameLifecycleGeneration = false,
  processRunning = false,
  hasLiveCodexEvidence = false,
} = {}) {
  const expected = clean(expectedOwnerId);
  const current = clean(currentOwnerId);
  if (!expected) {
    return {
      allowed: true,
      pending: false,
      rebased: false,
      effectiveExpectedOwnerId: null,
      reason: 'writer-precondition-absent',
    };
  }
  if (current === expected) {
    return {
      allowed: true,
      pending: false,
      rebased: false,
      effectiveExpectedOwnerId: expected,
      reason: 'writer-owner-unchanged',
    };
  }

  const exactGeneration = sameTerminal === true
    && sameRunSeq === true
    && sameLifecycleGeneration === true;
  if (!current
    && exactGeneration
    && processRunning === true
    && hasLiveCodexEvidence === true) {
    return {
      allowed: false,
      pending: true,
      rebased: false,
      effectiveExpectedOwnerId: expected,
      reason: 'codex_settings_writer_adoption_pending',
    };
  }

  const expectedLaunchId = launchIdFromOwner(expected);
  if (!expectedLaunchId || !exactGeneration) {
    return {
      allowed: false,
      pending: false,
      rebased: false,
      effectiveExpectedOwnerId: expected,
      reason: 'codex_settings_writer_changed',
    };
  }
  if (current) {
    if (clean(currentWriterLaunchId) === expectedLaunchId) {
      return {
        allowed: true,
        pending: false,
        rebased: true,
        effectiveExpectedOwnerId: current,
        reason: 'exact-launch-writer-adoption',
      };
    }
    return {
      allowed: false,
      pending: false,
      rebased: false,
      effectiveExpectedOwnerId: expected,
      reason: 'codex_settings_writer_changed',
    };
  }
  return {
    allowed: false,
    pending: false,
    rebased: false,
    effectiveExpectedOwnerId: expected,
    reason: 'codex_settings_writer_changed',
  };
}

/** Event-driven wait; the timer is only a failure guard, never the transition. */
function waitForCodexSettingsWriterTransition({
  tabId,
  readTransition,
  eventBus,
  timeoutMs = 8000,
} = {}) {
  if (!tabId) return Promise.reject(new Error('tabId required'));
  if (typeof readTransition !== 'function') {
    return Promise.reject(new TypeError('readTransition is required'));
  }
  if (!eventBus || typeof eventBus.on !== 'function' || typeof eventBus.removeListener !== 'function') {
    return Promise.reject(new TypeError('eventBus is required'));
  }

  const limitMs = Math.max(250, Math.min(30_000, Number(timeoutMs) || 8000));
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      eventBus.removeListener(CODEX_SETTINGS_WRITER_ADOPTED_EVENT, onAdopted);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const check = () => {
      let result;
      try {
        result = readTransition();
      } catch (error) {
        finish({
          allowed: false,
          pending: false,
          rebased: false,
          effectiveExpectedOwnerId: null,
          reason: error?.message || String(error),
        });
        return;
      }
      if (result?.pending !== true) finish(result);
    };
    function onAdopted(_event, payload = {}) {
      if (payload?.tabId !== tabId) return;
      check();
    }

    eventBus.on(CODEX_SETTINGS_WRITER_ADOPTED_EVENT, onAdopted);
    // Subscribe before the first read, then read immediately: adoption either
    // exists in the snapshot or wakes this exact listener.
    check();
    if (settled) return;
    timer = setTimeout(() => {
      let latest;
      try {
        latest = readTransition();
      } catch (error) {
        finish({
          allowed: false,
          pending: false,
          rebased: false,
          effectiveExpectedOwnerId: null,
          reason: error?.message || String(error),
        });
        return;
      }
      if (latest?.pending !== true) {
        finish(latest);
        return;
      }
      finish({
        ...latest,
        pending: false,
        reason: 'codex_settings_writer_transition_timeout',
      });
    }, limitMs);
  });
}

module.exports = {
  CODEX_SETTINGS_WRITER_ADOPTED_EVENT,
  classifyCodexSettingsWriterTransition,
  launchIdFromOwner,
  waitForCodexSettingsWriterTransition,
};
