'use strict';
// Reader-owned derived indexes over one immutable canonical source cut.
// This is not yet prompt/timing/runtime semantic preparation or a UI view.
const { HistoryProjectionArena } = require('./history-projection-arena');
const text = require('./history-paged-text');
const fail = code => Object.assign(new Error(code), { code });
const nonemptyText = value => text.isText(value) && value.length > 0;
const same = (a, b) => text.isText(a) && text.equal(a, b);
async function trimmedFacts(value, { checkpoint, observeChunk = () => {} } = {}) {
  if (!text.isText(value)) return { hasContent: false, trimmedLength: 0 };
  let leading = 0, trailing = 0, seen = false, length = 0, chunks = 0;
  for (const part of text.chunks(value)) {
    observeChunk(part.length);
    length += part.length;
    for (let index = 0; index < part.length; index++) {
      if (/\s/u.test(part[index])) { if (seen) trailing++; else leading++; }
      else { seen = true; trailing = 0; }
    }
    if (++chunks % 64 === 0 && checkpoint) await checkpoint();
  }
  return { hasContent: seen, trimmedLength: seen ? length - leading - trailing : 0 };
}
const validIndex = (index, total) => Number.isSafeInteger(index) && index >= 0 && index <= total;
class HistoryRootIndexes {
  constructor(store, lease, stats) {
    this.lease = lease; this.arena = new HistoryProjectionArena(store, lease);
    this.root = lease.cursor(); this.entries = this.root.field('entries'); this.closed = false;
    this.buildStats = stats; this.metrics = { lookups: 0, rankComparisons: 0, maxReturnedOrdinals: 0 };
  }
  assertOpen() { if (this.closed) throw fail('HISTORY_ROOT_INDEX_RELEASED'); this.lease.cursor(); }
  lookup(identity, { offset = 0, limit = 3, aliases = true } = {}) {
    this.assertOpen(); const total = this.entries.length;
    if (!nonemptyText(identity) || !validIndex(offset, total) || !Number.isSafeInteger(limit) || limit < 1 || limit > 3) {
      throw fail('HISTORY_ROOT_INDEX_RANGE');
    }
    const root = this.arena.state(), values = (aliases ? root.identities : root.uuids).get(identity);
    const count = values?.length || 0; let lo = 0, hi = count;
    // A repeated identity may itself span the entire history. Its ordinal list
    // stays paged; seek must not linearly walk all earlier members.
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2); this.metrics.rankComparisons++;
      if (values[mid] < offset) lo = mid + 1; else hi = mid;
    }
    const ordinals = [];
    for (let at = lo; at < count && ordinals.length < limit; at++) ordinals.push(values[at]);
    this.metrics.lookups++; this.metrics.maxReturnedOrdinals = Math.max(this.metrics.maxReturnedOrdinals, ordinals.length);
    return Object.freeze({ totalMatches: count, ordinals: Object.freeze(ordinals),
      nextOffset: lo + ordinals.length < count ? ordinals.at(-1) + 1 : total,
      done: lo + ordinals.length >= count });
  }
  settingsBefore(offset) {
    this.assertOpen(); if (!validIndex(offset, this.entries.length)) throw fail('HISTORY_ROOT_INDEX_RANGE');
    return this.root.field('settingsBefore').at(offset);
  }
  hasSessionId(value) {
    this.assertOpen();
    return nonemptyText(value) && this.arena.state().physicalSessions.has(value);
  }
  factsAt(offset) {
    this.assertOpen(); if (!validIndex(offset, this.entries.length - 1)) throw fail('HISTORY_ROOT_INDEX_RANGE');
    return this.root.field('facts').at(offset);
  }
  stats() { this.assertOpen(); return { ...this.buildStats, ...this.metrics, ownership: this.arena.inspectOwnership(),
    indexKind: 'canonical-derived-index-v1', completeSemanticSnapshot: false, nativeMemoryMeasured: false }; }
  close() { if (this.closed) return; this.closed = true; try { this.arena.close(); } finally { this.lease.release(); } }
}
async function buildHistoryRootIndexes(store, canonicalRoot, { control } = {}) {
  const arena = new HistoryProjectionArena(store, canonicalRoot);
  let frame, lease, priorModel = null, priorEffort = null;
  const stats = { rows: 0, indexedIdentities: 0, indexedUUIDs: 0, maxTrimmedTextChunk: 0 };
  const checkpoint = async () => {
    if (control?.checkpoint) await control.checkpoint();
    else await new Promise(resolve => setImmediate(resolve));
    control?.assertCurrent();
  };
  const insert = (map, identity, ordinal, metric) => {
    if (!nonemptyText(identity)) return;
    let positions = map.get(identity);
    if (!positions) { positions = arena.make('array'); map.set(identity, positions); stats[metric]++; }
    if (!positions.length || positions[positions.length - 1] !== ordinal) positions.push(ordinal);
  };
  try {
    control?.assertCurrent();
    frame = arena.step(() => {
      const view = arena.make('object'); view.version = 1; view.entries = arena.state();
      view.uuids = arena.make('map'); view.identities = arena.make('map'); view.physicalSessions = arena.make('map');
      view.settingsBefore = arena.make('array'); view.facts = arena.make('array');
      return view;
    });
    for (let ordinal = 0; ordinal < frame.entries.length; ordinal++) {
      control?.assertCurrent();
      const row = frame.entries[ordinal];
      const options = { checkpoint, observeChunk: length => { stats.maxTrimmedTextChunk = Math.max(stats.maxTrimmedTextChunk, length); } };
      const content = await trimmedFacts(row?.content, options), thinking = await trimmedFacts(row?.thinking, options);
      arena.step(() => {
        frame.settingsBefore.push({ model: priorModel, effort: priorEffort });
        frame.facts.push({ hasContent: content.hasContent, contentLength: content.trimmedLength,
          hasThinking: thinking.hasContent, thinkingLength: thinking.trimmedLength });
        insert(frame.uuids, row?.uuid, ordinal, 'indexedUUIDs');
        insert(frame.identities, row?.uuid, ordinal, 'indexedIdentities');
        insert(frame.identities, row?.sourceIdentity, ordinal, 'indexedIdentities');
        insert(frame.identities, row?.entryRef?.sourceIdentity, ordinal, 'indexedIdentities');
        const session = text.trim(text.coerce(row?.sessionId || ''));
        if (session.length) frame.physicalSessions.set(session, true);
        for (const name of ['sourceIdentityAliases', 'uuidAliases', 'sourceUuidAliases']) {
          const aliases = row?.[name];
          if (Array.isArray(aliases)) for (const alias of aliases) insert(frame.identities, alias, ordinal, 'indexedIdentities');
        }
        const fact = row?.settingsFact;
        if (fact?.version === 1 && same(fact.provider, 'codex') && nonemptyText(fact.value)) {
          if (same(fact.kind, 'model')) priorModel = row;
          else if (same(fact.kind, 'effort')) priorEffort = row;
        }
        stats.rows++;
      });
      if (ordinal % 32 === 31) await checkpoint();
    }
    arena.step(() => {
      frame.settingsBefore.push({ model: priorModel, effort: priorEffort });
      lease = arena.publish(frame);
    });
    control?.assertCurrent();
    const index = new HistoryRootIndexes(store, lease, stats); lease = null;
    return index;
  } finally { lease?.release(); arena.close(); }
}
module.exports = { buildHistoryRootIndexes, HistoryRootIndexes, trimmedFacts };

