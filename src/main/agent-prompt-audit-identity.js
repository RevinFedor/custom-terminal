'use strict';

const CODEX_CANONICAL_REASONS = new Set([
  'codex_trimmed_boundary_whitespace',
  'codex_image_placeholder_canonical',
  'codex_pty_crlf_materialized_as_double_lf',
]);
const CLAUDE_PROVIDER_TRANSFORM_CANONICAL_REASON =
  'claude_owned_composer_provider_transform';
const CLAUDE_CANONICAL_REASONS = new Set([
  CLAUDE_PROVIDER_TRANSFORM_CANONICAL_REASON,
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The expected hash names the application-owned send operation. The actual
 * hash is transcript evidence. They may differ only for an explicitly proven
 * provider transformation. A generic `canonicalized` flag is not sufficient:
 * Claude and Codex also use it for exact-text causal carriers.
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
  const provenClaudeCanonical = provider === 'claude'
    && input.canonicalized === true
    && CLAUDE_CANONICAL_REASONS.has(canonicalReason);
  const provenProviderCanonical = provenCodexCanonical || provenClaudeCanonical;
  return {
    accepted: provenProviderCanonical,
    reason: provenProviderCanonical ? null : 'prompt-audit-canonical-proof-missing',
    provider,
    identityHash: provenProviderCanonical ? expectedHash : null,
    expectedHash,
    actualHash,
    canonicalized: provenProviderCanonical,
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
  CLAUDE_CANONICAL_REASONS,
  CLAUDE_PROVIDER_TRANSFORM_CANONICAL_REASON,
  CODEX_CANONICAL_REASONS,
  agentPromptAuditMatchesHash,
  classifyAgentPromptAuditIdentity,
};
