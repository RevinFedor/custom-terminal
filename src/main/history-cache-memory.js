'use strict';

const bytes = value => Number.isSafeInteger(value) && value >= 0;
// Retained cache accounting, not heap/RSS, transient buffers or renderer DOM.
function historyCacheRamSnapshot(mainStats, worker, budgetBytes, measuredAt = Date.now()) {
  const values = [mainStats?.approxBytes, worker?.graphBytes, worker?.virtualBytes, worker?.indexBytes];
  const valid = worker?.status === 'ready' && values.every(bytes) && bytes(budgetBytes);
  const sum = valid ? values.reduce((total, value) => total + value, 0) : null;
  return { status: valid && bytes(sum) ? 'ready' : 'unknown',
    approxBytes: valid && bytes(sum) ? sum : null, budgetBytes: bytes(budgetBytes) ? budgetBytes : null,
    measuredAt, approximate: true, workerGeneration: worker?.generation ?? null,
    reason: ['not-started', 'worker-starting', 'cache-counters', 'invalid-counters', 'worker-unavailable', 'client-closed']
      .includes(worker?.reason) ? worker.reason : valid ? 'cache-counters' : 'invalid-counters' };
}

module.exports = { historyCacheRamSnapshot };
