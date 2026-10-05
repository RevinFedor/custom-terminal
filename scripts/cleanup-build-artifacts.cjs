#!/usr/bin/env node
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const { planOldArtifacts, applyTargets, DAY, auditFor } = require('./lib/build-artifact-retention.cjs');

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const beforeAt = args.indexOf('--before');
  const beforeDate = beforeAt < 0 ? undefined : args[beforeAt + 1];
  const home = os.homedir();
  const plan = await planOldArtifacts({ home, beforeDate, minAgeMs: 2 * DAY });
  if (!apply) { console.log(JSON.stringify({ mode: 'dry-run', cutoff: plan.cutoff, targetCount: plan.targets.length, skippedCount: plan.skipped.length,
    ...(args.includes('--list') ? { targets: plan.targets.slice(0, 200), listTruncated: plan.targets.length > 200 } : {}) })); return; }
  const disk = () => { const s = fs.statfsSync(home); return Number(s.bavail) * Number(s.bsize); };
  const beforeFreeBytes = disk();
  const result = await applyTargets(plan.targets, { source: beforeDate ? 'manual-old-build-cleanup' : 'automatic-old-build-cleanup' });
  const summary = { ...result, beforeFreeBytes, afterFreeBytes: disk(), cutoff: plan.cutoff, protectedGroups: plan.skipped,
    sessionIdsDeleted: [], installedApplicationsTouched: false };
  await auditFor(home).record({ source: 'build-artifacts', status: 'maintenance-summary', ...summary });
  console.log(JSON.stringify({ operationId: result.operationId, removedCount: result.removed.length, skippedCount: result.skipped.length,
    beforeFreeBytes, afterFreeBytes: summary.afterFreeBytes, removedSample: result.removed.slice(0, 10), skippedSample: result.skipped.slice(0, 10) }));
}
if (require.main === module) main().catch(e => { console.error('[BuildArtifactCleanup] ' + e.stack); process.exitCode = 1; });
module.exports = { main };
