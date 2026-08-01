'use strict';

const LAUNCH_SOURCE_AUTO_RESUME = 'auto-resume';
const LAUNCH_SOURCE_EXPLICIT = 'explicit';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeAgentLaunchSource(value) {
  return cleanText(value) === LAUNCH_SOURCE_AUTO_RESUME
    ? LAUNCH_SOURCE_AUTO_RESUME
    : LAUNCH_SOURCE_EXPLICIT;
}

function normalizeAiLifecycleIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const processStatus = value.processStatus === 'found'
    || value.processStatus === 'absent'
    || value.processStatus === 'unknown'
    ? value.processStatus
    : 'unknown';
  const processPid = cleanInteger(value.processPid);
  return {
    terminalLifecycleGeneration: cleanText(value.terminalLifecycleGeneration) || null,
    terminalRunSeq: cleanInteger(value.terminalRunSeq),
    inputRevision: cleanInteger(value.inputRevision),
    processStatus,
    processPid: processPid && processPid > 0 ? processPid : null,
    processName: cleanText(value.processName) || null,
    sessionId: cleanText(value.sessionId) || null,
  };
}

function compareAiLifecycleIdentity(expectedValue, observedValue) {
  const expected = normalizeAiLifecycleIdentity(expectedValue);
  const observed = normalizeAiLifecycleIdentity(observedValue);
  if (!expected || !observed) {
    return { matches: false, reason: 'lifecycle-identity-unavailable', expected, observed };
  }
  if (!expected.terminalLifecycleGeneration || !observed.terminalLifecycleGeneration) {
    return { matches: false, reason: 'terminal-generation-unproven', expected, observed };
  }
  if (expected.terminalLifecycleGeneration !== observed.terminalLifecycleGeneration) {
    return { matches: false, reason: 'terminal-generation-changed', expected, observed };
  }
  if (expected.terminalRunSeq === null || expected.terminalRunSeq !== observed.terminalRunSeq) {
    return { matches: false, reason: 'terminal-run-changed', expected, observed };
  }
  if (expected.inputRevision === null || expected.inputRevision !== observed.inputRevision) {
    return { matches: false, reason: 'terminal-input-changed', expected, observed };
  }
  if (expected.processStatus === 'unknown' || observed.processStatus === 'unknown') {
    return { matches: false, reason: 'process-identity-unknown', expected, observed };
  }
  if (expected.processStatus !== observed.processStatus) {
    return { matches: false, reason: 'process-presence-changed', expected, observed };
  }
  if (expected.processStatus === 'absent') {
    return { matches: true, reason: null, expected, observed };
  }
  if (!expected.processPid || expected.processPid !== observed.processPid) {
    return { matches: false, reason: 'process-pid-changed', expected, observed };
  }
  if (expected.processName && expected.processName !== observed.processName) {
    return { matches: false, reason: 'process-provider-changed', expected, observed };
  }
  if (expected.sessionId && expected.sessionId !== observed.sessionId) {
    return { matches: false, reason: 'process-session-changed', expected, observed };
  }
  return { matches: true, reason: null, expected, observed };
}

function decideAutomaticRestoreAdmission({ launchSource, pendingAutoStop }) {
  const source = normalizeAgentLaunchSource(launchSource);
  if (source !== LAUNCH_SOURCE_AUTO_RESUME) {
    return { allowed: true, source, reason: null };
  }
  if (pendingAutoStop?.authoritative === true) {
    return {
      allowed: false,
      source,
      suppressed: true,
      reason: 'orchestration-auto-stop-pending',
      runId: pendingAutoStop.runId || null,
    };
  }
  return { allowed: true, source, reason: null };
}

module.exports = {
  LAUNCH_SOURCE_AUTO_RESUME,
  LAUNCH_SOURCE_EXPLICIT,
  compareAiLifecycleIdentity,
  decideAutomaticRestoreAdmission,
  normalizeAgentLaunchSource,
  normalizeAiLifecycleIdentity,
};
