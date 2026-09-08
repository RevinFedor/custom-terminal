'use strict';

// E2E transport fault only: emulate the provider consuming paste but ignoring
// the following Enter. The real delivery audit, helper and writer observers
// still run normally; no application state/receipt is fabricated by the test.
function createCodexSubmitDropTestFault({ enabled = false, getIdentity, log = () => {} }) {
  const armed = new Map();
  return {
    configure({ tabId, action = 'arm', count = 2 } = {}) {
      if (!enabled) return { success: false, error: 'test_hook_disabled' };
      if (action === 'clear') { armed.delete(tabId); return { success: true }; }
      const owner = getIdentity(tabId);
      if (!owner?.terminal || !owner.runSeq || !owner.lifecycleGeneration
        || !Number.isInteger(count) || count < 1 || count > 2) {
        return { success: false, error: 'invalid_test_fault_scope' };
      }
      armed.set(tabId, { ...owner, count, audit: null });
      return { success: true, count };
    },
    consume(tabId, terminal, bytes, audit, phase) {
      if (!enabled || bytes !== '\r' || !audit) return false;
      const fault = armed.get(tabId);
      const current = getIdentity(tabId);
      if (!fault || fault.terminal !== terminal || current?.terminal !== terminal
        || fault.runSeq !== current.runSeq
        || fault.lifecycleGeneration !== current.lifecycleGeneration) return false;
      if (fault.audit && fault.audit !== audit) return false;
      fault.audit = audit;
      fault.count -= 1;
      log({ tabId, phase, remaining: fault.count, handoffId: audit.handoffId || null });
      if (fault.count === 0) armed.delete(tabId);
      return true;
    },
  };
}
module.exports = { createCodexSubmitDropTestFault };
