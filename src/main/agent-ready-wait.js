'use strict';

const {
  isCodexComposerReadyForGuardedSend,
} = require('./codex-runtime-contract');

const READY_EVENT = 'agent:tui-ready-internal';
const READINESS_CHANGED_EVENT = 'agent:readiness-changed-internal';

function startupFailureFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const error = status.startupDefaultsError
    || (status.startupFailed === true ? status.startupError : null);
  if (!error) return null;
  const failure = new Error(String(error));
  failure.code = 'agent_startup_defaults_failed';
  failure.statusCode = 409;
  failure.status = status;
  return failure;
}

function manualActionFailureFromStatus(status) {
  if (!status) return null;
  const blockers = Array.isArray(status.lastNotReady?.blockers)
    ? status.lastNotReady.blockers
    : [];
  if (status.manualActionRequired !== true && !blockers.includes('auth-required')) {
    return null;
  }
  const failure = new Error('codex_auth_required');
  failure.code = 'codex_auth_required';
  failure.statusCode = 409;
  failure.status = status;
  return failure;
}

function isAgentInputReady(status) {
  if (!status || typeof status !== 'object') return false;
  const runtimeStatus = status.status || status.sessionStatus || 'unknown';
  const settled = (runtimeStatus === 'active' || runtimeStatus === 'busy')
    && status.inputReady === true;
  const codexProvisionalComposerReady = runtimeStatus === 'starting'
    && isCodexComposerReadyForGuardedSend(status);
  return settled || codexProvisionalComposerReady;
}

/**
 * Event-driven readiness wait shared by the Project API and Terminal MCP.
 *
 * The initial read closes the subscribe-after-ready race. Later reads are
 * woken both by the TUI edge and by post-TUI readiness changes such as the
 * Claude startup-settings transaction becoming ready or failed.
 */
function waitForAgentReadyTransition({
  tabId,
  timeoutMs = 20_000,
  readStatus,
  eventBus,
  log = () => {},
} = {}) {
  if (!tabId) return Promise.reject(new Error('tabId required'));
  if (typeof readStatus !== 'function') {
    return Promise.reject(new TypeError('readStatus is required'));
  }
  if (!eventBus || typeof eventBus.on !== 'function' || typeof eventBus.removeListener !== 'function') {
    return Promise.reject(new TypeError('eventBus is required'));
  }

  const limitMs = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 20_000));
  let last = null;
  let settled = false;
  let timer = null;
  let checkInflight = false;
  let checkAgain = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      eventBus.removeListener(READY_EVENT, onWake);
      eventBus.removeListener(READINESS_CHANGED_EVENT, onWake);
    };
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(status);
    };
    const check = async () => {
      if (settled) return;
      if (checkInflight) {
        checkAgain = true;
        return;
      }
      checkInflight = true;
      try {
        do {
          checkAgain = false;
          try {
            last = await readStatus();
          } catch (error) {
            last = { error: String(error?.message || error) };
          }
          log('[AgentReadyWait] check tab=' + String(tabId).slice(-12)
            + ' tool=' + String(last?.toolType || last?.commandType || '-')
            + ' status=' + String(last?.status || last?.sessionStatus || '-')
            + ' inputReady=' + (last?.inputReady === true)
            + ' defaults=' + (last?.startupDefaultsReady === true
              ? 'ready'
              : (last?.startupDefaultsPending === true ? 'pending' : '-'))
            + ' generation=' + String(last?.launchGeneration || '-'));
          const manualFailure = manualActionFailureFromStatus(last);
          if (manualFailure) {
            finish(manualFailure);
            return;
          }
          const startupFailure = startupFailureFromStatus(last);
          if (startupFailure) {
            finish(startupFailure);
            return;
          }
          if (isAgentInputReady(last)) {
            finish(null, last);
            return;
          }
        } while (checkAgain && !settled);
      } finally {
        checkInflight = false;
      }
    };
    function onWake(_event, payload = {}) {
      const readyTabId = typeof payload === 'string' ? payload : payload?.tabId;
      if (readyTabId !== tabId) return;
      log('[AgentReadyWait] wake tab=' + String(tabId).slice(-12)
        + ' source=' + String(payload?.source || payload?.toolType || 'event')
        + ' status=' + String(payload?.status || '-'));
      void check();
    }

    eventBus.on(READY_EVENT, onWake);
    eventBus.on(READINESS_CHANGED_EVENT, onWake);
    timer = setTimeout(() => {
      const error = new Error('agent did not become ready');
      error.code = 'agent_ready_timeout';
      error.statusCode = 504;
      error.status = last;
      finish(error);
    }, limitMs);
    void check();
  });
}

module.exports = {
  READY_EVENT,
  READINESS_CHANGED_EVENT,
  isAgentInputReady,
  waitForAgentReadyTransition,
};
