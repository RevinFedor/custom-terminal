'use strict';

// Mutable logical identities over the EXISTING immutable page store. A handle
// owns only (arena,id); its empty target is never a decoded DTO cache. Published
// readers use HistoryPagedCursor, never these reducer-internal handles.
const HANDLE = new WeakMap();
const text = require('./history-paged-text');
const { isHistoryPagedCursor } = require('./history-paged-store');
const NONE = Object.freeze({ type: 'undefined' });
const vector = () => ({ page: 0, depth: 0, length: 0 });
const logical = id => ({ type: 'owner', id });
const page = id => ({ type: 'page', id });
const fail = code => Object.assign(new Error(code), { code });
const indexOf = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)
  && Number(key) < 0xffffffff ? Number(key) : -1;

class HistoryProjectionArena {
  constructor(store, checkpoint = null) {
    if (!store || typeof store.vectorSet !== 'function' || store.closed) throw fail('history_root_owner_required');
    this.store = store;
    this.closed = false;
    this.inStep = false;
    this.stepLeases = null;
    this.inputIdentities = new Map(); // ONE feed/one finalizer step; cleared synchronously.
    this.handles = new Map(); // A bounded identity convenience, not an owner index.
    this.metrics = { boundaries: 0, peakInputObjects: 0, peakHandleCache: 0,
      peakImportedStringChars: 0, peakStepLeases: 0, finalizerSteps: 0 };
    if (checkpoint) {
      this.pin = store.open(checkpoint.descriptor || checkpoint);
      const root = store.json(this.pin.descriptor.page);
      if (root.kind !== 'owner-root' || root.root.type !== 'owner') { this.pin.release(); throw fail('history_projection_checkpoint'); }
      this.owners = root.owners;
      this.imported = root.imported || vector();
      this.nextId = root.nextId;
      this.stateId = root.root.id;
    } else {
      this.owners = vector(); this.imported=vector(); this.nextId = 0; this.stateId = 0; this.pin = null;
      this.step(() => { this.stateId = this.allocate('object'); });
    }
  }
  assertOpen() { this.store.assertOpen(); if (this.closed) throw fail('history_projection_closed'); }
  state() { this.assertOpen(); return this.handle(this.stateId); }
  owner(value) {
    const h = HANDLE.get(value);
    return h?.arena === this ? h.id : null;
  }
  same(a, b) {
    if (a === b) return true;
    if (text.isText(a) && text.isText(b)) return text.equal(a,b);
    const x = HANDLE.get(a), y = HANDLE.get(b);
    return !!(x && y && x.arena === y.arena && x.id === y.id);
  }
  step(fn) {
    this.assertOpen();
    if (this.inStep) return fn();
    const before = { owners: this.owners, imported:this.imported, nextId: this.nextId, stateId: this.stateId, pin: this.pin };
    const endBuild = this.store.beginBuild();
    this.inStep = true;
    this.stepLeases = [];
    this.inputIdentities.clear();
    let next;
    try {
      const value = this.store.transaction(() => {
        const result = fn();
        if (result?.then) throw fail('history_projection_async_mutation');
        next = this.publishRef(logical(this.stateId));
        return result;
      });
      this.pin = next;
      before.pin?.release();
      this.metrics.boundaries++;
      return value;
    } catch (error) {
      // SQL rollback and the JS root pointer roll back together. Published
      // leases never refer to this staged root before successful publication.
      for (const lease of this.stepLeases) lease.release();
      this.owners = before.owners; this.imported=before.imported; this.nextId = before.nextId; this.stateId = before.stateId;
      this.pin = before.pin; this.handles.clear();
      throw error;
    } finally {
      this.inputIdentities.clear(); this.stepLeases = null; this.inStep = false; endBuild();
    }
  }
  requireStep() { this.assertOpen(); if (!this.inStep) throw fail('history_projection_write_outside_step'); }
  allocate(kind) {
    this.requireStep();
    const id = this.nextId++;
    const meta = this.store.container(kind);
    if (kind === 'map' || kind === 'set') { meta.lookup = vector(); meta.size = 0; meta.logicalMap = true; }
    this.writeNode(id, meta);
    return id;
  }
  make(kind) { return this.handle(this.allocate(kind)); }
  own(value) { return this.decode(this.encode(value)); }
  assign(...sources) {
    this.requireStep();
    const target=this.make('object'), id=this.owner(target);
    for(const source of sources) {
      const sourceId=this.owner(source);
      if(sourceId===null) {
        if(source!=null)for(const key in source)if(Object.hasOwn(source,key))this.set(id,key,source[key]);
        continue;
      }
      const meta=this.node(sourceId), out=this.node(id);
      // Copy references, one property at a time. Object.assign/spread over a
      // wide paged object would otherwise force ownKeys() to return a native
      // array and materialize every long property name before this copy.
      if(meta.kind==='array')for(const {ordinal,page:at} of this.store.vectorPresent(meta.items)) {
        if(ordinal<meta.length)this.store.setField(out,String(ordinal),this.store.json(at).value);
      }
      for(const at of this.store.vectorValues(meta.fields)) {
        const field=this.store.json(at);
        if(!field.deleted)this.store.setField(out,field.key,field.value);
      }
      this.writeNode(id,out);
    }
    return target;
  }
  encode(value) {
    this.requireStep();
    if (text.isPagedText(value)) {
      const data=text.info(value);
      if(data.arena.store!==this.store)throw fail('history_projection_foreign_text');
      return data.ref;
    }
    if (isHistoryPagedCursor(value)) return this.store.referenceForCursor(value);
    const handle = HANDLE.get(value);
    if (handle) {
      if (handle.arena !== this && (handle.arena.store !== this.store
        || this.store.vectorGet(this.owners,handle.id) !== this.store.vectorGet(handle.arena.owners,handle.id))) {
        throw fail('history_projection_foreign_mutable_owner');
      }
      return logical(handle.id);
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') this.metrics.peakImportedStringChars = Math.max(this.metrics.peakImportedStringChars, value.length);
      return this.store.scalar(value);
    }
    if (this.inputIdentities.has(value)) return logical(this.inputIdentities.get(value));
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)
      && proto !== Object.prototype && proto !== null) throw fail('history_projection_input_prototype');
    const kind = Array.isArray(value) ? 'array' : value instanceof Map ? 'map' : value instanceof Set ? 'set' : 'object';
    const id = this.allocate(kind);
    this.inputIdentities.set(value, id);
    this.metrics.peakInputObjects = Math.max(this.metrics.peakInputObjects, this.inputIdentities.size);
    if (kind === 'map') for (const [key, item] of value) this.mapSet(id, key, item);
    else if (kind === 'set') for (const key of value) this.mapSet(id, key, key);
    // Import each container with one final owner-index update. The local
    // metadata contains only vector roots, never a decoded children array.
    const meta = this.node(id);
    if (kind === 'array') meta.length = value.length;
    for (const key in value) if (Object.hasOwn(value,key)) {
      const ref = this.encode(value[key]), index = kind === 'array' ? indexOf(key) : -1;
      if (index >= 0) meta.items = this.store.vectorSet(meta.items,index,
        this.store.put({ value:ref },[ref.type === 'page' ? ref.id : 0]));
      else this.store.setField(meta,key,ref);
    }
    this.writeNode(id,meta);
    return logical(id);
  }
  decode(ref) {
    if (!ref || ref.type === 'undefined') return undefined;
    if (ref.type === 'owner') return this.handle(ref.id);
    if (ref.type === 'page') {
      const meta=this.store.json(ref.id);
      if(meta.kind==='text')return text.fromRef(this,ref);
      if(meta.kind==='scalar-root')return this.decode(meta.value);
      return this.adopt(ref);
    }
    if (ref.type === 'number') return Number(ref.value);
    if (ref.type === 'bigint') return BigInt(ref.value);
    return ref.value;
  }
  adopt(ref) {
    const at=this.store.vectorGet(this.imported,ref.id);
    if(at)return this.handle(this.store.json(at).owner);
    if(!this.inStep)return this.step(()=>this.adopt(ref));
    const meta=this.store.json(ref.id);
    if(!['object','array'].includes(meta.kind))throw fail('history_projection_import_kind');
    const id=this.nextId++;
    this.writeNode(id,meta);
    this.imported=this.store.vectorSet(this.imported,ref.id,this.store.put({owner:id}));
    return this.handle(id);
  }
  node(id) {
    this.assertOpen();
    const at = this.store.vectorGet(this.owners, id);
    if (!at) throw fail('history_projection_owner_missing');
    return this.store.json(at);
  }
  writeNode(id, meta) {
    this.requireStep();
    const at = this.store.finishContainer(meta).id;
    this.owners = this.store.vectorSet(this.owners, id, at);
  }
  refAt(meta, key) {
    const index = meta.kind === 'array' ? indexOf(key) : -1;
    if (index >= 0) {
      if (index >= meta.length) return null;
      const at = this.store.vectorGet(meta.items, index);
      return at ? this.store.json(at).value : null;
    }
    const at = this.store.fieldOrdinal(meta, key);
    return at < 0 ? null : this.store.json(this.store.vectorGet(meta.fields, at)).value;
  }
  get(id, key) {
    const meta = this.node(id);
    if (key === 'length' && meta.kind === 'array') return meta.length;
    return this.decode(this.refAt(meta, key));
  }
  has(id, key) { return this.refAt(this.node(id), key) !== null; }
  set(id, key, value) {
    this.requireStep();
    let meta = this.node(id);
    if (meta.kind === 'array' && key === 'length') {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Invalid array length');
      if (value === meta.length) return true;
      if (value < meta.length) meta.items = this.store.vectorTruncate(meta.items, value);
      meta.length = value;
      this.writeNode(id, meta); return true;
    }
    const previous = this.refAt(meta, key), existing = HANDLE.get(value);
    if (previous && (existing?.arena === this && previous.type === 'owner' && previous.id === existing.id
      || typeof value === 'string' && previous.type === 'page' && this.store.textEqualsString(previous,value)
      || (value === null || typeof value !== 'object' && typeof value !== 'string')
        && previous.type !== 'owner' && previous.type !== 'page' && Object.is(this.decode(previous),value))) return true;
    const ref = this.encode(value);
    // encode can allocate child owners; re-read the owning node afterwards.
    meta = this.node(id);
    const index = meta.kind === 'array' ? indexOf(key) : -1;
    if (index >= 0) {
      const at = this.store.put({ value: ref }, [ref.type === 'page' ? ref.id : 0]);
      meta.items = this.store.vectorSet(meta.items, index, at);
      meta.length = Math.max(meta.length, index + 1);
    } else this.store.setField(meta, key, ref);
    this.writeNode(id, meta); return true;
  }
  delete(id, key) {
    this.requireStep();
    const meta = this.node(id), index = meta.kind === 'array' ? indexOf(key) : -1;
    if (index >= 0) {
      if (index < meta.items.length) meta.items = this.store.vectorSet(meta.items, index, 0);
    } else this.store.deleteField(meta, key);
    this.writeNode(id, meta); return true;
  }
  *keys(id) {
    const meta = this.node(id);
    if (meta.kind === 'array') {
      for (const item of this.store.vectorPresent(meta.items)) if (item.ordinal < meta.length) yield String(item.ordinal);
    }
    if (meta.numeric) for (const item of this.store.vectorPresent(meta.numeric)) {
      const field = this.store.json(item.page);
      if (!field.deleted) yield this.decode(field.key);
    }
    for (const at of this.store.vectorValues(meta.fields)) {
      const field = this.store.json(at);
      if (!field.deleted && (field.propertyIndex === null || field.propertyIndex === undefined)) yield this.decode(field.key);
    }
  }
  keyHash(key) {
    const id = this.owner(key);
    if (id !== null) key = 'owner:' + id;
    else if (!text.isText(key)) key = typeof key + ':' + String(key === 0 ? 0 : key);
    const digest = this.store.textDigestFactory();
    for (const part of text.chunks(key)) digest.update(Buffer.from(part, 'utf16le'));
    return parseInt(digest.digest('hex').slice(0, 8), 16) >>> 0;
  }
  keyEqual(ref, key) {
    if (ref.type === 'owner') return this.owner(key) === ref.id || this.inputIdentities.get(key) === ref.id;
    if (ref.type === 'page') return text.isPagedText(key) ? this.store.textEqual(ref,text.info(key).ref)
      : typeof key === 'string' && this.store.textEqualsString(ref, key);
    const value = this.decode(ref);
    return value === key || (Number.isNaN(value) && Number.isNaN(key));
  }
  findMap(id, key) {
    const meta = this.node(id);
    const normalized = key && typeof key === 'object' && this.inputIdentities.has(key)
      ? this.handle(this.inputIdentities.get(key)) : key;
    let at = this.store.vectorGet(meta.lookup, this.keyHash(normalized));
    while (at) {
      const link = this.store.json(at);
      const value = this.store.json(this.store.vectorGet(meta.items, link.ordinal));
      if (!value.deleted && this.keyEqual(value.key, normalized)) return { ordinal: link.ordinal, value };
      at = link.next;
    }
    return null;
  }
  mapSet(id, key, value) {
    this.requireStep();
    const keyRef = this.encode(key), valueRef = this.encode(value);
    const normalized = keyRef.type === 'owner' ? this.handle(keyRef.id) : key;
    const found = this.findMap(id, normalized), meta = this.node(id);
    const ordinal = found ? found.ordinal : meta.items.length;
    const at = this.store.put({ key: keyRef, value: valueRef },
      [keyRef.type === 'page' ? keyRef.id : 0, valueRef.type === 'page' ? valueRef.id : 0]);
    meta.items = this.store.vectorSet(meta.items, ordinal, at);
    if (!found) {
      const hash = this.keyHash(normalized);
      const next = this.store.vectorGet(meta.lookup, hash);
      const link = this.store.put({ ordinal, next }, [next]);
      meta.lookup = this.store.vectorSet(meta.lookup, hash, link);
      meta.size++;
    }
    this.writeNode(id, meta); return this.handle(id);
  }
  mapDelete(id, key) {
    this.requireStep();
    const found = this.findMap(id, key);
    if (!found) return false;
    const meta = this.node(id);
    const at = this.store.put({ ...found.value, deleted: true },
      [found.value.key.type === 'page' ? found.value.key.id : 0]);
    meta.items = this.store.vectorSet(meta.items, found.ordinal, at); meta.size--;
    this.writeNode(id, meta); return true;
  }
  *mapEntries(id) {
    // The ordinal index, including tombstones, is on pages. A suspended
    // iterator retains one entry and integer position, never all pending calls.
    for (let i = 0; i < this.node(id).items.length; i++) {
      const meta = this.node(id), at = this.store.vectorGet(meta.items, i);
      const item = this.store.json(at);
      if (!item.deleted) yield [this.decode(item.key), this.decode(item.value)];
    }
  }
  arrayMethod(id, name, args) {
    const self = this.handle(id), length = self.length;
    if(name==='join')return text.arrayJoin(this,self,args[0]===undefined?',':text.coerce(args[0]));
    if (['includes', 'indexOf', 'lastIndexOf'].includes(name)) {
      let at = args.length > 1 ? Number(args[1]) || 0 : name === 'lastIndexOf' ? length - 1 : 0;
      if (at < 0) at = Math.max(0, length + at);
      for (let i = Math.min(at, length - (name === 'lastIndexOf' ? 1 : 0)); i >= 0 && i < length; i += name === 'lastIndexOf' ? -1 : 1) {
        if (this.same(self[i], args[0]) || (name === 'includes' && Number.isNaN(self[i]) && Number.isNaN(args[0]))) return name === 'includes' ? true : i;
      }
      return name === 'includes' ? false : -1;
    }
    this.requireStep();
    if (name === 'push') { for (const value of args) self[self.length] = value; return self.length; }
    if (name === 'pop') { if (!length) return undefined; const value = self[length - 1]; self.length--; return value; }
    if (name === 'splice') {
      const rawStart = Number(args[0]) || 0;
      const start = Math.max(0, Math.min(length, rawStart < 0 ? length + rawStart : rawStart));
      const count = args.length < 2 ? length - start : Math.max(0, Math.min(length - start, Number(args[1]) || 0));
      const inserts = args.slice(2), removed = this.make('array');
      removed.length = count;
      for (let i = 0; i < count; i++) if (start + i in self) removed[i] = self[start + i];
      const shift = inserts.length - count;
      if (shift > 0) for (let i = length - 1; i >= start + count; i--) {
        if (i in self) self[i + shift] = self[i]; else delete self[i + shift];
      }
      else if (shift < 0) for (let i = start + count; i < length; i++) {
        if (i in self) self[i + shift] = self[i]; else delete self[i + shift];
      }
      for (let i = 0; i < inserts.length; i++) self[start + i] = inserts[i];
      self.length = length + shift; return removed;
    }
    const out = this.make('array');
    if (name === 'map' || name === 'filter') {
      if (name === 'map') out.length = length;
      for (let i = 0; i < length; i++) if (i in self) {
        const value = args[0].call(args[1], self[i], i, self);
        if (name === 'map') out[i] = value; else if (value) out.push(self[i]);
      }
    } else if (name === 'slice') {
      const norm = (x, fallback) => x === undefined ? fallback : Math.max(0, Math.min(length, x < 0 ? length + Number(x) : Number(x)));
      const from = norm(args[0], 0), to = norm(args[1], length);
      out.length = Math.max(0, to - from);
      for (let i = from; i < to; i++) if (i in self) out[i - from] = self[i];
    } else if (name === 'concat') {
      for (const item of [self, ...args]) {
        if (!Array.isArray(item)) out.push(item);
        else { const offset = out.length; out.length += item.length; for (let i = 0; i < item.length; i++) if (i in item) out[offset + i] = item[i]; }
      }
    }
    return out;
  }
  handle(id) {
    this.assertOpen();
    if (this.handles.has(id)) return this.handles.get(id);
    const kind = this.node(id).kind;
    const target = kind === 'array' ? [] : kind === 'map' ? new Map() : kind === 'set' ? new Set() : {};
    const arena = this;
    const arrayMethods = ['push','pop','splice','map','filter','slice','concat','includes','indexOf','lastIndexOf','join'];
    const handle = new Proxy(target, {
      get(_target, key, receiver) {
        if ((kind === 'map' || kind === 'set')) {
          if (key === 'size') return arena.node(id).size;
          if (key === 'get') return k => arena.decode(arena.findMap(id, k)?.value.value);
          if (key === 'has') return k => !!arena.findMap(id, k);
          if (key === 'set') return (k, v) => arena.mapSet(id, k, v);
          if (key === 'add') return k => arena.mapSet(id, k, k);
          if (key === 'delete') return k => arena.mapDelete(id, k);
          if (key === 'clear') return () => { const m = arena.node(id); m.items = vector(); m.lookup = vector(); m.size = 0; arena.writeNode(id, m); };
          if (key === 'entries' || key === Symbol.iterator && kind === 'map') return () => arena.mapEntries(id);
          if (key === 'keys' || key === 'values' || key === Symbol.iterator && kind === 'set') return function* () {
            for (const pair of arena.mapEntries(id)) yield key === 'keys' || kind === 'set' ? pair[0] : pair[1];
          };
          if (key === 'forEach') return (fn, self) => { for (const [k,v] of arena.mapEntries(id)) fn.call(self,v,k,receiver); };
        }
        if (kind === 'array' && arrayMethods.includes(key)
          && !(key==='join'&&arena.has(id,key))) return (...args) => arena.arrayMethod(id, key, args);
        if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
        const meta = arena.node(id);
        if (key === 'length' && kind === 'array') return meta.length;
        const ref = arena.refAt(meta,key);
        if (ref !== null) return arena.decode(ref);
        if(kind==='array'&&key==='toString')return ()=>arena.has(id,'join')?'[object Array]'
          : text.materialize(text.arrayJoin(arena,receiver,','),'array-toString');
        return Reflect.get(target, key, receiver);
      },
      set(_target, key, value) { if (typeof key !== 'string') throw fail('history_projection_symbol_field'); return arena.set(id,key,value); },
      deleteProperty(_target, key) { return arena.delete(id,key); },
      has(_target, key) { return typeof key === 'string' && arena.has(id,key) || Reflect.has(target,key); },
      ownKeys() {
        // Native Object.keys/spread is a remaining semantic boundary for wide
        // objects. Record it instead of disguising its allocation as a cache.
        const keys=[];
        for(const key of arena.keys(id))keys.push(text.isPagedText(key)?text.materialize(key,'property-key'):key);
        arena.metrics.maxOwnKeyArray=Math.max(arena.metrics.maxOwnKeyArray || 0,keys.length);
        if(kind==='array')keys.push('length');return keys;
      },
      getOwnPropertyDescriptor(_target, key) {
        if (kind === 'array' && key === 'length') return { value: arena.node(id).length, writable: true, enumerable: false, configurable: false };
        if (typeof key !== 'string' || !arena.has(id,key)) return undefined;
        return { value: arena.get(id,key), writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_target, key, descriptor) {
        if (!('value' in descriptor) || descriptor.get || descriptor.set) throw fail('history_projection_accessor');
        return arena.set(id,key,descriptor.value);
      },
    });
    HANDLE.set(handle, { arena, id, target });
    // Handles held in the reducer's fixed registers remain valid after cache
    // eviction. No handle has a row, args, record or decoded children attached.
    while (this.handles.size >= 3) this.handles.delete(this.handles.keys().next().value);
    this.handles.set(id,handle);
    this.metrics.peakHandleCache = Math.max(this.metrics.peakHandleCache,this.handles.size);
    return handle;
  }
  publishRef(ref) {
    const at = this.store.put({ kind: 'owner-root', owners: this.owners, imported:this.imported, nextId: this.nextId, root: ref },
      [this.owners.page,this.imported.page,ref.type === 'page' ? ref.id : 0]);
    const lease = this.store.lease(page(at));
    if (this.stepLeases) {
      this.stepLeases.push(lease);
      this.metrics.peakStepLeases = Math.max(this.metrics.peakStepLeases,this.stepLeases.length);
    }
    return lease;
  }
  publish(value = this.state()) {
    this.requireStep(); return this.publishRef(this.encode(value));
  }
  checkpoint() { this.assertOpen(); if (this.inStep) throw fail('history_projection_checkpoint_inside_step'); return this.pin.fork(); }
  fork() { const pin = this.checkpoint(); try { return new HistoryProjectionArena(this.store,pin); } finally { pin.release(); } }
  inspectOwnership() {
    // Inspect actual native backing targets, not a claimed zero supplied by
    // the caller. Fixed reducer registers point at the same empty targets.
    let nativeRows = 0, nativeMapEntries = 0, nativeOwnFields = 0;
    for (const handle of this.handles.values()) {
      const target = HANDLE.get(handle).target;
      if (Array.isArray(target)) nativeRows += target.length;
      if (target instanceof Map || target instanceof Set) nativeMapEntries += target.size;
      nativeOwnFields += Reflect.ownKeys(target).filter(key => key !== 'length').length;
    }
    return { nativeRows,nativeMapEntries,nativeOwnFields,
      inputIdentitySlots: this.inputIdentities.size,handleCache: this.handles.size,
      pageCache: this.store.cache.size,indexBytes: this.store.cacheBytes };
  }
  stats() {
    return { ...this.metrics, inputIdentitySlots: this.inputIdentities.size, handleCache: this.handles.size,
      ownerCountOnDisk: this.nextId, ownerIndexDepth: this.owners.depth,
      ownership: this.inspectOwnership(),
      largeLeafTransientBounded: false, nativeMemoryMeasured: false, store: this.store.stats() };
  }
  close() { if (this.closed) return; this.pin?.release(); this.handles.clear(); this.inputIdentities.clear(); this.closed = true; }
}

module.exports = { HistoryProjectionArena, projectionArenaOf: value => HANDLE.get(value)?.arena || null };
