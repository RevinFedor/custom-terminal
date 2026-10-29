'use strict';

// A catalog owns the original thin prepared subtree, its paged join/fold and
// one native continuation. Native CURRENT values never cross as body copies:
// the renderer evaluates requested operations against its original objects,
// and selected fields return as opaque slot references under that same demand.
const { CatalogWork, CatalogArena } = require('./history-agent-catalog-work');
const { historyPagedCursorAddress } = require('./history-paged-store');
const text = require('./history-paged-text');
const { preparedPresentationBinding } = require('./history-primary-prepared-presentation');

const PROFILE = 'history-agent-catalog-v1';
const ENCODING = 'history-primary-agent-catalog-v1';
const STEP = 'primary-agent-catalog-step';
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const eq = (a, b) => text.isText(a) && text.isText(b) ? text.equal(a, b) : a === b;
class CatalogText { constructor(value) { this.value = value; } }
class NativeValue {
  constructor(meta) { this.meta = Object.freeze({ ...meta }); Object.freeze(this); }
}
const native = value => value instanceof NativeValue;
const truth = value => native(value) ? value.meta.truthy : !!value;
const nil = value => value === null || value === undefined;
function decodeNative(value) {
  if (value instanceof CatalogText) return value.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('HISTORY_AGENT_NATIVE_VALUE');
  if (value.type === 'native') {
    if (!integer(value.slot) || !['object','function','symbol','string'].includes(value.valueType)
      || typeof value.array !== 'boolean' || typeof value.truthy !== 'boolean'
      || value.valueType !== 'string' && value.truthy !== true
      || value.valueType !== 'object' && value.array) throw fail('HISTORY_AGENT_NATIVE_VALUE');
    return new NativeValue(value);
  }
  if (value.type === 'undefined') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'string' && typeof value.value === 'string') return value.value;
  if (value.type === 'boolean' && typeof value.value === 'boolean') return value.value;
  if (value.type === 'bigint' && typeof value.value === 'string') return BigInt(value.value);
  if (value.type === 'number' && (typeof value.value === 'number'
    || ['-0','NaN','Infinity','-Infinity'].includes(value.value))) return Number(value.value);
  throw fail('HISTORY_AGENT_NATIVE_VALUE');
}
const nativeSlot = slot => new NativeValue({ type: 'native', slot, valueType: 'object', array: false, truthy: true });

function sourceArena(store, source) {
  if (source.kind !== 'array') throw fail('HISTORY_AGENT_CATALOG_SOURCE');
  const address = historyPagedCursorAddress(source);
  if (!address.owners) return { arena: new CatalogArena(store), inherited: false };
  // Prepared metadata is a logical subtree of an immutable owner snapshot.
  // Importing its reference into a fresh unrelated owner index is invalid.
  // Retain that exact index and add one logical root for the selected subtree;
  // no compiler/view/model closure and no decoded row collection is retained.
  const endBuild = store.beginBuild(); let pin;
  try {
    pin = store.transaction(() => {
      // Keep the existing store/lease authentication even though this path
      // adopts the logical owner index directly rather than importing data.
      store.referenceForCursor(source);
      const id = address.owners.length;
      const owners = store.vectorSet(address.owners, id, address.ref.id);
      const page = store.put({ kind: 'owner-root', owners, imported: address.imported,
        nextId: id + 1, root: { type: 'owner', id } }, [owners.page, address.imported?.page || 0, address.ref.id]);
      return store.lease({ type: 'page', id: page });
    });
    return { arena: new CatalogArena(store, pin), inherited: true };
  } finally { pin?.release(); endBuild(); }
}

class HistoryAgentCatalog extends CatalogWork {
  constructor(store, source, current, binding, requestId) {
    super();
    this.store = store; this.binding = Object.freeze({ ...binding }); this.requestId = requestId;
    this.sequence = 0; this.phase = 'native'; this.pending = null; this.closed = false; this.finished = false;
    this.metrics = { sourceRows: 0, joinedRows: 0, historicalActions: 0, nativeRequests: 0, sortPasses: 0,
      bodyCopies: 0, nativeHistoricalRegistry: 0, checkpoints: 0, workUnits: 0, workSinceYield: 0, maxWorkBetweenYields: 0, normalizationNodes: 0 };
    const retained = sourceArena(store, source); this.arena = retained.arena;
    try {
      this.arena.step(() => {
        const original = retained.inherited ? this.arena.state() : this.arena.own(source);
        if (retained.inherited) this.arena.stateId = this.arena.allocate('object');
        const s = this.arena.state();
        s.source = original; s.current = null;
        s.work = this.arena.make('object'); s.sections = this.arena.make('object');
      });
      this.pin = this.arena.checkpoint(); this.inputCurrent = current; this.machine = this.initialize();
    } catch (error) { this.arena.close(); throw error; }
  }
  assertOpen() { if (this.closed) throw fail('HISTORY_AGENT_CATALOG_CLOSED'); this.arena.assertOpen(); }
  array() { return this.arena.step(() => this.arena.make('array')); }
  map() { return this.arena.step(() => this.arena.make('map')); }
  set() { return this.arena.step(() => this.arena.make('set')); }
  push(array, value) { this.arena.step(() => array.push(value)); }


