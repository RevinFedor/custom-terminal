'use strict';

const CODEX_ACTION_PROFILE_NATIVE_REWIND = 'native-rewind';
const CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT = 'resumed-active-submit';

const TERMINAL_PHASES = new Set(['revoked', 'committed']);
const VALID_PHASES = new Set([
  'requested',
  'waiting',
  'armed',
  'consumed',
  'revoked',
  'committed',
]);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeCodexActionAuthorityIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    terminalToken: value.terminalToken || null,
    projectId: cleanString(value.projectId),
    tabId: cleanString(value.tabId),
    lifecycleGeneration: cleanString(value.lifecycleGeneration),
    runSeq: cleanInteger(value.runSeq),
    launchId: cleanString(value.launchId),
    sourceSessionId: cleanString(value.sourceSessionId),
    persistedSessionId: cleanString(value.persistedSessionId),
    inputRevision: cleanInteger(value.inputRevision),
    operationId: cleanString(value.operationId),
    requestId: cleanString(value.requestId),
  };
}

function validateRequiredIdentity(identity) {
  if (!identity) return 'identity-unavailable';
  if (!identity.terminalToken) return 'terminal-unproven';
  if (!identity.projectId) return 'project-unproven';
  if (!identity.tabId) return 'tab-unproven';
  if (!identity.lifecycleGeneration) return 'lifecycle-generation-unproven';
  if (!Number.isInteger(identity.runSeq) || identity.runSeq <= 0) return 'run-generation-unproven';
  if (!identity.launchId) return 'launch-generation-unproven';
  if (!identity.sourceSessionId) return 'source-session-unproven';
  if (!identity.persistedSessionId) return 'persisted-session-unproven';
  if (!Number.isInteger(identity.inputRevision)) return 'input-revision-unproven';
  if (!identity.operationId) return 'operation-unproven';
  if (!identity.requestId) return 'request-unproven';
  return null;
}

function createCodexActionAuthority({
  authorityId,
  profile,
  identity,
  target = null,
  now = Date.now(),
} = {}) {
  const normalizedIdentity = normalizeCodexActionAuthorityIdentity(identity);
  const identityError = validateRequiredIdentity(normalizedIdentity);
  if (!cleanString(authorityId)) {
    return { success: false, error: 'authority-id-unproven' };
  }
  if (profile !== CODEX_ACTION_PROFILE_NATIVE_REWIND
    && profile !== CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT) {
    return { success: false, error: 'action-profile-unrecognized' };
  }
  if (identityError) return { success: false, error: identityError };
  if (normalizedIdentity.persistedSessionId !== normalizedIdentity.sourceSessionId) {
    return { success: false, error: 'persisted-source-mismatch' };
  }
  const authority = {
    authorityId: cleanString(authorityId),
    profile,
    identity: normalizedIdentity,
    target: target && typeof target === 'object' ? { ...target } : null,
    actionGeneration: null,
    phase: 'requested',
    reason: null,
    createdAt: Number(now),
    updatedAt: Number(now),
    consumedAt: null,
    committedAt: null,
    revokedAt: null,
  };
  return { success: true, authority };
}

function compareCodexActionAuthorityIdentity(expectedValue, observedValue) {
  const expected = normalizeCodexActionAuthorityIdentity(expectedValue);
  const observed = normalizeCodexActionAuthorityIdentity(observedValue);
  const expectedError = validateRequiredIdentity(expected);
  const observedError = validateRequiredIdentity(observed);
  if (expectedError || observedError) {
    return {
      matches: false,
      reason: expectedError || observedError,
      expected,
      observed,
    };
  }
  const checks = [
    ['terminal-changed', expected.terminalToken === observed.terminalToken],
    ['project-owner-changed', expected.projectId === observed.projectId],
    ['tab-owner-changed', expected.tabId === observed.tabId],
    ['lifecycle-generation-changed', expected.lifecycleGeneration === observed.lifecycleGeneration],
    ['run-generation-changed', expected.runSeq === observed.runSeq],
    ['launch-generation-changed', expected.launchId === observed.launchId],
    ['source-session-changed', expected.sourceSessionId === observed.sourceSessionId],
    ['persisted-session-changed', expected.persistedSessionId === observed.persistedSessionId],
    ['input-revision-changed', expected.inputRevision === observed.inputRevision],
    ['operation-changed', expected.operationId === observed.operationId],
    ['request-changed', expected.requestId === observed.requestId],
  ];
  const failed = checks.find(([, matches]) => !matches);
  return {
    matches: !failed,
    reason: failed ? failed[0] : null,
    expected,
    observed,
  };
}

