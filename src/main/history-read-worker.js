'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => parentPort.postMessage({
  event: 'log', level, emittedAt: Date.now(), correlation: requestContext.getStore()?.correlation,
  text: args.map(value => String(value)).join(' ').slice(0, 16000),
});
const fs = require('node:fs');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const codexData = require('./ipc/codex-data');
const { createSessionTranscriptService } = require('./session-transcript-service');
const { HistoryPreparedCache, exactSource } = require('./history-prepared-cache');
const { historyPayloadStash, dehydrateHistoryEntries } = require('./history-payload-dehydrate');
const { historyPreparationActivity } = require('./history-preparation-activity');
const { observeHistoryResponseTimingBindings } = require('./history-response-timings');
const { PromptQueueAssetStore } = require('./prompt-queue-assets');
const { recordCodexProcessActionOwnership } = require('./codex-process-action-ownership');
const { beginHistoryReadDiagnostic } = require('./history-read-memory-diagnostics');

// This connection uses the existing application's schema and exact methods.
// It does not run startup migrations, create tabs, or own runtime delivery.
const db = workerData.databasePath ? new DatabaseManager({
  existingConnection: new Database(workerData.databasePath, { fileMustExist: true }),
}) : null;
if (db) {
  db.db.pragma('busy_timeout = 5000');
}
// Parsed data is valid for the exact parser/preparation implementation. A
// source update must not silently reuse a previous version's interpretation.
const schemaHash = crypto.createHash('sha256');
schemaHash.update(process.versions.v8);
const srcRoot = require('node:path').resolve(__dirname, '..');
for (const filename of Object.keys(require.cache).filter(name => name.startsWith(srcRoot + require('node:path').sep)
  && /\.(?:js|cjs)$/.test(name)).sort()) {
  schemaHash.update(require('node:path').relative(srcRoot, filename));
  schemaHash.update(fs.readFileSync(filename));
}
const startupCacheDiagnostics = [];
const cache = new HistoryPreparedCache({ directory: workerData.cacheDirectory, maxBytes: workerData.diskBudgetBytes,
  onDiagnostic: event => { if (startupCacheDiagnostics.length < 8) startupCacheDiagnostics.push(event); },
  indexBudgetBytes: workerData.indexBudgetBytes,
  schema: '1-' + schemaHash.digest('hex').slice(0, 20) });
const DIAGNOSTIC_SCHEMA = 1, MAX_PHASE_GROUPS = 16;
const slowMs = Number.isFinite(workerData.diagnosticSlowMs) ? Math.max(0, workerData.diagnosticSlowMs) : 100;
const stamp = () => { const perf = performance.now(); return { abs: performance.timeOrigin + perf, perf }; };
const token = value => typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value) ? value : 'other';
const identity = value => value == null || value === '' ? null : token(String(value)) !== 'other' ? String(value)
  : 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const counters = { requests: 0, completed: 0, errors: 0, rebuilds: 0, cacheMisses: 0, cacheErrors: 0, cacheEvictions: 0, droppedPhaseGroups: 0 };