  record(fields) { return this.arena.step(() => this.arena.record(fields)); }
  own(value) { return this.arena.step(() => this.arena.own(value)); }
  *initialize() {
    this.metrics.stage='thin-normalization';yield* this.normalizeThin(this.arena.state().source);
    this.metrics.stage='recipe-import';
    this.arena.state().current = yield* this.importNative(this.inputCurrent);
    this.inputCurrent = null;
    return yield* this.run();
  }
  *checkpoint() {
    this.metrics.maxWorkBetweenYields = Math.max(this.metrics.maxWorkBetweenYields, this.metrics.workSinceYield);
    this.metrics.workSinceYield = 0; this.metrics.checkpoints++; yield null;
  }
  *ask(kind, fields = {}) {
    yield* this.work('native-request');
    this.metrics.nativeRequests++;
    return decodeNative(yield { kind, ...fields });
  }
  *get(value, key) {
    if (native(value)) return yield* this.ask('property', { slot: value.meta.slot, key });
    // Literal property access throws for undefined/null, including deliberately
    // sparse/undefined actionSummary members. Do not silently optional-chain.
    return value[key];
  }
  *has(value, key) {
    if (native(value)) return yield* this.ask('has', { slot: value.meta.slot, key });
    return key in value;
  }
  *string(value, hint = 'string') {
    if (native(value)) {
      if (hint === 'template' && value.meta.valueType === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
      const primitive = yield* this.ask('coerce', { slot: value.meta.slot, hint: hint === 'template' ? 'string' : hint });
      if (native(primitive)) {
        if (primitive.meta.valueType === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        throw fail('HISTORY_AGENT_NATIVE_COERCION');
      }
      return text.coerce(primitive);
    }
    const primitive = yield* this.primitive(value, hint === 'default' ? 'number' : 'string');
    return text.isText(primitive) ? primitive : String(primitive);
  }
  *number(value) {
    if (native(value)) return yield* this.ask('coerce', { slot: value.meta.slot, hint: 'number' });
    return yield* this.numeric(value);
  }
  *equal(left, right) {
    if (!native(left) && !native(right)) return yield* this.sameValue(left, right);
    if (native(left) && native(right) && left.meta.slot === right.meta.slot) return true;
    const selected = native(left) ? left : right, other = native(left) ? right : left;
    let encoded;
    if (native(other)) encoded = other.meta;
    else if (other === undefined) encoded = {type:'undefined'};
    else if (other === null) encoded = {type:'null'};
    else if (text.isText(other)) encoded = {type:'string',value:text.isPagedText(other) ? yield* this.materialize(other) : other};
    else if (typeof other === 'object' || typeof other === 'function') return false;
    else if (typeof other === 'number') encoded = {type:'number',value:Object.is(other,-0)?'-0':Number.isFinite(other)?other:String(other)};
    else if (typeof other === 'bigint') encoded = {type:'bigint',value:String(other)};
    else encoded = {type:typeof other,value:other};
    return yield* this.ask('strict-equal',{slot:selected.meta.slot,value:encoded});
  }
  *subtract(value, right) {
    if (native(value)) return yield* this.ask('subtract',{slot:value.meta.slot,right});
    const primitive=yield* this.primitive(value,'number');
    return (text.isText(primitive)?yield* this.numeric(primitive):primitive)-right;
  }
  *date(value) {
    if (native(value)) return yield* this.ask('date', { slot: value.meta.slot });
    return yield* this.parseDate(value);
  }
  *iter(value) {
    if (native(value)) {
      const iterator = yield* this.ask('iterator', { slot: value.meta.slot });
      if (!native(iterator)) throw fail('HISTORY_AGENT_NATIVE_ITERATOR');
      for (;;) {yield* this.work('loop');
        const item = yield* this.ask('next', { slot: iterator.meta.slot });
        const done = yield* this.get(item, 'done');
        if (truth(done)) break;
        yield { value: yield* this.get(item, 'value') };
      }
      return;
    }
    for (const item of value) {yield* this.work('loop');yield { value: item };}
  }
  // Iteration with a callback is a generator so a native iterator's next/get
  // operations retain their literal order across bounded continuations.
  *each(value, fn, method) {
    if (native(value)) {
      const iterator = yield* this.ask('iterator', { slot: value.meta.slot, ...(method ? { method } : {}) });
      if (!native(iterator)) throw fail('HISTORY_AGENT_NATIVE_ITERATOR');
      for (;;) {yield* this.work('loop');
        const next = yield* this.ask('next', { slot: iterator.meta.slot });
        if (truth(yield* this.get(next, 'done'))) return;
        yield* fn.call(this, yield* this.get(next, 'value'));
      }
    } else for (const item of value) {yield* this.work('loop');yield* fn.call(this, item);}
  }
  *mapGet(slot, key) {
    if (slot === null || slot === undefined) return undefined;
    return yield* this.ask('map-get', { slot, key: native(key) ? key.meta : text.isPagedText(key) ? yield* this.materialize(key) : key });
  }
  *setHas(slot, key) {
    if (slot === null || slot === undefined) return false;
    return yield* this.ask('set-has', { slot, key: native(key) ? key.meta : text.isPagedText(key) ? yield* this.materialize(key) : key });
  }
  rowValue(row) { return row.origin === 'native' ? nativeSlot(row.slot) : row.value; }
  rowSlot(row) { return row.origin === 'native' ? row.slot : null; }
  *identities(row) {
    const out = this.array(), value = this.rowValue(row);
    if (row.origin === 'native') {
      const ids = yield* this.ask('identities', { rowSlot: row.slot });
      yield* this.each(ids, function* (id) { this.push(out, yield* this.string(id)); });
      return out;
    }
    const self=this;
    function* append(id){if(!id)return;for(const old of out){yield* self.work('alias-dedup');if(yield* self.sameValue(old,id))return;}self.push(out,id);}
    const source = yield* this.string(value.sourceIdentity || ''); if (source) this.push(out, source);
    for (const alias of Array.isArray(value.sourceIdentityAliases) ? value.sourceIdentityAliases : []) {yield* this.work('loop');
      const normalized = yield* this.string(alias || ''); yield* append(normalized);
    }
    const role = value.role, uuid = value.uuid;
    if ((yield* this.sameValue(role, 'queued')) && !(yield* this.string(uuid || '')).startsWith('local-prompt-')) {
      // Existing primary thin rows normally have no queue body. Preserve the
      // legacy queue identity grammar if a genuine pre-stubbed row carries it.
      if (source.startsWith('claude-queue:')) yield* append(source);
      else {
        const content=value.content,parts=this.array();
        if(text.isText(content))this.push(parts,content);
        else if(Array.isArray(content))for(const item of content){
          yield* this.work('queue-content');
          const part=text.isText(item)?item:item&&typeof item==='object'&&!Array.isArray(item)
            &&(yield* this.sameValue(item.type,'text'))&&text.isText(item.text)?item.text:'';
          if(part)this.push(parts,part);
        } else if(content&&typeof content==='object'&&text.isText(content.text))this.push(parts,content.text);
        const raw=yield* this.concat(parts,'\n'), hash=yield* this.queueHash(raw);
        const timestamp=yield* this.string(value.timestamp||'');
        if(hash!==null&&timestamp)yield* append(yield* this.concat(['claude-queue:',yield* this.string(value.sessionId||''),':',timestamp,':',hash.toString(16).padStart(8,'0')]));
      }
    }
    if ((yield* this.sameValue(role, 'assistant')) && uuid) this.push(out, (yield* this.concat(['assistant-uuid:', yield* this.string(uuid)], '', this.arena)));
    if ((yield* this.sameValue(role, 'user')) && uuid) this.push(out, (yield* this.concat(['user-uuid:', yield* this.string(uuid)], '', this.arena)));
    if ((yield* this.sameValue(role, 'slash')) && uuid) this.push(out, (yield* this.concat(['slash-uuid:', yield* this.string(value.sessionId || ''), ':', yield* this.string(uuid)], '', this.arena)));
    if (((yield* this.sameValue(role, 'provider-error')) || (yield* this.sameValue(role, 'usage-limit'))) && uuid)
      this.push(out, (yield* this.concat([role, '-uuid:', yield* this.string(value.sessionId || ''), ':', yield* this.string(uuid)], '', this.arena)));
    return out;
  }
  *physical(row) {
    if (row.origin === 'native') {
      const value = yield* this.ask('physical', { rowSlot: row.slot });
      if (nil(value)) return null;
      return this.record({ sessionId: yield* this.string(yield* this.get(value, 'sessionId')),
        offset: yield* this.get(value, 'offset') });
    }
    const rowValue = row.value, sourceIdentity = yield* this.string(rowValue.sourceIdentity || ''),
      sessionId = yield* this.string(rowValue.sessionId || '');
    if (!sessionId) return null;
    const offset = yield* this.number(rowValue.recordByteOffset);
    if (Number.isSafeInteger(offset) && offset >= 0) return this.record({ sessionId, offset });
    if (!sourceIdentity.startsWith('codex-')) return null;
    const marker = (yield* this.concat(['-source-', sessionId, '-'], '', this.arena));
    let at = -1, from = 0;
    for (;;) {yield* this.work('loop'); const next = (yield* this.indexOf(sourceIdentity, marker, from)); if (next < 0) break; at = next; from = next + 1; }
    if (at < 0) return null;
    const raw = (yield* this.slice(sourceIdentity, at + marker.length));
    if (!raw.length) return null;
    for(const part of text.chunks(raw))for(let at=0;at<part.length;at+=128){yield* this.work('physical-number-window');if(!/^\d+$/.test(part.slice(at,at+128)))return null;}
    const number = yield* this.numeric(raw);
    return Number.isSafeInteger(number) && number >= 0 ? this.record({ sessionId, offset: number }) : null;
  }
  *deferred(row) {
    if (row.origin === 'native') return yield* this.ask('deferred', { rowSlot: row.slot });
    const e = row.value;
    return (yield* this.sameValue(e.role, 'queued')) && !(yield* this.sameValue(e.queueStatus, 'failed')) && !(yield* this.sameValue(e.queueStatus, 'cancelled'))
      && ((yield* this.sameValue(e.queueStatus, 'application-queued')) || (yield* this.sameValue(e.queueStatus, 'queued'))
        || (yield* this.sameValue(e.statusAtSend, 'busy')) && !(yield* this.sameValue(e.queueStatus, 'sent'))
        || (e.statusAtSend == null || (yield* this.sameValue(e.statusAtSend, 'unknown')))
          && ['preparing','sending','audit-pending','delivery-unknown'].some(s => eq(e.queueStatus, s)));
  }
  *setting(row) {
    if (row.origin === 'native') return yield* this.ask('setting', { rowSlot: row.slot });
    const e = row.value, fact = e?.settingsFact;
    return (yield* this.sameValue(e?.role, 'slash')) && fact?.version === 1 && (yield* this.sameValue(fact.provider, 'codex'))
      && ((yield* this.sameValue(fact.kind, 'model')) || (yield* this.sameValue(fact.kind, 'effort'))) && text.isText(fact.value) && fact.value ? fact : null;
  }
  *sort(values, compare) {
    let source = values;
    for (let width = 1; width < source.length; width *= 2) {yield* this.work('loop');
      const result = this.array(); this.metrics.sortPasses++;
      for (let from = 0; from < source.length; from += width * 2) {yield* this.work('loop');
        let left = from, right = Math.min(source.length, from + width),
          middle = right, end = Math.min(source.length, from + width * 2);
        while (left < middle || right < end) {yield* this.work('loop');
          if (right >= end || left < middle && !(compare(source[left], source[right]) > 0)) this.push(result, source[left++]);
          else this.push(result, source[right++]);
          if (result.length % 32 === 0) yield* this.checkpoint();
        }
      }
      source = result;
    }
    return source;
  }
  *joinBase(durable, live) {
    if (live.length === 0) return durable;
    this.metrics.stage='join-aliases';const identities = this.set();
    for (const row of durable) {yield* this.work('loop');for (const id of yield* this.identities(row)) {yield* this.work('loop');yield* this.add(identities, id);}}
    const unmatched = this.array();
    for (const row of live) {yield* this.work('loop');
      const ids = yield* this.identities(row);
      let matched=false;for(const id of ids){yield* this.work('join-alias');if(yield* this.contains(identities,id)){matched=true;break;}}
      if(!matched)this.push(unmatched,row);
    }
    if (!unmatched.length) return durable;
    let firstDeferred = -1;
    for (let i = 0; i < durable.length; i++) {yield* this.work('loop');if (yield* this.deferred(durable[i])) { firstDeferred = i; break; }}
    const deferred = this.array(); let causal = durable;
    if (firstDeferred >= 0) {
      causal = this.array(); for (let i = 0; i < firstDeferred; i++) {yield* this.work('loop');this.push(causal, durable[i]);}
      for (let i = firstDeferred; i < durable.length; i++) {yield* this.work('loop');this.push((yield* this.deferred(durable[i])) ? deferred : causal, durable[i]);}
    }
    let normalized = causal, cursor = 0;
    while (cursor < causal.length) {yield* this.work('loop');
      const first = yield* this.physical(causal[cursor]);
      if (!first) { cursor++; continue; }
      let end = cursor + 1, previous = first.offset, inverted = false;
      while (end < causal.length) {yield* this.work('loop');
        const next = yield* this.physical(causal[end]);
        if (!next || !(yield* this.sameValue(next.sessionId, first.sessionId))) break;
        if (previous > next.offset) inverted = true; previous = next.offset; end++;
      }
      if (inverted) {
        const run = this.array();
        for (let i = cursor; i < end; i++) {yield* this.work('loop');this.push(run, this.record({ entry: causal[i], arrival: i - cursor,
          offset: (yield* this.physical(causal[i])).offset }));}
        if (normalized === causal) { normalized = this.array(); for (const row of causal) {yield* this.work('loop');this.push(normalized, row);} }
        const sorted = yield* this.sort(run, (a, b) => a.offset - b.offset || a.arrival - b.arrival);
        for (let i = 0; i < sorted.length; i++) {yield* this.work('loop');this.arena.step(() => { normalized[cursor + i] = sorted[i].entry; });}
      }
      cursor = end;
    }
    causal = normalized;
    this.metrics.stage='join-anchors';const anchorsBySession = this.map();
    for (let i = 0; i < causal.length; i++) {yield* this.work('loop');
      const position = yield* this.physical(causal[i]); if (!position) continue;
      const anchors = (yield* this.lookup(anchorsBySession,position.sessionId)) || this.array();
      this.push(anchors, this.record({ index: i, offset: position.offset })); yield* this.put(anchorsBySession, position.sessionId, anchors);
    }
    this.metrics.stage='join-insertions';const insertions = this.map(), remaining = this.array();
    for (let i = 0; i < unmatched.length; i++) {yield* this.work('loop');
      const row = unmatched[i], position = yield* this.physical(row), anchors = position ? (yield* this.lookup(anchorsBySession,position.sessionId)) : null;
      if (!position || !anchors?.length) { this.push(remaining, row); continue; }
      let low = 0, high = anchors.length;
      while (low < high) {yield* this.work('loop'); const middle = Math.floor((low + high) / 2); if (anchors[middle].offset > position.offset) high = middle; else low = middle + 1; }
      const target = low < anchors.length ? anchors[low].index : causal.length, bucket = (yield* this.lookup(insertions,target)) || this.array();
      this.push(bucket, this.record({ entry: row, offset: position.offset, arrival: i })); yield* this.put(insertions, target, bucket);
    }
    for (const [key, bucket] of insertions) {yield* this.work('loop');yield* this.put(insertions, key, yield* this.sort(bucket, (a, b) => a.offset - b.offset || a.arrival - b.arrival));}
    if (insertions.size === 0 && causal.length === 0 && remaining.length > 1) {
      const positioned = this.array(), sessions = this.set(); let all = true;
      for (let i = 0; i < remaining.length; i++) {yield* this.work('loop');
        const position = yield* this.physical(remaining[i]);
        this.push(positioned, this.record({ entry: remaining[i], arrival: i, position }));
        if (position?.sessionId) yield* this.add(sessions, position.sessionId); if (!position) all = false;
      }
      if (sessions.size === 1 && all) {
        const sorted = yield* this.sort(positioned, (a, b) => a.position.offset - b.position.offset || a.arrival - b.arrival), result = this.array();
        for (const item of sorted) {yield* this.work('loop');this.push(result, item.entry);} for (const row of deferred) {yield* this.work('loop');this.push(result, row);} return result;
      }
    }
    const result = this.array();
    if (!insertions.size) { for (const row of causal) {yield* this.work('loop');this.push(result, row);} for (const row of remaining) {yield* this.work('loop');this.push(result, row);} }
    else { for (let i = 0; i <= causal.length; i++) {yield* this.work('loop');
      const bucket = (yield* this.lookup(insertions,i)); if (bucket) for (const item of bucket) {yield* this.work('loop');this.push(result, item.entry);}
      if (i < causal.length) this.push(result, causal[i]);
    } for (const row of remaining) {yield* this.work('loop');this.push(result, row);} }
    for (const row of deferred) {yield* this.work('loop');this.push(result, row);} return result;
  }
  *join(durable, live) {
    // Preserve the complete settings wrapper, including eager .map before
    // .find(Boolean) and the observable native spread when a conflict exists.
    const settings = this.array(); for (const row of live) {yield* this.work('loop');if (truth(yield* this.setting(row))) this.push(settings, row);}
    if (!settings.length) return yield* this.joinBase(durable, live);
    const expected = this.map(); for (const row of settings) {yield* this.work('loop');for (const id of yield* this.identities(row)) {yield* this.work('loop');yield* this.put(expected, id, row);}}
    const checked = this.array(); let changed = false;
    for (const row of durable) {yield* this.work('loop');
      if (!truth(yield* this.setting(row))) { this.push(checked,row); continue; }
      const conflicts = this.array();
      for (const id of yield* this.identities(row)) {yield* this.work('loop');
        const other = (yield* this.lookup(expected,id));
        const a = other ? yield* this.setting(other) : null, b = yield* this.setting(row);
        if (!truth(a) || !truth(b)) continue;
        const leftSession = yield* this.get(this.rowValue(other), 'sessionId'), rightSession = yield* this.get(this.rowValue(row), 'sessionId');
        if (!(yield* this.equal(leftSession, rightSession))) continue;
        const ak = yield* this.get(a, 'kind'), bk = yield* this.get(b, 'kind');
        let conflict = !(yield* this.equal(ak, bk));
        if (!conflict) conflict = !(yield* this.equal(yield* this.get(a, 'value'), yield* this.get(b, 'value')));
        if (conflict) {
          const parts = this.array();
          for (const [fact, field] of [[a,'kind'],[a,'value'],[b,'kind'],[b,'value']]) {yield* this.work('loop');this.push(parts,yield* this.string(yield* this.get(fact, field),'template'));}
          this.push(conflicts,(yield* this.concat(['History mismatch: /',parts[0],' ',parts[1],' → /',parts[2],' ',parts[3]],'',this.arena)));
        }
      }
      const conflict=conflicts.length?conflicts[0]:null;
      if(!conflict){this.push(checked,row);continue;}
      changed=true;
      if(row.origin==='native') {
        const copy=yield* this.ask('setting-conflict-clone',{rowSlot:row.slot,conflict});
        if(!native(copy)||copy.meta.valueType!=='object'||copy.meta.array)throw fail('HISTORY_AGENT_NATIVE_VALUE');
        this.push(checked,this.record({origin:'native',slot:copy.meta.slot}));
      } else this.push(checked,this.record({origin:'historical',value:yield* this.copyField(row.value,'settingsProjectionError',conflict)}));
    }
    const merged = yield* this.joinBase(changed?checked:durable, live), values = this.map(), shown = this.array();
    for (const row of merged) {yield* this.work('loop');
      const fact = yield* this.setting(row); if (!truth(fact)) { this.push(shown, row); continue; }
      const raw = this.rowValue(row), owner = yield* this.get(raw, 'viewOwnerSessionId'),
        session = truth(owner) ? owner : yield* this.get(raw, 'sessionId');
      const key = (yield* this.concat([yield* this.string(truth(session) ? session : ''), ':', yield* this.string(yield* this.get(fact, 'kind'), 'default')], '', this.arena));
      const isLive = (yield* this.get(fact, 'live')) === true;
      let unchanged = false;
      if (isLive) unchanged = yield* this.equal(this.field((yield* this.lookup(values,key)),'value'), yield* this.get(fact, 'value'));
      const value = yield* this.get(fact, 'value');
      yield* this.put(values, key, this.wrapper({value}));
      if (!unchanged) this.push(shown, row);
    }
    return shown;
  }
  wrapper(fields) {
    return this.arena.step(() => {
      const record = this.arena.make('object'), refs = this.arena.make('object'), types = this.arena.make('object');
      for (const [key, value] of Object.entries(fields)) {
        if (native(value)) { record[key] = undefined; refs[key] = value.meta.slot; types[key] = this.arena.own(value.meta); }
        else record[key] = value;
      }
      return this.arena.record({ record, fieldRefs: refs, fieldTypes: types });
    });
  }
  field(wrapper, name) {
    if (!wrapper) return undefined;
    const slot = wrapper.fieldRefs?.[name];
    return slot === undefined ? wrapper.record[name] : new NativeValue({ ...wrapper.fieldTypes[name] });
  }
  *callIdentity(value) {
    const string = yield* this.string(truth(value) ? value : '');
    // Only the terminal :canonical:<digits> suffix is removed.
    let end = string.length;
    while (end > 0 && /\d/.test(text.small((yield* this.slice(string, end - 1, end))))) {yield* this.work('canonical-suffix');end--;}
    return end < string.length && end >= 11 && text.equal((yield* this.slice(string, end - 11, end)), ':canonical:')
      ? (yield* this.slice(string, 0, end - 11)) : string;
  }
  *label(value, fallback, max) {
    let string = yield* this.string(truth(value) ? value : fallback);
    let end = string.length;
    while (end && /\s/u.test(text.small((yield* this.slice(string, end - 1, end))))) {yield* this.work('label-trim');end--;}
    if (end >= 7 && text.small((yield* this.slice(string, end - 7, end))).toLowerCase() === 'running') {
      let at = end - 7, spaces = at;
      while (at && /\s/u.test(text.small((yield* this.slice(string, at - 1, at))))) {yield* this.work('label-trim');at--;}
      if (at < spaces && at && text.equal((yield* this.slice(string, at - 1, at)), '·')) {
        at--; const before = at;
        while (at && /\s/u.test(text.small((yield* this.slice(string, at - 1, at))))) {yield* this.work('label-trim');at--;}
        if (at < before) string = (yield* this.slice(string, 0, at));
      }
    }
    return (yield* this.slice(string, 0, max));
  }
  *isTask(action) {
    const object = native(action) ? action.meta.valueType === 'object' : typeof action === 'object' && action !== null && !text.isPagedText(action);
    return object && (yield* this.has(action, 'tool')) && (yield* this.equal(yield* this.get(action, 'tool'), 'Task'));
  }
  *isRaw(action) {
    const object = native(action) ? action.meta.valueType === 'object' : typeof action === 'object' && action !== null && !text.isPagedText(action);
    return object && (yield* this.has(action, 'tool')) && (yield* this.equal(yield* this.get(action, 'tool'), '__raw__'));
  }
  *taskActions(row) {
    if (row.origin === 'native') return yield* this.ask('task-actions', { rowSlot: row.slot });
    const entry = row.value, hydrated = this.array();
    if (Array.isArray(entry.actions)) for (let i = 0; i < entry.actions.length; i++)
      {yield* this.work('loop');if (i in entry.actions && (yield* this.isTask(entry.actions[i]))) this.push(hydrated, entry.actions[i]);}
    if (hydrated.length) return hydrated;
    const summaries = entry.actionSummary || [];
    if (!Array.isArray(summaries)) throw new TypeError('(entry.actionSummary || []).filter is not a function');
    for (let i = 0; i < summaries.length; i++) {yield* this.work('loop');if (i in summaries) {
      const s = summaries[i];
      if (!(yield* this.sameValue(s.toolName, 'Task')) && !(yield* this.sameValue(s.family, 'task'))) continue;
      this.push(hydrated, this.record({ tool: 'Task', description: yield* this.string(s.description || 'Agent'),
        toolUseId: s.toolUseId, subagentStatus: s.subagentStatus, agentSessionId: s.agentSessionId, agentId: s.agentId,
        taskPrompt: s.taskPrompt, startedAt: s.startedAt, completedAt: s.completedAt, durationMs: s.durationMs, launchSettings: s.launchSettings }));
    }}
    return hydrated;
  }
  *agentKey(action, entry, row) {
    if (native(action) && row.origin === 'native') return yield* this.ask('agentKey', { rowSlot: row.slot, actionSlot: action.meta.slot });
    // Function argument entry.uuid is evaluated before the function body.
    const uuid = yield* this.get(entry, 'uuid');
    let value = yield* this.get(action, 'toolUseId');
    if (!truth(value)) value = yield* this.get(action, 'agentSessionId');
    if (!truth(value)) value = yield* this.get(action, 'agentId');
    if (!truth(value)) value = uuid;
    return (yield* this.concat(['task:', yield* this.string(value, 'default')], '', this.arena));
  }
  *run() {
    const state = this.arena.state(), current = state.current, context = current.context || {};
    const source = state.source, replacements = this.map(), exclusions = this.set();
    for (const item of current.replacements || []) {yield* this.work('loop');
      if (!integer(item.ordinal) || item.ordinal >= source.length || !integer(item.rowSlot) || (yield* this.contains(replacements,item.ordinal))) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
      yield* this.put(replacements, item.ordinal, this.record({ origin: 'native', slot: item.rowSlot }));
    }
    for (const ordinal of current.exclusions || []) {yield* this.work('loop');
      if (!integer(ordinal) || ordinal >= source.length || (yield* this.contains(exclusions,ordinal))) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
      yield* this.add(exclusions, ordinal);
    }
    this.metrics.stage='source-rows';const rows = this.array();
    if (current.segments !== undefined) {
      if (!Array.isArray(current.segments) || current.replacements?.length || current.exclusions?.length
        || current.insertions?.length) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
      // The committed compatibility publication supplies the exact original
      // thin-row runs, interleaved with CURRENT native objects. These are
      // already in their published order: do not perform a second insertion
      // merge against an obsolete sparse recipe.
      for (const segment of current.segments) {yield* this.work('loop');
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
        const keys=[];for(const key of this.arena.keys(this.arena.owner(segment))){yield* this.work('recipe-segment-key');keys.push(key);if(keys.length>2)throw fail('HISTORY_AGENT_CURRENT_RECIPE');}
        if (keys.length === 1 && keys[0] === 'rowSlot' && integer(segment.rowSlot)) {
          this.push(rows, this.record({ origin: 'native', slot: segment.rowSlot }));
          continue;
        }
        if (keys.length !== 2 || !keys.includes('start') || !keys.includes('end')
          || !integer(segment.start) || !integer(segment.end)
          || segment.start >= segment.end || segment.end > source.length) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
        for (let i = segment.start; i < segment.end; i++) {yield* this.work('loop');
          this.push(rows, this.record({ origin: 'historical', value: source[i] }));
          this.metrics.sourceRows++; if (this.metrics.sourceRows % 32 === 0) yield* this.checkpoint();
        }
      }
    } else for (let i = 0; i < source.length; i++) {yield* this.work('loop');
      if (!(yield* this.contains(exclusions,i))) this.push(rows, (yield* this.lookup(replacements,i)) || this.record({ origin: 'historical', value: source[i] }));
      this.metrics.sourceRows++; if (i % 32 === 31) yield* this.checkpoint();
    }
    const insertionRows = this.array(), liveRows = this.array();
    for (const slot of current.insertions || []) {yield* this.work('loop'); if (!integer(slot)) throw fail('HISTORY_AGENT_CURRENT_RECIPE'); this.push(insertionRows, this.record({ origin: 'native', slot })); }
    for (const slot of current.live || []) {yield* this.work('loop'); if (!integer(slot)) throw fail('HISTORY_AGENT_CURRENT_RECIPE'); this.push(liveRows, this.record({ origin: 'native', slot })); }
    this.metrics.stage='join';let joined = insertionRows.length ? yield* this.join(rows, insertionRows) : rows;
    joined = liveRows.length ? yield* this.join(joined, liveRows) : joined;
    this.metrics.joinedRows = joined.length;
    this.metrics.stage='background';const background = yield* this.background(joined, context);
    const entryKeys=this.set(),callKeys=this.set(),detailIndex=this.map(); let backgroundAgents=0,backgroundRank=0;
    for(const chip of background) {yield* this.work('loop');
      const rawUuid=this.field(chip,'entryUuid');
      const uuid=native(rawUuid)&&rawUuid.meta.valueType==='string'?yield* this.string(rawUuid):rawUuid;
      if(!native(uuid))yield* this.add(entryKeys,uuid);
      const key=this.field(chip,'key');
      yield* this.put(detailIndex,key,-(++backgroundRank));
      if(yield* this.equal(this.field(chip,'kind'),'subagent')) {
        backgroundAgents++; const keyText=text.isText(key)?key:yield* this.string(key);
        const call=yield* this.callIdentity(keyText.startsWith('task:')?(yield* this.slice(keyText,5)):keyText);
        if(call)yield* this.add(callKeys,call);
      }
    }
    const liveByKey = this.map();
    for (const chip of background) {yield* this.work('loop');if (yield* this.equal(this.field(chip, 'kind'), 'subagent')) yield* this.put(liveByKey, this.field(chip, 'key'), chip);}
    this.metrics.stage='fold';const byKey = this.map();
    for (const row of joined) {yield* this.work('loop');
      const actions = yield* this.taskActions(row), entry = this.rowValue(row);
      yield* this.each(actions, function* (action) {
        const key = yield* this.agentKey(action, entry, row), live = (yield* this.lookup(liveByKey,key));
        const terminal = context.terminalFactsSlot == null ? undefined
          : yield* this.mapGet(context.terminalFactsSlot, yield* this.callIdentity(yield* this.get(action, 'toolUseId')));
        const startedAt = (yield* this.number(this.field(live, 'startedAt')))
          || (yield* this.number(nil(terminal) ? undefined : yield* this.get(terminal, 'startedAt')))
          || (yield* this.number(yield* this.get(action, 'startedAt')))
          || (yield* this.date((yield* this.get(entry, 'timestamp')) || '')) || 0;
        const completedAt = (yield* this.number(nil(terminal) ? undefined : yield* this.get(terminal, 'completedAt')))
          || (yield* this.number(yield* this.get(action, 'completedAt'))) || 0;
        let durationMs;
        if (truth(nil(terminal) ? undefined : yield* this.get(terminal, 'completedAt')) && startedAt > 0)
          durationMs = Math.max(0, yield* this.subtract(yield* this.get(terminal, 'completedAt'), startedAt));
        else if ((yield* this.number(yield* this.get(action, 'durationMs'))) > 0) durationMs = yield* this.number(yield* this.get(action, 'durationMs'));
        else durationMs = completedAt > 0 && startedAt > 0 ? Math.max(0, completedAt - startedAt) : 0;
        let status;
        if (live) status = 'running';
        else if (truth(nil(terminal) ? undefined : yield* this.get(terminal, 'status'))) status = yield* this.get(terminal, 'status');
        else if (yield* this.equal(yield* this.get(action, 'subagentStatus'), 'interrupted')) status = 'interrupted';
        else status = (yield* this.equal(yield* this.get(action, 'subagentStatus'), 'completed')) || !nil(yield* this.get(action, 'result')) || completedAt > 0 ? 'completed' : 'interrupted';
        if (native(status) && status.meta.valueType === 'string') status = yield* this.string(status);
        const previous = (yield* this.lookup(byKey,key));
        let description = yield* this.get(action, 'description');
        if (!truth(description)) description = this.field(live, 'label');
        const label = yield* this.label(description, 'Task agent', 120), entryUuid = yield* this.get(entry, 'uuid');
        const history = yield* this.get(action, 'history');
        const length = nil(history) ? undefined : yield* this.get(history, 'length');
        const taskHistory = ((truth(length) ? yield* this.number(length) : 0) > 0) ? yield* this.get(action, 'history') : this.field(previous, 'taskHistory');
        const result = yield* this.get(action, 'result'), taskResult = nil(result) ? this.field(previous, 'taskResult') : result;
        let session = this.field(live, 'agentSessionId'); if (!truth(session)) session = yield* this.get(action, 'agentSessionId'); if (!truth(session)) session = this.field(previous, 'agentSessionId');
        let agentId = this.field(live, 'agentId'); if (!truth(agentId)) agentId = yield* this.get(action, 'agentId'); if (!truth(agentId)) agentId = this.field(previous, 'agentId');
        let prompt = yield* this.get(action, 'taskPrompt'); if (!truth(prompt)) prompt = this.field(previous, 'taskPrompt');
        let launch = this.field(live, 'launchSettings'); if (!truth(launch)) launch = nil(terminal) ? undefined : yield* this.get(terminal, 'launchSettings');
        if (!truth(launch)) launch = yield* this.get(action, 'launchSettings'); if (!truth(launch)) launch = this.field(previous, 'launchSettings');
        yield* this.put(byKey, key, this.wrapper({ key, kind: 'subagent', label, entryUuid, startedAt, status,
          completedAt: completedAt || undefined, durationMs: durationMs || undefined, taskHistory, taskResult,
          agentSessionId: session, agentId, taskPrompt: prompt, launchSettings: launch }));
        yield* this.remove(liveByKey,key); this.metrics.historicalActions += row.origin === 'historical' ? 1 : 0;
      });
      yield* this.checkpoint();
    }
    for (const [key, live] of liveByKey) {yield* this.work('loop');yield* this.put(byKey, key, live);}
    // Match the literal collector's values() protocol, including its native
    // iterator step. Intrinsic entry traversal is not equivalent after a
    // public iterator-prototype change, even with unchanged Main facts.
    if (context.terminalFactsSlot != null) yield* this.each(nativeSlot(context.terminalFactsSlot), function* (terminal) {
      const key = yield* this.concat(['task:', yield* this.string(yield* this.get(terminal, 'toolUseId'), 'default')], '', this.arena);
      if ((yield* this.contains(byKey, key)) || !truth(yield* this.get(terminal, 'agentSessionId'))) return;
      const completedAt = yield* this.number(yield* this.get(terminal, 'completedAt'));
      if (!(completedAt > 0)) return;
      const startedAt = (yield* this.number(yield* this.get(terminal, 'startedAt'))) || 0;
      let label = yield* this.get(terminal, 'label'); if (!truth(label)) label = 'Агент';
      yield* this.put(byKey, key, this.wrapper({ key, kind: 'subagent',
        label: yield* this.slice(yield* this.string(label), 0, 120), entryUuid: '',
        agentSessionId: yield* this.get(terminal, 'agentSessionId'), startedAt, completedAt,
        durationMs: startedAt > 0 ? Math.max(0, completedAt - startedAt) : undefined,
        status: (yield* this.equal(yield* this.get(terminal, 'status'), 'interrupted')) ? 'interrupted' : 'completed',
        launchSettings: yield* this.get(terminal, 'launchSettings') }));
    }, 'values');
    const unsorted = this.array(); for (const value of byKey.values()) {yield* this.work('loop');this.push(unsorted, value);}
    this.metrics.stage='sort-index';const all = yield* this.sort(unsorted, (a, b) => {
      const ar = eq(this.field(a, 'status'), 'running'), br = eq(this.field(b, 'status'), 'running');
      return ar && !br ? -1 : br && !ar ? 1 : this.field(b, 'startedAt') - this.field(a, 'startedAt');
    });
    const running = this.array(), completed = this.array(), interrupted = this.array(), roster = this.array();
    let detailRank=0;
    for (const value of all) {yield* this.work('loop');
      yield* this.put(detailIndex,this.field(value,'key'),detailRank++);
      const status = this.field(value, 'status');
      if ((yield* this.sameValue(status, 'running'))) this.push(running, value); else if ((yield* this.sameValue(status, 'completed'))) this.push(completed, value); else if ((yield* this.sameValue(status, 'interrupted'))) this.push(interrupted, value);
    }
    for (const section of [running, completed, interrupted]) {yield* this.work('loop');for (const value of section) {yield* this.work('loop');this.push(roster, value);}}
    this.arena.step(() => { state.sections = this.arena.record({ all, running, completed, interrupted, roster, background });
      state.counts = this.arena.own({ total: all.length, running: running.length, completed: completed.length,
        interrupted: interrupted.length, roster: roster.length, background: background.length, backgroundAgents });
      state.memberships=this.arena.record({entry:entryKeys,call:callKeys,detail:detailIndex});
    });
    return true;
  }
  *background(rows, c) {
    const chips = this.array(), seen = this.set(), seenSubagents = this.set();
    if (!c.isTurnBusy && !c.agentProcessAlive) return chips;
    let lastTurnStart = 0;
    for (let i = rows.length - 1; i >= 0; i--) {yield* this.work('loop');
      const row = rows[i];
      const yes = row.origin === 'native' ? yield* this.ask('isLastUser', { rowSlot: row.slot }) : (yield* this.sameValue(row.value.role, 'user'));
      if (yes) { lastTurnStart = i; break; }
    }
    for (let i = 0; i < rows.length; i++) {yield* this.work('loop');
      const entry = this.rowValue(rows[i]), actions = yield* this.get(entry, 'actions');
      if (!(native(actions) ? actions.meta.array : Array.isArray(actions))) continue;
      const inLastTurn = i >= lastTurnStart;
      yield* this.each(yield* this.get(entry, 'actions'), function* (action) {
        if (yield* this.isRaw(action)) {
          const toolValue = yield* this.get(yield* this.get(action, 'rawTool'), 'toolUseId'), toolUseId = yield* this.string(truth(toolValue) ? toolValue : '');
          const call = yield* this.callIdentity(toolUseId);
          const activity = call && c.exactActiveBackgroundTasksSlot != null ? yield* this.mapGet(c.exactActiveBackgroundTasksSlot, call) : null;
          const exact = truth(activity) ? activity : null;
          const terminal = (yield* this.setHas(c.terminalBackgroundTaskCallsSlot, call)) === true;
          if (!(c.agentProcessAlive === true && truth(exact) && !terminal)) return;
          const entrySession = yield* this.get(entry, 'sessionId');
          if (truth(entrySession) && c.currentSessionId && !(yield* this.equal(yield* this.get(entry, 'sessionId'), c.currentSessionId))) return;
          const args = yield* this.get(yield* this.get(action, 'rawTool'), 'args'), commandValue = nil(args) ? undefined : yield* this.get(args, 'command');
          const isString = native(commandValue) ? commandValue.meta.valueType === 'string' : text.isText(commandValue);
          const command = isString ? (yield* this.get(yield* this.get(yield* this.get(action, 'rawTool'), 'args'), 'command')) : '';
          const exactKind = nil(exact) ? undefined : yield* this.get(exact, 'kind');
          const kind = (yield* this.equal(exactKind, 'monitor')) || (yield* this.equal(yield* this.get(yield* this.get(action, 'rawTool'), 'toolName'), 'Monitor')) ? 'monitor' : 'bash';
          let label = nil(exact) ? undefined : yield* this.get(exact, 'label');
          if (!truth(label)) { const a = yield* this.get(yield* this.get(action, 'rawTool'), 'args'); label = nil(a) ? undefined : yield* this.get(a, 'description'); }
          if (!truth(label)) label = command;
          if (!truth(label)) label = kind === 'monitor' ? 'Monitor' : yield* this.get(yield* this.get(action, 'rawTool'), 'toolName');
          label = (yield* this.slice(yield* this.string(label), 0, 120));
          if (call) yield* this.add(seen, call);
          const key = (yield* this.concat([kind, ':', toolUseId || (yield* this.string(yield* this.get(entry, 'uuid'), 'default'))], '', this.arena));
          let entryUuid = nil(exact) ? undefined : yield* this.get(exact, 'entryUuid'); if (!truth(entryUuid)) entryUuid = yield* this.get(entry, 'uuid');
          const startedAt = (yield* this.number(nil(exact) ? undefined : yield* this.get(exact, 'startedAt')))
            || (yield* this.date((yield* this.get(entry, 'timestamp')) || '')) || 0;
          let acceptance = yield* this.get(yield* this.get(action, 'rawTool'), 'result'); if (!truth(acceptance)) acceptance = nil(exact) ? undefined : yield* this.get(exact, 'acceptance');
          let backgroundCommand = nil(exact) ? undefined : yield* this.get(exact, 'command'); if (!truth(backgroundCommand)) backgroundCommand = command;
          this.push(chips, this.wrapper({ key, kind, label, entryUuid, startedAt, status: 'running', bashAcceptance: acceptance,
            backgroundCommand, backgroundTaskId: nil(exact) ? undefined : yield* this.get(exact, 'taskId') })); return;
        }
        if (!(yield* this.isTask(action))) return;
        const call = yield* this.callIdentity(yield* this.get(action, 'toolUseId'));
        const activity = call && c.exactActiveSubagentsSlot != null ? yield* this.mapGet(c.exactActiveSubagentsSlot, call) : null;
        const exact = truth(activity) ? activity : null;
        // Evaluate every object-literal argument before entering the predicate,
        // including fields whose values the predicate subsequently ignores.
        const exactActive = yield* this.equal(nil(exact) ? undefined : yield* this.get(exact, 'provider'), c.chipToolType);
        const status = yield* this.get(action, 'subagentStatus'), generation = yield* this.get(action, 'processGeneration');
        const hasResult = !nil(yield* this.get(action, 'result'));
        const running = exactActive ? c.agentProcessAlive === true : truth(status) ? false
          : inLastTurn === true && c.isTurnBusy === true && hasResult !== true;
        // generation is deliberately read above, even though exact main proof
        // supersedes its value in the actual isHistoryTaskChipLive predicate.
        void generation;
        if (!running) return;
        if (call) yield* this.add(seenSubagents, call);
        const tool = yield* this.get(action, 'toolUseId');
        const key = (yield* this.concat(['task:', yield* this.string(truth(tool) ? tool : yield* this.get(entry, 'uuid'), 'default')], '', this.arena));
        const label = yield* this.label(yield* this.get(action, 'description'), 'Task agent', 80), entryUuid = yield* this.get(entry, 'uuid');
        const startedAt = (yield* this.number(nil(exact) ? undefined : yield* this.get(exact, 'startedAt')))
          || (yield* this.number(yield* this.get(action, 'startedAt')))
          || (yield* this.date((yield* this.get(entry, 'timestamp')) || '')) || 0;
        const taskHistory = yield* this.get(action, 'history'), taskResult = yield* this.get(action, 'result');
        let session = nil(exact) ? undefined : yield* this.get(exact, 'agentSessionId'); if (!truth(session)) session = yield* this.get(action, 'agentSessionId');
        let agentId = nil(exact) ? undefined : yield* this.get(exact, 'agentId'); if (!truth(agentId)) agentId = yield* this.get(action, 'agentId');
        const prompt = yield* this.get(action, 'taskPrompt');
        let launch = nil(exact) ? undefined : yield* this.get(exact, 'launchSettings'); if (!truth(launch)) launch = yield* this.get(action, 'launchSettings');
        this.push(chips, this.wrapper({ key, kind: 'subagent', label, entryUuid, startedAt, status: 'running', taskHistory, taskResult,
          agentSessionId: session, agentId, taskPrompt: prompt, launchSettings: launch }));
      });
      yield* this.checkpoint();
    }
    if (c.exactActiveSubagentsSlot != null) yield* this.each(nativeSlot(c.exactActiveSubagentsSlot), function* (pair) {
      const rawCall = yield* this.get(pair, '0');
      const call = native(rawCall) && rawCall.meta.valueType === 'string' ? yield* this.string(rawCall) : rawCall;
      const agent = yield* this.get(pair, '1');
      if ((!native(call) && (yield* this.contains(seenSubagents, call))) || !c.agentProcessAlive) return;
      if (c.chipToolType !== 'codex' || !(yield* this.equal(yield* this.get(agent, 'provider'), 'codex'))
        || !truth(yield* this.get(agent, 'agentSessionId'))
        || !(yield* this.equal(yield* this.get(agent, 'sessionId'), c.currentSessionId))
        || !c.currentProcessGeneration
        || !(yield* this.equal(yield* this.get(agent, 'generation'), c.currentProcessGeneration))) return;
      const key = yield* this.concat(['task:', yield* this.string(yield* this.get(agent, 'toolUseId'), 'default')], '', this.arena);
      let label = yield* this.get(agent, 'label'); if (!truth(label)) label = 'Агент';
      this.push(chips, this.wrapper({ key, kind: 'subagent', label: yield* this.slice(yield* this.string(label), 0, 120),
        entryUuid: '', startedAt: (yield* this.number(yield* this.get(agent, 'startedAt'))) || 0,
        status: 'running', agentSessionId: yield* this.get(agent, 'agentSessionId'),
        launchSettings: yield* this.get(agent, 'launchSettings') }));
    });
    if (c.exactActiveBackgroundTasksSlot != null) yield* this.each(nativeSlot(c.exactActiveBackgroundTasksSlot), function* (pair) {
      const callValue = yield* this.get(pair, '0'), call = native(callValue) && callValue.meta.valueType === 'string' ? yield* this.string(callValue) : callValue,
        task = yield* this.get(pair, '1');
      if (!native(call) && (yield* this.contains(seen,call))) return;
      if (truth(yield* this.setHas(c.terminalBackgroundTaskCallsSlot, call))) return;
      if (!c.agentProcessAlive) return;
      let label = yield* this.get(task, 'label'); if (!truth(label)) label = yield* this.get(task, 'command');
      if (!truth(label)) label = (yield* this.equal(yield* this.get(task, 'kind'), 'monitor')) ? 'Monitor' : 'Bash';
      label = yield* this.string(label);
      const kindForKey = yield* this.string(yield* this.get(task, 'kind'), 'default');
      const tool = yield* this.get(task, 'toolUseId');
      const key = (yield* this.concat([kindForKey, ':', yield* this.string(tool, 'default')], '', this.arena));
      const kind = yield* this.get(task, 'kind'); let entryUuid = yield* this.get(task, 'entryUuid'); if (!truth(entryUuid)) entryUuid = '';
      this.push(chips, this.wrapper({ key, kind, label: (yield* this.slice(label, 0, 120)), entryUuid,
        startedAt: (yield* this.number(yield* this.get(task, 'startedAt'))) || 0, status: 'running',
        bashAcceptance: yield* this.get(task, 'acceptance'), backgroundCommand: yield* this.get(task, 'command'), backgroundTaskId: yield* this.get(task, 'taskId') }));
    });
    return yield* this.sort(chips, (a, b) => this.field(b, 'startedAt') - this.field(a, 'startedAt'));
  }
  async compute(machine,control,{readOnly=false}={}) {
    try {
      for(;;){
        this.assertOpen();control?.assertCurrent();
        const next=readOnly?machine.next():this.arena.step(()=>machine.next());
        if(next.done)return next.value;
        if(next.value!==null)throw fail('HISTORY_AGENT_CATALOG_INTERNAL_CONTINUATION');
        control?.assertCurrent();
        if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));
      }
    } finally {machine.return?.();}
  }
  async resume(value, control) {
    this.assertOpen(); if (this.finished) throw fail('HISTORY_AGENT_CATALOG_ALREADY_READY');
    // One synchronous continuation is one existing arena transaction. Nested
    // record/push/put helpers share that transaction; the yielded native or
    // bounded checkpoint is the boundary. Never hold a builder across await.
    let next = this.arena.step(() => this.machine.next(value));
    while (!next.done && next.value === null) {
      control?.assertCurrent(); if (control?.checkpoint) await control.checkpoint(); else await new Promise(resolve => setImmediate(resolve));
      this.assertOpen(); control?.assertCurrent(); next = this.arena.step(() => this.machine.next());
    }
    this.assertOpen(); control?.assertCurrent();
    this.pending = next.done ? null : next.value;
    const pendingValue=this.pending?await this.compute(this.importNative(this.pending),control):null;
    this.arena.step(() => { this.arena.state().pending=pendingValue; });
    if (next.done) { this.finished = true; this.phase = 'ready'; this.machine = null; }
    const old = this.pin; this.pin = this.arena.checkpoint(); old.release();
  }
  cursor() { this.assertOpen(); return this.pin.cursor(); }
  close() {
    if (this.closed) return; this.closed = true;
    try { this.machine?.return(); } finally { this.machine = null; this.inputCurrent = null; this.pending = null; try { this.pin.release(); } finally { this.arena.close(); } }
  }
}

