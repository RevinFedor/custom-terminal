'use strict';

// Worker-owned, disposable data. Source journals and the application database
// are never written here. A small positional index survives without bringing
// either the parser graph or offscreen row bodies back into RAM.
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { makeHistoryRowStub, historyRowCarriesLiveWork, normalizeHistoryEntryWindowRequest,
  normalizeHistoryRowWindowRequest } = require('./history-entry-window');
const { historyEntryHasExactIdentity } = require('../shared/history-entry-identity.cjs');
const { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES } = require('./history-cache-policy');
const { currentReadControl, isHistoryReadCancelled, isHistoryReadUnavailable, createReadAdmission } = require('./history-read-control');
const { HistoryPendingPayloads, readChunkedPayload } = require('./history-pending-payloads');

const SCHEMA = 1;
const WORK_ROWS = 32;
const WORK_BYTES = 256 * 1024;
const DIAGNOSTIC_HISTORY_LIMIT = 256;
const DIAGNOSTIC_STRING_FIELDS = ['operation', 'outcome', 'reason', 'sessionId', 'cacheKey', 'cacheVersion', 'otherVersion',
  'layer', 'kind', 'cacheTier', 'indexOutcome', 'indexReason', 'causeOperation', 'errorReason', 'errorName', 'errorCode', 'errorModule'];
const DIAGNOSTIC_SCALAR_FIELDS = ['bytes', 'budgetBytes', 'snapshotBytes', 'sourceBytes', 'rows', 'pageRows', 'indexBytes',
  'indexMemoryBytes', 'indexBudgetBytes', 'evictedCount', 'evictedBytes', 'removedCount', 'deferredCount',
  'errorCount', 'fileCount', 'activeCount', 'diskBytes', 'otherVersionObserved', 'indexRetained', 'errorLine', 'errorColumn',
  'obsoleteEvictedCount', 'stateEvictedCount', 'rowsEvictedCount', 'timelineEvictedCount'];
const CACHE_FILE = /^([a-f0-9]{64})(?:\.(state|timeline))?\.sqlite$/;
const STATE_OPERATIONS = new Set(['saveContinuation', 'readContinuation', 'saveVirtualState', 'readVirtualState',
  'savePayload', 'savePayloads', 'readPayload']);
const TIMELINE_OPERATIONS = new Set(['saveTimeline', 'readTimeline', 'saveVirtualProjection', 'readVirtualProjection',
  'saveSourceHeader', 'readSource', 'readSourceProof']);
const operationTier = operation => STATE_OPERATIONS.has(operation) ? 'state' : TIMELINE_OPERATIONS.has(operation) ? 'timeline' : 'rows';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pack = value => v8.serialize(value);
const encode = value => { const body = pack(value); return { body, checksum: hash(body) }; };
const ownerKey = owner => JSON.stringify([owner.sessionId, owner.cwd || '']);
const indexHash = row => hash(JSON.stringify([row.pos, row.stub, row.live, row.content_hash, row.checksum]));
function decode(row) {
  if (!row || hash(row.body) !== row.checksum) throw new Error('history_cache_checksum');
  return v8.deserialize(row.body);
}
function rowContentHash(value) {
  // V8's byte encoding is not a semantic fingerprint (identical strings can
  // have different internal encodings after deserialize). Otherwise a tiny
  // append rewrites thousands of unchanged disk rows after RAM eviction.
  const digest = crypto.createHash('sha256');
  const seen = new Map();
  const visit = item => {
    if (item === null) { digest.update('null;'); return; }
    const kind = typeof item;
    if (kind === 'string') { digest.update('s' + item.length + ':'); digest.update(item, 'utf16le'); return; }
    if (kind !== 'object') { digest.update(kind + ':' + (Object.is(item, -0) ? '-0' : String(item)) + ';'); return; }
    if (seen.has(item)) { digest.update('ref:' + seen.get(item) + ';'); return; }
    seen.set(item, seen.size);
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) {
      const bytes = pack(item); digest.update('v8:' + bytes.length + ':'); digest.update(bytes); return;
    }
    digest.update(Array.isArray(item) ? 'array:' + item.length + ':' : 'object:');
    const keys = Object.keys(item); digest.update(keys.length + ':');
    for (const key of keys) { visit(key); visit(item[key]); }
  };
  visit(value);
  return digest.digest('hex');
}
function exactSource(snapshot, stat) {
  return !!snapshot && !!stat && snapshot.size === stat.size
    && snapshot.mtimeMs === stat.mtimeMs && snapshot.ctimeMs === stat.ctimeMs
    && snapshot.fileIdentity === stat.dev + ':' + stat.ino;
}
function sourceRejection(snapshot, filePath, stat, append = false) {
  if (!snapshot) return 'missing-source';
  if (snapshot.filePath !== filePath) return 'source-path-mismatch';
  if (!stat) return 'missing-source-stat';
  if (snapshot.fileIdentity !== stat.dev + ':' + stat.ino) return 'source-identity-mismatch';
  if (stat.size < snapshot.size) return 'source-truncated';
  if (stat.size !== snapshot.size) return append ? null : 'source-size-mismatch';
  return exactSource(snapshot, stat) ? null : 'source-rewritten';
}
function cacheErrorReason(error) {
  if (isHistoryReadCancelled(error)) return 'consumer-revoked';
  if (isHistoryReadUnavailable(error)) return {
    HISTORY_READER_FENCE_UNAVAILABLE: 'reader-fence-unavailable',
    HISTORY_READER_TRANSPORT_UNKNOWN: 'reader-transport-unknown',
    HISTORY_READER_PROCESS_EXITED: 'reader-process-exited',
  }[error.code];
  if (error?.message === 'history_cache_checksum') return 'checksum-mismatch';
  if (error?.message === 'history_cache_index' || error?.message === 'history_cache_payload_index') return 'index-corrupt';
  if (error?.message === 'history_cache_write_invalidated') return 'write-invalidated';
  if (error?.code === 'CODEX_SOURCE_READ_INVALIDATED') return 'source-invalidated';
  if (/^Unable to deserialize cloned data due to invalid or unsupported version\.?$/.test(error?.message || '')) return 'serialization-version';
  if (/^Unable to deserialize cloned data\.?$/.test(error?.message || '')) return 'serialization-error';
  if (error instanceof SyntaxError) return 'invalid-json';
  if (/^SQLITE_(?:CORRUPT|NOTADB)(?:_|$)/.test(error?.code || '')) return 'sqlite-corrupt';
  if (/^SQLITE_(?:FULL|BUSY|LOCKED|READONLY|CANTOPEN|IOERR)(?:_|$)/.test(error?.code || '')) return error.code.split('_').slice(0, 2).join('-').toLowerCase();
  if (/^SQLITE_[A-Z_]+$/.test(error?.code || '')) return 'sqlite-error';
  const ioReason = { ENOSPC: 'disk-full', EACCES: 'permission-denied', EPERM: 'permission-denied',
    ENOENT: 'no-file', ENOTDIR: 'not-a-directory', EISDIR: 'is-a-directory', EMFILE: 'open-file-limit' }[error?.code];
  if (ioReason) return ioReason;
  return 'cache-error';
}
function rejectDiagnostic(diagnostic, reason, outcome = 'rejected') {
  Object.assign(diagnostic, { outcome, reason });
  return null;
}
function diagnosticErrorSite(diagnostic, error) {
  // Keep a useful source location for unexpected exceptions without recording
  // an error's first line (it can contain query text, paths or payload bytes).
  diagnostic.errorName = error?.name;
  diagnostic.errorCode = error?.code;
  const site = /[\\/](history-[a-z0-9-]+\.(?:js|cjs)):(\d+):(\d+)/i.exec(String(error?.stack || '').slice(0, 3000));
  if (site) Object.assign(diagnostic, { errorModule: site[1].replace(/\./g, '_'), errorLine: Number(site[2]), errorColumn: Number(site[3]) });
}
function rememberBounded(map, key, value) {
  map.delete(key); map.set(key, value);
  if (map.size > DIAGNOSTIC_HISTORY_LIMIT) map.delete(map.keys().next().value);
}
function canonicalPageRow(row) {
  if (!row.entryRef) return row;
  // A composite view's current revision lives in its header. Storing that
  // token on every row would rewrite all ancestor bodies on each child append.
  const { contentRevision, ...entry } = row;
  const { contentRevision: refRevision, ...entryRef } = row.entryRef;
  return { ...entry, entryRef };
}