const count = name => { counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + 1); };
function emitDiagnostic(event, fields = {}) {
  const now = stamp();
  try { parentPort.postMessage({ event: 'diagnostic', diagnostic: { schema: DIAGNOSTIC_SCHEMA, side: 'worker', event,
    clientId: workerData.diagnosticClientId || null, workerGeneration: workerData.diagnosticGeneration || 0,
    emittedAbs: now.abs, emittedPerf: now.perf, ...fields } }); } catch {}
}
// A fixed-size, request-local summary. No payload, path, SQL, row identity or
// error text is retained, and repeated row/page phases only increment counters.
function phaseDiagnostic(event) {
  const context = requestContext.getStore();
  const phase = token(event.phase || event.operation), outcome = token(event.outcome), reason = token(event.reason);
  if (outcome === 'miss') count('cacheMisses');
  if (outcome === 'error') count('cacheErrors');
  if (outcome === 'evicted') count('cacheEvictions');
  const exceptional = ['miss', 'error', 'invalidated', 'evicted', 'rebuild', 'disabled', 'rejected', 'removed', 'deferred', 'skipped'].includes(outcome)
    || event.indexOutcome === 'miss' || event.evictedCount > 0 || event.errorCount > 0;
  if (!context) {
    if (exceptional) emitDiagnostic('cache-background', { phase, outcome, reason });
    return;
  }
  context.exceptional ||= exceptional;
  // Fixed categories survive phase truncation, even when a late rejection
  // follows many successful cache operations. They are observations, not proof.
  if (exceptional) {
    context.lastException = { phase, outcome, reason, atAbs: performance.timeOrigin + performance.now() };
    for (const field of ['errorName', 'errorCode', 'errorModule', 'cacheVersion', 'otherVersion']) {
      if (typeof event[field] === 'string') context.lastException[field] = token(event[field]);
    }
    for (const field of ['errorLine', 'errorColumn']) {
      if (Number.isFinite(event[field])) context.lastException[field] = event[field];
    }
    const category = outcome === 'error' ? 'error' : reason === 'no-file' ? 'missingFile'
      : reason === 'disk-quota' ? 'diskEvicted' : reason.includes('version') ? 'version'
      : outcome === 'disabled' || reason === 'disabled' ? 'disabled'
      : /^(source-|write-invalidated|invalidation)/.test(reason) ? 'sourceChange' : 'other';
    context.cacheReasons[category] = Math.min(Number.MAX_SAFE_INTEGER, context.cacheReasons[category] + 1);
  }
  if (outcome === 'hit' && (event.source === 'ssd'
    || ['readPrepared', 'readTimeline', 'readPayload', 'readContinuation', 'readVirtualProjection', 'readVirtualState'].includes(phase))) context.ssdHits++;
  if (event.source === 'ram' && outcome === 'hit') context.ramHits++;
  const key = phase + ':' + outcome + ':' + reason + ':' + token(event.indexReason) + ':' + token(event.errorReason);
  let group = context.phases.get(key);
  if (!group) {
    if (context.phases.size >= MAX_PHASE_GROUPS) {
      context.droppedPhaseGroups++; count('droppedPhaseGroups');
      const ordinary = exceptional ? [...context.phases].find(([, item]) => !item.exceptional) : null;
      if (!ordinary) return;
      context.phases.delete(ordinary[0]);
    }
    const now = stamp();
    group = { phase, outcome, reason, exceptional, count: 0, firstAbs: now.abs, lastAbs: now.abs };
    for (const field of ['layer', 'cacheTier', 'indexOutcome', 'indexReason', 'errorReason', 'causeOperation', 'cacheVersion', 'otherVersion', 'errorName', 'errorCode', 'errorModule']) {
      if (typeof event[field] === 'string') group[field] = token(event[field]);
    }
    context.phases.set(key, group);
  }
  group.count = Math.min(Number.MAX_SAFE_INTEGER, group.count + 1);
  group.lastAbs = performance.timeOrigin + performance.now();
  const started = context.cacheOperations?.findLast(item => item.operation === event.operation)?.started;
  const now = stamp();
  if (started) {
    group.durationMs = (group.durationMs || 0) + now.perf - started.perf;
    group.startAbs ??= started.abs; group.startPerf ??= started.perf;
    group.endAbs = now.abs; group.endPerf = now.perf;
  }
  for (const field of ['durationMs', 'serializeMs', 'writeMs', 'bytes', 'rows', 'records', 'pageRows', 'indexBytes', 'evictedBytes', 'evictedCount',
    'obsoleteEvictedCount', 'stateEvictedCount', 'rowsEvictedCount', 'timelineEvictedCount']) {
    if (field === 'durationMs' && started) continue;
    if (Number.isFinite(event[field]) && event[field] >= 0) group[field] = Math.min(Number.MAX_SAFE_INTEGER, (group[field] || 0) + event[field]);
  }
  for (const field of ['snapshotBytes', 'sourceBytes', 'indexMemoryBytes', 'indexBudgetBytes', 'diskBytes', 'budgetBytes', 'errorLine', 'errorColumn']) {
    if (Number.isFinite(event[field]) && event[field] >= 0) group[field] = event[field];
  }
}
// Optional on older cache implementations; assigned AFTER initialization so
// diagnostics cannot become constructor/proof/cache state.
cache.onDiagnostic = phaseDiagnostic;
for (const event of startupCacheDiagnostics) emitDiagnostic('cache-startup', {
  ...event, cacheVersion: require('node:path').basename(cache.directory),
});
startupCacheDiagnostics.length = 0;
// Cache summaries are emitted inside these operations. Their elapsed times
// include nested codec/I/O/prune work; do not subtract or sum them as CPU time.
for (const operation of ['readPrepared', 'savePrepared', 'readTimeline', 'saveTimeline', 'readContinuation', 'saveContinuation',
  'readSource', 'readSourceProof', 'saveSourceHeader', 'readPayload', 'savePayload', 'savePayloads', 'readVirtualProjection', 'saveVirtualProjection',
  'readVirtualState', 'saveVirtualState']) {
  const original = cache[operation];
  cache[operation] = function (...args) {
    const context = requestContext.getStore();
    if (!context) return original.apply(this, args);
    const item = { operation, started: stamp() };
    const active = context.cacheOperations ||= [];
    active.push(item);
    const finish = () => { const index = active.indexOf(item); if (index >= 0) active.splice(index, 1); };
    try {
      const result = original.apply(this, args);
      if (result?.then) return result.finally(finish);
      finish(); return result;
    } catch (error) { finish(); throw error; }
  };
}
const setMeta = cache.setMeta;
cache.setMeta = function (db, key, value, diagnostic) {
  if (key !== 'continuation' && key !== 'virtualState') return setMeta.call(this, db, key, value, diagnostic);
  const started = stamp(), before = { ...this.metrics };
  try { return setMeta.call(this, db, key, value, diagnostic); }
  finally { phaseDiagnostic({ phase: 'continuation-codec-write', outcome: 'observed', reason: key,
    durationMs: performance.now() - started.perf, bytes: this.metrics.continuationWriteBytes - before.continuationWriteBytes,
    serializeMs: this.metrics.continuationSerializeMs - before.continuationSerializeMs,
    writeMs: this.metrics.continuationWriteMs - before.continuationWriteMs }); }
};
cache.pendingPayloads = () => requestContext.getStore()?.payloads;
if (workerData.diagnosticStages) cache.onStage = phase => parentPort.postMessage({ event: 'cache-stage',
  sessionId: requestContext.getStore()?.payload.sessionId, ...phase });