function header(plane, state) {
  const catalog = state.agentCatalog, root = catalog.cursor();
  const result = { success: true, __notedHistoryTransport: 'root-v1', ...plane.identity(state), readProfile: PROFILE,
    schema: 1, root: plane.describe(state, root, { inline: false }), binding: catalog.binding,
    catalogRequestId: catalog.requestId, phase: catalog.phase, sequence: catalog.sequence };
  if (catalog.phase === 'native') result.nativeRequest = { kind: catalog.pending.kind,
    arguments: plane.describe(state, root.field('pending'), { inline: false }) };
  else {
    result.sections = {}; result.counts = {};
    for (const key of ['all','running','completed','interrupted','roster','background']) result.sections[key] = plane.describe(state, root.field('sections').field(key), { inline: false });
    for (const key of ['total','running','completed','interrupted','roster','background','backgroundAgents']) result.counts[key] = root.field('counts').field(key).scalar();
    result.buildMetrics = { ...catalog.metrics, store: catalog.arena.stats(), nativeMemoryMeasured: false };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
  return result;
}
// Construct outside the async allocating scope. A held child may retain the
// paged catalog, never the caller's transient native recipe/request graph.
function catalogRelease(catalog) { return () => catalog.close(); }
function assertUniqueCatalogRequest(plane, requestId, consumerKey) {
  for (const state of plane.roots.values()) if (!state.released && state.consumerKey === consumerKey
    && state.agentCatalogRequestId === requestId) throw fail('HISTORY_AGENT_CATALOG_DUPLICATE_REQUEST');
}
async function forkAgentCatalog(plane, request, { consumerKey, control } = {}) {
  plane.assertCapacity(); control?.assertCurrent();
  const parent = plane.state(request, consumerKey), binding = preparedPresentationBinding(plane, parent);
  if (request.encoding !== ENCODING || !UUID.test(request.catalogRequestId || '') || !request.current
    || Object.entries(binding).some(([key, value]) => request[key] !== value)
    || Object.keys(request).some(key => ![...Object.keys(binding), 'encoding','catalogRequestId','current',
      '_historyRootConsumerKey','readDemandId','diagnosticReadId','diagnosticActionId'].includes(key))) throw fail('HISTORY_AGENT_CATALOG_BINDING');
  const current = request.current;
  if (!current || typeof current !== 'object' || Array.isArray(current)
    || Object.keys(current).some(key => !['segments','replacements','exclusions','insertions','live','context'].includes(key))
    || ['replacements','exclusions','insertions','live'].some(key => !Array.isArray(current[key]))
    || current.segments !== undefined && !Array.isArray(current.segments)) throw fail('HISTORY_AGENT_CURRENT_RECIPE');
  assertUniqueCatalogRequest(plane, request.catalogRequestId, consumerKey);
  let catalog, installed, transferred = false; plane.opening++;
  try {
    catalog = new HistoryAgentCatalog(plane.store, parent.primaryPresentation.sourceMetadataCursor, current, binding, request.catalogRequestId);
    await catalog.resume(undefined, control);
    control?.assertCurrent(); if (plane.state(request, consumerKey) !== parent) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    assertUniqueCatalogRequest(plane, request.catalogRequestId, consumerKey);
    installed = plane.install({ root: catalog.pin }, catalog.cursor(), { consumerKey, ownerKey: parent.ownerKey,
      revision: parent.revision, source: parent.source, release: catalogRelease(catalog) });
    installed.state.agentCatalog = catalog; installed.state.agentCatalogRequestId = request.catalogRequestId;
    const result = header(plane, installed.state); control?.assertCurrent(); plane.state(result, consumerKey);
    transferred = true; return result;
  } finally { plane.opening--; if (!transferred) { if (installed) plane.drop(installed.state); else catalog?.close(); } }
}
async function advanceAgentCatalog(plane, state, request, { consumerKey, control } = {}) {
  const c = state.agentCatalog;
  if (!(c instanceof HistoryAgentCatalog) || request.kind !== STEP || !['advance','append-value','advance-value'].includes(request.operation)
    || request.catalogRequestId !== c.requestId || request.sequence !== c.sequence || c.phase !== 'native'
    || request.nodeToken !== plane.nodeToken(state, c.cursor())
    || !request.data || Object.keys(request).some(key => !['leaseId','ownerKey','revision','generation','nodeToken','kind','operation',
      'catalogRequestId','sequence','data','readDemandId','diagnosticReadId','diagnosticActionId','_historyRootConsumerKey'].includes(key))) throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
  c.assertOpen(); control?.assertCurrent();
  try {
    let value;
    if(request.operation==='append-value') {
      const {offset,text:part}=request.data;
      if(Object.keys(request.data).length!==2||!integer(offset)||offset!==(c.scalarLength||0)
        ||typeof part!=='string'||part.length<1||part.length>8192||!Number.isSafeInteger(offset+part.length))throw fail('HISTORY_AGENT_CATALOG_SCALAR');
      const importedPart=await c.compute(c.copyText(part),control);
      c.arena.step(()=>{const s=c.arena.state();if(!c.scalarLength)s.scalarChunks=c.arena.make('array');s.scalarChunks.push(importedPart);});
      c.scalarLength=offset+part.length;
      control?.assertCurrent();c.assertOpen();
      if(plane.state(request,consumerKey)!==state)throw fail('HISTORY_ROOT_OWNER_MISMATCH');
      return {success:true,...plane.identity(state),catalogRequestId:c.requestId,sequence:c.sequence,
        offset,nextOffset:c.scalarLength,accepted:true};
    }
    if(request.operation==='advance-value') {
      if(Object.keys(request.data).length!==2||request.data.valueType!=='string'
        ||request.data.length!==c.scalarLength||!c.scalarLength)throw fail('HISTORY_AGENT_CATALOG_SCALAR');
      const valueText=await c.compute(c.concat(c.arena.state().scalarChunks),control);
      c.arena.step(()=>{c.arena.state().scalarValue=valueText;});
      value=new CatalogText(valueText);c.scalarLength=0;
    } else {
      if(c.scalarLength||Object.keys(request.data).length!==1||!Object.hasOwn(request.data,'value'))throw fail('HISTORY_AGENT_CATALOG_SCALAR');
      value=request.data.value;
    }
    await c.resume(value, control);
    if (plane.state(request, consumerKey) !== state || state.agentCatalog !== c) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
    c.sequence++; state.lease = c.pin; return header(plane, state);
  } catch (error) { plane.drop(state); throw error; }
}
async function readAgentCatalogMembership(plane,state,request,{consumerKey,control}={}) {
  const c=state.agentCatalog;
  if(!(c instanceof HistoryAgentCatalog)||c.phase!=='ready'||request.catalogRequestId!==c.requestId
    ||request.catalogSequence!==c.sequence||!['entry','call','detail'].includes(request.operation)
    ||!Array.isArray(request.values)||!request.values.length||request.values.length>3
    ||request.values.some(value=>typeof value!=='string')
    ||Object.keys(request).some(key=>!['leaseId','ownerKey','revision','generation','kind','operation','values','catalogRequestId',
      'catalogSequence','readDemandId','diagnosticReadId','diagnosticActionId','_historyRootConsumerKey'].includes(key)))throw fail('HISTORY_AGENT_CATALOG_MEMBERSHIP');
  c.assertOpen();control?.assertCurrent();
  const set=c.arena.state().memberships[request.operation];
  const items=[];for(let ordinal=0;ordinal<request.values.length;ordinal++){
    const value=request.values[ordinal],found=await c.compute(c.contains(set,value),control,{readOnly:true});
    if(request.operation!=='detail'){items.push({ordinal,found});continue;}
    const index=found?await c.compute(c.lookup(set,value),control,{readOnly:true}):undefined;
    if(found&&!Number.isSafeInteger(index))throw fail('HISTORY_AGENT_CATALOG_DETAIL_INDEX');
    const section=found?c.cursor().field('sections').field(index<0?'background':'all'):null;
    const rank=index<0?-index-1:index;
    if(found&&rank>=section.length)throw fail('HISTORY_AGENT_CATALOG_DETAIL_INDEX');
    items.push({ordinal,found,record:found?plane.describe(state,section.at(rank),{inline:false}):null});
  }
  c.assertOpen();control?.assertCurrent();if(plane.state(request,consumerKey)!==state)throw fail('HISTORY_ROOT_OWNER_MISMATCH');
  return {success:true,...plane.identity(state),catalogRequestId:c.requestId,catalogSequence:c.sequence,
    kind:'primary-agent-catalog-membership',operation:request.operation,items};
}
function assertAgentCatalogRead(plane, request, consumerKey, readyOnly = true) {
  const state = plane.state(request, consumerKey), c = state.agentCatalog;
  if (!(c instanceof HistoryAgentCatalog) || request.catalogRequestId !== c.requestId
    || request.catalogSequence !== c.sequence || readyOnly && c.phase !== 'ready'
    || !['range','fields','projection','rowWindow','leaf','text','primary-agent-catalog-membership'].includes(request.kind)) throw fail('HISTORY_AGENT_CATALOG_READ_BINDING');
  c.assertOpen(); return state;
}
module.exports = { HistoryAgentCatalog, PROFILE, ENCODING, STEP, forkAgentCatalog, advanceAgentCatalog, assertAgentCatalogRead, readAgentCatalogMembership };
