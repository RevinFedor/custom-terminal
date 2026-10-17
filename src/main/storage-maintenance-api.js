'use strict';

const crypto = require('node:crypto');
const CAPABILITY = Object.freeze({ version: 1, inventory: '/api/storage/inventory',
  plan: '/api/storage/plan', cleanup: '/api/storage/cleanup',
  receipt: '/api/storage/cleanup/:operationId', databaseSpace: '/api/storage/database-space',
  closedHistory: true, ragPreserved: true, testRuns: true });
const key = operationId => 'storage.cleanup.receipt.v1:' + operationId;

function createStorageMaintenance({ getService, database, onCleanup = () => {} }) {
  return {
    inventory: request => getService().scan({ force: request?.force === true }),
    plan: request => getService().runRetentionSweep({ dryRun: true,
      maxItems: Math.max(1, Math.min(250, Number(request?.maxItems) || 250)), maxBytes: Number.MAX_SAFE_INTEGER }),
    receipt: operationId => database.getAppState(key(operationId)) || null,
    databaseSpace: () => {
      const db = database.db, pageSize = db.pragma('page_size', { simple: true });
      const pageCount = db.pragma('page_count', { simple: true });
      const freePages = db.pragma('freelist_count', { simple: true });
      const has = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      return { pageSize, pageCount, freePages, allocatedBytes: pageSize * pageCount,
        reusableBytes: pageSize * freePages, autoVacuum: db.pragma('auto_vacuum', { simple: true }),
        workflowSnapshots: has('workflow_org_generations') ? db.prepare('SELECT COUNT(*) count FROM workflow_org_generations').get().count : 0,
        expiredHistory: has('storage_expired_tab_history') ? db.prepare('SELECT COUNT(*) count FROM storage_expired_tab_history').get().count : 0,
        physicalShrinkRequiresCompaction: db.pragma('auto_vacuum', { simple: true }) === 0 && freePages > 0 };
    },
    async cleanup(request) {
      const operationId = String(request?.operationId || '');
      if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(operationId)) throw new Error('storage_operation_id_required');
      const frozen = { operationId, maxItems: Math.max(1, Math.min(250, Number(request.maxItems) || 250)) };
      const hash = crypto.createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
      const previous = database.getAppState(key(operationId));
      if (previous) {
        if (previous.requestHash !== hash) throw new Error('storage_operation_id_conflict');
        return previous; // started/unknown is NOT permission to repeat a sweep.
      }
      const record = { operationId, requestHash: hash, state: 'started', startedAt: Date.now() };
      database.setAppState(key(operationId), record);
      try {
        const result = await getService().runRetentionSweep({ maxItems: frozen.maxItems, maxBytes: Number.MAX_SAFE_INTEGER });
        const receipt = { ...record, state: 'completed', completedAt: Date.now(), result };
        database.setAppState(key(operationId), receipt);
        try { onCleanup(result, operationId); }
        catch (error) { console.warn('[StorageCleanup:API] notification failed: ' + error.message); }
        return receipt;
      } catch (error) {
        const receipt = { ...record, state: 'unknown', error: error.code || error.message };
        database.setAppState(key(operationId), receipt);
        return receipt;
      }
    },
  };
}

async function handleStorageMaintenance({ req, res, parsed, api, readBody, sendJson }) {
  if (!parsed.pathname.startsWith('/api/storage/')) return false;
  if (!api) { sendJson(res, 503, { success: false, error: 'storage_api_unavailable' }); return true; }
  try {
    let result;
    if (req.method === 'GET' && parsed.pathname === CAPABILITY.inventory) result = await api.inventory({ force: parsed.query?.force === 'true' });
    else if (req.method === 'GET' && parsed.pathname === CAPABILITY.plan) result = await api.plan({ maxItems: parsed.query?.maxItems });
    else if (req.method === 'GET' && parsed.pathname === CAPABILITY.databaseSpace) result = api.databaseSpace();
    else if (req.method === 'POST' && parsed.pathname === CAPABILITY.cleanup) result = await api.cleanup(await readBody(req));
    else if (req.method === 'GET' && /^\/api\/storage\/cleanup\/[^/]+$/.test(parsed.pathname)) result = api.receipt(decodeURIComponent(parsed.pathname.split('/').pop()));
    else { sendJson(res, 404, { success: false, error: 'storage_route_not_found' }); return true; }
    sendJson(res, 200, result);
  } catch (error) { sendJson(res, 409, { success: false, error: error.code || error.message }); }
  return true;
}

module.exports = { CAPABILITY, createStorageMaintenance, handleStorageMaintenance };