function* entryPayloadBindings(entry) {
  if (!entry || typeof entry.uuid !== 'string' || !entry.uuid) return;
  function valid(ref) {
    return ref && typeof ref.payloadId === 'string' && /^[a-f0-9]{64}$/.test(ref.contentHash)
      && Number.isSafeInteger(ref.totalChars) && ref.totalChars >= 0;
  }
  for (const ref of [entry.thinkingRef, entry.compactSummaryRef]) if (valid(ref)) yield ref;
  for (const action of entry.actions || []) {
    if (valid(action?.actionRef)) yield action.actionRef;
    const raw = action?.rawTool, ref = raw?.resultRef;
    if (!valid(ref)) continue;
    // Canonical normalization appends :canonical:N to the physical call ID.
    // Record this relationship from the backend row, never by stripping a
    // client-supplied payload ID during rehydration. Other shapes miss safely.
    const canonical = typeof raw.toolUseId === 'string' && ref.payloadId === 'result:' + raw.toolUseId
      ? /^(.*):canonical:(?:0|[1-9][0-9]*)$/.exec(raw.toolUseId) : null;
    yield { ...ref, sourceCallId: canonical?.[1] || null,
      sourceRecordLine: canonical && Number.isSafeInteger(raw.resultSourceLine) && raw.resultSourceLine >= 0
        ? raw.resultSourceLine : null };
  }
}
const payloadBindingSource = source => hash(JSON.stringify(['payload-source-v1', source?.filePath,
  source?.size, source?.mtimeMs, source?.ctimeMs, source?.fileIdentity, source?.sourceGeneration]));
const payloadBindingHash = row => hash(JSON.stringify([row.view, row.entry_uuid, row.payload_id,
  row.content_hash, row.total_chars, row.source_generation, row.source_witness, row.source_call_id, row.source_line]));

class HistoryPreparedCache {
  constructor({ directory, maxBytes = HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES, schema = SCHEMA, indexBudgetBytes = 32 * 1024 * 1024, onDiagnostic = null } = {}) {
    if (!path.isAbsolute(directory || '')) throw new Error('history_cache_directory_required');
    if (!/^[a-z0-9-]+$/i.test(String(schema))) throw new Error('history_cache_schema');
    this.baseDirectory = directory;
    this.directory = path.join(directory, 'v' + schema);
    this.maxBytes = maxBytes;
    this.onDiagnostic = onDiagnostic;
    this.recentRemovals = new Map(); this.otherVersions = new Map();
    this.indices = new Map(); this.indexMemoryBytes = 0;
    this.activeFiles = new Set(); this.invalidatedFiles = new Set();
    this.asyncFileAdmissions = new Map();
    this.indexMemoryBudget = indexBudgetBytes;
    this.metrics = { pageBytes: 0, pageRows: 0, indexBytes: 0, continuationBytes: 0, writes: 0, hits: 0, misses: 0, errors: 0,
      continuationWriteBytes: 0, continuationSerializeMs: 0, continuationWriteMs: 0,
      metadataWriteBytes: 0, preparedRowWriteBytes: 0, payloadWriteBytes: 0, preparedWriteMs: 0 };
    this.metrics.virtualContinuationBytes = 0;
    Object.assign(this.metrics, { retainedIndexPeakBytes: 0, indexBatchPeakRows: 0, indexBatchPeakBytes: 0,
      preparedBatchPeakRows: 0, preparedBatchPeakBytes: 0, decodedRowPeakBytes: 0, pendingPayloadPeakChunkBytes: 0 });
    this.enabled = true;
    try { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.prune(); }
    catch (error) {
      this.enabled = false; this.metrics.errors++;
      this.diagnose({ operation: 'initialize', outcome: 'disabled', reason: cacheErrorReason(error) });
      console.warn('[HistoryPreparedCache] unavailable reason=' + cacheErrorReason(error));
    }
  }

