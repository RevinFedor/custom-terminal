'use strict';

const { collectDescendantProcessEntries } = require('./terminal-process-cwd');
const { knownProcessLookup, unknownProcessLookup } = require('./ai-process-liveness');

/**
 * One point-in-time inventory for a single Quit, including a failed observation.
 * Normal process lookups deliberately do NOT cache unknown; a shutdown sweep
 * must not turn that policy into one failing global ps per saved terminal.
 *
 * Targets/scopes are frozen before the one snapshot admission. Reuse the normal
 * descendant walker and provider classifier, but keep this receipt local to
 * shutdown: it is neither a live process cache nor authority to signal a PID,
 * write a PTY, launch, or adopt a session. Recovery still needs its own identity
 * proof; destructive consumers must obtain their own current process proof.
 */
async function captureShutdownProcessProof({
  targets,
  readSnapshot,
  isScopeCurrent,
  getProcessName,
  now,
  maxAgeMs,
}) {
  const owners = new Map(targets.map(({ tabId, processScope }) => [tabId, processScope]));
  const results = new Map();
  const startedAt = now();
  let snapshot = null;
  let failure = null;
  if (owners.size > 0) {
    try {
      // Main supplies its existing force-fresh single-flight reader. No retry,
      // new timeout, negative global cache, or per-tab process request here.
      snapshot = await readSnapshot();
      const at = now();
      if (!(snapshot?.children instanceof Map)
        || !(snapshot?.processesByPid instanceof Map)
        || !Number.isFinite(snapshot.createdAt)
        || snapshot.createdAt < startedAt
        || snapshot.createdAt > at
        || !(maxAgeMs > 0) || at - snapshot.createdAt >= maxAgeMs) {
        throw new Error('shutdown-process-snapshot-stale-or-invalid');
      }
    } catch (error) {
      failure = error;
    }
  }
  const unknown = (tabId, reason) => unknownProcessLookup(reason, {
    tabId, expectedName: null, source: 'shutdown-inventory',
  });
  for (const [tabId, scope] of owners) {
    try {
      if (failure) throw failure;
      if (!scope?.terminal || !isScopeCurrent(tabId, scope)) {
        throw new Error('process_scope_changed');
      }
      const shellPid = Number(scope.terminal.pid);
      if (!Number.isInteger(shellPid) || shellPid <= 1) throw new Error('shutdown-shell-pid-invalid');
      const matches = collectDescendantProcessEntries(snapshot.children, shellPid)
        .map(entry => ({ ...entry, processName: getProcessName(entry.cmd) }))
        .filter(entry => entry.processName);
      results.set(tabId, knownProcessLookup(matches, {
        tabId, expectedName: null, source: 'shutdown-inventory',
      }));
    } catch (error) {
      results.set(tabId, unknown(tabId, error));
    }
  }
  const counts = { found: 0, absent: 0, unknown: 0 };
  for (const result of results.values()) counts[result.status] += 1;
  return {
    summary: { targets: owners.size, snapshotReads: owners.size > 0 ? 1 : 0,
      ...counts, durationMs: Math.max(0, now() - startedAt),
      snapshotError: failure ? String(failure?.message || failure).slice(0, 200) : null },
    lookup(tabId) {
      // Earlier recovery may await descriptor IO. Never attach the frozen
      // observation to a replacement terminal/run/launch when the loop resumes.
      const scope = owners.get(tabId);
      try {
        if (!scope || !isScopeCurrent(tabId, scope)) throw new Error('process_scope_changed');
        return results.get(tabId);
      } catch (error) {
        return unknown(tabId, error);
      }
    },
  };
}

module.exports = { captureShutdownProcessProof };
