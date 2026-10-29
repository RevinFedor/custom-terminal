'use strict';

// Immutable values for the History reader. This is an explicit cursor API:
// a cursor is neither an Array nor a Proxy. The legacy DTO capture below is a
// named, still-unbounded input boundary; it is not the canonical reducer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const OWNERS = new WeakMap();
const FANOUT = 8;
const NO_VALUE = Object.freeze({ type: 'undefined' });
const safeInteger = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(name);
  return n;
};
const failure = code => Object.assign(new Error(code), { code });
const vector = () => ({ page: 0, depth: 0, length: 0 });
const reference = id => ({ type: 'page', id });
const isRef = value => value?.type === 'page';
const hash = body => crypto.createHash('sha256').update(body).digest('hex');

class HistoryPagedStore {
  constructor({ filename, Database = require('better-sqlite3'), pageBytes = 1024,
    indexBytes = 2048, residentPages = 3, diskBytes = 20 * 1024 ** 3,
    sqlCacheKiB = 8, textDigestFactory = () => crypto.createHash('sha256') } = {}) {
    safeInteger(pageBytes, 'history_page_bytes');
    if (pageBytes < 256 || pageBytes > 64 * 1024 || pageBytes % 2) throw failure('history_page_bytes');
    safeInteger(indexBytes, 'history_index_bytes');
    safeInteger(residentPages, 'history_resident_pages');
    safeInteger(diskBytes, 'history_disk_bytes');
    this.pageBytes = pageBytes;
    this.indexBytes = indexBytes;
    this.residentPages = residentPages;
    this.diskBudget = diskBytes;
    this.temporaryDirectory = filename ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'noted-history-pages-'));
    this.filename = filename || path.join(this.temporaryDirectory, 'pages.sqlite');
    this.db = new Database(this.filename);
    this.closed = false;
    this.depth = 0;
    this.builders = 0;
    this.textDigestFactory = textDigestFactory;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.statements = new Map(); // Fixed SQL vocabulary, never a per-row index.
    this.owner = crypto.randomUUID();
    this.metrics = { pagesRead: 0, pagesWritten: 0, readBytes: 0, writeBytes: 0,
      peakPageReadBytes: 0, peakPageWriteBytes: 0, peakCachedPages: 0,
      peakIndexBytes: 0, forks: 0, forkPagesWritten: 0, leases: 0,
      legacyCaptureValues: 0, legacyInputPeakStringChars: 0, maxLeafWriteChars: 0,
      gcSteps: 0, reclaimedPages: 0 };
    try {
      fs.chmodSync(this.filename, 0o600);
      this.db.pragma('journal_mode = DELETE');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('temp_store = FILE');
      this.db.pragma('cache_size = -' + Math.max(1, safeInteger(sqlCacheKiB, 'history_sql_cache')));
      this.db.pragma('temp.cache_size = -' + Math.max(1, sqlCacheKiB));
      this.db.exec([
        'CREATE TABLE IF NOT EXISTS hp_pages(id INTEGER PRIMARY KEY, body BLOB NOT NULL, digest TEXT NOT NULL);',
        'CREATE TABLE IF NOT EXISTS hp_edges(parent INTEGER NOT NULL, ordinal INTEGER NOT NULL, child INTEGER NOT NULL, PRIMARY KEY(parent,ordinal));',
        'CREATE INDEX IF NOT EXISTS hp_child ON hp_edges(child);',
        'CREATE TABLE IF NOT EXISTS hp_pins(name TEXT PRIMARY KEY, page INTEGER NOT NULL, durable INTEGER NOT NULL);',
        'CREATE TABLE IF NOT EXISTS hp_gc(page INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, next_edge INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);',
        'CREATE INDEX IF NOT EXISTS hp_gc_pending ON hp_gc(epoch,done,page);',
        'CREATE TABLE IF NOT EXISTS hp_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);',
        "INSERT OR IGNORE INTO hp_meta VALUES ('gc_phase',0);",
        "INSERT OR IGNORE INTO hp_meta VALUES ('gc_cursor',0);",
        "INSERT OR IGNORE INTO hp_meta VALUES ('gc_epoch',0);",
        "INSERT OR IGNORE INTO hp_meta VALUES ('gc_pin_cursor','');",
      ].join('\n'));
      // Account SQLite pages, not merely payload lengths. This does not prove
      // native/RSS bounds. A journal needs additional space in checkDisk().
      const sqlPageBytes = Number(this.db.pragma('page_size', { simple: true }));
      const cap = Math.floor(diskBytes / (2 * sqlPageBytes));
      if (cap < Number(this.db.pragma('page_count', { simple: true }))) throw failure('HISTORY_BACKING_FULL');
      this.db.pragma('max_page_count = ' + cap);
      this.checkDisk();
    } catch (error) {
      this.db.close(); this.closed = true;
      if (this.temporaryDirectory) fs.rmSync(this.temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  assertOpen() { if (this.closed) throw failure('history_paged_store_closed'); }
  sql(source) {
    this.assertOpen();
    let statement = this.statements.get(source);
    if (!statement) { statement = this.db.prepare(source); this.statements.set(source, statement); }
    return statement;
  }
  transaction(operation) {
    this.assertOpen();
    if (this.depth) return operation();
    this.depth++;
    try {
      return this.db.transaction(() => {
        const result = operation();
        this.checkDisk();
        return result;
      })();
    } catch (error) {
      // Rolled-back row IDs can be reused: no cached page survives rollback.
      this.cache.clear(); this.cacheBytes = 0;
      throw error;
    } finally { this.depth--; }
  }
  beginBuild() {
    this.assertOpen(); this.builders++;
    let released = false;
    return () => { if (!released) { released = true; this.builders--; } };
  }
  diskUsage() {
    let bytes = 0;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { bytes += fs.statSync(this.filename + suffix).size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return bytes;
  }
  checkDisk() {
    if (this.diskUsage() > this.diskBudget) throw failure('HISTORY_BACKING_FULL');
  }
  reserve() {
    return Number(this.sql('INSERT INTO hp_pages(body,digest) VALUES (?,?)').run(Buffer.alloc(0), '').lastInsertRowid);
  }
  put(body, children = [], reserved = null) {
    if (!Buffer.isBuffer(body)) body = Buffer.from(JSON.stringify(body));
    if (body.length > this.pageBytes) throw failure('history_page_overflow');
    const id = reserved ?? this.reserve();
    this.sql('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(body, hash(body), id);
    for (let ordinal = 0; ordinal < children.length; ordinal++) {
      if (children[ordinal]) this.sql('INSERT INTO hp_edges VALUES (?,?,?)').run(id, ordinal, children[ordinal]);
    }
    this.metrics.pagesWritten++; this.metrics.writeBytes += body.length;
    this.metrics.peakPageWriteBytes = Math.max(this.metrics.peakPageWriteBytes, body.length);
    // Mutations invalidate an in-progress mark. New pages and their ancestors
    // are protected by a lease before any collection is allowed.
    this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
    return id;
  }
  read(id) {
    this.assertOpen();
    if (!Number.isSafeInteger(id) || id < 1) throw failure('history_page_id');
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id); this.cache.set(id, cached);
      return cached;
    }
    // Query length before BLOB. A corrupt oversized cell is not admitted as a
    // whole JS Buffer, including when the cache is disabled.
    const meta = this.sql('SELECT length(body) AS bytes,digest FROM hp_pages WHERE id=?').get(id);
    if (!meta || !meta.bytes || meta.bytes > this.pageBytes) throw failure('history_page_missing_or_corrupt');
    const row = this.sql('SELECT substr(body,1,?) AS body FROM hp_pages WHERE id=?').get(this.pageBytes, id);
    const body = Buffer.from(row.body.buffer, row.body.byteOffset, row.body.byteLength);
    if (body.length !== meta.bytes || hash(body) !== meta.digest) throw failure('history_page_corrupt');
    this.metrics.pagesRead++; this.metrics.readBytes += body.length;
    this.metrics.peakPageReadBytes = Math.max(this.metrics.peakPageReadBytes, body.length);
    if (this.residentPages && body.length <= this.indexBytes) {
      // Evict BEFORE inserting: the cache never has a temporary fourth page.
      while (this.cache.size >= this.residentPages || this.cacheBytes + body.length > this.indexBytes) {
        const first = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(first).length; this.cache.delete(first);
      }
      this.cache.set(id, body); this.cacheBytes += body.length;
      this.metrics.peakCachedPages = Math.max(this.metrics.peakCachedPages, this.cache.size);
      this.metrics.peakIndexBytes = Math.max(this.metrics.peakIndexBytes, this.cacheBytes);
    }
    return body;
  }
  json(id) { return JSON.parse(this.read(id).toString('utf8')); }
  vectorGet(tree, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= tree.length) return 0;
    let page = tree.page;
    for (let depth = tree.depth - 1; depth >= 0 && page; depth--) {
      const slots = this.json(page);
      page = slots[Math.floor(index / FANOUT ** depth) % FANOUT] || 0;
    }
    return page;
  }
  vectorSet(tree, index, value) {
    safeInteger(index, 'history_ordinal');
    if (index >= Number.MAX_SAFE_INTEGER / FANOUT) throw failure('history_ordinal_overflow');
    let depth = tree.depth, page = tree.page;
    while (index >= FANOUT ** depth || !depth) {
      const slots = new Array(FANOUT).fill(0); slots[0] = page;
      page = this.put(slots, slots); depth++;
    }
    const base = { page, depth, length: Math.max(tree.length, index + 1) };
    let child = value;
    // Rewalk the short path instead of retaining all ancestor page bodies.
    // The cost is O(log² N) small page reads; fork itself writes zero pages.
    for (let level = depth - 1; level >= 0; level--) {
      let old = page;
      for (let at = 0; at < level && old; at++) {
        old = this.json(old)[Math.floor(index / FANOUT ** (depth - 1 - at)) % FANOUT] || 0;
      }
      const slots = old ? this.json(old) : new Array(FANOUT).fill(0);
      slots[Math.floor(index / FANOUT ** (depth - 1 - level)) % FANOUT] = child;
      child = this.put(slots, slots);
    }
    return { ...base, page: child };
  }
  vectorTruncate(tree, length) {
    safeInteger(length, 'history_vector_length');
    if (length >= tree.length) return tree;
    if (!length) return vector();
    const index = length - 1;
    let child = 0;
    // Preserve the prefix and remove every right sibling, one path at a
    // time. Extending later cannot resurrect a removed slot.
    for (let level = tree.depth - 1; level >= 0; level--) {
      let old = tree.page;
      for (let at = 0; at < level && old; at++) old = this.json(old)[Math.floor(index / FANOUT ** (tree.depth - 1 - at)) % FANOUT] || 0;
      const slots = old ? this.json(old) : new Array(FANOUT).fill(0);
      const digit = Math.floor(index / FANOUT ** (tree.depth - 1 - level)) % FANOUT;
      if (level < tree.depth - 1) slots[digit] = child;
      for (let at = digit + 1; at < FANOUT; at++) slots[at] = 0;
      child = this.put(slots, slots);
    }
    return { page: child, depth: tree.depth, length };
  }
  *vectorValues(tree) {
    for (let index = 0; index < tree.length; index++) yield this.vectorGet(tree, index);
  }
  *vectorPresent(tree, from = 0) {
    let ordinal = safeInteger(from, 'history_vector_from');
    while (ordinal < tree.length) {
      let page = tree.page, restart = false;
      for (let depth = tree.depth - 1; depth >= 0; depth--) {
        const span = FANOUT ** depth, parentSpan = span * FANOUT;
        const digit = Math.floor(ordinal / span) % FANOUT;
        const slots = page ? this.json(page) : [];
        let next = digit;
        while (next < FANOUT && !slots[next]) next++;
        if (next === FANOUT) {
          ordinal = (Math.floor(ordinal / parentSpan) + 1) * parentSpan;
          restart = true; break;
        }
        if (next !== digit) ordinal = Math.floor(ordinal / parentSpan) * parentSpan + next * span;
        page = slots[next];
      }
      if (restart) continue;
      yield { ordinal, page }; ordinal++;
    }
  }
  leafWriter() {
    let tree = vector(), totalChars = 0, done = false, pending = '';
    const digest = this.textDigestFactory();
    const flush = () => {
      if (!pending) return;
      const bytes = Buffer.from(pending, 'utf16le');
      this.metrics.maxLeafWriteChars = Math.max(this.metrics.maxLeafWriteChars, pending.length);
      digest.update(bytes); totalChars += pending.length; pending = '';
      tree = this.vectorSet(tree, tree.length, this.put(bytes));
    };
    const writer = {
      write: text => {
        if (done || typeof text !== 'string') throw failure('history_leaf_writer_state');
        // The caller owns text; no concatenation or full encoded copy occurs.
        for (let offset = 0; offset < text.length;) {
          const count = Math.min(this.pageBytes / 2 - pending.length, text.length - offset);
          pending += text.slice(offset, offset + count); offset += count;
          if (pending.length === this.pageBytes / 2) flush();
        }
      },
      finish: () => {
        if (done) throw failure('history_leaf_writer_state');
        done = true;
        flush();
        return reference(this.put({ kind: 'text', chunks: tree, totalChars,
          digest: digest.digest('hex') }, [tree.page]));
      },
    };
    return writer;
  }
  *leafChunks(ref) {
    const meta = this.json(ref.id);
    if (meta.kind !== 'text') throw failure('history_not_text');
    let chars = 0;
    const digest = this.textDigestFactory();
    for (const page of this.vectorValues(meta.chunks)) {
      const body = this.read(page);
      if (body.length % 2) throw failure('history_leaf_corrupt');
      digest.update(body); chars += body.length / 2;
      yield body.toString('utf16le');
    }
    if (chars !== meta.totalChars || digest.digest('hex') !== meta.digest) throw failure('history_leaf_corrupt');
  }
  *leafRange(ref, offset = 0, limit = Infinity) {
    const meta = this.json(ref.id);
    if (meta.kind !== 'text') throw failure('history_not_text');
    safeInteger(offset,'history_text_offset');
    if (limit !== Infinity) safeInteger(limit,'history_text_limit');
    const end = Math.min(meta.totalChars,offset+limit), width=this.pageBytes/2;
    for(let at=offset;at<end;) {
      const ordinal=Math.floor(at/width), page=this.vectorGet(meta.chunks,ordinal);
      const body=this.read(page), expected=Math.min(width,meta.totalChars-ordinal*width);
      if(body.length!==expected*2)throw failure('history_leaf_corrupt');
      const start=at-ordinal*width,count=Math.min(end-at,expected-start);
      yield body.subarray(start*2,(start+count)*2).toString('utf16le');at+=count;
    }
  }
  text(text) {
    const writer = this.leafWriter(); writer.write(text); return writer.finish();
  }
  textEqual(a, b) {
    const left = this.json(a.id), right = this.json(b.id);
    if (left.kind !== 'text' || right.kind !== 'text') return false;
    if (left.totalChars !== right.totalChars || left.digest !== right.digest) return false;
    // Hash equality is only a filter. The exact UTF-16 content is compared.
    const ai = this.leafChunks(a), bi = this.leafChunks(b);
    let av = '', bv = '', ad = false, bd = false;
    try {
      for (;;) {
        if (!av && !ad) { const n = ai.next(); av = n.value || ''; ad = !!n.done; }
        if (!bv && !bd) { const n = bi.next(); bv = n.value || ''; bd = !!n.done; }
        if (ad && bd) return !av && !bv;
        if (ad && !av || bd && !bv) return false;
        const n = Math.min(av.length, bv.length);
        if (av.slice(0, n) !== bv.slice(0, n)) return false;
        av = av.slice(n); bv = bv.slice(n);
      }
    } finally { ai.return?.(); bi.return?.(); }
  }
  textEqualsString(ref, text) {
    if (this.json(ref.id).totalChars !== text.length) return false;
    let offset = 0;
    for (const part of this.leafChunks(ref)) {
      if (part !== text.slice(offset, offset + part.length)) return false;
      offset += part.length;
    }
    return offset === text.length;
  }
  scalar(value) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return NO_VALUE;
    if (value === null || typeof value === 'boolean') return { type: 'scalar', value };
    if (typeof value === 'number') return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
    if (typeof value === 'string') return this.text(value);
    throw failure('history_scalar_type');
  }
  container(kind) {
    if (!['object', 'array', 'map', 'set'].includes(kind)) throw failure('history_container_kind');
    return { kind, items: vector(), fields: vector(), length: 0 };
  }
  fieldOrdinal(container, key) {
    let index = 0;
    for (const page of this.vectorValues(container.fields)) {
      const field = this.json(page);
      if (!field.deleted && (typeof key === 'string' ? this.textEqualsString(field.key, key) : this.textEqual(field.key, key))) return index;
      index++;
    }
    return -1;
  }
  setField(container, key, value) {
    const index = this.fieldOrdinal(container, key);
    let shortKey = typeof key === 'string' ? key : null;
    if (shortKey === null && this.json(key.id).totalChars <= 10) {
      shortKey = ''; for (const chunk of this.leafChunks(key)) shortKey += chunk;
    }
    const propertyIndex = shortKey !== null && /^(0|[1-9]\d{0,9})$/.test(shortKey)
      && Number(shortKey) < 0xffffffff ? Number(shortKey) : null;
    if (typeof key === 'string') key = this.text(key);
    const pair = this.put({ key, value, propertyIndex }, [key.id, isRef(value) ? value.id : 0]);
    container.fields = this.vectorSet(container.fields, index < 0 ? container.fields.length : index, pair);
    if (propertyIndex !== null) container.numeric = this.vectorSet(container.numeric || vector(), propertyIndex, pair);
  }
  append(container, value) {
    const page = this.put({ value }, [isRef(value) ? value.id : 0]);
    container.items = this.vectorSet(container.items, container.length++, page);
  }
  deleteField(container, key) {
    const ordinal = this.fieldOrdinal(container, key);
    if (ordinal < 0) return false;
    const previous = this.json(this.vectorGet(container.fields, ordinal));
    const at = this.put({ ...previous, value: NO_VALUE, deleted: true }, [previous.key.id]);
    container.fields = this.vectorSet(container.fields, ordinal, at);
    if (previous.propertyIndex !== null && previous.propertyIndex !== undefined) {
      container.numeric = this.vectorSet(container.numeric, previous.propertyIndex, 0);
    }
    return true;
  }
  finishContainer(container, reserved = null) {
    return reference(this.put(container, [container.items.page, container.fields.page, container.numeric?.page || 0, container.lookup?.page || 0], reserved));
  }
  // Explicit compatibility boundary. It preserves aliases, cycles, sparse
  // arrays and extra enumerable fields. Its caller still owns the full input
  // DTO and recursive depth. No bounded-ingest claim is made for this method.
  captureLegacy(value) {
    this.metrics.legacyCaptureValues++;
    return this.transaction(() => {
      const seen = new WeakMap();
      const copy = item => {
        if (typeof item === 'string') {
          this.metrics.legacyInputPeakStringChars = Math.max(this.metrics.legacyInputPeakStringChars, item.length);
          return this.text(item);
        }
        if (!item || typeof item !== 'object') return this.scalar(item);
        if (seen.has(item)) return reference(seen.get(item));
        const proto = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && !(item instanceof Map) && !(item instanceof Set)
          && proto !== Object.prototype && proto !== null) throw failure('history_legacy_capture_prototype');
        const reserved = this.reserve(); seen.set(item, reserved);
        const out = this.container(Array.isArray(item) ? 'array' : item instanceof Map ? 'map' : item instanceof Set ? 'set' : 'object');
        if (item instanceof Map) {
          for (const [key, val] of item) {
            const pair = this.container('array'); this.append(pair, copy(key)); this.append(pair, copy(val));
            this.append(out, this.finishContainer(pair));
          }
        } else if (item instanceof Set) {
          for (const val of item) this.append(out, copy(val));
        }
        if (Array.isArray(item)) out.length = item.length;
        for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            const val = copy(item[key]);
            if (Array.isArray(item) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff) {
              const page = this.put({ value: val }, [isRef(val) ? val.id : 0]);
              out.items = this.vectorSet(out.items, Number(key), page);
            } else this.setField(out, key, val);
        }
        return this.finishContainer(out, reserved);
      };
      const ref = copy(value);
      return this.lease(ref);
    });
  }
  descriptor(ref) {
    return Object.freeze({ $historyPagedRoot: 1, page: ref.id, filename: this.filename });
  }
  lease(ref, name = this.owner + ':' + crypto.randomUUID(), durable = false) {
    this.assertOpen();
    if (!isRef(ref)) {
      ref = reference(this.put({ kind: 'scalar-root', value: ref }));
    }
    this.read(ref.id);
    this.sql('INSERT INTO hp_pins(name,page,durable) VALUES (?,?,?)').run(name, ref.id, durable ? 1 : 0);
    this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
    this.metrics.leases++;
    let released = false;
    const assert = () => { this.assertOpen(); if (released) throw failure('history_lease_released'); };
    const lease = {
      descriptor: this.descriptor(ref),
      cursor: () => {
        assert();
        const root = this.json(ref.id);
        return root.kind === 'owner-root'
          ? new HistoryPagedCursor(this, root.root, assert, root.owners, root.imported)
          : new HistoryPagedCursor(this, ref, assert);
      },
      fork: () => {
        assert(); this.metrics.forks++;
        // Immutable page graph shared; no page copy, SQL clone or tree walk.
        return this.lease(ref);
      },
      release: () => {
        if (released) return;
        released = true;
        if (!this.closed) {
          this.sql('DELETE FROM hp_pins WHERE name=?').run(name);
          this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
        }
        this.metrics.leases--;
      },
    };
    return Object.freeze(lease);
  }
  open(descriptor) {
    if (descriptor?.$historyPagedRoot !== 1 || descriptor.filename !== this.filename) throw failure('history_root_descriptor');
    return this.lease(reference(descriptor.page));
  }
  openPin(name) {
    const pin = this.sql('SELECT page FROM hp_pins WHERE name=? AND durable=1').get(name);
    return pin ? this.lease(reference(pin.page)) : null;
  }
  replaceRootPin(name, descriptor) {
    if (descriptor?.$historyPagedRoot !== 1 || descriptor.filename !== this.filename) throw failure('history_root_descriptor');
    this.read(descriptor.page);
    return this.transaction(() => {
      this.sql('INSERT OR REPLACE INTO hp_pins VALUES (?,?,1)').run(name, descriptor.page);
      this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
    });
  }
  replacePin(name, cursor) {
    const owner = OWNERS.get(cursor);
    if (!owner || owner.store !== this) throw failure('history_foreign_root');
    owner.assert();
    return this.transaction(() => {
      const ref = this.cursorReference(owner);
      this.sql('INSERT OR REPLACE INTO hp_pins VALUES (?,?,1)').run(name, ref.id);
      this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
    });
  }
  cursorReference(owner) {
    // A nested logical cursor carries its frozen owner index with it. Storing
    // only its resolved node page would orphan logical children after GC or
    // accidentally resolve them against the receiving root's revision.
    return owner.owners ? reference(this.put({ kind: 'owner-root',owners: owner.owners,imported:owner.imported,
      nextId: owner.owners.length,root: owner.ref },[owner.owners.page,owner.imported?.page || 0,owner.ref.id])) : owner.ref;
  }
  referenceForCursor(cursor) {
    const owner=OWNERS.get(cursor);
    if(!owner||owner.store!==this)throw failure('history_foreign_root');
    owner.assert();return this.cursorReference(owner);
  }
  removePin(name) {
    this.sql('DELETE FROM hp_pins WHERE name=? AND durable=1').run(name);
    this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
  }
  withOrdinal(cursor, ordinal, valueCursor) {
    const owner = OWNERS.get(cursor), value = OWNERS.get(valueCursor);
    if (!owner || owner.store !== this || !value || value.store !== this) throw failure('history_foreign_root');
    owner.assert(); value.assert();
    return this.transaction(() => {
      const meta = this.json(owner.ref.id);
      if (meta.kind !== 'array') throw failure('history_not_array');
      safeInteger(ordinal, 'history_ordinal');
      const valueRef = this.cursorReference(value);
      const page = this.put({ value: valueRef }, [valueRef.id]);
      meta.items = this.vectorSet(meta.items, ordinal, page);
      meta.length = Math.max(meta.length, ordinal + 1);
      return this.lease(this.cursorReference({ ...owner,ref: this.finishContainer(meta) }));
    });
  }
  // Bounded mark/sweep work. The queue and traversal position live in SQLite,
  // including cycles. A call processes <= work units and never .all()s pages.
  collectStep(work = 32) {
    safeInteger(work, 'history_gc_work');
    if (this.depth) throw failure('history_gc_during_mutation');
    if (this.builders) return { complete: false, work: 0, reclaimed: 0, blockedByBuilders: this.builders };
    return this.transaction(() => {
      let phase = this.sql("SELECT value FROM hp_meta WHERE key='gc_phase'").get().value;
      if (phase === 5) return { complete: true, work: 0, reclaimed: 0 };
      if (phase === 0) {
        this.sql("UPDATE hp_meta SET value=value+1 WHERE key='gc_epoch'").run();
        this.sql("UPDATE hp_meta SET value='' WHERE key='gc_pin_cursor'").run();
        this.sql("UPDATE hp_meta SET value=1 WHERE key='gc_phase'").run();
        phase = 1;
      }
      const epoch = this.sql("SELECT value FROM hp_meta WHERE key='gc_epoch'").get().value;
      let completed = 0, reclaimed = 0;
      while (completed++ < work) {
        if (phase === 1) {
          const at = this.sql("SELECT value FROM hp_meta WHERE key='gc_pin_cursor'").get().value;
          const pin = this.sql('SELECT name,page FROM hp_pins WHERE name>? ORDER BY name LIMIT 1').get(at);
          if (pin) {
            this.sql('INSERT OR REPLACE INTO hp_gc(page,epoch) VALUES (?,?)').run(pin.page, epoch);
            this.sql("UPDATE hp_meta SET value=? WHERE key='gc_pin_cursor'").run(pin.name);
          } else {
            phase = 2;
            this.sql("UPDATE hp_meta SET value=2 WHERE key='gc_phase'").run();
          }
        } else if (phase === 2) {
          const next = this.sql('SELECT page,next_edge FROM hp_gc WHERE epoch=? AND done=0 LIMIT 1').get(epoch);
          if (!next) {
            phase = 3;
            this.sql("UPDATE hp_meta SET value=3 WHERE key='gc_phase'").run();
            this.sql("UPDATE hp_meta SET value=0 WHERE key='gc_cursor'").run();
            continue;
          }
          const edge = this.sql('SELECT ordinal,child FROM hp_edges WHERE parent=? AND ordinal>=? ORDER BY ordinal LIMIT 1').get(next.page, next.next_edge);
          if (edge) {
            this.sql('INSERT INTO hp_gc(page,epoch) VALUES (?,?) ON CONFLICT(page) DO UPDATE SET epoch=excluded.epoch,next_edge=0,done=0 WHERE hp_gc.epoch<>excluded.epoch').run(edge.child, epoch);
            this.sql('UPDATE hp_gc SET next_edge=? WHERE page=?').run(edge.ordinal + 1, next.page);
          } else this.sql('UPDATE hp_gc SET done=1 WHERE page=?').run(next.page);
        } else if (phase === 3) {
          const at = this.sql("SELECT value FROM hp_meta WHERE key='gc_cursor'").get().value;
          const next = this.sql('SELECT id FROM hp_pages WHERE id>? ORDER BY id LIMIT 1').get(at);
          if (!next) {
            phase = 4;
            this.sql("UPDATE hp_meta SET value=4 WHERE key='gc_phase'").run();
            continue;
          }
          this.sql("UPDATE hp_meta SET value=? WHERE key='gc_cursor'").run(next.id);
          if (!this.sql('SELECT 1 FROM hp_gc WHERE page=? AND epoch=?').get(next.id, epoch)) {
            this.sql('DELETE FROM hp_edges WHERE parent=?').run(next.id);
            this.sql('DELETE FROM hp_pages WHERE id=?').run(next.id);
            const cached = this.cache.get(next.id);
            if (cached) { this.cacheBytes -= cached.length; this.cache.delete(next.id); }
            reclaimed++; this.metrics.reclaimedPages++;
          }
        } else {
          const stale = this.sql('SELECT page FROM hp_gc WHERE epoch<>? LIMIT 1').get(epoch);
          if (stale) this.sql('DELETE FROM hp_gc WHERE page=?').run(stale.page);
          else {
            this.sql("UPDATE hp_meta SET value=5 WHERE key='gc_phase'").run();
            return { complete: true, work: completed, reclaimed };
          }
        }
        this.metrics.gcSteps++;
      }
      return { complete: false, work, reclaimed };
    });
  }
  stats() {
    return { ...this.metrics, cachedPages: this.cache.size, indexBytes: this.cacheBytes,
      diskBytes: this.diskUsage(), diskBudget: this.diskBudget, pageBytes: this.pageBytes,
      activeBuilders: this.builders, sqliteNativeMemoryMeasured: false, producerBounded: false,
      ownerCoverage: 'page cache; decoded transient objects and legacy producer excluded' };
  }
  close() {
    if (this.closed) return;
    this.sql('DELETE FROM hp_pins WHERE durable=0 AND substr(name,1,?)=?').run(this.owner.length + 1, this.owner + ':');
    this.cache.clear(); this.cacheBytes = 0; this.statements.clear();
    this.db.close(); this.closed = true;
    if (this.temporaryDirectory) fs.rmSync(this.temporaryDirectory, { recursive: true, force: true });
  }
}