const beginPreparation = historyPreparationActivity.begin.bind(historyPreparationActivity);
historyPreparationActivity.begin = options => {
  const finish = beginPreparation(options);
  const context = requestContext.getStore();
  if (!context) return finish;
  context.preparations.push(finish);
  const prepared = () => finish.update?.({ phase: 'preparing' });
  prepared.update = finish.update;
  return prepared;
};
const assets = workerData.assetDirectory ? new PromptQueueAssetStore({ rootDir: workerData.assetDirectory }) : null;
const send = (message, transfer = []) => parentPort.postMessage(message, transfer);
const writtenSources = new Set();
function rememberWrittenSource(filePath) {
  writtenSources.delete(filePath); writtenSources.add(filePath);
  if (writtenSources.size > 4096) writtenSources.delete(writtenSources.values().next().value);
}
let sourceBytes = 0, sourceVerificationBytes = 0;
const api = codexData._api;
const sourceEpochs = new Int32Array(workerData.sourceEpochBuffer);
const sourceEpochSlots = new Map(), epochPending = new Map();
const epochSlot = file => sourceEpochSlots.get(file) ?? 0;
cache.assertCurrent = () => {
  const context = requestContext.getStore();
  if (context && [...context.sources].some(file => context.sourceEpochs[epochSlot(file)] !== Atomics.load(sourceEpochs, epochSlot(file)))) {
    phaseDiagnostic({ phase: 'source-fence', outcome: 'invalidated', reason: 'source-epoch-invalidated' });
    throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  }
};
function prepareSourceEpoch(filePath) {
  // Every source access participates, including raw/search/payload/virtual
  // reads whose public DTO contains no revision or filePath.
  requestContext.getStore()?.sources.add(filePath);
  if (epochPending.has(filePath)) return epochPending.get(filePath).promise;
  if (sourceEpochSlots.has(filePath)) return Promise.resolve();
  let resolve; const registered = new Promise(done => { resolve = done; });
  const promise = registered.then(async () => {
    const owner = requestContext.getStore()?.payload;
    if (owner?.sessionId) {
      // A full-payload client may arrive before desktop after a restart.
      const saved = cache.readSource(owner);
      const stat = saved?.filePath === filePath ? await fs.promises.stat(filePath).catch(() => null) : null;
      if (saved && exactSource(saved, stat)) api.restoreCodexSourceSnapshot(saved);
    }
  }).finally(() => epochPending.delete(filePath));
  epochPending.set(filePath, { promise, resolve });
  send({ event: 'source-epoch', filePath });
  return promise;
}
api.setCodexExternalReadPrepare(prepareSourceEpoch);
api.setCodexExternalReadVersion(file => Atomics.load(sourceEpochs, epochSlot(file)));
const originalSourceCurrent = api.isCodexSourceSnapshotCurrent;
api.isCodexSourceSnapshotCurrent = snapshot => {
  const context = requestContext.getStore();
  if (context && snapshot?.filePath) {
    context.sources.add(snapshot.filePath);
    const slot = epochSlot(snapshot.filePath);
    if (context.sourceEpochs[slot] !== Atomics.load(sourceEpochs, slot)) {
      phaseDiagnostic({ phase: 'source-fence', outcome: 'invalidated', reason: 'source-epoch-invalidated' }); return false;
    }
  }
  return originalSourceCurrent(snapshot);
};
if (db) for (const method of ['bindHistoryPromptPresentationEntry', 'bindHistoryResponseTimingEntry']) {
  const bind = db[method].bind(db);
  db[method] = (...args) => {
    const context = requestContext.getStore();
    if (context && [...context.sources].some(file => context.sourceEpochs[epochSlot(file)] !== Atomics.load(sourceEpochs, epochSlot(file)))) {
      throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    }
    return bind(...args);
  };
}
const workerGraphBudget = Math.floor((workerData.memoryBudgetMb || 400) * 1024 * 1024);
const virtualGraphBudget = Math.min(128 * 1024 * 1024, Math.floor(workerGraphBudget / 4));
api.setCodexProjectionRuntimeBudgetBytes(workerGraphBudget - virtualGraphBudget);
for (const ownership of workerData.ownership || []) recordCodexProcessActionOwnership(ownership);
// One cold parser at a time; disk-page hits do not join this lane. Thus a
// visible warm seek can finish while another session yields during cold work.
let coldActive = false; const coldWaiters = [];
async function acquireCold() {
  if (coldActive) await new Promise(resolve => coldWaiters.push(resolve));
  else coldActive = true;
  let released = false;
  return () => {
    if (released) return; released = true;
    const next = coldWaiters.shift();
    if (next) next(); else coldActive = false;
  };
}
async function enterCold() {
  const context = requestContext.getStore();
  if (!context) return acquireCold();
  // Keep admission through yielded preparation/commit. Otherwise many cold
  // requests could accumulate full transient graphs while writing in turns.
  if (!context.coldAdmission) {
    const queued = stamp();
    context.coldQueuedAbs = queued.abs; context.coldQueuedPerf = queued.perf;
    context.coldQueueDepth = coldWaiters.length + Number(coldActive);
    context.coldAdmission = acquireCold().then(release => {
      const admitted = stamp();
      context.coldAdmittedAbs = admitted.abs; context.coldAdmittedPerf = admitted.perf;
      context.coldAdmissionMs = admitted.perf - queued.perf; context.coldRelease = release;
    });
  }
  await context.coldAdmission;
  return () => {}; // The owning RPC releases exactly once in its finally.
}
cache.enterCold = enterCold;

