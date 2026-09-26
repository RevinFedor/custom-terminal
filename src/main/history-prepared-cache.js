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
function canonicalPageRow(row) {
  if (!row.entryRef) return row;
  // A composite view's current revision lives in its header. Storing that
  // token on every row would rewrite all ancestor bodies on each child append.
  const { contentRevision, ...entry } = row;
  const { contentRevision: refRevision, ...entryRef } = row.entryRef;
  return { ...entry, entryRef };
}

class HistoryPreparedCache {
  constructor({ directory, maxBytes = 2 * 1024 ** 3, schema = SCHEMA, indexBudgetBytes = 32 * 1024 * 1024 } = {}) {
    if (!path.isAbsolute(directory || '')) throw new Error('history_cache_directory_required');
    if (!/^[a-z0-9-]+$/i.test(String(schema))) throw new Error('history_cache_schema');
    this.baseDirectory = directory;
    this.directory = path.join(directory, 'v' + schema);
    this.maxBytes = maxBytes;
    this.indices = new Map(); this.indexMemoryBytes = 0;
    this.activeFiles = new Set(); this.invalidatedFiles = new Set();
    this.indexMemoryBudget = indexBudgetBytes;
    this.metrics = { pageBytes: 0, pageRows: 0, indexBytes: 0, continuationBytes: 0, writes: 0, hits: 0, misses: 0, errors: 0,
      continuationWriteBytes: 0, continuationSerializeMs: 0, continuationWriteMs: 0,
      metadataWriteBytes: 0, preparedRowWriteBytes: 0, payloadWriteBytes: 0, preparedWriteMs: 0 };
    this.metrics.virtualContinuationBytes = 0;
    this.enabled = true;
    try { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.prune(); }
    catch (error) { this.enabled = false; this.metrics.errors++; console.warn('[HistoryPreparedCache] unavailable: ' + error.message); }
  }

