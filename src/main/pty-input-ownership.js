'use strict';

function isManualSubmitInput(data) {
  return data === '\r' || data === '\n';
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
  // first operation has already submitted, forwarding this Enter would create
  // a second empty/draft submit. Printable input remains deliverable after the
  // first operation releases the lock.
  if (
    isManualSubmitInput(data)
    && precedingOperation?.kind === 'safe-paste'
    && precedingOperation?.submitted === true
  ) {
    return {
      action: 'suppress',
      reason: 'preceding-safe-paste-submitted',
    };
  }
  return {
    action: 'deliver',
    reason: 'manual-input-owns-next-boundary',
  };
}

module.exports = {
  classifyManualPtyInputAtBoundary,
  isManualSubmitInput,
  shouldSerializeManualPtyInput,
};
