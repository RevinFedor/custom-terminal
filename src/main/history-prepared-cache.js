'use strict';

// Worker-owned, disposable data. Source journals and the application database
// are never written here. A small positional index survives without bringing
// either the parser graph or offscreen row bodies back into RAM.
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { makeHistoryRowStub, historyRowCarriesLiveWork, historyRowWindowRange } = require('./history-entry-window');

const SCHEMA = 1;
const DIAGNOSTIC_HISTORY_LIMIT = 256;
const DIAGNOSTIC_STRING_FIELDS = ['operation', 'outcome', 'reason', 'sessionId', 'cacheKey', 'cacheVersion', 'otherVersion',
  'layer', 'kind', 'indexOutcome', 'indexReason', 'causeOperation', 'errorReason', 'errorName', 'errorCode', 'errorModule'];
const DIAGNOSTIC_SCALAR_FIELDS = ['bytes', 'budgetBytes', 'snapshotBytes', 'sourceBytes', 'rows', 'pageRows', 'indexBytes',
  'indexMemoryBytes', 'indexBudgetBytes', 'evictedCount', 'evictedBytes', 'removedCount', 'deferredCount',
  'errorCount', 'fileCount', 'activeCount', 'diskBytes', 'otherVersionObserved', 'indexRetained', 'errorLine', 'errorColumn'];
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
  if (error?.message === 'history_cache_checksum') return 'checksum-mismatch';
  if (error?.message === 'history_cache_index') return 'index-corrupt';
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

class HistoryPreparedCache {
  constructor({ directory, maxBytes = 2 * 1024 ** 3, schema = SCHEMA, indexBudgetBytes = 32 * 1024 * 1024, onDiagnostic = null } = {}) {
    if (!path.isAbsolute(directory || '')) throw new Error('history_cache_directory_required');
    if (!/^[a-z0-9-]+$/i.test(String(schema))) throw new Error('history_cache_schema');
    this.baseDirectory = directory;
    this.directory = path.join(directory, 'v' + schema);
    this.maxBytes = maxBytes;
    this.onDiagnostic = onDiagnostic;
    this.recentRemovals = new Map(); this.otherVersions = new Map();
    this.indices = new Map(); this.indexMemoryBytes = 0;
    this.activeFiles = new Set(); this.invalidatedFiles = new Set();
    this.indexMemoryBudget = indexBudgetBytes;
    this.metrics = { pageBytes: 0, pageRows: 0, indexBytes: 0, continuationBytes: 0, writes: 0, hits: 0, misses: 0, errors: 0,
      continuationWriteBytes: 0, continuationSerializeMs: 0, continuationWriteMs: 0,
      metadataWriteBytes: 0, preparedRowWriteBytes: 0, payloadWriteBytes: 0, preparedWriteMs: 0 };
    this.metrics.virtualContinuationBytes = 0;
    this.enabled = true;
    try { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.prune(); }
    catch (error) {
      this.enabled = false; this.metrics.errors++;
      this.diagnose({ operation: 'initialize', outcome: 'disabled', reason: cacheErrorReason(error) });
      console.warn('[HistoryPreparedCache] unavailable reason=' + cacheErrorReason(error));
    }
  }

