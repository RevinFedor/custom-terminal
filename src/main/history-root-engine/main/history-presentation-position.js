'use strict';

// Coordinates of one explicitly captured renderer presentation, not a Source
// root or a writer/paint certificate. Only fixed page roots and one partial key
// are native; the typed UUID dictionary lives in the existing quota-owned store.
const crypto = require('node:crypto');
const { HistoryPagedCursor } = require('./history-paged-store');
const PROFILE = 'history-presentation-position-v1';
const QUERY_ENCODING = 'history-presentation-position-query-v2';
const CHUNK_CHARS = 128, MAX_EVENTS = 3, MAX_WORK = 64;
const fail = code => Object.assign(new Error(code), { code });
const vector = () => ({ page: 0, depth: 0, length: 0 });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const TYPES = new Set(['string', 'number', 'boolean', 'bigint']);
const sameRecord = (a,b) => ['index','memberIndex','memberCount','type','selectionKind','selectionOrdinal'].every(key => a[key] === b[key]);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const typedHash = (type, digest) => Number.parseInt(crypto.createHash('sha256').update(type + ':' + digest).digest('hex').slice(0,8),16);

function workControl(control, assert = () => {}, metrics, budget = { work: 0 }) {
  const check = () => { control?.assertCurrent(); assert(); };
  return { check, async step() { check(); budget.work++;
    if (metrics) { metrics.workSteps++; metrics.maxWorkPerTurn = Math.max(metrics.maxWorkPerTurn, budget.work); }
    if (budget.work === MAX_WORK) {
    if (metrics) metrics.workCheckpoints++;
    budget.work = 0; if (control?.checkpoint) await control.checkpoint(); else await tick(); check();
  } } };
}
async function exactText(store, left, right, work) {
  const a = store.json(left.id), b = store.json(right.id);
  if (a.kind !== 'text' || b.kind !== 'text') throw fail('HISTORY_POSITION_KEY_CORRUPT');
  const ai = store.leafChunks(left), bi = store.leafChunks(right);
  // Different metadata is not a missing proof until BOTH original leaves
  // have completed their aggregate integrity validation.
  let equal = a.totalChars === b.totalChars && a.digest === b.digest;
  let leftPart = '', rightPart = '', leftOffset = 0, rightOffset = 0;
  let leftDone = false, rightDone = false;
  try {
    for (;;) {
      work.check();
      while (!leftDone && leftOffset === leftPart.length) {
        const next = ai.next(); leftDone = !!next.done;
        leftPart = leftDone ? '' : next.value; leftOffset = 0;
        await work.step();
      }
      while (!rightDone && rightOffset === rightPart.length) {
        const next = bi.next(); rightDone = !!next.done;
        rightPart = rightDone ? '' : next.value; rightOffset = 0;
        await work.step();
      }
      if (leftDone && rightDone) return equal;
      if (leftDone || rightDone) {
        equal = false;
        leftOffset = leftPart.length; rightOffset = rightPart.length;
      } else {
        const count = Math.min(leftPart.length - leftOffset, rightPart.length - rightOffset);
        if (leftPart.slice(leftOffset, leftOffset + count) !== rightPart.slice(rightOffset, rightOffset + count)) equal = false;
        leftOffset += count; rightOffset += count;
      }
      // Even a mismatch must drain both original leaves: their aggregate
      // UTF16 length/digest checks execute only on iterator completion.
      await work.step();
    }
  } finally { ai.return?.(); bi.return?.(); }
}
function validateKeyPiece(type, text, offset, done) {
  if (!TYPES.has(type) || typeof text !== 'string' || text.length > CHUNK_CHARS
    || !integer(offset) || typeof done !== 'boolean' || !done && text.length === 0) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
  // Numeric/boolean encodings are canonical and disjoint from strings. Bigints
  // are checked incrementally; no whole decimal is retained in the reader.
  if (type === 'number' || type === 'boolean') {
    if (offset !== 0 || !done || type === 'boolean' && text !== 'true'
      || type === 'number' && (!Number(text) || String(Number(text)) !== text)) throw fail('HISTORY_POSITION_KEY_TYPE');
  } else if (type === 'bigint') {
    if (!/^[0-9-]*$/.test(text) || offset === 0 && !/^-?[1-9]/.test(text)
      || offset > 0 && text.includes('-') || text.slice(1).includes('-')
      || done && offset + text.length === 0) throw fail('HISTORY_POSITION_KEY_TYPE');
  } else if (done && offset + text.length === 0) throw fail('HISTORY_POSITION_FALSY_KEY');
}

