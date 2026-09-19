'use strict';

function isManualSubmitInput(data) {
  return data === '\r' || data === '\n';
}

function classifyLateMcpProofInput({
  proofPending = false,
  xtermInputOrigin = null,
} = {}) {
  if (!proofPending) {
    return {
      action: 'deliver',
      reason: 'late-mcp-proof-not-pending',
      cancelProof: false,
    };
  }
  if (xtermInputOrigin === 'terminal-response') {
    return {
      action: 'deliver',
      reason: 'terminal-protocol-response',
      cancelProof: false,
    };
  }
  // A late MCP candidate is diagnostic, not an input owner. Any physical or
  // origin-unknown xterm input wins immediately; inputRevision will then make
  // every stale automation proof fail at its own write boundary.
  return {
    action: 'deliver',
    reason: 'manual-input-owns-terminal',
    cancelProof: true,
  };
}

function shouldSerializeManualPtyInput({
  alreadySerialized = false,
  isTerminalProtocolResponse = false,
  isManualCodexSubmit = false,
  activeOperation = null,
  queuedOperation = null,
} = {}) {
  if (alreadySerialized || isTerminalProtocolResponse || isManualCodexSubmit) {
    return false;
  }
  if (!queuedOperation) return false;
  // Picker automation is advisory. A physical key owns the current picker
  // immediately and invalidates the automation through inputRevision.
  if (activeOperation?.manualInputYields === true) return false;
  return true;
}

function classifyManualPtyInputAtBoundary({
  data = '',
  precedingOperation = null,
} = {}) {
  // If a physical Enter arrived while a programmatic paste was still running,
  // observe the operation object at the eventual write boundary. Once the
  // first operation has submitted OR attempted an unconfirmed write, forwarding
  // this Enter could create a second empty/draft submit. This applies only to
  // a key already queued behind that operation; later explicit input is free.
  // Printable input remains deliverable after the first operation releases.
  if (
    isManualSubmitInput(data)
    && ((precedingOperation?.kind === 'safe-paste'
        && (precedingOperation.submitted === true || precedingOperation.enterAttempted === true))
      || (precedingOperation?.kind === 'claude-settings-send'
        && (precedingOperation.promptSubmitted === true || precedingOperation.promptSubmitAttempted === true)))
  ) {
    return {
      action: 'suppress',
      reason: (precedingOperation.kind === 'safe-paste'
        ? precedingOperation.submitted : precedingOperation.promptSubmitted) === true
        ? 'preceding-safe-paste-submitted' : 'preceding-safe-paste-write-unknown',
    };
  }
  return {
    action: 'deliver',
    reason: 'manual-input-owns-next-boundary',
  };
}

module.exports = {
  classifyLateMcpProofInput,
  classifyManualPtyInputAtBoundary,
  isManualSubmitInput,
  shouldSerializeManualPtyInput,
};
