'use strict';

const CODEX_CANONICAL_REASONS = new Set([
  'codex_trimmed_boundary_whitespace',
  'codex_image_placeholder_canonical',
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The expected hash names the application-owned send operation. The actual
 * hash is transcript evidence. They may differ only for one of Codex's
 * explicitly proven canonical transformations; a generic `canonicalized`
 * flag is not sufficient because Claude also uses it for exact-text carriers.
 */
function classifyAgentPromptAuditIdentity(input = {}) {
  const provider = cleanString(input.provider || input.toolType);
  const actualHash = cleanString(input.actualHash || input.promptHash);
  const expectedHash = cleanString(input.expectedHash) || actualHash;
  const canonicalReason = cleanString(input.canonicalReason) || null;
  if (!provider || !actualHash || !expectedHash) {
    return {
      accepted: false,
      reason: 'prompt-audit-identity-incomplete',
      provider: provider || null,
      expectedHash: expectedHash || null,
      actualHash: actualHash || null,
      canonicalized: false,
      canonicalReason,
    };
  }
  if (actualHash === expectedHash) {
    return {
      accepted: true,
      reason: null,
      provider,
      identityHash: expectedHash,
      expectedHash,
      actualHash,
      canonicalized: input.canonicalized === true,
      canonicalReason,
    };
  }
  const provenCodexCanonical = provider === 'codex'
    && input.canonicalized === true
    && CODEX_CANONICAL_REASONS.has(canonicalReason);
  return {
    accepted: provenCodexCanonical,
    reason: provenCodexCanonical ? null : 'prompt-audit-canonical-proof-missing',
    provider,
    identityHash: provenCodexCanonical ? expectedHash : null,
    expectedHash,
    actualHash,
    canonicalized: provenCodexCanonical,
    canonicalReason,
  };
}

function agentPromptAuditMatchesHash(expectedOperationHash, input = {}) {
  const operationHash = cleanString(expectedOperationHash);
  const proof = classifyAgentPromptAuditIdentity(input);
  return {
    ...proof,
    matches: proof.accepted === true
      && !!operationHash
      && proof.identityHash === operationHash,
    operationHash: operationHash || null,
  };
}

module.exports = {
  CODEX_CANONICAL_REASONS,
  agentPromptAuditMatchesHash,
  classifyAgentPromptAuditIdentity,
};