// A sealed coordinate graph already owns one genuine SQL pin. Independent
// readers retain that SAME immutable pin through fixed scalar reference counts;
// opening a read does not insert a pin, reset GC, allocate pages or start a
// builder. Each handle has its own closed guard, including its paged cursors.
// The last owner alone releases the original store lease.
function shareSealedPositionPin(store, lease) {
  let references = 0;
  const retain = () => {
    references++; let closed = false;
    const assertOpen = () => { store.assertOpen(); if (closed) throw fail('HISTORY_POSITION_RELEASED'); };
    return Object.freeze({ descriptor: lease.descriptor, assertOpen,
      cursor() { assertOpen(); return new HistoryPagedCursor(store,
        { type: 'page', id: lease.descriptor.page }, assertOpen); },
      fork() { assertOpen(); return retain(); },
      release() { if (closed) return; closed = true; if (--references === 0) lease.release(); },
    });
  };
  return retain();
}

class HistoryPresentationPosition {
  constructor(store, { projectionId, unitCount }) {
    if (!store?.transaction || store.closed || !token(projectionId) || !integer(unitCount)) throw fail('HISTORY_POSITION_CONFIGURATION');
    this.store = store; this.projectionId = projectionId; this.unitCount = unitCount;
    this.closed = false; this.sealed = false; this.sequence = 0; this.partial = null;
    this.last = null; this.pin = null; this.physicalPartial = null; this.unitPhysical = null;
    this.selectedMode = false; this.endBuild = store.beginBuild();
    this.meta = { kind: 'presentation-position', items: vector(), lookup: vector(), unitCount, records: 0 };
    this.metrics = { records: 0, indexedKeys: 0, skippedFalsy: 0, unqueryableKeys: 0,
      maxEvents: 0, maxKeyFragmentChars: 0, maxPartialKeys: 0, nativeCoordinateEntries: 0,
      workSteps: 0, workCheckpoints: 0, maxWorkPerTurn: 0 };
    try { this.publish(this.meta); } catch (error) { this.close(); throw error; }
  }
  assertOpen() { this.store.assertOpen(); if (this.closed) throw fail('HISTORY_POSITION_RELEASED'); }
  assertWritable() { this.assertOpen(); if (this.sealed) throw fail('HISTORY_POSITION_ALREADY_SEALED'); }
  publish(meta) {
    let next;
    try { this.store.transaction(() => { next = this.store.lease({ type: 'page', id: this.store.put(meta, [meta.items.page, meta.lookup.page]) }); }); }
    catch (error) { next?.release(); throw error; }
    const previous = this.pin; this.pin = next; this.meta = meta; previous?.release();
  }
  cursor() { this.assertOpen(); return this.pin.cursor(); }
  checkOrder(record) {
    if (!integer(record.index) || record.index >= this.unitCount || !integer(record.memberCount)
      || !Number.isSafeInteger(record.memberIndex)) throw fail('HISTORY_POSITION_RECORD');
    const valid = record.memberIndex === -1 ? record.memberCount === 1
      : record.memberIndex === -2 ? record.memberCount === 0
        : record.memberIndex >= 0 && record.memberIndex < record.memberCount;
    if (!valid || record.memberIndex === -2 && record.type !== 'skip') throw fail('HISTORY_POSITION_RECORD');
    const before = this.last;
    if (!before) {
      if (record.index !== 0 || record.memberIndex > 0) throw fail('HISTORY_POSITION_ORDER');
    } else if (record.index === before.index) {
      if (before.memberIndex < 0 || record.memberCount !== before.memberCount
        || record.memberIndex !== before.memberIndex + 1) throw fail('HISTORY_POSITION_ORDER');
    } else if (record.index !== before.index + 1 || record.memberIndex > 0
      || before.memberIndex >= 0 && before.memberIndex + 1 !== before.memberCount) throw fail('HISTORY_POSITION_ORDER');
  }
  async find(type, key, work, meta = this.meta) {
    const info = this.store.json(key.id);
    let at = this.store.vectorGet(meta.lookup, typedHash(type, info.digest));
    while (at) {
      work.check();
      const link = this.store.json(at), item = this.store.json(this.store.vectorGet(meta.items, link.ordinal));
      if (item.type === type && await exactText(this.store, item.key, key, work)) return { ordinal: link.ordinal, item };
      at = link.next; await work.step();
    }
    return null;
  }
  async append(sequence, events, { control, assert = () => {} } = {}) {
    this.assertWritable();
    if (sequence !== this.sequence || !Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) throw fail('HISTORY_POSITION_SEQUENCE');
    const work = workControl(control, () => { this.assertWritable(); assert(); }, this.metrics);
    this.metrics.maxEvents = Math.max(this.metrics.maxEvents, events.length);
    try {
      for (const event of events) {
        work.check();
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw fail('HISTORY_POSITION_RECORD');
        // V52: the exact actual frame key is stored once per physical unit.
        // It is not synthesized from a UUID or a future Root address. The
        // index still owns only bounded scalar/page handles in native memory.
        if (event.field === 'physical-key') {
          if (this.partial || !integer(event.index) || event.index >= this.unitCount
            || typeof event.text !== 'string' || event.text.length > CHUNK_CHARS
            || !integer(event.offset) || typeof event.done !== 'boolean'
            || !event.done && !event.text.length) throw fail('HISTORY_POSITION_PHYSICAL_KEY');
          if (!this.physicalPartial) {
            if (event.offset !== 0 || event.index !== (this.last ? this.last.index + 1 : 0)
              || this.last && this.last.memberIndex >= 0 && this.last.memberIndex + 1 !== this.last.memberCount
              || this.unitPhysical?.index === event.index) throw fail('HISTORY_POSITION_PHYSICAL_KEY');
            this.physicalPartial = { index: event.index, offset: 0, writer: this.store.leafWriter() };
            this.selectedMode = true;
          }
          const key = this.physicalPartial;
          if (key.index !== event.index || key.offset !== event.offset) throw fail('HISTORY_POSITION_PHYSICAL_KEY');
          this.store.transaction(() => key.writer.write(event.text)); key.offset += event.text.length;
          if (event.done) {
            let value; this.store.transaction(() => { value = key.writer.finish(); });
            this.unitPhysical = { index: key.index, key: value, chars: key.offset };
            this.physicalPartial = null;
          }
          await work.step(); continue;
        }
        if (event.field !== undefined || this.physicalPartial) throw fail('HISTORY_POSITION_RECORD');
        const skipping = event.type === 'skip' || event.type === 'unqueryable';
        if (this.selectedMode && (this.unitPhysical?.index !== event.index
          || !skipping && (!['prepared', 'current'].includes(event.selectionKind) || !integer(event.selectionOrdinal))
          || skipping && event.selectionKind !== undefined
            && (!['prepared', 'current'].includes(event.selectionKind) || !integer(event.selectionOrdinal)))) {
          throw fail('HISTORY_POSITION_SELECTION');
        }
        if (!this.selectedMode && (event.selectionKind !== undefined || event.selectionOrdinal !== undefined)) throw fail('HISTORY_POSITION_SELECTION');
        if (!this.partial) {
          this.checkOrder(event);
          if (event.offset !== 0) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
          this.partial = { index: event.index, memberIndex: event.memberIndex, memberCount: event.memberCount,
            type: event.type, selectionKind: event.selectionKind, selectionOrdinal: event.selectionOrdinal,
            offset: 0, writer: skipping ? null : this.store.leafWriter() };
          this.metrics.maxPartialKeys = 1;
        }
        const pending = this.partial;
        if (!sameRecord(pending, event) || event.offset !== pending.offset) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
        if (skipping) {
          if (event.text !== '' || event.done !== true) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
        } else {
          validateKeyPiece(event.type, event.text, event.offset, event.done);
          this.metrics.maxKeyFragmentChars = Math.max(this.metrics.maxKeyFragmentChars, event.text.length);
          this.store.transaction(() => pending.writer.write(event.text));
          pending.offset += event.text.length;
        }
        if (event.done) {
          let key = null, found = null;
          if (!skipping) {
            this.store.transaction(() => { key = pending.writer.finish(); });
            found = await this.find(event.type, key, work);
          }
          work.check();
          const next = { ...this.meta, records: this.meta.records + 1 };
          this.store.transaction(() => {
            work.check();
            if (key && (!found || found.item.index !== event.index)) {
              const ordinal = found ? found.ordinal : next.items.length;
              const item = { type: event.type, key: found?.item.key || key, index: event.index, memberIndex: event.memberIndex,
                ...(this.selectedMode ? { memberCount: event.memberCount,
                  selection: { kind: event.selectionKind, ordinal: event.selectionOrdinal }, physicalKey: this.unitPhysical.key } : {}) };
              const page = this.store.put(item, [item.key.id, ...(item.physicalKey ? [item.physicalKey.id] : [])]);
              next.items = this.store.vectorSet(next.items, ordinal, page);
              if (!found) {
                const hash = typedHash(event.type, this.store.json(key.id).digest);
                const previous = this.store.vectorGet(next.lookup, hash);
                const link = this.store.put({ ordinal, next: previous }, [previous]);
                next.lookup = this.store.vectorSet(next.lookup, hash, link);
              }
            }
          });
          // Commit data pages before publishing/releasing JS lease handles.
          // A final quota rollback must never resurrect an already released
          // old SQL pin whose local lease can no longer clean it up.
          work.check(); this.publish(next);
          this.last = { index: event.index, memberIndex: event.memberIndex, memberCount: event.memberCount };
          this.partial = null; this.metrics.records++;
          this.metrics.indexedKeys = this.meta.items.length;
          if (event.type === 'skip') this.metrics.skippedFalsy++;
          if (event.type === 'unqueryable') this.metrics.unqueryableKeys++;
        }
        await work.step();
      }
      work.check(); this.sequence++;
      return this.status();
    } catch (error) { this.close(); throw error; }
  }
  seal(sequence) {
    this.assertWritable();
    if (sequence !== this.sequence || this.partial || this.physicalPartial || (this.unitCount === 0 ? this.last !== null
      : this.last?.index !== this.unitCount - 1 || this.last.memberIndex >= 0
        && this.last.memberIndex + 1 !== this.last.memberCount)) throw fail('HISTORY_POSITION_INCOMPLETE');
    this.pin = shareSealedPositionPin(this.store, this.pin);
    this.sealed = true; this.endBuild?.(); this.endBuild = null; return this.status();
  }
  status() { return { phase: this.sealed ? 'ready' : 'writing', sequence: this.sequence,
    records: this.metrics.records, indexedKeys: this.metrics.indexedKeys,
    skippedFalsy: this.metrics.skippedFalsy, unqueryableKeys: this.metrics.unqueryableKeys }; }
  forkQuery() { this.assertOpen(); if (!this.sealed) throw fail('HISTORY_POSITION_PENDING'); return new HistoryPresentationPositionQuery(this); }
  assertReadOnlyFork() { this.assertOpen(); if (!this.sealed) throw fail('HISTORY_POSITION_PENDING'); this.pin.assertOpen(); }
  close() {
    if (this.closed) return; this.closed = true;
    this.partial = null; this.last = null; this.physicalPartial = null; this.unitPhysical = null;
    try { this.pin?.release(); } finally { this.endBuild?.(); this.endBuild = null; }
  }
}