  filename(owner, tier = 'rows') {
    if (!['rows', 'state', 'timeline'].includes(tier)) throw new Error('history_cache_tier');
    return path.join(this.directory, hash(ownerKey(owner)) + (tier === 'rows' ? '' : '.' + tier) + '.sqlite');
  }
  check(control = currentReadControl()) { control?.assertCurrent(); this.assertCurrent?.(); }
  async checkpoint(control = currentReadControl()) {
    this.check(control);
    if (control) await control.checkpoint(); else await new Promise(resolve => setImmediate(resolve));
    this.check(control);
  }
  async acquireFile(filename, control) {
    let entry = this.asyncFileAdmissions.get(filename);
    if (!entry) { entry = { users: 0, admission: createReadAdmission() }; this.asyncFileAdmissions.set(filename, entry); }
    entry.users++;
    const forget = () => {
      if (--entry.users === 0 && this.asyncFileAdmissions.get(filename) === entry) this.asyncFileAdmissions.delete(filename);
    };
    try {
      const release = await entry.admission.acquire(control);
      return () => { release(); forget(); };
    } catch (error) { forget(); throw error; }
  }
  createPendingPayloads(owner) {
    this.check();
    return new HistoryPendingPayloads({ directory: this.directory, control: currentReadControl(),
      onHighWater: value => { this.metrics.pendingPayloadPeakChunkBytes = Math.max(this.metrics.pendingPayloadPeakChunkBytes, value.peakChunkBytes); } });
  }
  diagnostic(operation, owner, write = false) {
    return { operation, outcome: write ? 'stored' : 'hit', reason: write ? 'stored' : 'disk-hit',
      sessionId: owner?.sessionId, cacheKey: owner ? hash(ownerKey(owner)) : undefined,
      layer: 'disk', cacheTier: operationTier(operation), cacheVersion: path.basename(this.directory), budgetBytes: this.maxBytes };
  }
  diagnose(details) {
    if (typeof this.onDiagnostic !== 'function') return;
    // Fixed scalar allowlist: never forward source/context/payload/error text.
    // One summary per operation, never one event per row/payload/file in a scan.
    const event = {};
    for (const key of DIAGNOSTIC_STRING_FIELDS) {
      const value = details[key];
      if (typeof value === 'string') event[key] = /^[a-z0-9_-]{1,128}$/i.test(value) ? value : hash(value);
    }
    for (const key of DIAGNOSTIC_SCALAR_FIELDS) {
      const value = details[key];
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) event[key] = value;
    }
    try {
      const pending = this.onDiagnostic(event);
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch {} // Diagnostics cannot reject a usable cache result.
  }
  missingFile(diagnostic, filename) {
    const removal = this.recentRemovals.get(hash(filename));
    const key = path.basename(filename, '.sqlite');
    const otherVersion = this.otherVersions.get(key) || this.otherVersions.get(key.replace(/\.(?:state|timeline)$/, ''));
    diagnostic.cacheVersion = path.basename(this.directory);
    if (otherVersion) { diagnostic.otherVersion = otherVersion; diagnostic.otherVersionObserved = true; }
    return rejectDiagnostic(diagnostic, removal || (otherVersion ? 'version-mismatch' : 'no-file'), 'miss');
  }
  rememberIndex(key, value, causeOperation = 'rememberIndex') {
    let evictedCount = 0, evictedBytes = 0;
    this.indexMemoryBytes -= this.indices.get(key)?.bytes || 0;
    this.indices.delete(key);
    if (value.entries && value.bytes <= this.indexMemoryBudget) { this.indices.set(key, value); this.indexMemoryBytes += value.bytes; }
    while (this.indexMemoryBytes > this.indexMemoryBudget) {
      const oldest = this.indices.keys().next().value;
      evictedCount++; evictedBytes += this.indices.get(oldest).bytes;
      this.indexMemoryBytes -= this.indices.get(oldest).bytes; this.indices.delete(oldest);
    }
    this.diagnose({ operation: 'rememberIndex', causeOperation, layer: 'memory', cacheKey: path.basename(key.split('\u0000')[0], '.sqlite'),
      outcome: value.entries && value.bytes <= this.indexMemoryBudget ? 'retained' : 'skipped', reason: evictedCount || !value.entries || value.bytes > this.indexMemoryBudget ? 'index-budget' : 'memory-store',
      bytes: value.bytes, indexMemoryBytes: this.indexMemoryBytes, indexBudgetBytes: this.indexMemoryBudget, evictedCount, evictedBytes });
  }
  forgetIndexFile(filename) {
    for (const [key, value] of this.indices) if (key.startsWith(filename + '\u0000')) {
      this.indices.delete(key); this.indexMemoryBytes -= value.bytes;
    }
  }
  clearMemory() {
    const bytes = this.indexMemoryBytes, removedCount = this.indices.size;
    this.indices.clear(); this.indexMemoryBytes = 0;
    this.diagnose({ operation: 'clearMemory', layer: 'memory', outcome: 'cleared', reason: 'memory-release', bytes, removedCount });
  }
  removeFile(filename, reason = 'explicit-removal', report = true) {
    const diagnostic = { operation: 'removeFile', outcome: 'removed', reason, cacheKey: path.basename(filename, '.sqlite'), layer: 'disk' };
    if (this.activeFiles.has(filename)) {
      this.invalidatedFiles.add(filename); rememberBounded(this.recentRemovals, hash(filename), reason);
      if (report) this.diagnose({ ...diagnostic, outcome: 'deferred' });
      return;
    }
    try {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { fs.unlinkSync(filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.forgetIndexFile(filename);
      rememberBounded(this.recentRemovals, hash(filename), reason);
      if (path.dirname(filename) !== this.directory) this.otherVersions.delete(path.basename(filename, '.sqlite'));
    } catch (error) {
      Object.assign(diagnostic, { outcome: 'error', errorReason: cacheErrorReason(error) });
      throw error;
    } finally { if (report) this.diagnose(diagnostic); }
  }
  withDb(owner, write, callback, operation = write ? 'write' : 'read', sharedDiagnostic = null) {
    this.check();
    const diagnostic = sharedDiagnostic || this.diagnostic(operation, owner, write);
    const report = () => { if (!sharedDiagnostic) this.diagnose(diagnostic); };
    if (!this.enabled) { rejectDiagnostic(diagnostic, 'disabled', 'disabled'); report(); return null; }
    const filename = this.filename(owner, operationTier(operation));
    if (!write && !fs.existsSync(filename)) { this.missingFile(diagnostic, filename); report(); return null; }
    let db, result = null;
    try {
      db = new Database(filename);
      db.pragma('cache_size = -2048');
      db.pragma('journal_mode = DELETE');
      if (write) {
        fs.chmodSync(filename, 0o600);
        db.pragma('auto_vacuum = FULL');
        db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, body BLOB NOT NULL, checksum TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS rows (view TEXT, pos INTEGER, stub TEXT NOT NULL, live INTEGER NOT NULL, index_hash TEXT NOT NULL,
            body BLOB NOT NULL, checksum TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(view,pos));
          CREATE TABLE IF NOT EXISTS payloads (id TEXT PRIMARY KEY, body BLOB NOT NULL, checksum TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS payload_bindings (view TEXT NOT NULL, entry_uuid TEXT NOT NULL,
            payload_id TEXT NOT NULL, content_hash TEXT NOT NULL, total_chars INTEGER NOT NULL,
            source_generation TEXT NOT NULL, source_witness TEXT NOT NULL,
            source_call_id TEXT, source_line INTEGER, checksum TEXT NOT NULL,
            PRIMARY KEY(view,entry_uuid,payload_id));`);
      }
      if (!this.invalidatedFiles.has(filename)) this.recentRemovals.delete(hash(filename));
      result = callback(db, diagnostic);
      this.check();
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      if (isHistoryReadCancelled(error) || isHistoryReadUnavailable(error)) {
        rejectDiagnostic(diagnostic, cacheErrorReason(error), isHistoryReadCancelled(error) ? 'cancelled' : 'unknown'); report();
        throw error;
      }
      if (error?.message === 'history_payload_range_invalid') {
        rejectDiagnostic(diagnostic, 'payload-range-invalid'); report(); throw error;
      }
      this.metrics.errors++;
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error');
      diagnosticErrorSite(diagnostic, error);
      console.warn('[HistoryPreparedCache] rejected file=' + path.basename(filename) + ' reason=' + diagnostic.reason);
      try { db?.close(); db = null; this.removeFile(filename, diagnostic.reason); } catch {}
      this.forgetIndexFile(filename);
      report();
      return null; // A bad acceleration file never makes history unavailable.
    } finally {
      db?.close();
      if (write && !sharedDiagnostic && !['cancelled', 'unknown'].includes(diagnostic.outcome)) { try { this.prune(filename); } catch (error) { this.metrics.errors++; } }
    }
    if (write && !fs.existsSync(filename)) { this.missingFile(diagnostic, filename); result = null; }
    report();
    return result;
  }
  async withAsyncDb(owner, callback, operation = 'writeAsync', control = currentReadControl()) {
    const release = await this.acquireFile(this.filename(owner, operationTier(operation)), control);
    try { return await this._withAsyncDb(owner, callback, operation, control); }
    finally { release(); }
  }
  async _withAsyncDb(owner, callback, operation, control) {
    this.check(control);
    const diagnostic = this.diagnostic(operation, owner, true);
    if (!this.enabled) { rejectDiagnostic(diagnostic, 'disabled', 'disabled'); this.diagnose(diagnostic); return null; }
    const filename = this.filename(owner, operationTier(operation));
    // Initialize outside the long transaction using the same schema/path rules.
    this.withDb(owner, true, () => true, operation, diagnostic);
    if (!fs.existsSync(filename)) {
      if (diagnostic.outcome !== 'error') this.missingFile(diagnostic, filename);
      this.diagnose(diagnostic); return null;
    }
    let db, result = null;
    this.activeFiles.add(filename);
    try {
      db = new Database(filename);
      db.pragma('cache_size = -2048');
      db.exec('BEGIN IMMEDIATE');
      result = await callback(db, diagnostic);
      await this.checkpoint(control); // Deliver pending aborts before COMMIT.
      this.check(control);
      if (this.invalidatedFiles.has(filename)) throw new Error('history_cache_write_invalidated');
      db.exec('COMMIT');
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      if (db?.inTransaction) db.exec('ROLLBACK');
      if (isHistoryReadCancelled(error) || isHistoryReadUnavailable(error)) {
        rejectDiagnostic(diagnostic, cacheErrorReason(error), isHistoryReadCancelled(error) ? 'cancelled' : 'unknown');
        // Revoked demand or unavailable authority is not cache corruption.
        // ROLLBACK above leaves the last committed generation fully usable.
        throw error;
      }
      this.metrics.errors++; result = null;
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error');
      diagnosticErrorSite(diagnostic, error);
      console.warn('[HistoryPreparedCache] rejected async file=' + path.basename(filename) + ' reason=' + diagnostic.reason);
      this.invalidatedFiles.add(filename);
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
    } finally {
      db?.close(); this.activeFiles.delete(filename);
      if (this.invalidatedFiles.delete(filename)) this.removeFile(filename, this.recentRemovals.get(hash(filename)) || diagnostic.reason);
      if (!['cancelled', 'unknown'].includes(diagnostic.outcome)) { try { this.prune(filename); } catch { this.metrics.errors++; } }
      if (!['error', 'cancelled', 'unknown'].includes(diagnostic.outcome) && !fs.existsSync(filename)) this.missingFile(diagnostic, filename);
      this.diagnose(diagnostic);
    }
    return fs.existsSync(filename) ? result : null;
  }
  getMeta(db, key) { const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get(key); return row ? decode(row) : null; }
  setMeta(db, key, value, diagnostic = null) {
    this.check();
    if (key === 'continuation' || key === 'virtualState') this.onStage?.({ phase: 'continuation-codec' });
    const started = performance.now();
    const { body, checksum } = encode(value);
    this.check();
    if (diagnostic) diagnostic.bytes = (diagnostic.bytes || 0) + body.length;
    if (key === 'continuation' || key === 'virtualState') {
      this.metrics.continuationWriteBytes += body.length;
      this.metrics.continuationSerializeMs += performance.now() - started;
    } else this.metrics.metadataWriteBytes += body.length;
    const writeAt = performance.now();
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?,?)').run(key, body, checksum);
    if (key === 'continuation' || key === 'virtualState') this.metrics.continuationWriteMs += performance.now() - writeAt;
  }
  prune(protectedFile = null) {
    const diagnostic = { operation: 'prune', layer: 'disk', outcome: 'unchanged', reason: 'within-budget',
      budgetBytes: this.maxBytes, evictedCount: 0, evictedBytes: 0, removedCount: 0, activeCount: 0, errorCount: 0 };
    if (!this.enabled) { this.diagnose({ ...diagnostic, outcome: 'disabled', reason: 'disabled' }); return; }
    this.otherVersions.clear();
    try {
      // Old parser/schema versions share the same quota rather than each
      // silently acquiring another full budget after an application update.
      const families = new Map();
      for (const entry of fs.readdirSync(this.baseDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^v\d+(?:-[a-f0-9]+)?$/.test(entry.name)) continue;
        const directory = path.join(this.baseDirectory, entry.name);
        for (const name of fs.readdirSync(directory).filter(name => CACHE_FILE.test(name.replace(/-(?:journal|wal|shm)$/, '')))) {
          const file = path.join(directory, name);
          const base = file.replace(/-(?:journal|wal|shm)$/, '');
          try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile()) continue;
            const item = families.get(base) || { file: base, size: 0, used: stat.mtimeMs, main: false };
            item.size += stat.size;
            if (file === base) { item.used = stat.mtimeMs; item.main = true; }
            families.set(base, item);
          } catch { diagnostic.errorCount++; }
        }
      }
      const files = [...families.values()].filter(item => {
        if (item.main) {
          // Reuse this existing quota scan. A hot miss never searches old schema
          // directories; this bounded hint is only evidence from the last prune.
          if (path.dirname(item.file) !== this.directory) rememberBounded(this.otherVersions,
            path.basename(item.file, '.sqlite'), path.basename(path.dirname(item.file)));
          return true;
        }
        this.removeFile(item.file, 'orphan-sidecar', false); diagnostic.removedCount++; return false;
      });
      let size = files.reduce((n, f) => n + f.size, 0);
      // Obsolete schema first, compact Timeline last. Among heavy files, use
      // OWNER LRU and discard its checkpoint before its ready rows. A global
      // "all checkpoints first" would keep ancient rows while repeatedly
      // evicting a working tab's new append checkpoint. Protect the whole
      // just-written owner across its split files, still under one total cap.
      const retentionTier = file => path.dirname(file) !== this.directory ? 0
        : file.endsWith('.state.sqlite') ? 1 : file.endsWith('.timeline.sqlite') ? 3 : 2;
      const ownerId = file => path.join(path.dirname(file), path.basename(file).split('.')[0]);
      const ownerUsed = new Map();
      for (const item of files) ownerUsed.set(ownerId(item.file), Math.max(ownerUsed.get(ownerId(item.file)) || 0, item.used));
      const protectedOwner = protectedFile ? ownerId(protectedFile) : null;
      const group = file => retentionTier(file) === 0 ? 0 : retentionTier(file) === 3 ? 2 : 1;
      files.sort((a, b) => group(a.file) - group(b.file)
        || Number(ownerId(a.file) === protectedOwner) - Number(ownerId(b.file) === protectedOwner)
        || ownerUsed.get(ownerId(a.file)) - ownerUsed.get(ownerId(b.file))
        || retentionTier(a.file) - retentionTier(b.file) || a.used - b.used);
      for (const item of files) {
        if (size <= this.maxBytes) break;
        if (this.activeFiles.has(item.file)) { diagnostic.activeCount++; continue; }
        this.removeFile(item.file, 'disk-quota', false); size -= item.size;
        diagnostic.evictedCount++; diagnostic.evictedBytes += item.size;
        const counter = ['obsoleteEvictedCount', 'stateEvictedCount', 'rowsEvictedCount', 'timelineEvictedCount'][retentionTier(item.file)];
        diagnostic[counter] = (diagnostic[counter] || 0) + 1;
      }
      this.diskBytes = size;
      diagnostic.diskBytes = size; diagnostic.fileCount = files.length;
      if (diagnostic.evictedCount) { diagnostic.outcome = 'evicted'; diagnostic.reason = 'disk-quota'; }
      else if (diagnostic.removedCount) { diagnostic.outcome = 'removed'; diagnostic.reason = 'orphan-sidecar'; }
      if (size > this.maxBytes) diagnostic.reason = 'active-files-over-budget';
      if (diagnostic.errorCount) { diagnostic.outcome = 'partial'; diagnostic.reason = 'file-stat-error'; }
    } catch (error) {
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error'); throw error;
    } finally { this.diagnose(diagnostic); }
  }
  invalidate(filePath = null) {
    const diagnostic = { operation: 'invalidate', layer: 'disk', outcome: 'unchanged', reason: 'no-matching-source',
      removedCount: 0, deferredCount: 0, errorCount: 0 };
    if (!this.enabled) { this.diagnose({ ...diagnostic, outcome: 'disabled', reason: 'disabled' }); return; }
    const remove = file => {
      const deferred = this.activeFiles.has(file);
      this.removeFile(file, 'invalidation', false);
      diagnostic[deferred ? 'deferredCount' : 'removedCount']++;
      diagnostic.outcome = deferred ? 'deferred' : 'removed'; diagnostic.reason = 'invalidation';
    };
    try {
      const names = fs.readdirSync(this.directory).filter(name => CACHE_FILE.test(name));
      const owners = new Set();
      // A committed tier identifies the owner even when another tier has an
      // in-flight page transaction and no committed source header yet.
      for (const name of names) {
        const file = path.join(this.directory, name);
        let db;
        try {
          db = new Database(file, { readonly: true });
          const source = this.getMeta(db, 'source');
          db.close(); db = null;
          if (!filePath || source?.filePath === filePath) owners.add(CACHE_FILE.exec(name)[1]);
        } catch (error) {
          diagnostic.errorCount++; diagnostic.errorReason = cacheErrorReason(error);
          try { remove(file); } catch { diagnostic.errorCount++; }
        }
        finally { db?.close(); }
      }
      for (const name of names) if (owners.has(CACHE_FILE.exec(name)[1])) remove(path.join(this.directory, name));
    } catch (error) {
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error'); throw error;
    } finally { this.diagnose(diagnostic); }
  }

  saveContinuation(owner, snapshot, state, payloads = new Map()) {
    this.check();
    this.saveSourceHeader(owner, snapshot, state.sourceProof || []);
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.snapshotBytes = snapshot?.size;
      this.putPayloads(db, payloads, diagnostic);
      this.setMeta(db, 'source', snapshot, diagnostic);
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'continuationSource', snapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.sourceProof || [], diagnostic);
      this.setMeta(db, 'continuation', state, diagnostic);
      this.metrics.writes++;
      return true;
    })(), 'saveContinuation');
  }
  async saveContinuationAsync(owner, snapshot, state, payloads = new Map()) {
    const saved = await this.withAsyncDb(owner, async (db, diagnostic) => {
      diagnostic.snapshotBytes = snapshot?.size;
      await this.putPayloadsAsync(db, payloads, diagnostic);
      await this.checkpoint();
      this.setMeta(db, 'source', snapshot, diagnostic);
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'continuationSource', snapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.sourceProof || [], diagnostic);
      this.setMeta(db, 'continuation', state, diagnostic);
      this.metrics.writes++;
      return true;
    }, 'saveContinuation');
    if (saved) this.saveSourceHeader(owner, snapshot, state.sourceProof || []);
    return saved;
  }
  saveTimeline(owner, source, entries, sessionMeta) {
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      this.setMeta(db, 'source', source, diagnostic);
      this.setMeta(db, 'timeline', { owner: ownerKey(owner), source, entries, sessionMeta }, diagnostic);
    })(), 'saveTimeline');
  }
  readTimeline(owner, filePath, stat) {
    return this.withDb(owner, false, (db, diagnostic) => {
      const result = this.getMeta(db, 'timeline');
      if (!result) return rejectDiagnostic(diagnostic, 'missing-timeline', 'miss');
      if (result.owner !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      diagnostic.snapshotBytes = result.source?.size; diagnostic.sourceBytes = stat?.size;
      const reason = sourceRejection(result.source, filePath, stat);
      return reason ? rejectDiagnostic(diagnostic, reason) : result;
    }, 'readTimeline');
  }
  saveVirtualProjection(owner, projection) {
    const { historyEntries, ...metadata } = projection;
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      this.setMeta(db, 'source', projection.childSnapshot || null, diagnostic);
      this.setMeta(db, 'virtual', { ...metadata, owner: ownerKey(owner) }, diagnostic);
    })(), 'saveVirtualProjection');
  }
  readVirtualProjection(owner, descriptor) {
    return this.withDb(owner, false, (db, diagnostic) => {
      const saved = this.getMeta(db, 'virtual');
      if (!saved) return rejectDiagnostic(diagnostic, 'missing-virtual-projection', 'miss');
      if (saved.owner !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      if (saved.eventKey !== descriptor.eventKey) return rejectDiagnostic(diagnostic, 'event-key-mismatch');
      if (saved.manifest?.manifestDigest !== descriptor.manifest.manifestDigest) return rejectDiagnostic(diagnostic, 'manifest-mismatch');
      return saved;
    }, 'readVirtualProjection');
  }
  saveVirtualState(owner, state) {
    this.saveSourceHeader(owner, state.childSnapshot, state.childProof || []);
    const payloads = this.pendingPayloads?.() || new Map();
    const saved = this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.bytes = 0; diagnostic.snapshotBytes = state.childSnapshot?.size;
      this.putPayloads(db, payloads, diagnostic);
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'source', state.childSnapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.childProof || [], diagnostic);
      this.setMeta(db, 'virtualState', state, diagnostic);
      return true;
    })(), 'saveVirtualState');
    if (saved) payloads.clear();
    return saved;
  }
  async saveVirtualStateAsync(owner, state) {
    const payloads = this.pendingPayloads?.() || new Map();
    const saved = await this.withAsyncDb(owner, async (db, diagnostic) => {
      diagnostic.bytes = 0; diagnostic.snapshotBytes = state.childSnapshot?.size;
      await this.putPayloadsAsync(db, payloads, diagnostic);
      await this.checkpoint();
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'source', state.childSnapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.childProof || [], diagnostic);
      this.setMeta(db, 'virtualState', state, diagnostic);
      return true;
    }, 'saveVirtualState');
    if (saved) { this.saveSourceHeader(owner, state.childSnapshot, state.childProof || []); payloads.clear(); }
    return saved;
  }
  readVirtualState(owner, descriptor) {
    return this.withDb(owner, false, (db, diagnostic) => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get('virtualState');
      if (!row) return rejectDiagnostic(diagnostic, 'missing-virtual-state', 'miss');
      diagnostic.bytes = row.body.length;
      const state = decode(row);
      if (state.descriptor.eventKey !== descriptor.eventKey) return rejectDiagnostic(diagnostic, 'event-key-mismatch');
      if (state.descriptor.manifest.manifestDigest !== descriptor.manifest.manifestDigest) return rejectDiagnostic(diagnostic, 'manifest-mismatch');
      if (state.descriptor.payloadPolicy !== descriptor.payloadPolicy) return rejectDiagnostic(diagnostic, 'payload-policy-mismatch');
      diagnostic.snapshotBytes = state.childSnapshot?.size;
      this.metrics.virtualContinuationBytes += row.body.length;
      return state;
    }, 'readVirtualState');
  }
  readContinuation(owner, filePath, stat, onRestore = null) {
    return this.withDb(owner, false, (db, diagnostic) => {
      const snapshot = this.getMeta(db, 'continuationSource');
      diagnostic.snapshotBytes = snapshot?.size; diagnostic.sourceBytes = stat?.size;
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      if (!snapshot) return rejectDiagnostic(diagnostic, 'missing-continuation-source', 'miss');
      if (snapshot.sessionId !== owner.sessionId) return rejectDiagnostic(diagnostic, 'session-mismatch');
      const reason = sourceRejection(snapshot, filePath, stat, true);
      if (reason) return rejectDiagnostic(diagnostic, reason);
      onRestore?.(snapshot);
      const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get('continuation');
      if (!row) return rejectDiagnostic(diagnostic, 'missing-continuation', 'miss');
      diagnostic.bytes = row.body.length;
      diagnostic.reason = stat.size > snapshot.size ? 'append-compatible' : 'disk-hit';
      this.metrics.continuationBytes += row.body.length;
      return { snapshot, state: decode(row) };
    }, 'readContinuation');
  }
  async savePrepared({ owner, source, context, entries, sessionMeta = null, kind = 'view', control = currentReadControl() }) {
    this.check(control);
    this.onStage?.({ phase: kind + '-rows', sessionId: owner.sessionId });
    const started = performance.now();
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
    let indexEntries = [], retainedLive = [], bytes = 0;
    const assets = new Map();
    const indexNonce = crypto.randomUUID();
    const saved = await this.withAsyncDb(owner, async (db, diagnostic) => {
      diagnostic.rows = entries.length; diagnostic.snapshotBytes = source?.size; diagnostic.bytes = 0;
      diagnostic.kind = kind === 'base' ? 'base' : 'view';
      const get = db.prepare('SELECT pos,stub,live,index_hash,checksum,content_hash FROM rows WHERE view=? AND pos=?');
      const put = db.prepare('INSERT OR REPLACE INTO rows VALUES (?,?,?,?,?,?,?,?)');
      // This bounded index survives stash/process loss independently of the
      // canonical graph. Publish only with this exact prepared transaction.
      db.prepare('DELETE FROM payload_bindings WHERE view=?').run(view);
      const bind = db.prepare('INSERT OR REPLACE INTO payload_bindings VALUES (?,?,?,?,?,?,?,?,?,?)');
      let sliceStart = performance.now(), batchRows = 0, batchBytes = 0;
      for (let pos = 0; pos < entries.length; pos++) {
        control?.assertCurrent();
        if (batchRows >= WORK_ROWS || batchBytes >= WORK_BYTES || performance.now() - sliceStart >= 8) {
          await this.checkpoint(control);
          batchRows = 0; batchBytes = 0; sliceStart = performance.now();
        }
        const entry = canonicalPageRow(entries[pos]);
        for (const ref of entryPayloadBindings(entry)) {
          const binding = { view, entry_uuid: entry.uuid, payload_id: ref.payloadId,
            content_hash: ref.contentHash, total_chars: ref.totalChars,
            source_generation: String(source?.sourceGeneration || ''), source_witness: payloadBindingSource(source),
            source_call_id: ref.sourceCallId || null, source_line: ref.sourceRecordLine ?? null };
          bind.run(view, entry.uuid, ref.payloadId, ref.contentHash, ref.totalChars,
            binding.source_generation, binding.source_witness, binding.source_call_id, binding.source_line,
            payloadBindingHash(binding));
        }
        for (const ref of Array.isArray(entry.imagePaths) ? entry.imagePaths : []) {
          const id = ref?.assetId || (typeof ref?.path === 'string' ? path.basename(ref.path) : '');
          if (/^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(id)) assets.set(id, ref);
        }
        const stubEntry = makeHistoryRowStub(entry);
        const stub = JSON.stringify(stubEntry);
        const live = historyRowCarriesLiveWork(entry) || entry.actions?.some(action => action.tool === 'Task'
          && action.subagentStatus === 'completed' && !Number(action.completedAt)) ? 1 : 0;
        bytes += Buffer.byteLength(stub) * 3 + 128;
        if (indexEntries && bytes <= this.indexMemoryBudget) {
          indexEntries.push(stubEntry); retainedLive.push(live);
          this.metrics.retainedIndexPeakBytes = Math.max(this.metrics.retainedIndexPeakBytes, bytes);
        } else { indexEntries = null; retainedLive = null; }
        batchRows++; batchBytes += Buffer.byteLength(stub);
        const contentHash = rowContentHash(entry);
        const previous = get.get(view, pos);
        if (previous && previous.index_hash !== indexHash(previous)) throw new Error('history_cache_index');
        if (previous?.content_hash === contentHash) continue;
        const { body, checksum } = encode(entry);
        const writtenBytes = body.length + Buffer.byteLength(stub);
        batchBytes += body.length;
        this.metrics.preparedBatchPeakRows = Math.max(this.metrics.preparedBatchPeakRows, batchRows);
        this.metrics.preparedBatchPeakBytes = Math.max(this.metrics.preparedBatchPeakBytes, batchBytes);
        this.metrics.preparedRowWriteBytes += writtenBytes; diagnostic.bytes += writtenBytes;
        put.run(view, pos, stub, live, indexHash({ pos, stub, live, content_hash: contentHash, checksum }), body, checksum, contentHash);
        this.metrics.writes++;
      }
      db.prepare('DELETE FROM rows WHERE view=? AND pos>=?').run(view, entries.length);
      this.setMeta(db, 'source', source, diagnostic);
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'view:' + view, { owner: ownerKey(owner), source, context, total: entries.length, sessionMeta, indexNonce,
        assets: [...assets.values()] }, diagnostic);
      this.metrics.preparedWriteMs += performance.now() - started;
      return true;
    }, 'savePrepared', control);
    if (saved) {
      this.check(control);
      this.saveSourceHeader(owner, source);
      this.rememberIndex(this.filename(owner) + '\u0000' + view, { nonce: indexNonce, entries: indexEntries,
        liveRows: retainedLive ? Uint8Array.from(retainedLive) : null, bytes }, 'savePrepared');
    }
    return saved;
  }
  *_preparedRows(db, { owner, filePath, stat, context, hydrate, bounds, kind = 'view', control = currentReadControl() }, diagnostic) {
    this.check(control);
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
      diagnostic.kind = kind === 'base' ? 'base' : 'view';
      const meta = this.getMeta(db, 'view:' + view);
      if (!meta) return rejectDiagnostic(diagnostic, 'missing-prepared-view', 'miss');
      diagnostic.snapshotBytes = meta.source?.size; diagnostic.sourceBytes = stat?.size; diagnostic.rows = meta.total;
      if (meta.owner !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const reason = sourceRejection(meta.source, filePath, stat);
      if (reason) return rejectDiagnostic(diagnostic, reason);
      if (meta.context !== context) return rejectDiagnostic(diagnostic, 'context-mismatch');
      const key = this.filename(owner) + '\u0000' + view;
      let index = this.indices.get(key);
      diagnostic.indexOutcome = 'hit'; diagnostic.indexReason = 'memory-hit';
      const rowRequest = normalizeHistoryRowWindowRequest(hydrate);
      // A ready view is already decorated. A bounded full-row consumer needs
      // only these bodies. Hydration's full positional-list contract remains
      // unchanged; it uses the ordinary row-window path below.
      const entryRequest = rowRequest ? null : normalizeHistoryEntryWindowRequest(bounds);
      const anchors = new Map();
      for (const value of [rowRequest?.centerUuid, entryRequest?.aroundUuid, entryRequest?.fromUuid,
        entryRequest?.afterUuid, entryRequest?.beforeUuid]) if (value) anchors.set(value, -1);
      const observe = (entry, pos) => {
        for (const [identity, found] of anchors) if (found < 0 && historyEntryHasExactIdentity(entry, identity)) anchors.set(identity, pos);
      };
      if (!index || index.nonce !== meta.indexNonce) {
        diagnostic.indexOutcome = 'miss'; diagnostic.indexReason = index ? 'nonce-mismatch' : 'not-in-memory';
        let retained = [], live = [], bytes = 0, count = 0, batchRows = 0, batchBytes = 0;
        for (const row of db.prepare('SELECT pos,stub,live,index_hash,content_hash,checksum FROM rows WHERE view=? ORDER BY pos').iterate(view)) {
          control?.assertCurrent();
          if (row.pos !== count++ || row.index_hash !== indexHash(row)) throw new Error('history_cache_index');
          const entry = JSON.parse(row.stub), rowBytes = Buffer.byteLength(row.stub);
          bytes += rowBytes; observe(entry, row.pos);
          if (retained && bytes * 3 + count * 128 <= this.indexMemoryBudget) { retained.push(entry); live.push(row.live); }
          else { retained = null; live = null; }
          batchRows++; batchBytes += rowBytes;
          this.metrics.indexBatchPeakRows = Math.max(this.metrics.indexBatchPeakRows, batchRows);
          this.metrics.indexBatchPeakBytes = Math.max(this.metrics.indexBatchPeakBytes, batchBytes);
          if (batchRows >= WORK_ROWS || batchBytes >= WORK_BYTES) { yield; batchRows = 0; batchBytes = 0; }
        }
        if (count !== meta.total) throw new Error('history_cache_index');
        diagnostic.indexBytes = bytes; this.metrics.indexBytes += bytes;
        index = { nonce: meta.indexNonce, entries: retained, liveRows: live ? Uint8Array.from(live) : null,
          bytes: bytes * 3 + count * 128 };
      } else {
        for (let pos = 0; pos < index.entries.length; pos++) {
          control?.assertCurrent(); observe(index.entries[pos], pos);
          if (pos % WORK_ROWS === WORK_ROWS - 1) yield;
        }
      }
      this.rememberIndex(key, index, 'readPrepared');
      diagnostic.indexRetained = this.indices.has(key);
      diagnostic.indexMemoryBytes = this.indexMemoryBytes; diagnostic.indexBudgetBytes = this.indexMemoryBudget;
      const total = meta.total;
      const center = anchors.get(rowRequest?.centerUuid) ?? -1;
      const range = rowRequest ? { applied: true,
        from: center < 0 ? Math.max(0, total - rowRequest.radius) : Math.max(0, center - rowRequest.radius),
        to: center < 0 ? total - 1 : Math.min(total - 1, center + rowRequest.radius),
        tailFrom: Math.max(0, total - rowRequest.alwaysHydrateTail) } : { applied: false, from: 0, to: total - 1, tailFrom: 0 };
      let start = 0, end = total, anchorMissing = false;
      if (entryRequest?.aroundUuid || entryRequest?.fromUuid) {
        const anchor = anchors.get(entryRequest.aroundUuid || entryRequest.fromUuid);
        if (anchor < 0) { anchorMissing = true; end = 0; }
        else if (entryRequest.aroundUuid) { start = Math.max(0, anchor - entryRequest.radius); end = Math.min(total, anchor + entryRequest.radius + 1); }
        else start = anchor;
      } else if (entryRequest) {
        if (entryRequest.afterUuid) {
          const anchor = anchors.get(entryRequest.afterUuid);
          if (anchor < 0) anchorMissing = true; else start = anchor + 1;
        }
        if (entryRequest.beforeUuid) {
          const anchor = anchors.get(entryRequest.beforeUuid);
          if (anchor < 0) anchorMissing = true; else end = Math.max(start, anchor);
        }
        if (anchorMissing) { start = 0; end = 0; }
        else if (entryRequest.last && end - start > entryRequest.last) start = end - entryRequest.last;
      }
      const entries = [], settingsBefore = { model: null, effort: null };
      const read = db.prepare('SELECT body,checksum FROM rows WHERE view=? AND pos=?');
      diagnostic.bytes = 0; diagnostic.pageRows = 0;
      const rows = index.entries ? index.entries.map((entry, pos) => ({ pos, entry, live: index.liveRows[pos] }))
        : db.prepare('SELECT pos,stub,live FROM rows WHERE view=? ORDER BY pos').iterate(view);
      let batchRows = 0, batchBytes = 0;
      for (const row of rows) {
        control?.assertCurrent();
        const pos = row.pos, entry = row.entry || JSON.parse(row.stub);
        if (pos < start) {
          const fact = entry.settingsFact;
          if (fact?.version === 1 && fact.provider === 'codex' && ['model', 'effort'].includes(fact.kind)
            && typeof fact.value === 'string' && fact.value) settingsBefore[fact.kind] = {
            uuid: entry.uuid, sourceIdentity: entry.sourceIdentity || null, sessionId: entry.sessionId || owner.sessionId,
            timestamp: entry.timestamp, settingsFact: { version: 1, provider: 'codex', kind: fact.kind, value: fact.value, source: fact.source } };
        }
        if (pos < start || pos >= end) { if (pos % WORK_ROWS === WORK_ROWS - 1) yield; continue; }
        let selected = entry;
        if (!range.applied || (pos >= range.from && pos <= range.to) || pos >= range.tailFrom || row.live) {
          const stored = read.get(view, pos);
          selected = decode(stored);
          this.metrics.pageBytes += stored.body.length; this.metrics.pageRows++;
          this.metrics.decodedRowPeakBytes = Math.max(this.metrics.decodedRowPeakBytes, stored.body.length);
          diagnostic.bytes += stored.body.length; diagnostic.pageRows++;
          batchBytes += stored.body.length;
        }
        entries.push(selected); batchRows++;
        if (batchRows >= WORK_ROWS || batchBytes >= WORK_BYTES) { yield; batchRows = 0; batchBytes = 0; }
      }
      this.check(control);
      return { ...meta, entries, ...(entryRequest ? { entryWindow: {
        total, startIndex: start, dropped: Math.max(0, total - entries.length), truncated: entries.length < total,
        boundsApplied: true, hasMoreAbove: start > 0, hasMoreBelow: start + entries.length < total,
        firstUuid: entries[0]?.uuid || null, lastUuid: entries.at(-1)?.uuid || null,
        ...(anchorMissing ? { anchorMissing: true } : {}) }, settingsBefore } : {}) };
  }
  readPrepared(request) {
    const result = this.withDb(request.owner, false, (db, diagnostic) => db.transaction(() => {
      const iterator = this._preparedRows(db, request, diagnostic);
      let next = iterator.next();
      while (!next.done) next = iterator.next();
      return next.value;
    })(), 'readPrepared');
    this.metrics[result ? 'hits' : 'misses']++;
    return result;
  }
  async readPreparedAsync(request) {
    const release = await this.acquireFile(this.filename(request.owner), request.control || currentReadControl());
    try { return await this._readPreparedAsync(request); }
    finally { release(); }
  }
  async _readPreparedAsync(request) {
    const control = request.control || currentReadControl();
    this.check(control);
    const diagnostic = this.diagnostic('readPrepared', request.owner);
    const filename = this.filename(request.owner);
    if (!this.enabled) { rejectDiagnostic(diagnostic, 'disabled', 'disabled'); this.diagnose(diagnostic); return null; }
    if (!fs.existsSync(filename)) { this.missingFile(diagnostic, filename); this.diagnose(diagnostic); this.metrics.misses++; return null; }
    let db, iterator, result = null;
    this.activeFiles.add(filename);
    try {
      db = new Database(filename); db.pragma('cache_size = -2048'); db.exec('BEGIN');
      iterator = this._preparedRows(db, { ...request, control }, diagnostic);
      let next = iterator.next();
      while (!next.done) { await this.checkpoint(control); next = iterator.next(); }
      result = next.value; this.check(control);
      if (this.invalidatedFiles.has(filename)) throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      db.exec('COMMIT');
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      iterator?.return();
      if (db?.inTransaction) db.exec('ROLLBACK');
      if (isHistoryReadCancelled(error)) { rejectDiagnostic(diagnostic, 'consumer-revoked', 'cancelled'); throw error; }
      if (isHistoryReadUnavailable(error)) { rejectDiagnostic(diagnostic, cacheErrorReason(error), 'unknown'); throw error; }
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
      this.metrics.errors++; rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error'); diagnosticErrorSite(diagnostic, error);
      this.invalidatedFiles.add(filename); result = null;
    } finally {
      db?.close(); this.activeFiles.delete(filename);
      if (this.invalidatedFiles.delete(filename)) this.removeFile(filename, this.recentRemovals.get(hash(filename)) || diagnostic.reason);
      this.diagnose(diagnostic);
    }
    this.metrics[result ? 'hits' : 'misses']++;
    return result;
  }
  savePayload(owner, id, value) {
    const source = this.readSource(owner);
    return this.withDb(owner, true, (db, diagnostic) => {
      if (source) {
        this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
        this.setMeta(db, 'source', source, diagnostic);
      }
      const { body, checksum } = encode(value);
      diagnostic.bytes = body.length;
      db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)').run(id, body, checksum);
      return true;
    }, 'savePayload');
  }
  savePayloads(owner, values) {
    const source = this.readSource(owner);
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.bytes = 0;
      if (source) {
        this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
        this.setMeta(db, 'source', source, diagnostic);
      }
      this.putPayloads(db, values, diagnostic);
      return true;
    })(), 'savePayloads');
  }
  async savePayloadsAsync(owner, values) {
    const source = this.readSource(owner);
    return this.withAsyncDb(owner, async (db, diagnostic) => {
      diagnostic.bytes = 0;
      if (source) {
        this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
        this.setMeta(db, 'source', source, diagnostic);
      }
      await this.putPayloadsAsync(db, values, diagnostic);
      return true;
    }, 'savePayloads');
  }
  async putPayloadsAsync(db, values, diagnostic) {
    this.check();
    if (typeof values?.transferToAsync === 'function') {
      const bytes = await values.transferToAsync(db);
      this.check(); this.metrics.payloadWriteBytes += bytes; diagnostic.bytes = (diagnostic.bytes || 0) + bytes;
      return;
    }
    const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
    let batchRows = 0, batchBytes = 0;
    for (const [id, value] of values) {
      currentReadControl()?.assertCurrent();
      const { body, checksum } = encode(value); put.run(id, body, checksum);
      this.metrics.payloadWriteBytes += body.length; diagnostic.bytes = (diagnostic.bytes || 0) + body.length;
      batchRows++; batchBytes += body.length;
      if (batchRows >= WORK_ROWS || batchBytes >= WORK_BYTES) { await this.checkpoint(); batchRows = 0; batchBytes = 0; }
    }
  }
  putPayloads(db, values, diagnostic) {
    this.check();
    if (typeof values?.transferTo === 'function') {
      const bytes = values.transferTo(db);
      this.check();
      this.metrics.payloadWriteBytes += bytes; diagnostic.bytes = (diagnostic.bytes || 0) + bytes;
      return;
    }
    // Compatibility for finite callers outside the request-owned worker path.
    const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
    for (const [id, value] of values) {
      currentReadControl()?.assertCurrent();
      const { body, checksum } = encode(value); put.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length;
      diagnostic.bytes = (diagnostic.bytes || 0) + body.length;
    }
  }
  readSource(owner) {
    return this.withDb(owner, false, (db, diagnostic) => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const source = this.getMeta(db, 'source');
      if (source == null) return rejectDiagnostic(diagnostic, 'missing-source', 'miss');
      diagnostic.snapshotBytes = source.size;
      return source;
    }, 'readSource');
  }
  readSourceProof(owner) {
    return this.withDb(owner, false, (db, diagnostic) => {
      const proof = this.getMeta(db, 'sourceProof');
      return proof == null ? rejectDiagnostic(diagnostic, 'missing-source-proof', 'miss') : proof;
    }, 'readSourceProof');
  }
  readPayload(owner, id, source) {
    return this.withDb(owner, false, (db, diagnostic) => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const saved = this.getMeta(db, 'source');
      diagnostic.snapshotBytes = saved?.size; diagnostic.sourceBytes = source?.size;
      if (!source || !saved) return rejectDiagnostic(diagnostic, 'missing-source', 'miss');
      if (saved.filePath !== source.filePath) return rejectDiagnostic(diagnostic, 'source-path-mismatch');
      if (saved.sourceGeneration !== source.sourceGeneration) return rejectDiagnostic(diagnostic, 'source-generation-mismatch');
      const chunked = readChunkedPayload(db, id);
      if (chunked) return chunked.payload;
      const row = db.prepare('SELECT body,checksum FROM payloads WHERE id=?').get(id);
      if (!row) return rejectDiagnostic(diagnostic, 'missing-payload', 'miss');
      diagnostic.bytes = row.body.length;
      return decode(row);
    }, 'readPayload');
  }
  readPayloadPage(owner, id, source, request) {
    return this.withDb(owner, false, (db, diagnostic) => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const saved = this.getMeta(db, 'source');
      if (!source || !saved) return rejectDiagnostic(diagnostic, 'missing-source', 'miss');
      if (saved.filePath !== source.filePath) return rejectDiagnostic(diagnostic, 'source-path-mismatch');
      if (saved.sourceGeneration !== source.sourceGeneration) return rejectDiagnostic(diagnostic, 'source-generation-mismatch');
      const result = readChunkedPayload(db, id, request);
      if (!result) return rejectDiagnostic(diagnostic, 'missing-chunked-payload', 'miss');
      diagnostic.bytes = (result.payload?.length || 0) * 2;
      return result;
    }, 'readPayload');
  }
  readPayloadBinding(owner, id, source, { entryUuid, contentHash } = {}) {
    return this.withDb(owner, false, (db, diagnostic) => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return rejectDiagnostic(diagnostic, 'owner-mismatch');
      const saved = this.getMeta(db, 'source');
      if (!source || !saved || saved.filePath !== source.filePath
        || saved.sourceGeneration !== source.sourceGeneration) return rejectDiagnostic(diagnostic, 'source-generation-mismatch');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payload_bindings'").get()) {
        return rejectDiagnostic(diagnostic, 'missing-payload-binding', 'miss');
      }
      // Exact admitted row/ref AND physical snapshot. A source generation
      // deliberately survives append; an old hash in an earlier output with
      // the same call ID is not proof of membership in the current projection.
      // Never trust a client-supplied file path or byte span.
      const sourceWitness = payloadBindingSource(source);
      const row = entryUuid ? db.prepare(`SELECT * FROM payload_bindings WHERE entry_uuid=? AND payload_id=?
        AND content_hash=? AND source_generation=? AND source_witness=? LIMIT 1`)
        .get(entryUuid, id, contentHash, source.sourceGeneration, sourceWitness)
        : db.prepare(`SELECT * FROM payload_bindings WHERE payload_id=? AND content_hash=?
          AND source_generation=? AND source_witness=? LIMIT 1`)
          .get(id, contentHash, source.sourceGeneration, sourceWitness);
      if (!row) return rejectDiagnostic(diagnostic, 'missing-payload-binding', 'miss');
      if (row.checksum !== payloadBindingHash(row)) throw new Error('history_cache_checksum');
      return { entryUuid: row.entry_uuid, payloadId: row.payload_id, contentHash: row.content_hash,
        totalChars: row.total_chars, sourceGeneration: row.source_generation,
        sourceCallId: row.source_call_id, sourceRecordLine: row.source_line };
    }, 'readPayloadBinding');
  }
  saveSourceHeader(owner, source, proof) {
    // Keep the small source/prefix certificate with Timeline when bulky state
    // or ready rows are evicted; payload fallback must preserve generation proof.
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      const previous = this.getMeta(db, 'source');
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'source', source, diagnostic);
      if (proof !== undefined) this.setMeta(db, 'sourceProof', proof, diagnostic);
      else if (['filePath', 'size', 'mtimeMs', 'ctimeMs', 'fileIdentity', 'sourceGeneration']
        .some(key => previous?.[key] !== source?.[key])) db.prepare("DELETE FROM meta WHERE key='sourceProof'").run();
      return true;
    })(), 'saveSourceHeader');
  }
  stats() { return { ...this.metrics, diskBytes: this.diskBytes || 0, budgetBytes: this.maxBytes,
    indexMemoryBytes: this.indexMemoryBytes, indexMemoryBudget: this.indexMemoryBudget }; }
}

module.exports = { HistoryPreparedCache, exactSource, rowContentHash };
