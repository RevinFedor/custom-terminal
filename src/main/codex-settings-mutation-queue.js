'use strict';

function createCodexSettingsMutationQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  // The settings transaction may release its observation/queue slot before
  // the CLI paints our unsubmitted /model or /fast. Retain that physical write receipt
  // on the SAME terminal; it is not a new settings coordinator or a timer.
  const unsubmittedInputs = new WeakMap();

  return {
    getUnsubmittedInput(term) { return unsubmittedInputs.get(term) || null; },
    rememberUnsubmittedInput(term, receipt) {
      if (unsubmittedInputs.has(term)) return false;
      unsubmittedInputs.set(term, receipt);
      return true;
    },
    releaseUnsubmittedInput(term, receipt) {
      if (unsubmittedInputs.get(term) !== receipt) return false;
      unsubmittedInputs.delete(term);
      return true;
    },
    run(operation) {
      pending += 1;
      const next = tail
        .catch(() => {})
        .then(() => operation());
      tail = next;
      return next.finally(() => {
        pending = Math.max(0, pending - 1);
        if (tail === next && pending === 0) tail = Promise.resolve();
      });
    },
    get pending() {
      return pending;
    },
  };
}

module.exports = { createCodexSettingsMutationQueue };
