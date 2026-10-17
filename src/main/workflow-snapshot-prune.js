'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// These are redundant diagnostic snapshots, not the publication/current
// workflow tables, migration source, mutation receipts or RAG. No runtime
// reader restores them. Keep the first migration snapshot + the latest two.
function snapshotPrunePlan(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_org_meta'").get();
  if (hasMeta && db.prepare('SELECT schema_version FROM workflow_org_meta WHERE singleton=1').get()?.schema_version !== 1)
    throw new Error('workflow_snapshot_schema_unknown');
  const bounds = db.prepare('SELECT MIN(generation) first, MAX(generation) latest FROM workflow_org_generations').get();
  if (bounds.latest == null) return { first: null, before: 0, count: 0 };
  const before = bounds.latest - 1;
  const count = db.prepare('SELECT COUNT(*) count FROM workflow_org_generations WHERE generation<>? AND generation<?')
    .get(bounds.first, before).count;
  return { first: bounds.first, before, count };
}

function pruneSnapshotBatch(db, { limit = 4, dryRun = false } = {}) {
  const plan = snapshotPrunePlan(db);
  if (dryRun || !plan.count) return { ...plan, removed: 0 };
  const ids = db.prepare('SELECT generation FROM workflow_org_generations WHERE generation<>? AND generation<? ORDER BY generation LIMIT ?')
    .all(plan.first, plan.before, Math.max(1, Math.min(16, limit))).map(row => row.generation);
  // Recheck bounds in the DELETE itself. A newer publication only adds safe
  // old candidates; no receipt/current organization row is ever consumed.
  const remove = db.prepare(`DELETE FROM workflow_org_generations WHERE generation=?
    AND generation<>(SELECT MIN(generation) FROM workflow_org_generations)
    AND generation<(SELECT MAX(generation)-1 FROM workflow_org_generations)`);
  let removed = 0;
  for (const generation of ids) removed += remove.run(generation).changes;
  return { ...plan, removed };
}

function startSnapshotPrune(databasePath, logger = console) {
  if (!isMainThread || !path.isAbsolute(databasePath || '')) return null;
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    logger.warn?.('[WorkflowSnapshots:Prune] skipped reason=database-not-exclusive-physical-file'); return null;
  }
  const actual = fs.realpathSync(databasePath);
  if (process.env.NOTED_E2E_TEST === 'true') {
    const isolation = process.env.NOTED_E2E_CLI_ISOLATION_ROOT;
    if (!isolation || !actual.startsWith(fs.realpathSync(isolation) + path.sep)) {
      logger.warn?.('[WorkflowSnapshots:Prune] skipped reason=test-database-outside-private-scope'); return null;
    }
  }
  const operationId = randomUUID();
  logger.log?.('[WorkflowSnapshots:Prune] ' + JSON.stringify({ operationId, phase: 'start', databasePath: actual, startedAt: Date.now() }));
  const worker = new Worker(__filename, { workerData: { databasePath: actual, operationId,
    identity: { dev: stat.dev, ino: stat.ino } } });
  worker.unref();
  worker.on('message', result => logger.log?.('[WorkflowSnapshots:Prune] ' + JSON.stringify({ operationId, ...result })));
  worker.on('error', error => logger.warn?.('[WorkflowSnapshots:Prune] ' + JSON.stringify({ operationId, error: error.message })));
  return worker;
}

if (!isMainThread && workerData?.databasePath) {
  const current = fs.lstatSync(workerData.databasePath);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== workerData.identity.dev
    || current.ino !== workerData.identity.ino || current.nlink !== 1) throw new Error('workflow_snapshot_database_identity_changed');
  const Database = require('better-sqlite3');
  const db = new Database(workerData.databasePath, { fileMustExist: true, timeout: 50 });
  let removed = 0;
  const startedAt = Date.now();
  (async () => {
    try {
      for (;;) {
        const result = pruneSnapshotBatch(db);
        removed += result.removed;
        if (!result.removed) break;
        // Yield the writer lock between small transactions, not a long Main
        // DELETE/VACUUM. Publication/Send can continue while old pages recycle.
        await new Promise(resolve => setImmediate(resolve));
      }
      const plan = snapshotPrunePlan(db);
      const autoVacuum = db.pragma('auto_vacuum', { simple: true });
      if (autoVacuum === 2) db.pragma('incremental_vacuum(128)');
      parentPort.postMessage({ removed, remaining: plan.count, elapsedMs: Date.now() - startedAt,
        freePages: db.pragma('freelist_count', { simple: true }),
        pageSize: db.pragma('page_size', { simple: true }),
        incrementalVacuum: autoVacuum === 2,
        physicalShrinkRequiresCompaction: autoVacuum === 0 });
    } catch (error) {
      parentPort.postMessage({ removed, error: error.code || error.message, elapsedMs: Date.now() - startedAt, retry: 'next-publication' });
    } finally { db.close(); }
  })().catch(error => { db.close(); throw error; });
}

module.exports = { snapshotPrunePlan, pruneSnapshotBatch, startSnapshotPrune };