class HistoryPagedCursor {
  constructor(store, ref, assert, owners = null, imported = null) {
    for (;;) {
      if(isRef(ref)&&imported) {
        const at=store.vectorGet(imported,ref.id);
        if(at)ref={type:'owner',id:store.json(at).owner};
      }
      if (ref?.type === 'owner') {
        const at = owners && store.vectorGet(owners, ref.id);
        if (!at) throw failure('history_projection_owner_missing');
        ref = reference(at);
      }
      if (!isRef(ref)) break;
      const nested = store.json(ref.id);
      if (nested.kind !== 'owner-root') break;
      owners = nested.owners; imported=nested.imported; ref = nested.root;
    }
    OWNERS.set(this, { store, ref, assert, owners, imported });
    Object.freeze(this);
  }
  get kind() {
    const { store, ref, assert } = OWNERS.get(this); assert();
    return isRef(ref) ? store.json(ref.id).kind : ref.type;
  }
  get length() {
    const { store, ref, assert } = OWNERS.get(this); assert();
    const meta = store.json(ref.id);
    return meta.kind === 'text' ? meta.totalChars : meta.length;
  }
  identity() {
    const { store, ref, assert } = OWNERS.get(this); assert();
    return isRef(ref) ? store.filename + ':' + ref.id : null;
  }
  scalar() {
    const { ref: owned, store, assert } = OWNERS.get(this); assert();
    const ref = isRef(owned) ? store.json(owned.id).value : owned;
    if (!ref) throw failure('history_cursor_not_scalar');
    if (ref.type === 'undefined') return undefined;
    if (ref.type === 'scalar') return ref.value;
    if (ref.type === 'number') return Number(ref.value);
    if (ref.type === 'bigint') return BigInt(ref.value);
    throw failure('history_cursor_not_scalar');
  }
  field(key) {
    const { store, ref, assert, owners, imported } = OWNERS.get(this); assert();
    const meta = store.json(ref.id);
    const ordinal = store.fieldOrdinal(meta, key);
    const field = ordinal < 0 ? null : store.json(store.vectorGet(meta.fields, ordinal));
    return new HistoryPagedCursor(store, field?.value || NO_VALUE, assert, owners, imported);
  }
  at(ordinal) {
    const { store, ref, assert, owners, imported } = OWNERS.get(this); assert();
    const meta = store.json(ref.id);
    if (meta.kind !== 'array') throw failure('history_cursor_not_array');
    const page = ordinal < meta.length ? store.vectorGet(meta.items, ordinal) : 0;
    return new HistoryPagedCursor(store, page ? store.json(page).value : NO_VALUE, assert, owners, imported);
  }
  *rows(from = 0, count = this.length - from) {
    safeInteger(from, 'history_range_from'); safeInteger(count, 'history_range_count');
    for (let i = from, end = Math.min(this.length, from + count); i < end; i++) yield this.at(i);
  }
  *fields() {
    const { store, ref, assert, owners, imported } = OWNERS.get(this); assert();
    const meta = store.json(ref.id);
    if (!meta.fields) throw failure('history_cursor_not_container');
    if (meta.numeric) for (const { page } of store.vectorPresent(meta.numeric)) {
      assert();
      const field = store.json(page);
      if (field.deleted) continue;
      yield [new HistoryPagedCursor(store, field.key, assert, owners, imported), new HistoryPagedCursor(store, field.value, assert, owners, imported)];
    }
    for (const page of store.vectorValues(meta.fields)) {
      assert();
      const field = store.json(page);
      if (field.deleted) continue;
      if (field.propertyIndex !== null && field.propertyIndex !== undefined) continue;
      yield [new HistoryPagedCursor(store, field.key, assert, owners, imported), new HistoryPagedCursor(store, field.value, assert, owners, imported)];
    }
  }
  *pairs() {
    const { store, ref, assert, owners, imported } = OWNERS.get(this); assert();
    const meta = store.json(ref.id);
    if (!meta.logicalMap) throw failure('history_cursor_not_logical_map');
    for (const at of store.vectorValues(meta.items)) {
      assert();
      const item = store.json(at);
      if (!item.deleted) yield [new HistoryPagedCursor(store,item.key,assert,owners,imported), new HistoryPagedCursor(store,item.value,assert,owners,imported)];
    }
  }
  *textChunks() {
    const { store, ref, assert } = OWNERS.get(this); assert();
    for (const part of store.leafChunks(ref)) { assert(); yield part; }
    assert();
  }
  textEquals(other) {
    const left = OWNERS.get(this), right = OWNERS.get(other);
    left.assert(); right?.assert();
    if (!right || left.store !== right.store) throw failure('history_foreign_root');
    return left.store.textEqual(left.ref, right.ref);
  }
}

