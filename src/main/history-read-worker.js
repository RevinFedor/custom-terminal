'use strict';

const { parentPort, workerData } = require('./history-read-runtime').getHistoryReadRuntime();
const { createReadControl, currentReadControl, withReadControl, createReadAdmission,
  createDemandRegistry, historyReadCancelled, isHistoryReadCancelled } = require('./history-read-control');
const { openProcessEpochReader } = require('./history-process-epochs');
const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => parentPort.postMessage({
  event: 'log', level, emittedAt: Date.now(), correlation: requestContext.getStore()?.correlation,
  text: args.map(value => String(value)).join(' ').slice(0, 16000),
});
const fs = require('node:fs');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { HistoryByteSender } = require('./history-byte-stream');
const { encodeHistoryStream, streamLimits } = require('./history-stream-codec');
const { performance } = require('node:perf_hooks');
const { httpReadCorrelation } = require('./http-read-diagnostics');
const DIAGNOSTIC_SCHEMA = 1, MAX_PHASE_GROUPS = 16;
const workerBoot = crypto.randomUUID();
let diagnosticSequence = 0, diagnosticSendErrors = 0;
const stamp = () => { const perf = performance.now(); return { abs: performance.timeOrigin + perf, perf }; };
emitDiagnostic('worker-boot');
emitDiagnostic('imports-begin');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const codexData = require('./ipc/codex-data');
const { createSessionTranscriptService } = require('./session-transcript-service');
const { HistoryPreparedCache, exactSource } = require('./history-prepared-cache');
const { historyPayloadStash, dehydrateHistoryEntries, HISTORY_PAYLOAD_HEADER_VERSION } = require('./history-payload-dehydrate');
const { applyHistoryEntryWindow } = require('./history-entry-window');
const { historyPreparationActivity } = require('./history-preparation-activity');
const { observeHistoryResponseTimingBindings } = require('./history-response-timings');
const { PromptQueueAssetStore } = require('./prompt-queue-assets');
const { recordCodexProcessActionOwnership } = require('./codex-process-action-ownership');
const { beginHistoryReadDiagnostic } = require('./history-read-memory-diagnostics');
emitDiagnostic('imports-end');

// This connection uses the existing application's schema and exact methods.
// It does not run startup migrations, create tabs, or own runtime delivery.
emitDiagnostic('database-ready-begin', { configured: !!workerData.databasePath });
const db = workerData.databasePath ? new DatabaseManager({
  existingConnection: new Database(workerData.databasePath, { fileMustExist: true }),
}) : null;
if (db) {
  db.db.pragma('busy_timeout = 5000');
}
emitDiagnostic('database-ready-end', { configured: !!db });
// Parsed data is valid for the exact parser/preparation implementation. A
// source update must not silently reuse a previous version's interpretation.
const schemaHash = crypto.createHash('sha256');
let sourceModuleCount=0, workerSourceSHA256=null;
schemaHash.update(process.versions.v8);
const srcRoot = require('node:path').resolve(__dirname, '..');
for (const filename of Object.keys(require.cache).filter(name => name.startsWith(srcRoot + require('node:path').sep)
  && /\.(?:js|cjs)$/.test(name)).sort()) {
  schemaHash.update(require('node:path').relative(srcRoot, filename));
  const sourceBytes=fs.readFileSync(filename);
  schemaHash.update(sourceBytes);sourceModuleCount++;
  if(filename===__filename)workerSourceSHA256=crypto.createHash('sha256').update(sourceBytes).digest('hex');
}
const sourceSchemaSHA256=schemaHash.digest('hex');
const startupCacheDiagnostics = [];
emitDiagnostic('cache-init-begin');
const cache = new HistoryPreparedCache({ directory: workerData.cacheDirectory, maxBytes: workerData.diskBudgetBytes,
  onDiagnostic: event => { if (startupCacheDiagnostics.length < 8) startupCacheDiagnostics.push(event); },
  indexBudgetBytes: workerData.indexBudgetBytes,
  schema: '1-' + sourceSchemaSHA256.slice(0, 20) });
emitDiagnostic('cache-init-end', { enabled: cache.enabled });
const slowMs = Number.isFinite(workerData.diagnosticSlowMs) ? Math.max(0, workerData.diagnosticSlowMs) : 100;
const token = value => typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value) ? value : 'other';
const identity = value => value == null || value === '' ? null : token(String(value)) !== 'other' ? String(value)
  : 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const counters = { requests: 0, completed: 0, errors: 0, rebuilds: 0, cacheMisses: 0, cacheErrors: 0, cacheEvictions: 0, droppedPhaseGroups: 0 };
