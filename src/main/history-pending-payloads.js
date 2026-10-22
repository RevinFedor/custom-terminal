'use strict';

// A request owns this disposable staging file. Payload strings are copied in
// fixed UTF-16 chunks; a request never retains another Map of all full bodies.
// The committed cache is untouched until transferTo() runs in its transaction.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { currentReadControl } = require('./history-read-control');
const { createLeafTextHash } = require('./history-source-leaf');

const PAYLOAD_CHUNK_CHARS = 32 * 1024;
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const chunkCharsOf = row => row.chunk_chars ?? PAYLOAD_CHUNK_CHARS;
const metadataHash = row => {
  const fields = [row.id, row.total_chars, row.content_hash, row.chunks];
  // Preserve checksums of existing default-size cache records. Only the
  // optional smaller layout extends the private index proof; public hashes
  // and payload IDs are the same decoded-text contract as before.
  if (chunkCharsOf(row) !== PAYLOAD_CHUNK_CHARS) fields.push(chunkCharsOf(row));
  return checksum(JSON.stringify(fields));
};

function payloadTextHash(text, control = currentReadControl()) {
  const digest = crypto.createHash('sha256');
  for (let from = 0; from < text.length;) {
    control?.assertCurrent();
    let to = Math.min(text.length, from + PAYLOAD_CHUNK_CHARS);
    // Match one crypto.update(text, 'utf8'), including replacement of a lone
    // surrogate. Do not replace a valid pair merely because a chunk ended.
    if (to < text.length && text.charCodeAt(to - 1) >= 0xD800 && text.charCodeAt(to - 1) <= 0xDBFF
      && text.charCodeAt(to) >= 0xDC00 && text.charCodeAt(to) <= 0xDFFF) to--;
    digest.update(text.slice(from, to), 'utf8'); from = to;
  }
  return digest.digest('hex');
}