const findSource = api.findCodexSessionFile;
api.findCodexSessionFile = async (id, cwd) => {
  const found = await findSource(id, cwd, workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {});
  if (found?.filePath) await prepareSourceEpoch(found.filePath);
  return found;
};
const load = api.loadSessionRecords;
api.loadSessionRecords = async (id, cwd, options = {}) => {
  const result = await load(id, cwd, { ...options, ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}) });
  const context = requestContext.getStore();
  if (context && result.success) {
    context.loadedRecords = (context.loadedRecords || 0) + result.records.length;
    context.sourceSize = result.sourceSnapshot?.size;
    // This raw-record API does not expose its I/O/cache mode. Do not infer a
    // RAM hit or claim zero bytes from another session's cumulative counters.
    context.unmeasuredRecordRead = true;
  }
  return result;
};
const originalHistory = api.projectCodexFullHistoryFromFile;
function currentRewriteReceipt(id) {
  const receipt = requestContext.getStore()?.rewriteReceipt;
  return receipt?.sessionId === id ? receipt : null;
}
function observeProjection(result) {
  const context = requestContext.getStore();
  if (context && Number.isFinite(result?.fedRecords)) context.fedRecords += result.fedRecords;
  return result;
}
api.projectCodexFullHistoryFromFile = async (id, cwd, options = {}) => observeProjection(await originalHistory(id, cwd, {
  ...options, rewriteReceipt: currentRewriteReceipt(id),
  ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
}));
const originalTimeline = api.projectCodexTimelineFromFile;
api.projectCodexTimelineFromFile = async (id, cwd, options = {}) => {
  const found = await api.findCodexSessionFile(id, cwd);
  const stat = found?.filePath ? await fs.promises.stat(found.filePath).catch(() => null) : null;
  const saved = stat ? cache.readTimeline({ sessionId: id, cwd }, found.filePath, stat) : null;
  if (saved && api.restoreCodexSourceSnapshot(saved.source)) {
    const context = requestContext.getStore(); if (context) context.ssdHits++;
    return {
    success: true, filePath: found.filePath, entries: saved.entries, sessionMeta: saved.sessionMeta,
    sourceSnapshot: saved.source, mode: 'disk', fedRecords: 0,
    };
  }
  return observeProjection(await originalTimeline(id, cwd, {
    ...options, rewriteReceipt: currentRewriteReceipt(id),
    ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
  }));
};

