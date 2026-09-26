'use strict';

const { parentPort, workerData } = require('node:worker_threads');
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => parentPort.postMessage({
  event: 'log', level, emittedAt: Date.now(), text: args.map(value => String(value)).join(' ').slice(0, 16000),
});
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const crypto = require('node:crypto');
const v8 = require('node:v8');
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
const cache = new HistoryPreparedCache({ directory: workerData.cacheDirectory, maxBytes: workerData.diskBudgetBytes,
  indexBudgetBytes: workerData.indexBudgetBytes,
  schema: '1-' + schemaHash.digest('hex').slice(0, 20) });
const requestContext = new AsyncLocalStorage();
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
    if (context.sourceEpochs[slot] !== Atomics.load(sourceEpochs, slot)) return false;
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
  if (!context.coldAdmission) context.coldAdmission = acquireCold().then(release => { context.coldRelease = release; });
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
if (workerData.sessionsDir) {
  const load = api.loadSessionRecords;
  api.loadSessionRecords = (id, cwd, options = {}) => load(id, cwd, { ...options, sessionsDir: workerData.sessionsDir });
}
const originalHistory = api.projectCodexFullHistoryFromFile;
api.projectCodexFullHistoryFromFile = (id, cwd, options = {}) => originalHistory(id, cwd, {
  ...options, ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
});
const originalTimeline = api.projectCodexTimelineFromFile;
api.projectCodexTimelineFromFile = async (id, cwd, options = {}) => {
  const found = await api.findCodexSessionFile(id, cwd);
  const stat = found?.filePath ? await fs.promises.stat(found.filePath).catch(() => null) : null;
  const saved = stat ? cache.readTimeline({ sessionId: id, cwd }, found.filePath, stat) : null;
  if (saved && api.restoreCodexSourceSnapshot(saved.source)) return {
    success: true, filePath: found.filePath, entries: saved.entries, sessionMeta: saved.sessionMeta,
    sourceSnapshot: saved.source, mode: 'disk', fedRecords: 0,
  };
  return originalTimeline(id, cwd, {
    ...options, ...(workerData.sessionsDir ? { sessionsDir: workerData.sessionsDir } : {}),
  });
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
    try {
      const restored = cache.readContinuation({ sessionId, cwd }, filePath, stat, snapshot => {
        restoreLease = historyPreparationActivity.begin({ sessionId, tabId: requestContext.getStore()?.payload.tabId,
          bytes: snapshot.size, source: { toolType: 'codex', cwd } });
        restoreLease.update({ phase: 'preparing' });
      });
      if (!restored) return null;
      if (!await verifyPrefix(filePath, stat, restored)) { cache.invalidate(filePath); return null; }
      rememberWrittenSource(filePath);
      return restored;
    } finally { restoreLease?.(); }
  },
  write({ sessionId, cwd, snapshot, state, timelineEntries, sessionMeta }) {
    const payloads = requestContext.getStore()?.payloads || new Map();
    const stored = cache.saveContinuation({ sessionId, cwd }, snapshot, state, payloads);
    if (stored) payloads.clear();
    cache.saveTimeline({ sessionId, cwd }, snapshot, timelineEntries, sessionMeta);
    rememberWrittenSource(snapshot.filePath);
  },
  onRead({ bytes }) { sourceBytes += bytes; },
  onRewrite(filePath) { cache.invalidate(filePath); writtenSources.delete(filePath); },
  prepare(cached) {
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
  if (hit != null) return hit;
  const context = requestContext.getStore();
  return tool === 'codex' && context && sessionId === context.payload.sessionId
    ? context.payloads.get(id) ?? cache.readPayload(context.payload, id, context.payloadSource) : null;
};

const service = createSessionTranscriptService({ codexData, promptPresentationStore: db, sessionHistoryStore: db,
  preparedHistoryStore: cache,
  codexVirtualMaxBytes: virtualGraphBudget,
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
historyPreparationActivity.subscribe(snapshot => send({ event: 'preparation', snapshot }));
observeHistoryResponseTimingBindings(payload => send({ event: 'timing-bound', payload }));
const chains = new Map();
const receipts = new Map();
const originalReceipt = api.getCodexRewriteReceipt;
api.getCodexRewriteReceipt = (id, source) => {
  const receipt = receipts.get(id);
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
    return;
  }
  if (message.event === 'ownership') { recordCodexProcessActionOwnership(message.payload); return; }
  if (message.event === 'lineage') {
    service.codexProviderForkMetadata.delete(message.sessionId);
    db?.invalidateForkMarkerCache(message.sessionId);
    return;
  }
  if (!message.id) return;
  const { id, method, payload = {} } = message;
  const key = JSON.stringify([payload.sessionId, payload.cwd]);
  const work = async () => {
    if (method === 'stats') return { value: { cache: cache.stats(), projector: api.getCodexHistoryProjectorStats(), sourceBytes, sourceVerificationBytes,
      virtual: { ...service.codexVirtualTranscriptStore?.stats(), budgetBytes: virtualGraphBudget }, workerGraphBudget,
      memory: { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss } }, readProof: [] };
    if (method === 'releaseMemory') { api.invalidateCodexHistoryProjectors(); cache.clearMemory();
      service.codexVirtualTranscriptStore?.clear(); return { value: true, readProof: [] }; }
    if (!['getHistory', 'getTimeline', 'getToolPayload', 'getMessages', 'searchHistory',
      'resolveCodexPhysicalRow', 'copyCodexVirtualRange', 'exportCodexSession'].includes(method)) throw new Error('history_read_method');
    if (message.rewriteReceipt) receipts.set(payload.sessionId, message.rewriteReceipt);
    const context = { payload, payloads: new Map(), sources: new Set(), sourceEpochs: sourceEpochs.slice(), preparations: [], assets: new Map() };
    return requestContext.run(context, async () => {
      try {
        const result = await service[method](payload);
        const readProof = [...context.sources].map(filePath => ({ filePath,
          epoch: context.sourceEpochs[epochSlot(filePath)], slot: epochSlot(filePath) }));
        if (readProof.some(source => source.epoch !== Atomics.load(sourceEpochs, source.slot))) {
          throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
        if (context.payloads.size) cache.savePayloads(payload, context.payloads);
        return { value: result, readProof };
      } finally {
        if (context.assets.size) send({ event: 'assets', refs: [...context.assets.values()] });
        for (const finish of context.preparations) finish();
        context.coldRelease?.();
      }
    });
  };
  const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(work);
  chains.set(key, run);
  run.then(({ value: result, readProof }) => {
    if (message.binary) {
      const data = new Uint8Array(v8.serialize(result));
      // Transfer bytes, not tens of thousands of objects through main. Only
      // this small witness is needed there to reject a revoked response.
      send({ id, readProof, result: { __notedHistoryTransport: 'v8-1', data,
        proof: { filePath: result.filePath, error: result.error,
          sourcePaths: (result.revision?.sources || []).map(source => source.filePath) } } }, [data.buffer]);
    } else send({ id, readProof, result });
  }, error => send({ id, error: { message: error.message, code: error.code } }))
    .catch(error => { try { send({ id, error: { message: error.message, code: error.code } }); } catch {} })
    .finally(() => { if (chains.get(key) === run) chains.delete(key); receipts.delete(payload.sessionId); });
});

send({ event: 'ready' });
