'use strict';

function ownsTerminalRuntime(terminals, tabId, expectedTerminal) {
  return !!expectedTerminal && terminals?.get?.(tabId) === expectedTerminal;
}

function deleteTerminalRuntimeIfOwned(terminals, tabId, expectedTerminal) {
  if (!ownsTerminalRuntime(terminals, tabId, expectedTerminal)) return false;
  terminals.delete(tabId);
  return true;
}

module.exports = {
  deleteTerminalRuntimeIfOwned,
  ownsTerminalRuntime,
};
