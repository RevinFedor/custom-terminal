'use strict';

function createCodexSettingsMutationQueue() {
  let tail = Promise.resolve();
  let pending = 0;

  return {
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
