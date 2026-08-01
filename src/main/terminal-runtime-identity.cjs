'use strict';

function ownsTerminalRuntime(terminals, tabId, expectedTerminal) {
  return !!expectedTerminal && terminals?.get?.(tabId) === expectedTerminal;
}

function deleteTerminalRuntimeIfOwned(terminals, tabId, expectedTerminal) {
  if (!ownsTerminalRuntime(terminals, tabId, expectedTerminal)) return false;
  terminals.delete(tabId);
  return true;
}

/**
 * A delayed close may finish after a replacement PTY has claimed the same
 * tabId.  The captured old PTY must still be terminated, but it must never
 * delete or clean the replacement's slot.
 */
function terminateCapturedTerminalRuntime(terminals, tabId, expectedTerminal) {
  if (!expectedTerminal || typeof expectedTerminal.kill !== 'function') {
    return { killed: false, released: false };
  }
  expectedTerminal.kill();
  return {
    killed: true,
    released: deleteTerminalRuntimeIfOwned(terminals, tabId, expectedTerminal),
  };
}

module.exports = {
  deleteTerminalRuntimeIfOwned,
  ownsTerminalRuntime,
  terminateCapturedTerminalRuntime,
};