  filename(owner) { return path.join(this.directory, hash(ownerKey(owner)) + '.sqlite'); }
  diagnostic(operation, owner, write = false) {
    return { operation, outcome: write ? 'stored' : 'hit', reason: write ? 'stored' : 'disk-hit',
      sessionId: owner?.sessionId, cacheKey: owner ? hash(ownerKey(owner)) : undefined,
      layer: 'disk', cacheVersion: path.basename(this.directory), budgetBytes: this.maxBytes };
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
    const otherVersion = this.otherVersions.get(path.basename(filename, '.sqlite'));
    diagnostic.cacheVersion = path.basename(this.directory);
    if (otherVersion) { diagnostic.otherVersion = otherVersion; diagnostic.otherVersionObserved = true; }
    return rejectDiagnostic(diagnostic, removal || (otherVersion ? 'version-mismatch' : 'no-file'), 'miss');
  }
  rememberIndex(key, value, causeOperation = 'rememberIndex') {
    let evictedCount = 0, evictedBytes = 0;
    this.indexMemoryBytes -= this.indices.get(key)?.bytes || 0;
    this.indices.delete(key);
    if (value.bytes <= this.indexMemoryBudget) { this.indices.set(key, value); this.indexMemoryBytes += value.bytes; }
    while (this.indexMemoryBytes > this.indexMemoryBudget) {
      const oldest = this.indices.keys().next().value;
      evictedCount++; evictedBytes += this.indices.get(oldest).bytes;
      this.indexMemoryBytes -= this.indices.get(oldest).bytes; this.indices.delete(oldest);
    }
    this.diagnose({ operation: 'rememberIndex', causeOperation, layer: 'memory', cacheKey: path.basename(key.split('\u0000')[0], '.sqlite'),
      outcome: value.bytes <= this.indexMemoryBudget ? 'retained' : 'skipped', reason: evictedCount || value.bytes > this.indexMemoryBudget ? 'index-budget' : 'memory-store',
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
    const diagnostic = sharedDiagnostic || this.diagnostic(operation, owner, write);
    const report = () => { if (!sharedDiagnostic) this.diagnose(diagnostic); };
    if (!this.enabled) { rejectDiagnostic(diagnostic, 'disabled', 'disabled'); report(); return null; }
    const filename = this.filename(owner);
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
          CREATE TABLE IF NOT EXISTS payloads (id TEXT PRIMARY KEY, body BLOB NOT NULL, checksum TEXT NOT NULL);`);
      }
      if (!this.invalidatedFiles.has(filename)) this.recentRemovals.delete(hash(filename));
      result = callback(db, diagnostic);
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
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
      if (write) { try { this.prune(filename); } catch (error) { this.metrics.errors++; } }
    }
    if (write && !fs.existsSync(filename)) { this.missingFile(diagnostic, filename); result = null; }
    report();
    return result;
  }
  async withAsyncDb(owner, callback, operation = 'writeAsync') {
    const diagnostic = this.diagnostic(operation, owner, true);
    if (!this.enabled) { rejectDiagnostic(diagnostic, 'disabled', 'disabled'); this.diagnose(diagnostic); return null; }
    const filename = this.filename(owner);
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
      this.assertCurrent?.();
      if (this.invalidatedFiles.has(filename)) throw new Error('history_cache_write_invalidated');
      db.exec('COMMIT');
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      if (db?.inTransaction) db.exec('ROLLBACK');
      this.metrics.errors++; result = null;
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error');
      diagnosticErrorSite(diagnostic, error);
      console.warn('[HistoryPreparedCache] rejected async file=' + path.basename(filename) + ' reason=' + diagnostic.reason);
      this.invalidatedFiles.add(filename);
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
    } finally {
      db?.close(); this.activeFiles.delete(filename);
      if (this.invalidatedFiles.delete(filename)) this.removeFile(filename, this.recentRemovals.get(hash(filename)) || diagnostic.reason);
      try { this.prune(filename); } catch { this.metrics.errors++; }
      if (diagnostic.outcome !== 'error' && !fs.existsSync(filename)) this.missingFile(diagnostic, filename);
      this.diagnose(diagnostic);
    }
    return fs.existsSync(filename) ? result : null;
  }
  getMeta(db, key) { const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get(key); return row ? decode(row) : null; }
  setMeta(db, key, value, diagnostic = null) {
    if (key === 'continuation' || key === 'virtualState') this.onStage?.({ phase: 'continuation-codec' });
    const started = performance.now();
    const { body, checksum } = encode(value);
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
      // silently acquiring another 2GiB after an application update.
      const families = new Map();
      for (const entry of fs.readdirSync(this.baseDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^v\d+(?:-[a-f0-9]+)?$/.test(entry.name)) continue;
        const directory = path.join(this.baseDirectory, entry.name);
        for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.sqlite(?:-(?:journal|wal|shm))?$/.test(name))) {
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
      // Prefer retaining the just-written owner, but even a single oversized
      // owner cannot turn this disposable cache into unbounded disk retention.
      files.sort((a, b) => Number(a.file === protectedFile) - Number(b.file === protectedFile) || a.used - b.used);
      for (const item of files) {
        if (size <= this.maxBytes) break;
        if (this.activeFiles.has(item.file)) { diagnostic.activeCount++; continue; }
        this.removeFile(item.file, 'disk-quota', false); size -= item.size;
        diagnostic.evictedCount++; diagnostic.evictedBytes += item.size;
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
      for (const name of fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name))) {
        const file = path.join(this.directory, name);
        let db;
        try {
          db = new Database(file, { readonly: true });
          const source = this.getMeta(db, 'source');
          db.close(); db = null;
          if (!filePath || source?.filePath === filePath) remove(file);
        } catch (error) {
          diagnostic.errorCount++; diagnostic.errorReason = cacheErrorReason(error);
          try { remove(file); } catch { diagnostic.errorCount++; }
        }
        finally { db?.close(); }
      }
    } catch (error) {
      rejectDiagnostic(diagnostic, cacheErrorReason(error), 'error'); throw error;
    } finally { this.diagnose(diagnostic); }
  }

  saveContinuation(owner, snapshot, state, payloads = new Map()) {
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.snapshotBytes = snapshot?.size;
      const putPayload = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of payloads) {
        const { body, checksum } = encode(value); putPayload.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length;
        diagnostic.bytes = (diagnostic.bytes || 0) + body.length;
      }
      this.setMeta(db, 'source', snapshot, diagnostic);
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'continuationSource', snapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.sourceProof || [], diagnostic);
      this.setMeta(db, 'continuation', state, diagnostic);
      this.metrics.writes++;
      return true;
    })(), 'saveContinuation');
  }
  saveTimeline(owner, source, entries, sessionMeta) {
    return this.withDb(owner, true, (db, diagnostic) => this.setMeta(db, 'timeline', { owner: ownerKey(owner), source, entries, sessionMeta }, diagnostic), 'saveTimeline');
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
    return this.withDb(owner, true, (db, diagnostic) => this.setMeta(db, 'virtual', { ...metadata, owner: ownerKey(owner) }, diagnostic), 'saveVirtualProjection');
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
    const payloads = this.pendingPayloads?.() || new Map();
    const saved = this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.bytes = 0; diagnostic.snapshotBytes = state.childSnapshot?.size;
      const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of payloads) {
        const { body, checksum } = encode(value); put.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length;
        diagnostic.bytes += body.length;
      }
      this.setMeta(db, 'owner', ownerKey(owner), diagnostic);
      this.setMeta(db, 'source', state.childSnapshot, diagnostic);
      this.setMeta(db, 'sourceProof', state.childProof || [], diagnostic);
      this.setMeta(db, 'virtualState', state, diagnostic);
      return true;
    })(), 'saveVirtualState');
    if (saved) payloads.clear();
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
  async savePrepared({ owner, source, context, entries, sessionMeta = null, kind = 'view' }) {
    this.onStage?.({ phase: kind + '-rows', sessionId: owner.sessionId });
    const started = performance.now();
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
    const indexEntries = []; const liveRows = new Uint8Array(entries.length); let bytes = 0;
    const assets = new Map();
    const indexNonce = crypto.randomUUID();
    const saved = await this.withAsyncDb(owner, async (db, diagnostic) => {
      diagnostic.rows = entries.length; diagnostic.snapshotBytes = source?.size; diagnostic.bytes = 0;
      diagnostic.kind = kind === 'base' ? 'base' : 'view';
      const get = db.prepare('SELECT pos,stub,live,index_hash,checksum,content_hash FROM rows WHERE view=? AND pos=?');
      const put = db.prepare('INSERT OR REPLACE INTO rows VALUES (?,?,?,?,?,?,?,?)');
      let sliceStart = performance.now();
      for (let pos = 0; pos < entries.length; pos++) {
        if (pos % 32 === 0 && performance.now() - sliceStart >= 8) {
          await new Promise(resolve => setImmediate(resolve));
          this.assertCurrent?.(); sliceStart = performance.now();
        }
        const entry = canonicalPageRow(entries[pos]);
        for (const ref of Array.isArray(entry.imagePaths) ? entry.imagePaths : []) {
          const id = ref?.assetId || (typeof ref?.path === 'string' ? path.basename(ref.path) : '');
          if (/^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(id)) assets.set(id, ref);
        }
        const stubEntry = makeHistoryRowStub(entry);
        const stub = JSON.stringify(stubEntry);
        const live = historyRowCarriesLiveWork(entry) || entry.actions?.some(action => action.tool === 'Task'
          && action.subagentStatus === 'completed' && !Number(action.completedAt)) ? 1 : 0;
        indexEntries.push(stubEntry); liveRows[pos] = live; bytes += Buffer.byteLength(stub) * 3 + 128;
        const contentHash = rowContentHash(entry);
        const previous = get.get(view, pos);
        if (previous && previous.index_hash !== indexHash(previous)) throw new Error('history_cache_index');
        if (previous?.content_hash === contentHash) continue;
        const { body, checksum } = encode(entry);
        const writtenBytes = body.length + Buffer.byteLength(stub);
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
    }, 'savePrepared');
    if (saved) this.rememberIndex(this.filename(owner) + '\u0000' + view, { nonce: indexNonce, entries: indexEntries, liveRows, bytes }, 'savePrepared');
    return saved;
  }
  readPrepared({ owner, filePath, stat, context, hydrate, kind = 'view' }) {
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
    const result = this.withDb(owner, false, (db, diagnostic) => db.transaction(() => {
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
      if (!index || index.nonce !== meta.indexNonce) {
        diagnostic.indexOutcome = 'miss'; diagnostic.indexReason = index ? 'nonce-mismatch' : 'not-in-memory';
        const rows = db.prepare('SELECT pos,stub,live,index_hash,content_hash,checksum FROM rows WHERE view=? ORDER BY pos').all(view);
        if (rows.length !== meta.total || rows.some((row, i) => row.pos !== i
          || row.index_hash !== indexHash(row))) throw new Error('history_cache_index');
        const bytes = rows.reduce((n, row) => n + Buffer.byteLength(row.stub), 0);
        diagnostic.indexBytes = bytes;
        this.metrics.indexBytes += bytes;
        index = { nonce: meta.indexNonce, entries: rows.map(row => JSON.parse(row.stub)),
          liveRows: Uint8Array.from(rows.map(row => row.live)), bytes: bytes * 3 + rows.length * 128 };
      }
      this.rememberIndex(key, index, 'readPrepared');
      diagnostic.indexRetained = this.indices.has(key);
      diagnostic.indexMemoryBytes = this.indexMemoryBytes; diagnostic.indexBudgetBytes = this.indexMemoryBudget;
      const entries = index.entries.slice();
      const range = historyRowWindowRange(entries, hydrate);
      const read = db.prepare('SELECT body,checksum FROM rows WHERE view=? AND pos=?');
      diagnostic.bytes = 0; diagnostic.pageRows = 0;
      for (let pos = 0; pos < entries.length; pos++) {
        if (!range.applied || (pos >= range.from && pos <= range.to) || pos >= range.tailFrom || index.liveRows[pos]) {
          const stored = read.get(view, pos);
          entries[pos] = decode(stored);
          this.metrics.pageBytes += stored.body.length; this.metrics.pageRows++;
          diagnostic.bytes += stored.body.length; diagnostic.pageRows++;
        }
      }
      return { ...meta, entries };
    })(), 'readPrepared');
    this.metrics[result ? 'hits' : 'misses']++;
    return result;
  }
  savePayload(owner, id, value) {
    return this.withDb(owner, true, (db, diagnostic) => {
      const { body, checksum } = encode(value);
      diagnostic.bytes = body.length;
      db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)').run(id, body, checksum);
      return true;
    }, 'savePayload');
  }
  savePayloads(owner, values) {
    return this.withDb(owner, true, (db, diagnostic) => db.transaction(() => {
      diagnostic.bytes = 0;
      const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of values) {
        const { body, checksum } = encode(value); put.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length;
        diagnostic.bytes += body.length;
      }
      return true;
    })(), 'savePayloads');
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
      const row = db.prepare('SELECT body,checksum FROM payloads WHERE id=?').get(id);
      if (!row) return rejectDiagnostic(diagnostic, 'missing-payload', 'miss');
      diagnostic.bytes = row.body.length;
      return decode(row);
    }, 'readPayload');
  }
  stats() { return { ...this.metrics, diskBytes: this.diskBytes || 0, budgetBytes: this.maxBytes,
    indexMemoryBytes: this.indexMemoryBytes, indexMemoryBudget: this.indexMemoryBudget }; }
}

module.exports = { HistoryPreparedCache, exactSource, rowContentHash };
