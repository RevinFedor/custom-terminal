'use strict';

const { performance } = require('node:perf_hooks');
const { isHistoryReadCancelled } = require('./history-read-control');
const stages = ['validation', 'projection', 'materialize', 'serialize', 'release', 'write', 'install', 'cleanup'];

// One invocation, fixed scalar vocabulary. Off means no clock reads. Offsets
// are integer microseconds from a process-monotonic origin, not CPU time.
// No DTO/cursor, error text, node token, path or global store deltas are kept.
function beginUnitReadDiagnostic(observer) {
  if (typeof observer !== 'function') return null;
  const origin = performance.now();
  const summary = { schema: 'history-unit-phase-v1', startedPerfMs: origin,
    parentLeaseId: null, generation: null, rank: null, kind: null,
    serializedBytes: null, chunks: 0, memo: null, outcome: 'incomplete', incomplete: true,
    lastStage: null, elapsedUs: null };
  for (const stage of stages) {
    summary[stage + 'StartUs'] = null;
    summary[stage + 'EndUs'] = null;
  }
  const offset = () => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round((performance.now() - origin) * 1000)));
  return {
    parent(parent, generation, rank) {
      summary.parentLeaseId = parent.leaseId; summary.generation = generation; summary.rank = rank;
    },
    kind(value) { summary.kind = value; },
    bytes(value) { summary.serializedBytes = value; },
    chunks(value) { summary.chunks = value; },
    memo(value) { summary.memo = value; },
    begin(stage) {
      summary[stage + 'StartUs'] = offset();
      // Cleanup has its own interval; retain the work stage at failure.
      if (stage !== 'cleanup') summary.lastStage = stage;
    },
    end(stage) { summary[stage + 'EndUs'] = offset(); },
    finish(error, completed) {
      summary.elapsedUs = offset();
      summary.outcome = error ? isHistoryReadCancelled(error) ? 'cancelled' : 'error'
        : completed ? 'success' : 'incomplete';
      summary.incomplete = !completed || stages.some(stage => summary[stage + 'StartUs'] !== null && summary[stage + 'EndUs'] === null);
      // Observation runs only after existing cleanup. A throwing observer
      // cannot replace a return/error or prevent endBuild/release-once.
      try { observer(summary); } catch {}
    },
  };
}

module.exports = { beginUnitReadDiagnostic };