function initializePayloadChunks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS payload_index (id TEXT PRIMARY KEY, total_chars INTEGER NOT NULL,
    content_hash TEXT NOT NULL, chunks INTEGER NOT NULL, index_hash TEXT NOT NULL,
    chunk_chars INTEGER NOT NULL DEFAULT 32768);
    CREATE TABLE IF NOT EXISTS payload_chunks (id TEXT NOT NULL, pos INTEGER NOT NULL,
      body BLOB NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(id,pos));`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('payload_index') WHERE name='chunk_chars'").get()) {
    db.exec('ALTER TABLE payload_index ADD COLUMN chunk_chars INTEGER NOT NULL DEFAULT 32768');
  }
}

function validatePayloadMeta(meta) {
  const chunkChars = chunkCharsOf(meta);
  if (meta.index_hash !== metadataHash(meta) || !Number.isSafeInteger(meta.total_chars) || meta.total_chars < 0
    || !Number.isSafeInteger(chunkChars) || chunkChars < 1 || chunkChars > PAYLOAD_CHUNK_CHARS
    || meta.chunks !== Math.ceil(meta.total_chars / chunkChars)) throw new Error('history_cache_payload_index');
  return chunkChars;
}

function* verifiedPayloadChunks(db, meta, control) {
  const chunkChars = validatePayloadMeta(meta);
  const read = db.prepare('SELECT substr(body,1,?) AS body FROM payload_chunks WHERE id=? AND pos=?');
  let position = 0;
  for (const row of db.prepare('SELECT pos,length(body) AS bytes,checksum FROM payload_chunks WHERE id=? ORDER BY pos').iterate(meta.id)) {
    control?.assertCurrent();
    const expectedBytes = Math.min(chunkChars, meta.total_chars - row.pos * chunkChars) * 2;
    if (row.pos !== position++ || expectedBytes < 0 || row.bytes !== expectedBytes) throw Error('history_cache_checksum');
    const body = read.get(expectedBytes + 2, meta.id, row.pos)?.body;
    if (!body || body.length !== expectedBytes || checksum(body) !== row.checksum) throw Error('history_cache_checksum');
    yield { id: meta.id, pos: row.pos, body, checksum: row.checksum };
  }
  if (position !== meta.chunks) throw Error('history_cache_payload_index');
}

function readChunkedPayload(db, id, request = {}, control = currentReadControl()) {
  control?.assertCurrent();
  // Old acceleration files remain valid; their single-blob payload path is
  // handled by the caller. A chunk table is a compatible optional cache tier.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payload_index'").get()) return null;
  const meta = db.prepare('SELECT * FROM payload_index WHERE id=?').get(id);
  if (!meta) return null;
  const chunkChars = validatePayloadMeta(meta);
  if (request.expectedContentHash && request.expectedContentHash !== meta.content_hash) {
    return { success: false, error: 'history_payload_changed', payloadId: id };
  }
  const offset = request.offset == null ? 0 : Number(request.offset);
  const limit = request.limit == null ? meta.total_chars : Number(request.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > meta.total_chars
    || !Number.isSafeInteger(limit) || limit < 0) throw Error('history_payload_range_invalid');
  const end = Math.min(meta.total_chars, offset + limit);
  // At most one extra code unit at either edge is read to retain the existing
  // sliceHistoryPayload contract at a surrogate boundary.
  const low = Math.max(0, offset - 1), high = Math.min(meta.total_chars, end + 1);
  const first = Math.floor(low / chunkChars), last = Math.floor(Math.max(low, high - 1) / chunkChars);
  let text = '', position = first;
  // Inspect only scalar metadata before a native SQLite row can materialize
  // the BLOB. A corrupt/old cache cell must not bypass the chunk bound merely
  // because its size is checked after Statement.get/iterate has returned it.
  const readBody = db.prepare('SELECT substr(body,1,?) AS body FROM payload_chunks WHERE id=? AND pos=?');
  if (high > low) for (const row of db.prepare('SELECT pos,length(body) AS bytes,checksum FROM payload_chunks WHERE id=? AND pos>=? AND pos<=? ORDER BY pos').iterate(id, first, last)) {
    control?.assertCurrent();
    const expectedBytes = Math.min(chunkChars, meta.total_chars - row.pos * chunkChars) * 2;
    if (row.pos !== position++ || row.bytes !== expectedBytes) {
      throw new Error('history_cache_checksum');
    }
    // The extra UTF-16 unit detects growth between the two statements without
    // allocating a complete oversized cell even under external replacement.
    const body = readBody.get(expectedBytes + 2, id, row.pos)?.body;
    if (!body || body.length !== expectedBytes || checksum(body) !== row.checksum) throw new Error('history_cache_checksum');
    text += Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf16le');
  }
  if (high > low && position !== last + 1) throw new Error('history_cache_payload_index');
  const base = first * chunkChars;
  const from = offset;
  let to = end;
  const char = at => text.charCodeAt(at - base);
  if (from > 0 && char(from) >= 0xDC00 && char(from) <= 0xDFFF && char(from - 1) >= 0xD800 && char(from - 1) <= 0xDBFF) throw Error('history_payload_range_invalid');
  if (!request.exactRenderCap && to < meta.total_chars && char(to - 1) >= 0xD800 && char(to - 1) <= 0xDBFF && char(to) >= 0xDC00 && char(to) <= 0xDFFF) to--;
  return { success: true, payload: text.slice(from - base, to - base), totalChars: meta.total_chars,
    offset: from, nextOffset: to < meta.total_chars ? to : null, contentHash: meta.content_hash,
    truncatedForRender: false };
}

class HistoryPendingPayloads {
  constructor({ directory, control = currentReadControl(), onHighWater = null, chunkChars = PAYLOAD_CHUNK_CHARS } = {}) {
    if (!Number.isSafeInteger(chunkChars) || chunkChars < 1 || chunkChars > PAYLOAD_CHUNK_CHARS) throw Error('history_payload_chunk_invalid');
    this.control = control; this.onHighWater = onHighWater;
    this.chunkChars = chunkChars; this.chunkWrites = new Map();
    control?.assertCurrent();
    this.filename = path.join(directory, '.pending-' + process.pid + '-' + crypto.randomUUID() + '.sqlite');
    this.size = 0; this.closed = false; this.openAttempted = false;
    this.metrics = { stagedPayloads: 0, stagedChars: 0, peakChunkBytes: 0 };
  }
  open() {
    if (this.db) return;
    this.assertCurrent();
    this.openAttempted = true;
    const initialize = () => {
      this.db = new Database(this.filename);
      fs.chmodSync(this.filename, 0o600);
      this.db.pragma('cache_size = -512');
      this.db.pragma('journal_mode = DELETE');
      initializePayloadChunks(this.db);
    };
    const disposePartial = () => {
      try { this.db?.close(); } catch {}
      this.db = null;
      for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(this.filename + suffix); } catch {} }
    };
    try {
      initialize();
    } catch (error) {
      disposePartial();
      this.assertCurrent();
      // Disabling an optional acceleration cache must not disable History.
      // A payload-producing request can use its own temporary staging area;
      // full/ready requests that never set a payload do no filesystem work.
      this.temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-payload-staging-'));
      fs.chmodSync(this.temporaryDirectory, 0o700);
      this.filename = path.join(this.temporaryDirectory, 'payloads.sqlite');
      try { initialize(); }
      catch (fallbackError) {
        disposePartial();
        try { fs.rmdirSync(this.temporaryDirectory); } catch {}
        this.temporaryDirectory = null;
        throw fallbackError;
      }
    }
  }
  assertCurrent() {
    if (this.closed) throw new Error('history_pending_payloads_closed');
    this.control?.assertCurrent();
  }
  set(id, text) {
    this.assertCurrent();
    if (typeof text !== 'string') return this;
    this.open();
    this.supersedeChunkWrite(id);
    const prior = this.db.prepare('SELECT total_chars FROM payload_index WHERE id=?').get(id);
    const meta = { id, total_chars: text.length, content_hash: payloadTextHash(text, this.control),
      chunks: Math.ceil(text.length / this.chunkChars), chunk_chars: this.chunkChars };
    const put = this.db.prepare('INSERT OR REPLACE INTO payload_chunks VALUES (?,?,?,?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM payload_chunks WHERE id=?').run(id);
      for (let pos = 0; pos < meta.chunks; pos++) {
        this.assertCurrent();
        const body = Buffer.from(text.slice(pos * this.chunkChars, (pos + 1) * this.chunkChars), 'utf16le');
        put.run(id, pos, body, checksum(body));
        this.metrics.peakChunkBytes = Math.max(this.metrics.peakChunkBytes, body.length);
      }
      this.assertCurrent();
      this.db.prepare('INSERT OR REPLACE INTO payload_index(id,total_chars,content_hash,chunks,index_hash,chunk_chars) VALUES (?,?,?,?,?,?)')
        .run(id, meta.total_chars, meta.content_hash, meta.chunks, metadataHash(meta), meta.chunk_chars);
    })();
    if (!prior) this.size++;
    this.metrics.stagedPayloads = this.size;
    this.metrics.stagedChars += text.length - (prior?.total_chars || 0);
    this.onHighWater?.(this.metrics);
    return this;
  }
  supersedeChunkWrite(id) {
    const prior = this.chunkWrites.get(id);
    if (!prior) return;
    prior.superseded = true;
    this.chunkWrites.delete(id);
    this.db.prepare('DELETE FROM payload_staging_chunks WHERE owner=?').run(prior.owner);
  }
  // Unlike set(), this API does not require a complete decoded string. One
  // value owns a private staging ID until both the iterator's final proof and
  // the source callback have completed. No await occurs in publication.
  async setChunks(id, chunks, { contentHash, totalChars, validateSource = null } = {}) {
    this.assertCurrent();
    if (typeof id !== 'string' || !id || !/^[a-f0-9]{64}$/.test(contentHash || '')
      || !Number.isSafeInteger(totalChars) || totalChars < 0) throw Error('history_payload_reference_required');
    this.open();
    this.db.exec(`CREATE TABLE IF NOT EXISTS payload_staging_chunks(owner TEXT NOT NULL,
      pos INTEGER NOT NULL, body BLOB NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(owner,pos));`);
    this.supersedeChunkWrite(id);
    const ticket = { owner: crypto.randomUUID(), superseded: false };
    this.chunkWrites.set(id, ticket);
    const check = () => {
      this.assertCurrent();
      if (ticket.superseded || this.chunkWrites.get(id) !== ticket) {
        throw Object.assign(Error('history_payload_staging_superseded'), { code: 'HISTORY_PAYLOAD_STAGING_SUPERSEDED' });
      }
    };
    const hash = createLeafTextHash(); let pending = '', received = 0, position = 0, primaryError = null;
    let put;
    const write = text => {
      check(); const body = Buffer.from(text, 'utf16le');
      put.run(ticket.owner, position++, body, checksum(body));
      this.metrics.peakChunkBytes = Math.max(this.metrics.peakChunkBytes, body.length);
    };
    try {
      put = this.db.prepare('INSERT INTO payload_staging_chunks VALUES (?,?,?,?)');
      for await (const chunk of chunks) {
        check();
        if (typeof chunk !== 'string') throw Error('history_payload_text_required');
        received += chunk.length;
        if (received > totalChars) throw Object.assign(Error('history_payload_changed'), { code: 'history_payload_changed' });
        hash.update(chunk);
        for (let from = 0; from < chunk.length;) {
          const take = Math.min(this.chunkChars - pending.length, chunk.length - from);
          pending += chunk.slice(from, from + take); from += take;
          if (pending.length === this.chunkChars) { write(pending); pending = ''; }
        }
        if (this.control?.checkpoint) await this.control.checkpoint(); else await new Promise(resolve => setImmediate(resolve));
        check();
      }
      check(); if (pending) write(pending); pending = '';
      if (received !== totalChars || hash.digest() !== contentHash) {
        throw Object.assign(Error('history_payload_changed'), { code: 'history_payload_changed' });
      }
      if (validateSource && await validateSource() === false) {
        throw Object.assign(Error('History payload source changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
      }
      check();
      const meta = { id, total_chars: totalChars, content_hash: contentHash, chunks: position, chunk_chars: this.chunkChars };
      let prior;
      this.db.transaction(() => {
        check(); prior = this.db.prepare('SELECT total_chars FROM payload_index WHERE id=?').get(id);
        this.db.prepare('DELETE FROM payload_chunks WHERE id=?').run(id);
        this.db.prepare('INSERT INTO payload_chunks(id,pos,body,checksum) SELECT ?,pos,body,checksum FROM payload_staging_chunks WHERE owner=? ORDER BY pos')
          .run(id, ticket.owner);
        this.db.prepare('INSERT OR REPLACE INTO payload_index(id,total_chars,content_hash,chunks,index_hash,chunk_chars) VALUES (?,?,?,?,?,?)')
          .run(id, meta.total_chars, meta.content_hash, meta.chunks, metadataHash(meta), meta.chunk_chars);
        this.db.prepare('DELETE FROM payload_staging_chunks WHERE owner=?').run(ticket.owner);
        check();
      })();
      if (!prior) this.size++;
      this.metrics.stagedPayloads = this.size;
      this.metrics.stagedChars += totalChars - (prior?.total_chars || 0);
      try { this.onHighWater?.(this.metrics); } catch { /* diagnostics cannot revoke a committed value */ }
      return this;
    } catch (error) {
      primaryError = error; throw error;
    } finally {
      pending = '';
      // Last-abort/close or a newer C may run while A is suspended. A's
      // cleanup owns only its staging ID, never C or the prior public value.
      try {
        if (!this.closed && this.db?.open !== false) this.db.prepare('DELETE FROM payload_staging_chunks WHERE owner=?').run(ticket.owner);
      } catch (error) { if (!primaryError) throw error; }
      finally { if (this.chunkWrites.get(id) === ticket) this.chunkWrites.delete(id); }
    }
  }
  readPage(id, request = {}) { this.assertCurrent(); return this.db ? readChunkedPayload(this.db, id, request, this.control) : null; }
  get(id) { this.assertCurrent(); return this.db ? readChunkedPayload(this.db, id, {}, this.control)?.payload ?? undefined : undefined; }
  *[Symbol.iterator]() {
    this.assertCurrent();
    if (!this.db) return;
    for (const row of this.db.prepare('SELECT id FROM payload_index ORDER BY id').iterate()) {
      this.assertCurrent(); yield [row.id, this.get(row.id)];
    }
  }
  transferTo(db) {
    this.assertCurrent(); if (!this.db) return 0; initializePayloadChunks(db);
    const putMeta = db.prepare('INSERT OR REPLACE INTO payload_index(id,total_chars,content_hash,chunks,index_hash,chunk_chars) VALUES (?,?,?,?,?,?)');
    const putChunk = db.prepare('INSERT OR REPLACE INTO payload_chunks VALUES (?,?,?,?)');
    const removeChunks = db.prepare('DELETE FROM payload_chunks WHERE id=?');
    const removeLegacy = db.prepare('DELETE FROM payloads WHERE id=?');
    let bytes = 0;
    for (const meta of this.db.prepare('SELECT * FROM payload_index ORDER BY id').iterate()) {
      this.assertCurrent(); removeChunks.run(meta.id); removeLegacy.run(meta.id);
      for (const row of verifiedPayloadChunks(this.db, meta, this.control)) {
        this.assertCurrent(); putChunk.run(row.id, row.pos, row.body, row.checksum); bytes += row.body.length;
      }
      putMeta.run(meta.id, meta.total_chars, meta.content_hash, meta.chunks, meta.index_hash, chunkCharsOf(meta));
    }
    return bytes;
  }
  async transferToAsync(db) {
    this.assertCurrent(); if (!this.db) return 0; initializePayloadChunks(db);
    const putMeta = db.prepare('INSERT OR REPLACE INTO payload_index(id,total_chars,content_hash,chunks,index_hash,chunk_chars) VALUES (?,?,?,?,?,?)');
    const putChunk = db.prepare('INSERT OR REPLACE INTO payload_chunks VALUES (?,?,?,?)');
    const removeChunks = db.prepare('DELETE FROM payload_chunks WHERE id=?');
    const removeLegacy = db.prepare('DELETE FROM payloads WHERE id=?');
    let bytes = 0, batchRows = 0, batchBytes = 0;
    for (const meta of this.db.prepare('SELECT * FROM payload_index ORDER BY id').iterate()) {
      this.assertCurrent(); removeChunks.run(meta.id); removeLegacy.run(meta.id);
      for (const row of verifiedPayloadChunks(this.db, meta, this.control)) {
        this.assertCurrent(); putChunk.run(row.id, row.pos, row.body, row.checksum);
        bytes += row.body.length; batchRows++; batchBytes += row.body.length;
        if (batchRows >= 32 || batchBytes >= 256 * 1024) {
          if (this.control) await this.control.checkpoint(); else await new Promise(resolve => setImmediate(resolve));
          batchRows = 0; batchBytes = 0;
        }
      }
      this.assertCurrent();
      putMeta.run(meta.id, meta.total_chars, meta.content_hash, meta.chunks, meta.index_hash, chunkCharsOf(meta));
    }
    return bytes;
  }
  clear() {
    this.assertCurrent();
    if (!this.db) return;
    for (const id of this.chunkWrites.keys()) this.supersedeChunkWrite(id);
    this.db.transaction(() => { this.db.exec('DELETE FROM payload_index; DELETE FROM payload_chunks;'); })();
    this.size = 0; this.metrics.stagedPayloads = 0; this.metrics.stagedChars = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const ticket of this.chunkWrites.values()) ticket.superseded = true;
    this.chunkWrites.clear();
    // A ready/full request that never staged a payload owns no file.
    if (!this.openAttempted) return;
    this.db?.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(this.filename + suffix); } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    if (this.temporaryDirectory) fs.rmdirSync(this.temporaryDirectory);
  }
}

module.exports = { HistoryPendingPayloads, PAYLOAD_CHUNK_CHARS, payloadTextHash, initializePayloadChunks, readChunkedPayload };