function transitionCodexActionAuthority(authority, phase, {
  reason = null,
  now = Date.now(),
} = {}) {
  if (!authority || !VALID_PHASES.has(phase)) {
    return { success: false, error: 'action-authority-transition-invalid' };
  }
  if (TERMINAL_PHASES.has(authority.phase)) {
    return { success: false, error: 'action-authority-terminal' };
  }
  const allowed = {
    requested: new Set(['waiting', 'armed', 'revoked']),
    waiting: new Set(['armed', 'revoked']),
    armed: new Set(['consumed', 'revoked']),
    consumed: new Set(['committed', 'revoked']),
  };
  if (!allowed[authority.phase]?.has(phase)) {
    return { success: false, error: 'action-authority-transition-out-of-order' };
  }
  authority.phase = phase;
  authority.reason = cleanString(reason);
  authority.updatedAt = Number(now);
  if (phase === 'consumed') authority.consumedAt = Number(now);
  if (phase === 'committed') authority.committedAt = Number(now);
  if (phase === 'revoked') authority.revokedAt = Number(now);
  return { success: true, authority };
}

function validateCodexActionAuthority(authority, observedIdentity, {
  phases = ['armed', 'consumed'],
  authorityId = null,
  profile = null,
  actionGeneration = undefined,
  target = undefined,
} = {}) {
  if (!authority) return { valid: false, reason: 'action-authority-missing' };
  if (!Array.isArray(phases) || !phases.includes(authority.phase)) {
    return { valid: false, reason: 'action-authority-not-usable' };
  }
  if (authorityId && authority.authorityId !== authorityId) {
    return { valid: false, reason: 'action-authority-id-changed' };
  }
  if (profile && authority.profile !== profile) {
    return { valid: false, reason: 'action-authority-profile-changed' };
  }
  if (actionGeneration !== undefined
    && authority.actionGeneration !== actionGeneration) {
    return { valid: false, reason: 'action-generation-changed' };
  }
  const identity = compareCodexActionAuthorityIdentity(authority.identity, observedIdentity);
  if (!identity.matches) return { valid: false, reason: identity.reason, identity };
  if (target !== undefined) {
    const expectedTarget = authority.target || null;
    const observedTarget = target && typeof target === 'object' ? target : null;
    if (!expectedTarget || !observedTarget) {
      return { valid: false, reason: 'action-target-unproven' };
    }
    const keys = new Set([...Object.keys(expectedTarget), ...Object.keys(observedTarget)]);
    for (const key of keys) {
      if ((expectedTarget[key] ?? null) !== (observedTarget[key] ?? null)) {
        return { valid: false, reason: 'action-target-changed', targetKey: key };
      }
    }
  }
  return { valid: true, reason: null, authority };
}

function bindCodexActionAuthorityGeneration(authority, actionGeneration) {
  const normalized = cleanString(actionGeneration);
  if (!authority || !normalized || TERMINAL_PHASES.has(authority.phase)) {
    return { success: false, error: 'action-generation-bind-invalid' };
  }
  if (authority.actionGeneration && authority.actionGeneration !== normalized) {
    return { success: false, error: 'action-generation-already-bound' };
  }
  authority.actionGeneration = normalized;
  return { success: true, authority };
}

function bindCodexActionAuthorityTarget(authority, target) {
  if (!authority || !target || typeof target !== 'object' || TERMINAL_PHASES.has(authority.phase)) {
    return { success: false, error: 'action-target-bind-invalid' };
  }
  if (authority.target) {
    const current = validateCodexActionAuthority(authority, authority.identity, {
      phases: [authority.phase],
      target,
    });
    return current.valid
      ? { success: true, authority }
      : { success: false, error: current.reason };
  }
  authority.target = { ...target };
  return { success: true, authority };
}

module.exports = {
  CODEX_ACTION_PROFILE_NATIVE_REWIND,
  CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT,
  bindCodexActionAuthorityGeneration,
  bindCodexActionAuthorityTarget,
  compareCodexActionAuthorityIdentity,
  createCodexActionAuthority,
  normalizeCodexActionAuthorityIdentity,
  transitionCodexActionAuthority,
  validateCodexActionAuthority,
};