const isHistoryPagedCursor = value => OWNERS.has(value);

// JSON traversal of a rooted graph uses the SAME backing store for suspended
// frames. A deep JSON value must not create a generator/Set/JS-stack entry per
// ancestor in the encoder. These temporary immutable frames are protected by
// an explicit build guard and are reclaimable after completion/cancellation.
// No visible root is changed; a frozen lease still selects its own owner index.
function* historyPagedJsonEvents(root, { stats = {}, assertCurrent = () => {} } = {}) {
  const initial = OWNERS.get(root);
  if (!initial) throw failure('history_cursor_required');
  const { store, assert } = initial;
  const endBuild = store.beginBuild();
  const state = cursor => {
    const { ref, owners, imported } = OWNERS.get(cursor);
    return { ref, owners, imported };
  };
  const cursorFor = value => new HistoryPagedCursor(store, value.ref, assert, value.owners, value.imported);
  const save = frame => store.transaction(() => store.put(frame,
    [frame.parent, isRef(frame.ref) ? frame.ref.id : 0, frame.owners?.page, frame.imported?.page]));
  let stack = 0, pending = state(root), depth = 0;
  try {
    while (pending || stack) {
      assert(); assertCurrent();
      if (pending) {
        const cursor = cursorFor(pending); pending = null;
        const kind = cursor.kind;
        stats.maxDepth = Math.max(stats.maxDepth || 0, depth);
        if (kind === 'text') { yield { text: cursor }; continue; }
        if (['scalar', 'scalar-root', 'number', 'bigint', 'undefined'].includes(kind)) {
          yield { scalar: cursor.scalar() }; continue;
        }
        const current = state(cursor);
        // Exact cycle detection by walking page-backed ancestry. No digest or
        // bounded hash table may replace an identity comparison here.
        for (let at = stack; at;) {
          const frame = store.json(at);
          if (isRef(current.ref) && isRef(frame.ref) && current.ref.id === frame.ref.id) {
            throw new TypeError('Converting circular structure to JSON');
          }
          at = frame.parent;
        }
        stack = save({ ...current, parent: stack, depth, index: 0,
          phase: kind === 'array' ? 'items' : 'numeric', any: false });
        stats.maxResidentTraversalFrames = Math.max(stats.maxResidentTraversalFrames || 0, 1);
        yield kind === 'array' ? '[' : '{';
        continue;
      }
      const frame = store.json(stack), cursor = cursorFor(frame), kind = cursor.kind;
      const meta = store.json(OWNERS.get(cursor).ref.id);
      if (kind === 'array') {
        if (frame.index >= meta.length) { stack = frame.parent; yield ']'; continue; }
        const item = cursor.at(frame.index++), comma = frame.any;
        frame.any = true; stack = save(frame);
        if (comma) yield ',';
        if (item.kind === 'undefined') yield 'null';
        else { pending = state(item); depth = frame.depth + 1; }
        continue;
      }
      let field = null;
      for (;;) {
        if (frame.phase === 'numeric') {
          const next = meta.numeric && store.vectorPresent(meta.numeric, frame.index).next();
          if (!next || next.done) { frame.phase = 'fields'; frame.index = 0; continue; }
          frame.index = next.value.ordinal + 1;
          field = store.json(next.value.page);
        } else {
          if (frame.index >= meta.fields.length) break;
          field = store.json(store.vectorGet(meta.fields, frame.index++));
          if (field.propertyIndex !== null && field.propertyIndex !== undefined) continue;
        }
        if (field.deleted) continue;
        const item = new HistoryPagedCursor(store, field.value, assert, frame.owners, frame.imported);
        if (item.kind === 'undefined') continue;
        const comma = frame.any; frame.any = true; stack = save(frame);
        if (comma) yield ',';
        yield { text: new HistoryPagedCursor(store, field.key, assert, frame.owners, frame.imported) };
        yield ':'; pending = state(item); depth = frame.depth + 1;
        break;
      }
      if (!pending) { stack = frame.parent; yield '}'; }
    }
  } finally { endBuild(); }
}

module.exports = { HistoryPagedStore, HistoryPagedCursor, isHistoryPagedCursor, historyPagedJsonEvents };