class HistoryPresentationPositionQuery {
  constructor(parent) {
    parent.assertReadOnlyFork();
    this.store = parent.store; this.projectionId = parent.projectionId; this.unitCount = parent.unitCount;
    this.meta = parent.meta; this.pin = parent.pin.fork();
    this.closed = false; this.complete = false; this.sequence = 0; this.pass = 0;
    this.metrics = { workSteps: 0, workCheckpoints: 0, maxWorkPerTurn: 0,
      hashFragments: 0, comparisonFragments: 0, storedChunks: 0, comparisonPasses: 0,
      targetPageWrites: 0, nativeTargetChars: 0 };
    this.partial = null; this.target = null; this.selected = null; this.next = 0;
    this.candidates = 0; this.replay = false; this.result = null; this.selectedPoint = null;
    this.selectionIterator = null; this.selectionPart = ''; this.selectionAt = 0; this.selectionOffset = 0; this.selectionDone = false;
    this.workBudget = { work: 0 };
  }
  assertOpen() { this.store.assertOpen(); if (this.closed) throw fail('HISTORY_POSITION_RELEASED'); this.pin.assertOpen(); }
  cursor() { this.assertOpen(); return this.pin.cursor(); }
  async chooseCandidate(work) {
    while (this.next) {
      work.check();
      if (++this.candidates > this.meta.items.length) throw fail('HISTORY_POSITION_KEY_CORRUPT');
      const link = this.store.json(this.next);
      if (!integer(link.ordinal) || link.ordinal >= this.meta.items.length || !integer(link.next)) throw fail('HISTORY_POSITION_KEY_CORRUPT');
      const item = this.store.json(this.store.vectorGet(this.meta.items, link.ordinal));
      if (!TYPES.has(item.type) || !item.key || item.key.type !== 'page' || !integer(item.key.id)
        || !integer(item.index) || item.index >= this.unitCount || !Number.isSafeInteger(item.memberIndex) || item.memberIndex < -1) {
        throw fail('HISTORY_POSITION_KEY_CORRUPT');
      }
      this.next = link.next;
      const iterator = this.store.leafChunks(item.key);
      if (item.type !== this.target.type) {
        // A 32-bit bucket may also contain another typed domain. Its negative
        // still completes the visited leaf's aggregate integrity check.
        try { for (;;) { const value = iterator.next(); await work.step(); if (value.done) break; this.metrics.storedChunks++; } }
        finally { iterator.return?.(); }
      } else {
        this.selected = { item, iterator, part: '', offset: 0, done: false, equal: true };
        this.pass++; this.metrics.comparisonPasses++; this.replay = true; return;
      }
      await work.step();
    }
    this.complete = true; this.result = { kind: 'missing' };
  }
  async compareFragment(text, work) {
    const selected = this.selected;
    for (let offset = 0; offset < text.length;) {
      work.check();
      while (!selected.done && selected.offset === selected.part.length) {
        const value = selected.iterator.next(); selected.done = !!value.done;
        selected.part = selected.done ? '' : value.value; selected.offset = 0;
        if (!selected.done) this.metrics.storedChunks++;
        await work.step();
      }
      if (selected.done) { selected.equal = false; break; }
      const count = Math.min(text.length - offset, selected.part.length - selected.offset);
      if (text.slice(offset, offset + count) !== selected.part.slice(selected.offset, selected.offset + count)) selected.equal = false;
      offset += count; selected.offset += count; await work.step();
    }
  }
  async completeComparison(work) {
    const selected = this.selected;
    if (selected.offset !== selected.part.length) selected.equal = false;
    // Fully drain even after content/length mismatch. iterator.return() alone
    // cannot execute the store's terminal aggregate UTF16 digest/length check.
    while (!selected.done) {
      work.check(); const value = selected.iterator.next(); selected.done = !!value.done;
      if (!selected.done) { this.metrics.storedChunks++; if (value.value.length) selected.equal = false; }
      await work.step();
    }
    selected.iterator.return?.(); this.selected = null;
    if (selected.equal) {
      this.complete = true;
      const item = selected.item;
      this.result = { kind: 'found', index: item.index, memberIndex: item.memberIndex };
      if (item.selection) {
        if (!['prepared', 'current'].includes(item.selection.kind) || !integer(item.selection.ordinal)
          || !integer(item.memberCount) || item.memberCount < 1 || item.memberIndex >= item.memberCount
          || item.memberIndex === -1 && item.memberCount !== 1 || item.physicalKey?.type !== 'page'
          || !integer(item.physicalKey.id)) throw fail('HISTORY_POSITION_SELECTION_CORRUPT');
        const physical = this.store.json(item.physicalKey.id);
        if (physical.kind !== 'text' || !integer(physical.totalChars)) throw fail('HISTORY_POSITION_SELECTION_CORRUPT');
        this.selectedPoint = item;
        Object.assign(this.result, { memberCount: item.memberCount, selection: item.selection, physicalKeyChars: physical.totalChars });
      }
    } else await this.chooseCandidate(work);
  }
  async append(sequence, events, { control, assert = () => {}, pass = this.pass } = {}) {
    this.assertOpen();
    if (this.complete || pass !== this.pass || sequence !== this.sequence || !Array.isArray(events)
      || events.length < 1 || events.length > MAX_EVENTS) throw fail('HISTORY_POSITION_SEQUENCE');
    const work = workControl(control, () => { this.assertOpen(); assert(); }, this.metrics, this.workBudget);
    try {
      this.replay = false;
      for (let at = 0; at < events.length; at++) {
        const event = events[at]; work.check();
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
        if (!this.partial) this.partial = { type: event.type, offset: 0, digest: this.store.textDigestFactory() };
        const pending = this.partial;
        if (pending.type !== event.type || pending.offset !== event.offset) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
        if (this.target && event.type !== this.target.type) throw fail('HISTORY_POSITION_TARGET_CHANGED');
        validateKeyPiece(event.type, event.text, event.offset, event.done);
        pending.digest.update(Buffer.from(event.text, 'utf16le')); pending.offset += event.text.length;
        if (this.pass === 0) this.metrics.hashFragments++;
        else { this.metrics.comparisonFragments++; await this.compareFragment(event.text, work); }
        if (event.done) {
          if (at !== events.length - 1) throw fail('HISTORY_POSITION_KEY_FRAGMENT');
          const digest = pending.digest.digest('hex');
          if (this.pass === 0) {
            this.target = { type: event.type, chars: pending.offset, digest };
            this.next = this.store.vectorGet(this.meta.lookup, typedHash(event.type, digest));
            this.partial = null; await this.chooseCandidate(work);
          } else {
            if (pending.offset !== this.target.chars || digest !== this.target.digest) throw fail('HISTORY_POSITION_TARGET_CHANGED');
            this.partial = null; await this.completeComparison(work);
          }
        }
        await work.step();
      }
      work.check(); this.sequence++;
      return { phase: this.complete ? 'done' : this.replay ? 'replay' : 'querying', sequence: this.sequence,
        pass: this.pass, ...(this.complete ? { result: this.result } : {}) };
    } catch (error) { this.close(); throw error; }
  }
  async readSelection(sequence, offset, { control, assert = () => {} } = {}) {
    this.assertOpen();
    if (!this.complete || !this.selectedPoint || sequence !== this.sequence || offset !== this.selectionOffset
      || this.selectionDone) throw fail('HISTORY_POSITION_SELECTION_SEQUENCE');
    const work = workControl(control, () => { this.assertOpen(); assert(); }, this.metrics, this.workBudget);
    try {
      if (!this.selectionIterator) this.selectionIterator = this.store.leafChunks(this.selectedPoint.physicalKey);
      let text = '';
      while (text.length < CHUNK_CHARS) {
        work.check();
        if (this.selectionAt === this.selectionPart.length) {
          const next = this.selectionIterator.next(); await work.step();
          if (next.done) { this.selectionDone = true; break; }
          this.selectionPart = next.value; this.selectionAt = 0;
        }
        const count = Math.min(CHUNK_CHARS - text.length, this.selectionPart.length - this.selectionAt);
        text += this.selectionPart.slice(this.selectionAt, this.selectionAt + count);
        this.selectionAt += count; await work.step();
      }
      this.selectionOffset += text.length;
      // Exact multiples require one terminal empty page. Its iterator.next()
      // performs aggregate UTF16 validation; length alone is never a receipt.
      if (this.selectionOffset > this.result.physicalKeyChars
        || this.selectionDone && this.selectionOffset !== this.result.physicalKeyChars) throw fail('history_leaf_corrupt');
      work.check(); this.sequence++;
      return { phase: 'selection', sequence: this.sequence, offset, nextOffset: this.selectionOffset,
        done: this.selectionDone, text };
    } catch (error) { this.close(); throw error; }
  }
  close() { if (this.closed) return; this.closed = true; this.partial = null;
    try { this.selected?.iterator.return?.(); }
    finally { try { this.selectionIterator?.return?.(); }
      finally { this.selected = null; this.target = null; this.selectedPoint = null; this.selectionIterator = null;
        this.selectionPart = ''; this.pin.release(); } } }

}

module.exports = { HistoryPresentationPosition, HistoryPresentationPositionQuery,
  HISTORY_PRESENTATION_POSITION_PROFILE: PROFILE, HISTORY_PRESENTATION_POSITION_QUERY_ENCODING: QUERY_ENCODING,
  HISTORY_PRESENTATION_POSITION_CHUNK_CHARS: CHUNK_CHARS, HISTORY_PRESENTATION_POSITION_MAX_EVENTS: MAX_EVENTS };
