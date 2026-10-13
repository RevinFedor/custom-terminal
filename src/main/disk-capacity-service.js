'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { constants: osConstants } = require('node:os');
const { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES, DISK_CAPACITY_RESERVE_BYTES } = require('./history-cache-policy');
const INTERVAL_MS = 30_000;
const FRESH_MS = 60_000;
const SLOW_SAMPLE_MS = 250;
const SAFE_ERROR_CODES = new Set([...Object.keys(osConstants.errno), 'cancelled', 'scan-limit',
  'cache-symlink', 'invalid-measurement', 'measure-failed', 'destroyed', 'sender-destroyed']);
const capacityError = code => Object.assign(new Error(code), { code });
// Neither IPC nor logs receive filesystem paths or arbitrary exception text.
function diskCapacityErrorCode(error) {
  return typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code) ? error.code : 'measure-failed';
}

function capacityProjection(freeBytes, cacheBytes, budgetBytes, reserveBytes) {
  for (const value of [freeBytes, cacheBytes, budgetBytes, reserveBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw capacityError('invalid-measurement');
  }
  const remainingGrowthBytes = Math.max(0, budgetBytes - cacheBytes);
  const projectedFreeBytes = freeBytes - remainingGrowthBytes;
  return { freeBytes, cacheBytes, budgetBytes, reserveBytes, remainingGrowthBytes,
    projectedFreeBytes, warning: projectedFreeBytes < reserveBytes };
}

// Only file metadata beneath this cache. No databases, histories, home inventory
// or symlink traversal. File sizes use the same accounting as cache eviction;
// every schema directory and SQLite sidecar belongs to the shared disk budget.
async function readCacheDiskBytes(root, { fsApi = fs, now = Date.now,
  maxEntries = 100_000, maxDurationMs = 5_000, isCancelled = () => false } = {}) {
  const started = now();
  let count = 0, bytes = 0;
  const pending = [root];
  const checkLimit = entriesExceeded => {
    const elapsedMs = Math.max(0, now() - started);
    const limit = elapsedMs > maxDurationMs ? 'duration' : entriesExceeded ? 'entries' : null;
    if (limit) throw Object.assign(capacityError('scan-limit'), {
      scanDiagnostic: { limit, scannedEntries: count, pendingEntries: pending.length, elapsedMs },
    });
  };
  while (pending.length) {
    if (isCancelled()) throw capacityError('cancelled');
    checkLimit(count + 1 > maxEntries);
    count++;
    const item = pending.pop();
    let stat;
    try { stat = await fsApi.lstat(item); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw capacityError('cache-symlink');
    if (stat.isDirectory()) {
      let directory;
      try { directory = await fsApi.opendir(item); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for await (const entry of directory) {
        checkLimit(pending.length + count >= maxEntries);
        if (isCancelled()) throw capacityError('cancelled');
        pending.push(path.join(item, entry.name));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) throw capacityError('invalid-measurement');
    }
  }
  return bytes;
}

async function readFreeDiskBytes(cacheDirectory, { fsApi = fs } = {}) {
  let directory = cacheDirectory;
  for (;;) {
    try {
      // bavail, not bfree: only bytes available to this user count as headroom.
      const stat = await fsApi.statfs(directory, { bigint: true });
      const bytes = Number(BigInt(stat.bavail) * BigInt(stat.bsize));
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw capacityError('invalid-measurement');
      return bytes;
    } catch (error) {
      const parent = path.dirname(directory);
      if (error.code !== 'ENOENT' || parent === directory) throw error;
      directory = parent; // Initial run: the cache/schema directory may not exist yet.
    }
  }
}

function createDiskCapacityService({ cacheDirectory, budgetBytes = HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES,
  reserveBytes = DISK_CAPACITY_RESERVE_BYTES, intervalMs = INTERVAL_MS, freshMs = FRESH_MS,
  fsApi = fs, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  readUsage = readCacheDiskBytes, readFree = readFreeDiskBytes, epoch = randomUUID(),
  log = console, slowSampleMs = SLOW_SAMPLE_MS, getRamUsage } = {}) {
  if (!path.isAbsolute(cacheDirectory || '')) throw new TypeError('absolute cacheDirectory required');
  capacityProjection(0, 0, budgetBytes, reserveBytes);
  let destroyed = false, timer = null, inFlight = null, revision = 0;
  const subscribers = new Map();
  const empty = status => ({ scope: 'history-prepared-cache', epoch, revision, status,
    measuredAt: null, expiresAt: null, freeBytes: null, cacheBytes: null,
    remainingGrowthBytes: null, projectedFreeBytes: null, warning: null, budgetBytes, reserveBytes });
  let snapshot = Object.freeze(empty('unknown'));
  let loggedState = 'unknown', loggedErrorCode = null;
  const logMeasurement = (value, durMs) => {
    const state = value.status === 'ready' ? value.warning ? 'ready-warning' : 'ready-healthy' : value.status;
    const errorCode = value.errorCode || null;
    const stateKey = state + ':' + (value.ram?.status || 'unknown');
    const transition = stateKey !== loggedState || errorCode !== loggedErrorCode;
    loggedState = stateKey; loggedErrorCode = errorCode;
    if (!transition && durMs < slowSampleMs) return;
    const record = { state, transition, slow: durMs >= slowSampleMs, durMs,
      source: 'statfs+cache-file-metadata', budgetBytes, reserveBytes, freeBytes: value.freeBytes,
      cacheBytes: value.cacheBytes, remainingGrowthBytes: value.remainingGrowthBytes,
      projectedFreeBytes: value.projectedFreeBytes, errorCode,
      ramStatus: value.ram?.status || 'unknown', ramApproxBytes: value.ram?.approxBytes ?? null,
      ramBudgetBytes: value.ram?.budgetBytes ?? null,
      ramReason: value.ram?.reason || 'unavailable', ramWorkerGeneration: value.ram?.workerGeneration ?? null,
      ...(value.scanDiagnostic ? { scanDiagnostic: value.scanDiagnostic } : {}) };
    try { (state === 'error' || record.slow ? log.warn : log.log)?.call(log, '[DiskCapacity] ' + JSON.stringify(record)); } catch {}
  };
  const stopTimer = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  const schedule = () => {
    stopTimer();
    if (destroyed || !subscribers.size) return;
    timer = setTimeoutFn(() => { timer = null; void sample(); }, intervalMs);
    timer?.unref?.();
  };
  function sample() {
    if (destroyed) return Promise.resolve({ ...empty('unknown'), errorCode: 'destroyed' });
    if (inFlight) return inFlight;
    stopTimer();
    inFlight = (async () => {
      const startedAt = now();
      let result;
      try {
        const cacheBytes = await readUsage(cacheDirectory, { fsApi, now, isCancelled: () => destroyed });
        if (destroyed) return { ...empty('unknown'), errorCode: 'destroyed' };
        const freeBytes = await readFree(cacheDirectory, { fsApi });
        const measuredAt = now();
        result = { ...empty('ready'), ...capacityProjection(freeBytes, cacheBytes, budgetBytes, reserveBytes),
          measuredAt, expiresAt: measuredAt + freshMs };
      } catch (error) {
        result = { ...empty('error'), errorCode: diskCapacityErrorCode(error) };
        if (result.errorCode === 'scan-limit' && ['duration', 'entries'].includes(error?.scanDiagnostic?.limit)) {
          const diagnostic = error.scanDiagnostic;
          if (['scannedEntries', 'pendingEntries', 'elapsedMs'].every(key => Number.isSafeInteger(diagnostic[key]) && diagnostic[key] >= 0)) {
            result.scanDiagnostic = { limit: diagnostic.limit, scannedEntries: diagnostic.scannedEntries,
              pendingEntries: diagnostic.pendingEntries, elapsedMs: diagnostic.elapsedMs };
          }
        }
      }
      let ram = { status: 'unknown', approxBytes: null, budgetBytes: null, approximate: true, reason: 'unavailable' };
      try {
        const value = getRamUsage?.();
        const valid = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0;
        ram.budgetBytes = valid('budgetBytes') ? value.budgetBytes : null;
        if (['not-started', 'worker-starting', 'cache-counters', 'invalid-counters', 'worker-unavailable', 'client-closed'].includes(value?.reason)) ram.reason = value.reason;
        if (valid('workerGeneration')) ram.workerGeneration = value.workerGeneration;
        if (value?.status === 'ready' && valid('approxBytes') && valid('budgetBytes')) {
          const measuredAt = now();
          ram = { ...ram, status: 'ready', approxBytes: value.approxBytes,
            measuredAt, expiresAt: measuredAt + freshMs };
        }
      } catch { ram.reason = 'counter-error'; /* Cannot erase a valid disk measurement. */ }
      result = { ...result, ram };
      if (destroyed) return { ...empty('unknown'), errorCode: 'destroyed' };
      snapshot = Object.freeze({ ...result, revision: ++revision });
      logMeasurement(snapshot, Math.max(0, Math.round(now() - startedAt)));
      for (const callback of subscribers.values()) { try { callback(snapshot); } catch {} }
      return snapshot;
    })().finally(() => { inFlight = null; schedule(); });
    return inFlight;
  }
  return {
    sample,
    snapshot: () => snapshot,
    subscribe(id, callback) {
      if (destroyed) return Promise.resolve({ ...empty('unknown'), errorCode: 'destroyed' });
      subscribers.set(id, callback);
      if (snapshot.status === 'ready' && now() - snapshot.measuredAt < intervalMs) {
        if (timer === null && !inFlight) schedule();
        return Promise.resolve(snapshot);
      }
      return sample();
    },
    unsubscribe(id) { subscribers.delete(id); if (!subscribers.size) stopTimer(); },
    destroy() { destroyed = true; subscribers.clear(); stopTimer(); },
  };
}

function installDiskCapacityIpc({ ipcMain, cacheDirectory, service = createDiskCapacityService({ cacheDirectory }) }) {
  const subscribers = new Map();
  const remove = sender => {
    const lease = subscribers.get(sender);
    if (!lease) return;
    subscribers.delete(sender);
    service.unsubscribe(sender.id);
    sender.removeListener('destroyed', lease.cleanup);
    sender.removeListener('render-process-gone', lease.cleanup);
    sender.removeListener('did-start-navigation', lease.navigation);
  };
  ipcMain.handle('system:disk-capacity-subscribe', (event, token) => {
    if (typeof token !== 'string' || !token || token.length > 128) throw new Error('invalid-subscription');
    const sender = event.sender;
    if (sender.isDestroyed()) return { status: 'error', errorCode: 'sender-destroyed' };
    if (subscribers.get(sender)?.token !== token) {
      remove(sender);
      const cleanup = () => remove(sender);
      const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cleanup(); };
      subscribers.set(sender, { token, cleanup, navigation });
      sender.once('destroyed', cleanup);
      sender.once('render-process-gone', cleanup);
      sender.on('did-start-navigation', navigation);
    }
    return service.subscribe(sender.id, snapshot => {
      if (sender.isDestroyed()) { remove(sender); return; }
      try { sender.send('system:disk-capacity', snapshot); } catch { remove(sender); }
    });
  });
  ipcMain.handle('system:disk-capacity-unsubscribe', (event, token) => {
    if (subscribers.get(event.sender)?.token === token) remove(event.sender);
    return { success: true };
  });
  return () => {
    for (const sender of subscribers.keys()) remove(sender);
    service.destroy();
    ipcMain.removeHandler('system:disk-capacity-subscribe');
    ipcMain.removeHandler('system:disk-capacity-unsubscribe');
  };
}

module.exports = { INTERVAL_MS, FRESH_MS, SLOW_SAMPLE_MS, diskCapacityErrorCode, capacityProjection, readCacheDiskBytes, readFreeDiskBytes,
  createDiskCapacityService, installDiskCapacityIpc };
