'use strict';

// Fedor31Oct: a programmatic Send from ANOTHER tab (Terminal MCP, Project API,
// Inbox, orchestration) is shown in the user's History by the SAME rule that
// applies to the user's own input — not by who sent it.
//
// The discriminator is whether the attempt reached the terminal itself:
//
//   * The transport/caller level refused BEFORE any byte crossed into the PTY
//     (bad arguments, unresolved target, model+Send pair refused while busy,
//     application-queue admission conflict). The user can do nothing about
//     another agent's malformed call, and X would only hide presentation
//     without returning anything to the composer. No local card is
//     materialized; the calling session receives the error as a tool result.
//
//   * The prompt DID reach the terminal and the failure happened in terminal
//     state (slash model/effort not applied, writer addressed the wrong
//     session, post-Enter audit failed). This is indistinguishable from typing
//     the same message into the input by hand, so it keeps its ordinary card.
//
// Unknown is never silently downgraded to "did not reach". `delivery-unknown`
// retains its card because claiming no-input without proof is exactly the
// failure mode the receipt contract forbids.
//
// This module decides PRESENTATION ONLY. The durable Main receipt, FIFO slot,
// attempt identity, audit and get_send_receipt recovery are untouched: a
// suppressed card still has a full receipt to read by handoffId.

// Sends authored on the desktop History surface itself. These always own their
// local card from the first frame: the user pressed Enter and must see it.
const OWN_INPUT_SEND_SOURCES = new Set([
  'history-panel',
  'codex-history-panel',
  'prompt-queue',
  'prompt-loop',
]);

// Programmatic origins. Identified by exact value or by their `<kind>:<id>`
// prefix, after Codex's physical writer prefix is removed.
const EXTERNAL_SEND_SOURCES = new Set([
  'terminal-mcp',
  'project-api',
  'mobile-native',
  'inbox',
]);

const EXTERNAL_SEND_SOURCE_PREFIXES = [
  'tab-message:',
  'orchestration:',
  'orchestration-completion:',
  'orchestration-continue:',
  'build-install-continue:',
  'research-operational:',
];

function normalizeSendSource(source) {
  const value = typeof source === 'string' ? source.trim() : '';
  // Codex's writer adds one provider prefix to the scenario origin. Recognize
  // the origin underneath without rewriting the persisted source.
  return value.startsWith('codex-') ? value.slice('codex-'.length) : value;
}

function isOwnInputSendSource(source) {
  const normalized = normalizeSendSource(source);
  return OWN_INPUT_SEND_SOURCES.has(normalized)
    || OWN_INPUT_SEND_SOURCES.has(typeof source === 'string' ? source.trim() : '');
}

function isExternalAgentSendSource(source) {
  const normalized = normalizeSendSource(source);
  if (!normalized || isOwnInputSendSource(source)) return false;
  if (EXTERNAL_SEND_SOURCES.has(normalized)) return true;
  return EXTERNAL_SEND_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix)
    && normalized.slice(prefix.length).trim().length > 0);
}

// True only when the receipt PROVES nothing was written to the terminal.
// `submitted === false` is that proof; it is set by the scenario layer only
// after it establishes that neither paste nor Enter crossed. Any uncertainty
// (`deliveryUnknown`, submitted null/undefined, a provider queue acceptance,
// an exact audit) is NOT this case.
function isProvenNoTerminalInput(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.deliveryUnknown === true) return false;
  if (receipt.submitted !== false) return false;
  if (receipt.pasteWritten === true || receipt.enterWritten === true) return false;
  if (receipt.providerQueueAccepted === true || receipt.exactAuditConfirmed === true) return false;
  return true;
}

/**
 * Should this failed external Send keep a card in the user's History?
 *
 * Returns true when the prompt reached the terminal (or its outcome is
 * unknown), false when the transport refused before touching the PTY.
 */
function externalSendFailureBelongsInHistory({ source, receipt } = {}) {
  if (!isExternalAgentSendSource(source)) return true; // own input keeps its card
  return !isProvenNoTerminalInput(receipt);
}

module.exports = {
  OWN_INPUT_SEND_SOURCES,
  EXTERNAL_SEND_SOURCES,
  EXTERNAL_SEND_SOURCE_PREFIXES,
  normalizeSendSource,
  isOwnInputSendSource,
  isExternalAgentSendSource,
  isProvenNoTerminalInput,
  externalSendFailureBelongsInHistory,
};