const count = name => { counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + 1); };
function emitDiagnostic(event, fields = {}) {
  const now = stamp();
  try { parentPort.postMessage({ event: 'diagnostic', diagnostic: { schema: DIAGNOSTIC_SCHEMA, side: 'worker', event,
    clientId: workerData.diagnosticClientId || null, workerGeneration: workerData.diagnosticGeneration || 0,
    producerBoot: workerBoot, producerPid:process.pid, seq: ++diagnosticSequence,
    emittedAbs: now.abs, emittedPerf: now.perf, ...fields } }); } catch { diagnosticSendErrors++; }
}
let phaseWindowAt = -Infinity, phaseWindowCount = 0, phaseGlobalOmitted = 0;
const phaseEnabled = context => !!context && (!!context.correlation?.httpRead || workerData.diagnosticReadPhases === true);
function requestPhase(context, event, fields = {}) {
  if (!phaseEnabled(context)) return;
  const now = performance.now();
  if (now - phaseWindowAt >= 60000) { phaseWindowAt = now; phaseWindowCount = 0; }
  context.observationEvents ||= 0;
  if (context.observationEvents >= 48 || phaseWindowCount >= 240) {
    context.observationOmitted = (context.observationOmitted || 0) + 1; phaseGlobalOmitted++; return;
  }
  context.observationEvents++; phaseWindowCount++;
  emitDiagnostic(event, { ...context.correlation, ...fields });
}
function beginWorkPhase(stage) {
  const context = requestContext.getStore();
  if (!phaseEnabled(context)) return () => {};
  const started = performance.now();
  requestPhase(context, 'work-phase-begin', { stage });
  let ended = false;
  return (outcome = 'returned') => { if (!ended) { ended = true;
    requestPhase(context, 'work-phase-end', { stage, outcome, elapsedMs: performance.now() - started }); } };
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
for (const operation of ['readPrepared', 'readPreparedAsync', 'savePrepared', 'readTimeline', 'saveTimeline', 'readContinuation', 'saveContinuation', 'saveContinuationAsync',
  'readSource', 'readSourceProof', 'saveSourceHeader', 'readPayload', 'savePayload', 'savePayloads', 'savePayloadsAsync', 'readVirtualProjection', 'saveVirtualProjection',
  'readVirtualState', 'saveVirtualState', 'saveVirtualStateAsync']) {
  const original = cache[operation];
  cache[operation] = function (...args) {
    const context = requestContext.getStore();
    if (!context) return original.apply(this, args);
    const item = { operation: operation.replace(/Async$/, ''), started: stamp() };
    const active = context.cacheOperations ||= [];
    active.push(item);
    const end = beginWorkPhase(operation);
    const finish = () => { const index = active.indexOf(item); if (index >= 0) active.splice(index, 1); end(); };
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
  const end = beginWorkPhase('history-preparation');
  context.preparations.push(() => { end(); return finish(); });
  let lastPhase = null, milestone = 0;
  const update = value => {
    if (typeof value?.phase === 'string' && value.phase !== lastPhase) {
      lastPhase = value.phase; requestPhase(context, 'preparation-phase', { stage: token(value.phase) });
    }
    // First actual progress, then at most eight byte milestones. No polling
    // or per-row message; retain the actual last progress even after quota.
    if (Number.isFinite(value?.completedBytes)) {
      context.lastProgress = { bytes: value.completedBytes, emittedAbs: performance.timeOrigin + performance.now() };
      const step = Math.max(1, Math.ceil((Number(options.bytes) || 0) / 8));
      if (milestone < 8 && (milestone === 0 || value.completedBytes >= milestone * step)) {
        milestone++; requestPhase(context, 'preparation-progress', { bytes: value.completedBytes });
      }
    }
    return finish.update?.(value);
  };
  const prepared = () => update({ phase: 'preparing' });
  prepared.update = typeof finish.update === 'function' ? update : finish.update;
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
const processEpochs = openProcessEpochReader(workerData.sourceEpochFile);
const { sourceEpochs, sourceRewriteEpochs } = processEpochs;
const sourceEpochSlots = new Map(), epochPending = new Map();
const epochSlot = file => sourceEpochSlots.get(file) ?? 0;
function assertContextSource(context) {
  if (context?.captureError) throw context.captureError;
  const captured = context?.snapshotEpochs || context?.sourceEpochs;
  const epochs = context?.snapshotEpochs ? sourceRewriteEpochs : sourceEpochs;
  if (captured && [...context.sources].some(file => captured[epochSlot(file)] !== Atomics.load(epochs, epochSlot(file)))) {
    phaseDiagnostic({ phase: 'source-fence', outcome: 'invalidated', reason: 'source-epoch-invalidated' });
    throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  }
}
cache.assertCurrent = () => {
  currentReadControl()?.assertCurrent();
  processEpochs.refresh(); // synchronous publication/codec/SQLite boundary
  assertContextSource(requestContext.getStore());
};
const ownedContexts = new WeakMap();
function makeOwnedControl(context, signal) {
  const control = createReadControl({ signal,
    assertSourceCurrent: () => assertContextSource(context),
    refreshSourceCurrent: () => processEpochs.refresh(),
    runOwned: operation => requestContext.run(context, operation),
    adoptReadDependencies: otherControl => {
      const other = ownedContexts.get(otherControl);
      if (!other) return;
      processEpochs.refresh(); assertContextSource(other);
      const captured = context.snapshotEpochs || context.sourceEpochs;
      const borrowed = context.snapshotEpochs ? other.rewriteSourceEpochs : other.sourceEpochs;
      for (const file of other.sources || []) {
        const slot = epochSlot(file);
        if (!captured || !borrowed || captured[slot] !== borrowed[slot]) {
          throw Object.assign(new Error('Shared History read source epoch differs'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
        context.sources.add(file);
      }
      const admission = coldOwners.get(otherControl);
      if (admission) retainCold(admission, control, context);
      // Merge the producer's bounded diagnostic counters without copying its
      // correlation/demand identity. Nested jobs start from their owner's
      // counters, hence max preserves cumulative progress without double sum.
      for (const field of ['sourceBytes', 'verificationBytes', 'fedRecords', 'rebuilds', 'ramHits', 'ssdHits',
        'loadedRecords', 'sourceSize', 'consumedRecords', 'lineCount', 'observationEvents', 'observationOmitted',
        'coldAdmissionMs', 'coldQueueDepth', 'coldQueuedAbs', 'coldQueuedPerf', 'coldAdmittedAbs', 'coldAdmittedPerf']) {
        if (Number.isFinite(other[field])) context[field] = Math.max(context[field] || 0, other[field]);
      }
      for (const field of ['unmeasuredRecordRead', 'catalogScan', 'fullStream', 'exceptional', 'continuationRestored']) context[field] ||= other[field];
      if (other.streamMetrics) context.streamMetrics = other.streamMetrics;
      for (const [category, value] of Object.entries(other.cacheReasons || {})) {
        context.cacheReasons[category] = Math.max(context.cacheReasons[category] || 0, value);
      }
    },
    forkSignal: nextSignal => {
      // Shared work has its own cold/staging/preparation lifetime. Cancelling
      // A must not close these resources while B still owns a demand lease.
      const owned = { ...context, payloads: null, preparations: [], assets: new Map(),
        coldAdmission: null, coldRelease: null, cacheOperations: [] };
      const forked = makeOwnedControl(owned, nextSignal);
      owned.payloads = withReadControl(forked, () => cache.createPendingPayloads(owned.payload));
      const admission = coldOwners.get(control);
      if (admission) retainCold(admission, forked, owned);
      return forked;
    },
  });
  context.control = control;
  ownedContexts.set(control, context);
  control.onSettled(() => {
    for (const finish of context.preparations || []) finish();
    context.payloads?.close();
    if (!signal?.aborted && context.assets?.size) send({ event: 'assets', refs: [...context.assets.values()] });
  });
  return control;
}
function prepareSourceEpoch(filePath) {
  // Every source access participates, including raw/search/payload/virtual
  // reads whose public DTO contains no revision or filePath.
  const context = requestContext.getStore();
  const control = currentReadControl();
  control?.assertCurrent();
  context?.sources.add(filePath);
  if (sourceEpochSlots.has(filePath)) return Promise.resolve();
  const endWait = beginWorkPhase('source-epoch');
  let registration = epochPending.get(filePath);
  if (!registration) {
    let resolve;
    const registered = new Promise(done => { resolve = done; });
    registration = { resolve, promise: registered.finally(() => {
      if (epochPending.get(filePath) === registration) epochPending.delete(filePath);
    }) };
    epochPending.set(filePath, registration);
    requestPhase(context, 'source-epoch-request');
    send({ event: 'source-epoch', filePath, diagnostic: context?.correlation });
  } else requestPhase(context, 'source-epoch-join');
  // Slot registration is tiny shared infrastructure, not A's read Promise.
  // Each borrower runs its own demand check and source restoration afterwards.
  return registration.promise.then(async () => {
    control?.assertCurrent();
    processEpochs.refresh();
    const owner = context?.payload;
    if (owner?.sessionId) {
      // A full-payload client may arrive before desktop after a restart.
      const saved = cache.readSource(owner);
      const stat = saved?.filePath === filePath ? await fs.promises.stat(filePath).catch(() => null) : null;
      control?.assertCurrent();
      if (saved && exactSource(saved, stat)) api.restoreCodexSourceSnapshot(saved);
    }
  }).finally(endWait);
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
    currentReadControl()?.assertCurrent();
    processEpochs.refresh();
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
const coldLane = createReadAdmission(), coldOwners = new WeakMap();
function retainCold(admission, control, context) {
  if (coldOwners.has(control)) return;
  coldOwners.set(control, admission); admission.owners++;
  control.onSettled(() => {
    if (--admission.owners === 0) { admission.release?.(); requestPhase(context, 'cold-released'); }
  });
}
async function enterCold() {
  const context = requestContext.getStore();
  const control = currentReadControl();
  if (!context || !control) return coldLane.acquire(control);
  // Keep admission through yielded preparation/commit. Otherwise many cold
  // requests could accumulate full transient graphs while writing in turns.
  if (!coldOwners.has(control)) {
    const queued = stamp();
    context.coldQueuedAbs = queued.abs; context.coldQueuedPerf = queued.perf;
    context.coldQueueDepth = coldLane.waiting + Number(coldLane.active);
    requestPhase(context, 'cold-queued', { queueDepth: context.coldQueueDepth });
    const admission = { owners: 0, release: null, promise: null };
    admission.promise = coldLane.acquire(control).then(release => {
      const admitted = stamp();
      context.coldAdmittedAbs = admitted.abs; context.coldAdmittedPerf = admitted.perf;
      context.coldAdmissionMs = admitted.perf - queued.perf; context.coldRelease = release;
      requestPhase(context, 'cold-admitted', { coldAdmissionMs: context.coldAdmissionMs });
      admission.release = release;
      if (!admission.owners) release();
    });
    retainCold(admission, control, context);
  }
  await coldOwners.get(control).promise;
  control.assertCurrent();
  return () => {}; // The owning RPC releases exactly once in its finally.
}
cache.enterCold = enterCold;

const findSource = api.findCodexSessionFile;
api.findCodexSessionFile = async (id, cwd) => {
  currentReadControl()?.assertCurrent();
  const found = await findSource(id, cwd, workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {});
  if (found?.filePath) await prepareSourceEpoch(found.filePath);
  return found;
};
const load = api.loadSessionRecords;
api.loadSessionRecords = async (id, cwd, options = {}) => {
  const control = options._readControl || currentReadControl();
  control?.assertCurrent();
  // All worker raw-record consumers (messages/search/legacy payload recovery),
  // including a full RAM records copy, share the same transient-work lane.
  // Prepared SSD page readers do not call this API and retain their fast path.
  await enterCold();
  control?.assertCurrent();
  const end = beginWorkPhase('records-read');
  let result;
  try { result = await load(id, cwd, { ...options, _readControl: control,
    ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}) }); control?.assertCurrent(); }
  finally { end(); }
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
  if (context && result?.mode === 'full-stream') {
    const bytes = Number(result.readMetrics?.bytes) || 0;
    context.fullStream = true; context.sourceBytes += bytes; sourceBytes += bytes;
    context.sourceSize = result.sourceSnapshot?.size;
    context.streamMetrics = {};
    for (const name of ['maxCollectedRecords', 'maxConsumerRecords', 'maxRecordBytes', 'maxBufferedBytes', 'canonicalRows', 'timelineRows']) {
      if (Number.isFinite(result.readMetrics?.[name])) context.streamMetrics[name] = result.readMetrics[name];
    }
    phaseDiagnostic({ phase: 'source-read', outcome: 'rebuild', reason: 'full-stream', bytes });
  }
  return result;
}
api.projectCodexFullHistoryFromFile = async (id, cwd, options = {}) => {
  const end = beginWorkPhase('history-projection');
  try { return observeProjection(await originalHistory(id, cwd, {
    ...options, _readControl: options._readControl || currentReadControl(), rewriteReceipt: currentRewriteReceipt(id),
    ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
  })); } finally { end(); }
};
const originalTimeline = api.projectCodexTimelineFromFile;
api.projectCodexTimelineFromFile = async (id, cwd, options = {}) => {
  currentReadControl()?.assertCurrent();
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
    ...options, _readControl: options._readControl || currentReadControl(), rewriteReceipt: currentRewriteReceipt(id),
    ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
  }));
};

async function verifyPrefix(filePath, stat, restored) {
  const control = currentReadControl();
  control?.assertCurrent();
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
        await control?.checkpoint();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), offset);
        if (!bytesRead) return false;
        sourceVerificationBytes += bytesRead;
        const context = requestContext.getStore(); if (context) context.verificationBytes += bytesRead;
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; remaining -= bytesRead;
      }
      control?.assertCurrent();
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
  async write({ sessionId, cwd, snapshot, state, timelineEntries, sessionMeta }) {
    const context = requestContext.getStore();
    if (context) { context.sourceSize = snapshot.size; context.lineCount = state.lineCount; }
    const payloads = context?.payloads || new Map();
    const stored = await cache.saveContinuationAsync({ sessionId, cwd }, snapshot, state, payloads);
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
    const dehydration = dehydrateHistoryEntries({ toolType: 'codex', sessionId: cached.sessionId,
      entries: cached.historyProjector.peekEntries(), stash: historyPayloadStash });
    return { fullHistoryPreserved: dehydration.dehydrated === 0 };
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
service.snapshotAssertCurrent = () => {
  const context = requestContext.getStore();
  currentReadControl()?.assertCurrent();
  processEpochs.refresh();
  if (!context?.snapshotEpochs || [...context.sources].some(file =>
    context.snapshotEpochs[epochSlot(file)] !== Atomics.load(sourceRewriteEpochs, epochSlot(file)))) {
    throw Object.assign(new Error('Codex snapshot source invalidated'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  }
};
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
const requests = new Map();
const replyAcknowledgements = new Map();
const byteStreams = new Map();
const rpcDemands = createDemandRegistry();
const shareableReads = new Set(['getHistory', 'getTimeline', 'getToolPayload', 'getTabMessageSourceLocation', 'getMessages',
  'searchHistory', 'searchCatalogCandidate', 'resolveCodexPhysicalRow', 'copyCodexVirtualRange', 'exportCodexSession', 'readSessionSnapshot']);
const originalReceipt = api.getCodexRewriteReceipt;
api.getCodexRewriteReceipt = (id, source) => {
  const receipt = currentRewriteReceipt(id);
  return receipt && (!source || receipt.sourceSessionId === source) ? receipt : originalReceipt(id, source);
};

parentPort.on('message', message => {
  if (message.event === 'stream-credit') {
    byteStreams.get(message.id)?.credit(message); return;
  }
  if (message.event === 'reply-consumed') {
    replyAcknowledgements.get(message.id)?.(); return;
  }
  if (message.event === 'cancel') {
    requests.get(message.id)?.abort(historyReadCancelled()); return;
  }
  if (message.event === 'source-epoch') {
    if (message.slot) sourceEpochSlots.set(message.filePath, message.slot);
    const pending = epochPending.get(message.filePath);
    pending?.resolve(); return;
  }
  if (message.event === 'invalidate') {
    // Another synchronous Main update can overlap this cache notice. An odd
    // fence cannot authorize a read; the next request boundary re-observes it.
    try { processEpochs.refresh(); } catch (error) { emitDiagnostic('source-fence-observation', { errorCode: error.code }); }
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
  const { diagnosticActionId, diagnosticReadId, _readControl, ...payload } = message.payload || {};
  const key = JSON.stringify([payload.sessionId, payload.cwd]);
  const received = stamp();
  count('requests');
  const context = { payload, phases: new Map(), droppedPhaseGroups: 0, sourceBytes: 0, verificationBytes: 0,
    fedRecords: 0, rebuilds: 0, ramHits: 0, ssdHits: 0, coldAdmissionMs: 0, exceptional: false,
    cacheReasons: { missingFile: 0, diskEvicted: 0, sourceChange: 0, version: 0, disabled: 0, error: 0, other: 0 } };
  try { processEpochs.refresh(); } catch (error) { context.captureError = error; }
  Object.assign(context, { payloads: null, sources: new Set(), sourceEpochs: sourceEpochs.slice(),
    rewriteSourceEpochs: sourceRewriteEpochs.slice(),
    snapshotEpochs: method === 'readSessionSnapshot' ? sourceRewriteEpochs.slice() : null, preparations: [], assets: new Map() });
  const controller = new AbortController();
  requests.set(id, controller);
  const control = makeOwnedControl(context, controller.signal);
  const correlation = { requestId: id, callId: message.diagnostic?.callId ?? id,
    attempt: message.diagnostic?.attempt || 1, method: identity(method), tool: identity(payload.toolType),
    tab: identity(payload.tabId), session: identity(payload.sessionId),
    diagnosticActionId: typeof diagnosticActionId === 'string' && /^[a-z0-9-]{1,90}$/.test(diagnosticActionId)
      ? diagnosticActionId : undefined,
    diagnosticReadId: typeof diagnosticReadId === 'string' && /^[a-z0-9-]{1,90}$/.test(diagnosticReadId)
      ? diagnosticReadId : undefined };
  const httpRead = httpReadCorrelation(message.diagnostic?.httpRead);
  if (httpRead) correlation.httpRead = httpRead;
  context.correlation = { ...correlation, workerGeneration: workerData.diagnosticGeneration || 0 };
  const sessionQueueDepth = queueDepths.get(key) || 0;
  queueDepths.set(key, sessionQueueDepth + 1);
  requestPhase(context, 'request-received', { sessionQueueDepth });
  let executionStart = received, executionEnd, serializationStart, serializationEnd;
  const work = async executionControl => {
    const control = executionControl, context = ownedContexts.get(control);
    executionStart = stamp();
    control.assertCurrent();
    await control.checkpoint(); // after session queue, before admission or any read
    requestPhase(context, 'execution-begin', { sessionQueueMs: executionStart.perf - received.perf });
    if (method === 'stats') return { value: { cache: cache.stats(), projector: api.getCodexHistoryProjectorStats(), sourceBytes, sourceVerificationBytes,
      virtual: { ...service.codexVirtualTranscriptStore?.stats(), budgetBytes: virtualGraphBudget }, workerGraphBudget,
      memory: { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss } }, readProof: [] };
    if (method === 'releaseMemory') { api.invalidateCodexHistoryProjectors(); cache.clearMemory();
      service.codexVirtualTranscriptStore?.clear(); return { value: true, readProof: [] }; }
    if (!['getHistory', 'getTimeline', 'getToolPayload', 'getTabMessageSourceLocation', 'getMessages', 'searchHistory', 'searchCatalogCandidate',
      'resolveCodexPhysicalRow', 'copyCodexVirtualRange', 'exportCodexSession', 'prepareCodexRewrite', 'readSessionSnapshot'].includes(method)) throw new Error('history_read_method');
    context.rewriteReceipt = message.rewriteReceipt || null;
    return withReadControl(control, async () => {
      context.payloads ||= cache.createPendingPayloads(payload);
      const serviceEnd = beginWorkPhase('service-work');
      const memoryRead = method === 'searchCatalogCandidate' ? beginHistoryReadDiagnostic('catalog-projection', {
        sessionId: payload.sessionId, provider: 'codex', readId: correlation.diagnosticReadId,
      }) : null;
      try {
        if (method === 'searchCatalogCandidate' || method === 'readSessionSnapshot') { context.catalogScan = true; await enterCold(); }
        // Legacy full-payload History builds a fresh transient graph rather
        // than seeking a prepared page. It must share the existing cold lane;
        // otherwise concurrent HTTP catch-up reads bypass its admission.
        // Prepared/dehydrated page hits keep their independent fast path.
        if (method === 'getHistory' && payload.dehydrate !== true) await enterCold();
        await control.checkpoint();
        const prepared = method === 'prepareCodexRewrite'
          ? await api.projectCodexFullHistoryFromFile(payload.sessionId, payload.cwd, { _readControl: control }) : null;
        // A ref-aware producer can expose its cursor and leaf resolver under
        // the same read control. The legacy producer remains explicitly
        // identified: byte framing alone does not bound its preparation.
        const streamResult = message.stream && method === 'getHistory' && typeof service.getHistoryStream === 'function'
          ? await service.getHistoryStream({ ...payload, _readControl: control }, message.stream) : null;
        if (streamResult?.release) control.onSettled(streamResult.release);
        const result = streamResult ? streamResult.value : prepared ? { success: prepared.success, error: prepared.error, mode: prepared.mode,
          fedRecords: prepared.fedRecords, reusedRecords: prepared.reusedRecords || 0, sourceSnapshot: prepared.sourceSnapshot }
          : await service[method]({ ...payload, _readControl: control });
        await control.checkpoint();
        const epochs = context.snapshotEpochs ? sourceRewriteEpochs : sourceEpochs;
        const capturedEpochs = context.snapshotEpochs || context.sourceEpochs;
        const readProof = [...context.sources].map(filePath => ({ filePath,
          epoch: capturedEpochs[epochSlot(filePath)], slot: epochSlot(filePath) }));
        if (readProof.some(source => source.epoch !== Atomics.load(epochs, source.slot))) {
          phaseDiagnostic({ phase: 'source-fence', outcome: 'invalidated', reason: 'source-epoch-invalidated' });
          throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
        if (context.payloads.size) { control.assertCurrent(); await cache.savePayloadsAsync(payload, context.payloads); }
        memoryRead?.end('success', { totalIterations: result?.totalIterations, matches: result?.bestMatches?.length });
        return { value: result, readProof, streamOptions: streamResult ? {
          metadata: streamResult.metadata, leafResolver: streamResult.leafResolver, sourceGraph: 'ref-cursor',
        } : { sourceGraph: 'legacy-owned-array' } };
      } catch (error) {
        memoryRead?.end('error', { errorCode: error.code });
        throw error;
      } finally {
        serviceEnd();
        // The owner keeps preparation/staging/cold leases through encoding and
        // process send. Shared jobs retain their own reference after A aborts.
      }
    });
  };
  const enqueue = executionControl => {
    const queued = (chains.get(key) || Promise.resolve()).catch(() => {}).then(() => work(executionControl));
    chains.set(key, queued);
    queued.finally(() => { if (chains.get(key) === queued) chains.delete(key); }).catch(() => {});
    return queued;
  };
  // Register actual identical-request consumers BEFORE the session queue.
  // Otherwise B is only a queued future call and A looks like the last demand.
  // Different methods/windows remain independent reads; they are not silently
  // merged into a different response contract.
  const run = Promise.resolve().then(() => !message.stream && shareableReads.has(method)
    ? rpcDemands.run(JSON.stringify([method, payload, message.rewriteReceipt || null, !!message.binary]), control, enqueue) : enqueue(control));
  let terminalPosted = false;
  let streamStarted = false;
  let acknowledgeReply;
  const acknowledgedReply = new Promise(resolve => { acknowledgeReply = resolve; });
  const reply = (body, resultBytes = null, transfer = []) => {
    if (terminalPosted) return;
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
      replyReadyAbs: ready.abs, replyReadyPerf: ready.perf, resultBytes, transport: message.binary ? 'v8-process-copy' : 'structured-clone-process',
      source: context.catalogScan ? 'catalog-scan' : context.fullStream ? 'full-stream' : context.rebuilds ? 'raw-rebuild' : context.sourceBytes ? 'raw-append' : context.ssdHits ? 'ssd' : context.ramHits ? 'ram'
        : context.unmeasuredRecordRead ? 'records-cache-or-raw' : 'unobserved',
      sourceBytes: context.unmeasuredRecordRead ? null : context.sourceBytes, projectionSourceBytes: context.sourceBytes,
      sourceSize: context.sourceSize, loadedRecords: context.loadedRecords, verificationBytes: context.verificationBytes,
      fedRecords: context.fedRecords, consumedRecords: context.consumedRecords, lineCount: context.lineCount,
      ...(context.streamMetrics ? { streamMetrics: context.streamMetrics } : {}),
      ramHits: context.ramHits, ssdHits: context.ssdHits, rebuilds: context.rebuilds, outcome, reason, exceptional };
    publishCacheMemory();
    // Terminal witness is reserved outside the request-detail budget. It still
    // travels through Main; absence cannot prove worker idleness during a gap.
    if (phaseEnabled(context)) emitDiagnostic('reply-ready', { ...context.correlation, outcome, resultBytes,
      observationEvents: context.observationEvents || 0, observationOmitted: context.observationOmitted || 0,
      phaseGlobalOmitted, diagnosticSendErrors, lastProgress: context.lastProgress || null });
    diagnostic.observationHealth = { lastSeq: diagnosticSequence, sendErrors: diagnosticSendErrors,
      omitted: context.observationOmitted || 0, globalOmitted: phaseGlobalOmitted };
    if (!body.error) { control.assertCurrent(); processEpochs.refresh(); assertContextSource(context); }
    replyAcknowledgements.set(id, acknowledgeReply);
    send({ ...body, diagnostic }, transfer);
    terminalPosted = true;
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
  const produced = run.then(async ({ value: result, readProof, streamOptions }) => {
    executionEnd = stamp();
    await control.checkpoint(); // cancellation after build/save, before codec
    if (message.stream) {
      const limits = streamLimits(message.stream);
      let value = result, metadata = streamOptions?.metadata || {
        success: result?.success, error: result?.error, sourceGraph: streamOptions?.sourceGraph,
      };
      if (message.stream.projection === 'history-entries') {
        if (message.stream.format !== 'json') throw new TypeError('history_entries_requires_json');
        if (streamOptions?.sourceGraph === 'ref-cursor') {
          if (!metadata?.result || !Number.isSafeInteger(metadata.entryCount) || typeof metadata.etag !== 'string') {
            throw new TypeError('history_stream_cursor_metadata_required');
          }
          value = result.entries;
        } else {
          const selected = result?.boundsApplied === true ? result
            : { ...result, ...applyHistoryEntryWindow(result?.entries, payload.bounds || payload) };
          const { entries, ...header } = selected;
          value = entries || [];
          const hash = crypto.createHash('sha1');
          if (message.stream.payloadPolicy) hash.update(message.stream.payloadPolicy + ':headers:' + HISTORY_PAYLOAD_HEADER_VERSION + ':');
          for (let index = 0; index < value.length; index++) {
            if (index) hash.update('|');
            const entry = value[index];
            hash.update(`${entry?.uuid || ''}:${entry?.queueStatus || ''}:${entry?.deliveryStatus || ''}`);
            if ((index + 1) % 128 === 0) await control.checkpoint();
          }
          metadata = { result: header, entryCount: value.length,
            firstUuid: selected.firstUuid ?? value[0]?.uuid ?? null,
            lastUuid: selected.lastUuid ?? value[value.length - 1]?.uuid ?? null,
            etag: hash.digest('hex').slice(0, 16), sourceGraph: 'legacy-owned-array' };
        }
      }
      control.assertCurrent(); processEpochs.refresh(); assertContextSource(context);
      const codecStats = {}, creditStats = {};
      const assertStreamCurrent = () => {
        processEpochs.refresh(); assertContextSource(context);
        // The first byte is admitted against the complete dependency set.
        // A lazy leaf may read those same pinned sources, never silently add
        // a new source after Main has accepted an incomplete proof.
        if (context.sources.size !== readProof.length || readProof.some(source => !context.sources.has(source.filePath))) {
          throw Object.assign(new Error('History stream dependencies changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
      };
      const sender = new HistoryByteSender({ id, send, control, ...limits, stats: creditStats,
        assertCurrent: assertStreamCurrent });
      byteStreams.set(id, sender); streamStarted = true;
      try {
        await sender.pump(encodeHistoryStream(value, { format: message.stream.format || 'json', frameBytes: limits.frameBytes,
          control, leafResolver: streamOptions?.leafResolver, stats: codecStats }), metadata, readProof);
        count('completed'); publishCacheMemory();
        emitDiagnostic('stream-complete', { ...context.correlation, outcome: 'success',
          sourceGraph: streamOptions?.sourceGraph, transport: 'byte-credit-process-copy', ...creditStats, codec: codecStats });
      } finally { byteStreams.delete(id); }
      return;
    }
    if (message.binary) {
      serializationStart = stamp();
      const data = new Uint8Array(v8.serialize(result));
      serializationEnd = stamp();
      await control.checkpoint(); // V8 serialize itself is synchronous
      // Preserve v8-1 and the small admission witness. UtilityProcess copies
      // these bytes; this does not bound the full DTO or serialization peak.
      reply({ id, readProof, result: { __notedHistoryTransport: 'v8-1', data,
        proof: { filePath: result.filePath, error: result.error,
          sourcePaths: (result.revision?.sources || []).map(source => source.filePath) } } }, data.byteLength, [data.buffer]);
    } else { control.assertCurrent(); reply({ id, readProof, result }); }
  }, error => { executionEnd = stamp(); reply({ id, error: { message: error.message, code: error.code,
    ...(typeof error.lineageReason === 'string' ? { lineageReason: error.lineageReason } : {}) } }); })
    .catch(error => { try {
      if (streamStarted) { count('errors'); return; } // Sender emitted the exact terminal stream error.
      if (serializationStart && !serializationEnd) serializationEnd = stamp();
      reply({ id, error: { message: error.message, code: error.code } });
    } catch {} });
  produced.finally(async () => {
      // postMessage enqueues/copies; its return is not consumption. HTTP
      // callers ACK at transport settlement, other callers at Main delivery.
      if (terminalPosted) await acknowledgedReply;
      replyAcknowledgements.delete(id);
      control.finish(); requests.delete(id);
    }).catch(() => {});
  produced.finally(() => {
      const remaining = queueDepths.get(key) - 1;
      if (remaining) queueDepths.set(key, remaining); else queueDepths.delete(key);
    }).catch(() => {});
});

emitDiagnostic('worker-ready', { workerSourceSHA256,sourceSchemaSHA256,sourceModuleCount,sourceDirectory:__dirname,
  codeWitness:'cached source files read at boot; pair with fresh process and immutable ASAR proof',cacheEnabled: cache.enabled, cacheSchema: require('node:path').basename(cache.directory),
  slowMs, phaseGroups: MAX_PHASE_GROUPS, workerGraphBudget, virtualGraphBudget,
  capabilities: { cacheOnDiagnostic: typeof cache.diagnose === 'function', sourceOnRead: 'projection-storage-only',
    recordReadBytes: false, binaryBytes: true, structuredCloneBytes: false },
  startupCacheErrors: cache.stats().errors, counters: { ...counters } });
publishCacheMemory();
send({ event: 'ready' });
