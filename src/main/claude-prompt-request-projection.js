'use strict';

const { prepareClaudePromptTransport } = require('./claude-prompt-transport');
const { agentPromptAuditMatchesHash } = require('./agent-prompt-audit-identity');

const CLAUDE_REQUEST_TRANSPORT_REASON = 'claude_request_transport_exact';

// The immutable request and the bytes prepared for Ink name the SAME attempt,
// but are not necessarily identical strings. Replay the existing transport
// codec over the persisted pre-Enter pair, never normalize provider evidence.
function validateClaudePromptRequestProjection({ tabId, record, audit } = {}) {
  const refused = reason => ({ valid: false, reason });
  const receipt = record?.receipt;
  if (record?.provider !== 'claude' || !receipt) return refused('claude-request-provider-mismatch');
  const scope = { tabId, handoffId: audit?.handoffId,
    operationKey: audit?.sendOperationKey, attemptId: audit?.sendAttemptId };
  for (const [key, value] of Object.entries(scope)) {
    if (!value || record[key] !== value) return refused('claude-request-' + key + '-mismatch');
  }
  if (receipt.operationKey !== scope.operationKey || receipt.attemptId !== scope.attemptId) {
    return refused('claude-request-persisted-attempt-mismatch');
  }
  if (typeof receipt.promptText !== 'string' || typeof receipt.transportText !== 'string') {
    return refused('claude-request-text-missing');
  }
  let replay;
  try { replay = prepareClaudePromptTransport(receipt.promptText); }
  catch { return refused('claude-request-transport-invalid'); }
  if (replay.raw.auditHash !== record.promptHash || replay.raw.utf16Length !== record.promptLength) {
    return refused('claude-request-identity-mismatch');
  }
  if (replay.transport.text !== receipt.transportText
    || replay.transport.text !== audit?.expectedText
    || replay.transport.auditHash !== audit?.expectedHash
    || replay.transport.utf16Length !== audit?.expectedLen) {
    return refused('claude-request-transport-mismatch');
  }
  return { valid: true, requestHash: replay.raw.auditHash, requestLength: replay.raw.utf16Length,
    transportHash: replay.transport.auditHash, transportLength: replay.transport.utf16Length };
}

function projectClaudePromptAuditToRequest({ tabId, record, audit, result } = {}) {
  const checked = validateClaudePromptRequestProjection({ tabId, record, audit });
  if (!checked.valid) return { applied: false, reason: checked.reason };
  const providerProof = agentPromptAuditMatchesHash(checked.transportHash, { ...result, provider: 'claude' });
  if (result?.success !== true || !providerProof.matches
    || result.expectedLen !== checked.transportLength
    || result.canonicalReason === CLAUDE_REQUEST_TRANSPORT_REASON
    || (result.actualHash === checked.transportHash && result.actualLen !== checked.transportLength)
    || (typeof result.actualText === 'string' && result.actualHash === checked.transportHash
      && result.actualText !== audit.expectedText)) {
    return { applied: false, reason: 'claude-request-provider-proof-missing' };
  }
  return { ...checked, applied: true, canonicalReason: CLAUDE_REQUEST_TRANSPORT_REASON };
}

module.exports = { CLAUDE_REQUEST_TRANSPORT_REASON, validateClaudePromptRequestProjection,
  projectClaudePromptAuditToRequest };