async function verifyPrefix(filePath, stat, restored) {
  if (exactSource(restored.snapshot, stat) || writtenSources.has(filePath)) return true;
  // Across worker/app restart, growth alone cannot prove an intact prefix.
  // Verify cached chunk hashes without parsing JSON or materializing records.
  const handle = await fs.promises.open(filePath, 'r');
  let offset = 0;
  try {
    for (const proof of restored.state.sourceProof || []) {
      if (proof.offset !== offset || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0) return false;
      const hash = crypto.createHash('sha256');
      let remaining = proof.bytes;
      const buffer = Buffer.alloc(Math.min(1024 * 1024, remaining));
      while (remaining) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), offset);
        if (!bytesRead) return false;
        sourceVerificationBytes += bytesRead;
        const context = requestContext.getStore(); if (context) context.verificationBytes += bytesRead;
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; remaining -= bytesRead;
      }
      if (hash.digest('hex') !== proof.hash) return false;
    }
    const after = await handle.stat();
    return offset === restored.snapshot.size && exactSource({
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino,
    }, after);
  } finally { await handle.close(); }
}
api.prepareCodexPayloadSource = async ({ sessionId, cwd, filePath, stat }) => {
  await prepareSourceEpoch(filePath);
  const owner = { sessionId, cwd };
  const saved = cache.readSource(owner);
  if (saved) {
    const unchanged = exactSource(saved, stat);
    const grew = saved.filePath === filePath && saved.fileIdentity === stat.dev + ':' + stat.ino && stat.size > saved.size;
    const prefixValid = grew && await verifyPrefix(filePath, stat, { snapshot: saved,
      state: { sourceProof: cache.readSourceProof(owner) || [] } });
    if (saved.filePath !== filePath || (!unchanged && !prefixValid) || !api.restoreCodexSourceSnapshot(saved)) {
      cache.invalidate(saved.filePath);
      historyPayloadStash.invalidateSession('codex', sessionId);
    }
  }
  const sourceGeneration = api.getCodexPayloadGeneration(filePath, stat, sessionId);
  const context = requestContext.getStore();
  if (context) context.payloadSource = { filePath, sourceGeneration };
};
api.setCodexProjectionStorage({
  enterCold,
  async read({ sessionId, cwd, filePath, stat }) {
    let restoreLease;
    const context = requestContext.getStore();
    if (context) context.sourceSize = stat.size;
    try {
      const restored = cache.readContinuation({ sessionId, cwd }, filePath, stat, snapshot => {
        restoreLease = historyPreparationActivity.begin({ sessionId, tabId: requestContext.getStore()?.payload.tabId,
          bytes: snapshot.size, source: { toolType: 'codex', cwd } });
        restoreLease.update({ phase: 'preparing' });
      });
      if (!restored) { phaseDiagnostic({ phase: 'projection-restore', outcome: 'miss', reason: 'continuation-unavailable' }); return null; }
      if (!await verifyPrefix(filePath, stat, restored)) {
        phaseDiagnostic({ phase: 'projection-restore', outcome: 'invalidated', reason: 'source-prefix-changed' });
        cache.invalidate(filePath); return null;
      }
      if (context) { context.ssdHits++; context.continuationRestored = true; }
      rememberWrittenSource(filePath);
      return restored;
    } finally { restoreLease?.(); }
  },
  write({ sessionId, cwd, snapshot, state, timelineEntries, sessionMeta }) {
    const context = requestContext.getStore();
    if (context) { context.sourceSize = snapshot.size; context.lineCount = state.lineCount; }
    const payloads = context?.payloads || new Map();
    const stored = cache.saveContinuation({ sessionId, cwd }, snapshot, state, payloads);
    if (stored) payloads.clear();
    cache.saveTimeline({ sessionId, cwd }, snapshot, timelineEntries, sessionMeta);
    rememberWrittenSource(snapshot.filePath);
  },
  onRead({ bytes, mode }) {
    sourceBytes += bytes;
    const context = requestContext.getStore();
    if (!context) return;
    context.sourceBytes += bytes;
    if (mode === 'rebuild') { context.rebuilds++; context.exceptional = true; count('rebuilds'); }
    else if (mode === 'unchanged' && !context.continuationRestored) context.ramHits++;
    phaseDiagnostic({ phase: 'source-read', outcome: mode === 'rebuild' ? 'rebuild' : 'success', reason: token(mode), bytes });
  },
  onRewrite(filePath) { cache.invalidate(filePath); writtenSources.delete(filePath); },
  prepare(cached) {
    const context = requestContext.getStore();
    if (context) context.consumedRecords = cached.historyProjector.getConsumedRecords();
    // Charge/store the graph we actually retain, not the pre-dehydration
    // outputs. Full payloads and the continuation commit atomically together.
    dehydrateHistoryEntries({ toolType: 'codex', sessionId: cached.sessionId,
      entries: cached.historyProjector.peekEntries(), stash: historyPayloadStash });
  },
});
api.observeCodexReadInvalidation(({ filePath, readRefresh, sourceAppend }) => {
  if (!readRefresh && !sourceAppend) { cache.invalidate(filePath); writtenSources.delete(filePath); }
});

