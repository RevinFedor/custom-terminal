'use strict';

// Installation is a projection, never a change to busy, delivery or Research.
// Only the app's strictly persisted run snapshot can certify an external wait.
const { externalResearchJobId, externalResearchRequestFingerprint } = require('./external-research-request');
const { sourceTarget } = require('./external-research-operational');
const { hasBirth } = require('./external-research-completion-delivery');
const { orchestrationInstallBlockers } = require('./orchestration-runs');

function preservedExternalWait(run) {
  const target = sourceTarget(run);
  if (run.runKind !== 'external-research' || run.targetTabId
    || !run.sourceTabId || !run.sourceProjectId || !run.externalResearchIntent
    || !['claude', 'codex'].includes(target?.toolType) || !target.sessionId
    || run.externalResearchJobId !== externalResearchJobId(run.runId)
    || !run.requestFingerprint) return false;
  const fingerprint = externalResearchRequestFingerprint({ runId: run.runId,
    sourceTabId: run.sourceTabId, request: run.externalResearchIntent, label: run.label || '',
    parentRunId: run.parentRunId || '', continueFromRunId: run.externalResearchContinuedFromRunId || '',
    notifySource: run.notifySource !== false });
  if (!hasBirth(run) && fingerprint !== run.requestFingerprint) return false;
  // Old/unknown local completion writes remain blockers. SC's own unknown
  // Send does not gain any authority here; its exact job is merely retained.
  if (run.notificationAttemptedAt && !run.sourceFollowupStartedAt
    || ['sending', 'unconfirmed', 'audit-pending'].includes(run.notificationStatus)
    || ['unknown', 'observing'].includes(run.externalResearchDelivery?.phase)
    || Object.values(run.externalResearchOperational?.notices || {}).some(n => ['sending', 'unknown'].includes(n.delivery))) return false;
  return true;
}

function projectInstallEligibility({ runtime, input, runs }) {
  if (!runtime || !Array.isArray(runtime.loaders) || typeof runtime.idle !== 'boolean'
    || !Array.isArray(input) || !Array.isArray(runs)) throw new Error('install_state_unavailable');
  const blockers = runtime.loaders.filter(l => l?.kind !== 'prompt-queue');
  if (!runtime.idle && runtime.loaders.length === 0) blockers.push({ kind: 'runtime', status: 'unknown' });
  blockers.push(...input);
  const preserved = [];
  for (const run of runs) {
    const projected = orchestrationInstallBlockers(run);
    if (!projected.length) continue;
    if (preservedExternalWait(run)) {
      preserved.push({ runId: run.runId, jobId: run.externalResearchJobId,
        sourceTabId: run.sourceTabId, sourceTarget: sourceTarget(run), status: run.status,
        resultComplete: run.resultComplete === true });
    } else blockers.push(...projected);
  }
  // Do not deduplicate by tab: an external wait must never conceal that same
  // source's physical input or a second non-preservable orchestration.
  return { version: 1, known: true, eligible: blockers.length === 0,
    blockers, preservedExternalWaits: preserved, preservedQueues: runtime.loaders.filter(l => l?.kind === 'prompt-queue'), ts: Date.now() };
}

function createBuildInstallEligibility({ store, readRuntime, readInput }) {
  return async () => {
    const runs = await store.installSnapshot();
    const input = await readInput();
    const runtime = await readRuntime(); // current turns after the input reader's final await
    return projectInstallEligibility({ runtime, input, runs });
  };
}

module.exports = { createBuildInstallEligibility, projectInstallEligibility, preservedExternalWait };