  filename(owner) { return path.join(this.directory, hash(ownerKey(owner)) + '.sqlite'); }
  rememberIndex(key, value) {
    this.indexMemoryBytes -= this.indices.get(key)?.bytes || 0;
    this.indices.delete(key);
    if (value.bytes <= this.indexMemoryBudget) { this.indices.set(key, value); this.indexMemoryBytes += value.bytes; }
    while (this.indexMemoryBytes > this.indexMemoryBudget) {
      const oldest = this.indices.keys().next().value;
      this.indexMemoryBytes -= this.indices.get(oldest).bytes; this.indices.delete(oldest);
    }
  }
  forgetIndexFile(filename) {
    for (const [key, value] of this.indices) if (key.startsWith(filename + '\u0000')) {
      this.indices.delete(key); this.indexMemoryBytes -= value.bytes;
    }
  }
  clearMemory() { this.indices.clear(); this.indexMemoryBytes = 0; }
  removeFile(filename) {
    if (this.activeFiles.has(filename)) { this.invalidatedFiles.add(filename); return; }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.forgetIndexFile(filename);
  }
  withDb(owner, write, callback) {
    if (!this.enabled) return null;
    const filename = this.filename(owner);
    if (!write && !fs.existsSync(filename)) return null;
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
      result = callback(db);
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      this.metrics.errors++;
      console.warn('[HistoryPreparedCache] rejected file=' + path.basename(filename) + ' error=' + error.message);
      try { db?.close(); db = null; this.removeFile(filename); } catch {}
      this.forgetIndexFile(filename);
      return null; // A bad acceleration file never makes history unavailable.
    } finally {
      db?.close();
      if (write) { try { this.prune(filename); } catch (error) { this.metrics.errors++; } }
    }
    return write && !fs.existsSync(filename) ? null : result;
  }
  async withAsyncDb(owner, callback) {
    if (!this.enabled) return null;
    const filename = this.filename(owner);
    // Initialize outside the long transaction using the same schema/path rules.
    this.withDb(owner, true, () => true);
    if (!fs.existsSync(filename)) return null;
    let db, result = null;
    this.activeFiles.add(filename);
    try {
      db = new Database(filename);
      db.pragma('cache_size = -2048');
      db.exec('BEGIN IMMEDIATE');
      result = await callback(db);
      this.assertCurrent?.();
      if (this.invalidatedFiles.has(filename)) throw new Error('history_cache_write_invalidated');
      db.exec('COMMIT');
      const now = new Date(); fs.utimesSync(filename, now, now);
    } catch (error) {
      if (db?.inTransaction) db.exec('ROLLBACK');
      this.metrics.errors++; result = null;
      console.warn('[HistoryPreparedCache] rejected async file=' + path.basename(filename) + ' error=' + error.message);
      this.invalidatedFiles.add(filename);
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
    } finally {
      db?.close(); this.activeFiles.delete(filename);
      if (this.invalidatedFiles.delete(filename)) this.removeFile(filename);
      try { this.prune(filename); } catch { this.metrics.errors++; }
    }
    return fs.existsSync(filename) ? result : null;
  }
  getMeta(db, key) { const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get(key); return row ? decode(row) : null; }
  setMeta(db, key, value) {
    if (key === 'continuation' || key === 'virtualState') this.onStage?.({ phase: 'continuation-codec' });
    const started = performance.now();
    const { body, checksum } = encode(value);
    if (key === 'continuation' || key === 'virtualState') {
      this.metrics.continuationWriteBytes += body.length;
      this.metrics.continuationSerializeMs += performance.now() - started;
    } else this.metrics.metadataWriteBytes += body.length;
    const writeAt = performance.now();
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?,?)').run(key, body, checksum);
    if (key === 'continuation' || key === 'virtualState') this.metrics.continuationWriteMs += performance.now() - writeAt;
  }
  prune(protectedFile = null) {
    if (!this.enabled) return;
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
        } catch {}
      }
    }
    const files = [...families.values()].filter(item => {
      if (item.main) return true;
      this.removeFile(item.file); return false;
    });
    let size = files.reduce((n, f) => n + f.size, 0);
    // Prefer retaining the just-written owner, but even a single oversized
    // owner cannot turn this disposable cache into unbounded disk retention.
    files.sort((a, b) => Number(a.file === protectedFile) - Number(b.file === protectedFile) || a.used - b.used);
    for (const item of files) {
      if (size <= this.maxBytes) break;
      if (this.activeFiles.has(item.file)) continue;
      this.removeFile(item.file); size -= item.size;
    }
    this.diskBytes = size;
  }
  invalidate(filePath = null) {
    if (!this.enabled) return;
    for (const name of fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name))) {
      const file = path.join(this.directory, name);
      let db;
      try {
        db = new Database(file, { readonly: true });
        const source = this.getMeta(db, 'source');
        db.close(); db = null;
        if (!filePath || source?.filePath === filePath) this.removeFile(file);
      } catch { try { this.removeFile(file); } catch {} }
      finally { db?.close(); }
    }
  }

  saveContinuation(owner, snapshot, state, payloads = new Map()) {
    return this.withDb(owner, true, db => db.transaction(() => {
      const putPayload = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of payloads) {
        const { body, checksum } = encode(value); putPayload.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length;
      }
      this.setMeta(db, 'source', snapshot);
      this.setMeta(db, 'owner', ownerKey(owner));
      this.setMeta(db, 'continuationSource', snapshot);
      this.setMeta(db, 'sourceProof', state.sourceProof || []);
      this.setMeta(db, 'continuation', state);
      this.metrics.writes++;
      return true;
    })());
  }
  saveTimeline(owner, source, entries, sessionMeta) {
    return this.withDb(owner, true, db => this.setMeta(db, 'timeline', { owner: ownerKey(owner), source, entries, sessionMeta }));
  }
  readTimeline(owner, filePath, stat) {
    return this.withDb(owner, false, db => {
      const result = this.getMeta(db, 'timeline');
      return result && result.owner === ownerKey(owner) && result.source.filePath === filePath && exactSource(result.source, stat) ? result : null;
    });
  }
  saveVirtualProjection(owner, projection) {
    const { historyEntries, ...metadata } = projection;
    return this.withDb(owner, true, db => this.setMeta(db, 'virtual', { ...metadata, owner: ownerKey(owner) }));
  }
  readVirtualProjection(owner, descriptor) {
    return this.withDb(owner, false, db => {
      const saved = this.getMeta(db, 'virtual');
      return saved?.owner === ownerKey(owner) && saved.eventKey === descriptor.eventKey
        && saved.manifest?.manifestDigest === descriptor.manifest.manifestDigest ? saved : null;
    });
  }
  saveVirtualState(owner, state) {
    const payloads = this.pendingPayloads?.() || new Map();
    const saved = this.withDb(owner, true, db => db.transaction(() => {
      const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of payloads) { const { body, checksum } = encode(value); put.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length; }
      this.setMeta(db, 'owner', ownerKey(owner));
      this.setMeta(db, 'source', state.childSnapshot);
      this.setMeta(db, 'sourceProof', state.childProof || []);
      this.setMeta(db, 'virtualState', state);
      return true;
    })());
    if (saved) payloads.clear();
    return saved;
  }
  readVirtualState(owner, descriptor) {
    return this.withDb(owner, false, db => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return null;
      const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get('virtualState');
      if (!row) return null;
      const state = decode(row);
      if (state.descriptor.eventKey !== descriptor.eventKey
        || state.descriptor.manifest.manifestDigest !== descriptor.manifest.manifestDigest
        || state.descriptor.payloadPolicy !== descriptor.payloadPolicy) return null;
      this.metrics.virtualContinuationBytes += row.body.length;
      return state;
    });
  }
  readContinuation(owner, filePath, stat, onRestore = null) {
    return this.withDb(owner, false, db => {
      const snapshot = this.getMeta(db, 'continuationSource');
      if (this.getMeta(db, 'owner') !== ownerKey(owner) || !snapshot || snapshot.sessionId !== owner.sessionId
        || snapshot.filePath !== filePath || snapshot.fileIdentity !== stat.dev + ':' + stat.ino
        || stat.size < snapshot.size || (stat.size === snapshot.size && !exactSource(snapshot, stat))) return null;
      onRestore?.(snapshot);
      const row = db.prepare('SELECT body,checksum FROM meta WHERE key=?').get('continuation');
      if (!row) return null;
      this.metrics.continuationBytes += row.body.length;
      return { snapshot, state: decode(row) };
    });
  }
  async savePrepared({ owner, source, context, entries, sessionMeta = null, kind = 'view' }) {
    this.onStage?.({ phase: kind + '-rows', sessionId: owner.sessionId });
    const started = performance.now();
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
    const indexEntries = []; const liveRows = new Uint8Array(entries.length); let bytes = 0;
    const assets = new Map();
    const indexNonce = crypto.randomUUID();
    const saved = await this.withAsyncDb(owner, async db => {
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
        this.metrics.preparedRowWriteBytes += body.length + Buffer.byteLength(stub);
        put.run(view, pos, stub, live, indexHash({ pos, stub, live, content_hash: contentHash, checksum }), body, checksum, contentHash);
        this.metrics.writes++;
      }
      db.prepare('DELETE FROM rows WHERE view=? AND pos>=?').run(view, entries.length);
      this.setMeta(db, 'source', source);
      this.setMeta(db, 'owner', ownerKey(owner));
      this.setMeta(db, 'view:' + view, { owner: ownerKey(owner), source, context, total: entries.length, sessionMeta, indexNonce,
        assets: [...assets.values()] });
      this.metrics.preparedWriteMs += performance.now() - started;
      return true;
    });
    if (saved) this.rememberIndex(this.filename(owner) + '\u0000' + view, { nonce: indexNonce, entries: indexEntries, liveRows, bytes });
    return saved;
  }
  readPrepared({ owner, filePath, stat, context, hydrate, kind = 'view' }) {
    const view = kind === 'base' ? 'base' : 'view:' + String(owner.tabId || '');
    const result = this.withDb(owner, false, db => db.transaction(() => {
      const meta = this.getMeta(db, 'view:' + view);
      if (!meta || meta.owner !== ownerKey(owner) || meta.source.filePath !== filePath || !exactSource(meta.source, stat) || meta.context !== context) return null;
      const key = this.filename(owner) + '\u0000' + view;
      let index = this.indices.get(key);
      if (!index || index.nonce !== meta.indexNonce) {
        const rows = db.prepare('SELECT pos,stub,live,index_hash,content_hash,checksum FROM rows WHERE view=? ORDER BY pos').all(view);
        if (rows.length !== meta.total || rows.some((row, i) => row.pos !== i
          || row.index_hash !== indexHash(row))) throw new Error('history_cache_index');
        const bytes = rows.reduce((n, row) => n + Buffer.byteLength(row.stub), 0);
        this.metrics.indexBytes += bytes;
        index = { nonce: meta.indexNonce, entries: rows.map(row => JSON.parse(row.stub)),
          liveRows: Uint8Array.from(rows.map(row => row.live)), bytes: bytes * 3 + rows.length * 128 };
      }
      this.rememberIndex(key, index);
      const entries = index.entries.slice();
      const range = historyRowWindowRange(entries, hydrate);
      const read = db.prepare('SELECT body,checksum FROM rows WHERE view=? AND pos=?');
      for (let pos = 0; pos < entries.length; pos++) {
        if (!range.applied || (pos >= range.from && pos <= range.to) || pos >= range.tailFrom || index.liveRows[pos]) {
          const stored = read.get(view, pos);
          entries[pos] = decode(stored);
          this.metrics.pageBytes += stored.body.length; this.metrics.pageRows++;
        }
      }
      return { ...meta, entries };
    })());
    this.metrics[result ? 'hits' : 'misses']++;
    return result;
  }
  savePayload(owner, id, value) {
    return this.withDb(owner, true, db => {
      const { body, checksum } = encode(value);
      db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)').run(id, body, checksum);
      return true;
    });
  }
  savePayloads(owner, values) {
    return this.withDb(owner, true, db => db.transaction(() => {
      const put = db.prepare('INSERT OR REPLACE INTO payloads VALUES (?,?,?)');
      for (const [id, value] of values) { const { body, checksum } = encode(value); put.run(id, body, checksum); this.metrics.payloadWriteBytes += body.length; }
      return true;
    })());
  }
  readSource(owner) { return this.withDb(owner, false, db => this.getMeta(db, 'owner') === ownerKey(owner) ? this.getMeta(db, 'source') : null); }
  readSourceProof(owner) { return this.withDb(owner, false, db => this.getMeta(db, 'sourceProof')); }
  readPayload(owner, id, source) {
    return this.withDb(owner, false, db => {
      if (this.getMeta(db, 'owner') !== ownerKey(owner)) return null;
      const saved = this.getMeta(db, 'source');
      if (!source || !saved || saved.filePath !== source.filePath
        || saved.sourceGeneration !== source.sourceGeneration) return null;
      const row = db.prepare('SELECT body,checksum FROM payloads WHERE id=?').get(id);
      return row ? decode(row) : null;
    });
  }
  stats() { return { ...this.metrics, diskBytes: this.diskBytes || 0, budgetBytes: this.maxBytes,
    indexMemoryBytes: this.indexMemoryBytes, indexMemoryBudget: this.indexMemoryBudget }; }
}

module.exports = { HistoryPreparedCache, exactSource, rowContentHash };