// Payloads remain recoverable after the 192MiB RAM stash is evicted. Queue
// them inside the current request and flush in a single cache transaction.
const originalSet = historyPayloadStash.set.bind(historyPayloadStash);
const originalGet = historyPayloadStash.get.bind(historyPayloadStash);
historyPayloadStash.set = (tool, sessionId, id, text) => {
  originalSet(tool, sessionId, id, text);
  const context = requestContext.getStore();
  if (tool === 'codex' && context && sessionId === context.payload.sessionId) context.payloads.set(id, text);
};
historyPayloadStash.get = (tool, sessionId, id) => {
  const hit = originalGet(tool, sessionId, id);
  if (hit != null) { const context = requestContext.getStore(); if (context) context.ramHits++; return hit; }
  const context = requestContext.getStore();
  return tool === 'codex' && context && sessionId === context.payload.sessionId
    ? context.payloads.get(id) ?? cache.readPayload(context.payload, id, context.payloadSource) : null;
};

const service = createSessionTranscriptService({ codexData, promptPresentationStore: db, sessionHistoryStore: db,
  preparedHistoryStore: cache,
  codexVirtualMaxBytes: virtualGraphBudget,
  catalogSearchHooks: {
    onRead(event) {
      const bytes = Number(event?.bytes) || 0;
      sourceBytes += bytes;
      const context = requestContext.getStore();
      if (context) { context.sourceBytes += bytes; context.exceptional = true; }
      phaseDiagnostic({ phase: 'catalog-source', outcome: 'success', reason: event?.phase || 'scan', bytes });
    },
    onDiagnostic(event) {
      phaseDiagnostic({ phase: 'catalog-projection', outcome: 'success', reason: 'query-only',
        rows: event?.rows, records: event?.records, bytes: event?.resultBytes,
        durationMs: event?.durationMs });
    },
  },
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => send({ event: 'window', channel, payload }) } }),
  recoverManagedHistoryImageRef: ref => {
    const result = assets?.existingManagedRefSync(ref) || null;
    if (result) {
      const context = requestContext.getStore();
      if (context) context.assets.set(result.assetId || result.path, result);
      else send({ event: 'assets', refs: [result] });
    }
    return result;
  },
});
let lastCacheMemory = '';
function publishCacheMemory() {
  try {
  const snapshot = { graphBytes: api.getCodexHistoryProjectorStats().approxBytes,
    virtualBytes: service.codexVirtualTranscriptStore?.stats().approxBytes ?? 0,
    indexBytes: cache.stats().indexMemoryBytes };
  const identity = `${snapshot.graphBytes}:${snapshot.virtualBytes}:${snapshot.indexBytes}`;
  if (identity === lastCacheMemory) return;
  send({ event: 'cache-memory', snapshot });
  lastCacheMemory = identity;
  } catch {
    lastCacheMemory = '';
    try { send({ event: 'cache-memory', snapshot: null }); } catch {}
    // Telemetry failure is unknown, and cannot alter the read/source proof.
  }
}
const cacheDiagnostic = cache.onDiagnostic;
cache.onDiagnostic = event => { cacheDiagnostic(event); if (!requestContext.getStore()) publishCacheMemory(); };
historyPreparationActivity.subscribe(snapshot => send({ event: 'preparation', snapshot }));
observeHistoryResponseTimingBindings(payload => send({ event: 'timing-bound', payload }));
const chains = new Map();
const queueDepths = new Map(); // Diagnostic-only; entries follow the existing RPC chains.
const originalReceipt = api.getCodexRewriteReceipt;
api.getCodexRewriteReceipt = (id, source) => {
  const receipt = currentRewriteReceipt(id);
  return receipt && (!source || receipt.sourceSessionId === source) ? receipt : originalReceipt(id, source);
};

