'use strict';

const DEFAULT_OWNER_LIMIT = 64;

function buildCodexLivePromptOwner(auditResult) {
  if (auditResult?.matched !== true) return null;
  const handoffId = typeof auditResult.handoffId === 'string'
    ? auditResult.handoffId
    : '';
  const sourceIdentity = typeof auditResult.sourceIdentity === 'string'
    ? auditResult.sourceIdentity
    : '';
  if (!handoffId || !sourceIdentity) return null;
  return {
    handoffId,
    source: typeof auditResult.source === 'string' && auditResult.source
      ? auditResult.source
      : 'codex-paste-audit',
    sessionId: typeof auditResult.sessionId === 'string' && auditResult.sessionId
      ? auditResult.sessionId
      : null,
    sourceIdentity,
  };
}

function rememberCodexLivePromptOwner(state, auditResult, {
  limit = DEFAULT_OWNER_LIMIT,
} = {}) {
  if (!state || typeof state !== 'object') return null;
  const owner = buildCodexLivePromptOwner(auditResult);
  if (!owner) return null;
  if (!(state.livePromptOwnersBySource instanceof Map)) {
    state.livePromptOwnersBySource = new Map();
  }
  const owners = state.livePromptOwnersBySource;
  owners.delete(owner.sourceIdentity);
  owners.set(owner.sourceIdentity, owner);
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? limit
    : DEFAULT_OWNER_LIMIT;
  while (owners.size > boundedLimit) {
    const oldest = owners.keys().next().value;
    owners.delete(oldest);
  }
  return owner;
}

function resolveCodexLivePromptOwner(state, sourceIdentity) {
  if (!state || !(state.livePromptOwnersBySource instanceof Map)) return null;
  const identity = typeof sourceIdentity === 'string' ? sourceIdentity : '';
  if (!identity) return null;
  return state.livePromptOwnersBySource.get(identity) || null;
}

module.exports = {
  DEFAULT_OWNER_LIMIT,
  buildCodexLivePromptOwner,
  rememberCodexLivePromptOwner,
  resolveCodexLivePromptOwner,
};