parentPort.on('message', message => {
  if (message.event === 'source-epoch') {
    if (message.slot) sourceEpochSlots.set(message.filePath, message.slot);
    const pending = epochPending.get(message.filePath);
    pending?.resolve(); return;
  }
  if (message.event === 'invalidate') {
    api.invalidateJsonlCache(message.filePath, message);
    publishCacheMemory();
    return;
  }
  if (message.event === 'ownership') { recordCodexProcessActionOwnership(message.payload); return; }
  if (message.event === 'lineage') {
    service.codexProviderForkMetadata.delete(message.sessionId);
    db?.invalidateForkMarkerCache(message.sessionId);
    publishCacheMemory();
    return;
  }
  if (!message.id) return;
  const { id, method } = message;
  // UI correlation is transport context only, never input to source/cache
  // identity, revision construction or a returned transcript DTO.
  const { diagnosticActionId, diagnosticReadId, ...payload } = message.payload || {};
  const key = JSON.stringify([payload.sessionId, payload.cwd]);
  const received = stamp();
  count('requests');
  const context = { payload, phases: new Map(), droppedPhaseGroups: 0, sourceBytes: 0, verificationBytes: 0,
    fedRecords: 0, rebuilds: 0, ramHits: 0, ssdHits: 0, coldAdmissionMs: 0, exceptional: false,
    cacheReasons: { missingFile: 0, diskEvicted: 0, sourceChange: 0, version: 0, disabled: 0, error: 0, other: 0 } };
  const correlation = { requestId: id, callId: message.diagnostic?.callId ?? id,
    attempt: message.diagnostic?.attempt || 1, method: identity(method), tool: identity(payload.toolType),
    tab: identity(payload.tabId), session: identity(payload.sessionId),
    diagnosticActionId: typeof diagnosticActionId === 'string' && /^[a-z0-9-]{1,90}$/.test(diagnosticActionId)
      ? diagnosticActionId : undefined,
    diagnosticReadId: typeof diagnosticReadId === 'string' && /^[a-z0-9-]{1,90}$/.test(diagnosticReadId)
      ? diagnosticReadId : undefined };
  context.correlation = { ...correlation, workerGeneration: workerData.diagnosticGeneration || 0 };
  const sessionQueueDepth = queueDepths.get(key) || 0;
  queueDepths.set(key, sessionQueueDepth + 1);
  let executionStart, executionEnd, serializationStart, serializationEnd;
  const work = async () => {
    executionStart = stamp();
    if (method === 'stats') return { value: { cache: cache.stats(), projector: api.getCodexHistoryProjectorStats(), sourceBytes, sourceVerificationBytes,
      virtual: { ...service.codexVirtualTranscriptStore?.stats(), budgetBytes: virtualGraphBudget }, workerGraphBudget,
      memory: { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss } }, readProof: [] };
    if (method === 'releaseMemory') { api.invalidateCodexHistoryProjectors(); cache.clearMemory();
      service.codexVirtualTranscriptStore?.clear(); return { value: true, readProof: [] }; }
    if (!['getHistory', 'getTimeline', 'getToolPayload', 'getTabMessageSourceLocation', 'getMessages', 'searchHistory', 'searchCatalogCandidate',
      'resolveCodexPhysicalRow', 'copyCodexVirtualRange', 'exportCodexSession', 'prepareCodexRewrite'].includes(method)) throw new Error('history_read_method');
    context.rewriteReceipt = message.rewriteReceipt || null;
    Object.assign(context, { payloads: new Map(), sources: new Set(), sourceEpochs: sourceEpochs.slice(), preparations: [], assets: new Map() });
    return requestContext.run(context, async () => {
      const memoryRead = method === 'searchCatalogCandidate' ? beginHistoryReadDiagnostic('catalog-projection', {
        sessionId: payload.sessionId, provider: 'codex', readId: correlation.diagnosticReadId,
      }) : null;
      try {
        if (method === 'searchCatalogCandidate') { context.catalogScan = true; await enterCold(); }
        const prepared = method === 'prepareCodexRewrite'
          ? await api.projectCodexFullHistoryFromFile(payload.sessionId, payload.cwd) : null;
        const result = prepared ? { success: prepared.success, error: prepared.error, mode: prepared.mode,
          fedRecords: prepared.fedRecords, reusedRecords: prepared.reusedRecords || 0, sourceSnapshot: prepared.sourceSnapshot }
          : await service[method](payload);
        const readProof = [...context.sources].map(filePath => ({ filePath,
          epoch: context.sourceEpochs[epochSlot(filePath)], slot: epochSlot(filePath) }));
        if (readProof.some(source => source.epoch !== Atomics.load(sourceEpochs, source.slot))) {
          phaseDiagnostic({ phase: 'source-fence', outcome: 'invalidated', reason: 'source-epoch-invalidated' });
          throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
        if (context.payloads.size) cache.savePayloads(payload, context.payloads);
        memoryRead?.end('success', { totalIterations: result?.totalIterations, matches: result?.bestMatches?.length });
        return { value: result, readProof };
      } catch (error) {
        memoryRead?.end('error', { errorCode: error.code });
        throw error;
      } finally {
        if (context.assets.size) send({ event: 'assets', refs: [...context.assets.values()] });
        for (const finish of context.preparations) finish();
        context.coldRelease?.();
      }
    });
  };
  const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(work);
  chains.set(key, run);
  const reply = (body, resultBytes = null, transfer = []) => {
    const ready = stamp();
    const executionMs = executionEnd.perf - executionStart.perf;
    const exceptional = context.exceptional || !!body.error || body.result?.success === false || !!body.result?.error
      || !!body.result?.proof?.error;
    const outcome = body.error ? 'error' : body.result?.success === false || body.result?.error || body.result?.proof?.error ? 'result-error' : 'success';
    count('completed'); if (outcome !== 'success') count('errors');
    const reason = body.error?.code === 'CODEX_SOURCE_READ_INVALIDATED' ? 'source-epoch-invalidated'
      : body.error ? token(body.error.code || 'execution-error')
      : body.result?.error === 'Codex session file not found' ? 'source-missing'
      : outcome === 'result-error' ? token(body.result?.error || body.result?.proof?.error) : undefined;
    const diagnostic = { ...correlation, receivedAbs: received.abs, receivedPerf: received.perf,
      executionStartAbs: executionStart.abs, executionStartPerf: executionStart.perf,
      executionEndAbs: executionEnd.abs, executionEndPerf: executionEnd.perf,
      sessionQueueDepth, sessionQueueMs: executionStart.perf - received.perf, executionMs,
      coldAdmissionMs: context.coldAdmissionMs, coldQueueDepth: context.coldQueueDepth || 0,
      coldQueuedAbs: context.coldQueuedAbs, coldQueuedPerf: context.coldQueuedPerf,
      coldAdmittedAbs: context.coldAdmittedAbs, coldAdmittedPerf: context.coldAdmittedPerf,
      serializationStartAbs: serializationStart?.abs, serializationStartPerf: serializationStart?.perf,
      serializationEndAbs: serializationEnd?.abs, serializationEndPerf: serializationEnd?.perf,
      serializationMs: serializationEnd ? serializationEnd.perf - serializationStart.perf : null,
      replyReadyAbs: ready.abs, replyReadyPerf: ready.perf, resultBytes, transport: message.binary ? 'v8-transfer' : 'structured-clone',
      source: context.catalogScan ? 'catalog-scan' : context.rebuilds ? 'raw-rebuild' : context.sourceBytes ? 'raw-append' : context.ssdHits ? 'ssd' : context.ramHits ? 'ram'
        : context.unmeasuredRecordRead ? 'records-cache-or-raw' : 'unobserved',
      sourceBytes: context.unmeasuredRecordRead ? null : context.sourceBytes, projectionSourceBytes: context.sourceBytes,
      sourceSize: context.sourceSize, loadedRecords: context.loadedRecords, verificationBytes: context.verificationBytes,
      fedRecords: context.fedRecords, consumedRecords: context.consumedRecords, lineCount: context.lineCount,
      ramHits: context.ramHits, ssdHits: context.ssdHits, rebuilds: context.rebuilds, outcome, reason, exceptional };
    publishCacheMemory();
    send({ ...body, diagnostic }, transfer);
    const posted = stamp();
    if (exceptional || posted.perf - received.perf >= slowMs) {
      const stats = cache.stats();
      emitDiagnostic('request-complete', { ...diagnostic, postMessageMs: posted.perf - ready.perf,
        postedAbs: posted.abs, postedPerf: posted.perf, phases: [...context.phases.values()], droppedPhaseGroups: context.droppedPhaseGroups,
        counters: { ...counters }, cacheReasons: { ...context.cacheReasons }, lastException: context.lastException || null,
        cache: { hits: stats.hits, misses: stats.misses, errors: stats.errors, diskBytes: stats.diskBytes,
          budgetBytes: stats.budgetBytes, indexMemoryBytes: stats.indexMemoryBytes, indexMemoryBudget: stats.indexMemoryBudget },
        timing: 'elapsed-wall; cold/cache phases nested in execution; overlapping phases are not summed CPU' });
    }
  };
  run.then(({ value: result, readProof }) => {
    executionEnd = stamp();
    if (message.binary) {
      serializationStart = stamp();
      const data = new Uint8Array(v8.serialize(result));
      serializationEnd = stamp();
      // Transfer bytes, not tens of thousands of objects through main. Only
      // this small witness is needed there to reject a revoked response.
      reply({ id, readProof, result: { __notedHistoryTransport: 'v8-1', data,
        proof: { filePath: result.filePath, error: result.error,
          sourcePaths: (result.revision?.sources || []).map(source => source.filePath) } } }, data.byteLength, [data.buffer]);
    } else reply({ id, readProof, result });
  }, error => { executionEnd = stamp(); reply({ id, error: { message: error.message, code: error.code,
    ...(typeof error.lineageReason === 'string' ? { lineageReason: error.lineageReason } : {}) } }); })
    .catch(error => { try {
      if (serializationStart && !serializationEnd) serializationEnd = stamp();
      reply({ id, error: { message: error.message, code: error.code } });
    } catch {} })
    .finally(() => {
      if (chains.get(key) === run) chains.delete(key);
      const remaining = queueDepths.get(key) - 1;
      if (remaining) queueDepths.set(key, remaining); else queueDepths.delete(key);
    });
});

emitDiagnostic('worker-ready', { cacheEnabled: cache.enabled, cacheSchema: require('node:path').basename(cache.directory),
  slowMs, phaseGroups: MAX_PHASE_GROUPS, workerGraphBudget, virtualGraphBudget,
  capabilities: { cacheOnDiagnostic: typeof cache.diagnose === 'function', sourceOnRead: 'projection-storage-only',
    recordReadBytes: false, binaryBytes: true, structuredCloneBytes: false },
  startupCacheErrors: cache.stats().errors, counters: { ...counters } });
publishCacheMemory();
send({ event: 'ready' });
