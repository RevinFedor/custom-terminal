'use strict';

// Opt-in reader preparation only. Rootplane admission/authentication, consumer
// credits, signed addresses and frontend installation remain the caller's job.
const { createHash, randomBytes } = require('node:crypto');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { forkFrozenCanonical } = require('./history-frozen-canonical');
const { materializeHistoryCursorSync: scalar, materializeHistoryCursor,
  isHistoryPagedCursor } = require('./history-paged-store');
const { createHistorySearchAccumulator, historySearchEntryKeys,
  normalizeHistorySearchType, HISTORY_SEARCH_PAGE_SIZE } = require('../shared/history-search.cjs');
const fail = code => Object.assign(new Error(code), { code });
const PROFILE = 'history-search-v1';

// Only these identities are selected, using the exact shared key helper below.
// Aliases stream one scalar at a time; no native row/UUID/alias list is kept.
// entryRef's complete value is copied by reference only for requested matches.
function identityProjection(row, control) {
  const read = cursor => { control?.assertCurrent(); return scalar(cursor, { control }); };
  const aliases = name => ({ *[Symbol.iterator]() {
    const cursor = row.field(name);
    if (cursor.kind === 'array') {
      for (let i = 0; i < cursor.length; i++) {
        const item = cursor.at(i);
        // Non-string keys are ignored by the shared helper. Do not decode
        // an invalid key's arbitrary nested graph merely to ignore it.
        yield ['object', 'array'].includes(item.kind) ? undefined : read(item);
      }
    } else {
      // Preserve the helper's iterable semantics for a string alias value,
      // including Unicode code-point iteration, rather than treating it as ID.
      if (cursor.kind === 'object') throw new TypeError('History search aliases must be iterable');
      yield* (read(cursor) || []);
    }
  } });
  const ref = row.field('entryRef');
  return { uuid: read(row.field('uuid')), sourceIdentity: read(row.field('sourceIdentity')),
    entryRef: ['object', 'array'].includes(ref.kind) ? { sourceIdentity: read(ref.field('sourceIdentity')) } : read(ref),
    sourceIdentityAliases: aliases('sourceIdentityAliases'), uuidAliases: aliases('uuidAliases') };
}
function querySnapshot(options) {
  // Take the same coercions as the legacy matcher, once, before any yield.
  // Preserve query case and UTF-16. Locale lowercase stays inside the matcher.
  return Object.freeze({ query: String(options.query === undefined ? '' : options.query),
    type: normalizeHistorySearchType(options.type),
    offset: Math.max(0, Math.floor(Number(options.offset) || 0)),
    limit: Math.max(1, Math.min(5000, Math.floor(Number(options.limit) || HISTORY_SEARCH_PAGE_SIZE))) });
}
function revision(lease, source, options) {
  // SQL page IDs may be reused after every old lease is released and GC.
  // This is an opaque per-cut identity, never a counts-only/content hash.
  return createHash('sha256').update(randomBytes(32)).update(PROFILE)
    .update(JSON.stringify(source.sourceSnapshot)).update(JSON.stringify(source.root.descriptor))
    .update(JSON.stringify(lease.descriptor)).update(options.query, 'utf16le')
    .update(JSON.stringify([options.type, options.offset, options.limit])).digest('hex');
}

class PagedHistorySearchPresentation {
  constructor(store, root, frozen, header, token, metrics) {
    this.store = store; this.root = root; this.frozen = frozen; this.header = header;
    this.viewRevisionToken = token; this.metrics = Object.freeze({ ...metrics }); this.closed = false;
    this.arena = new HistoryProjectionArena(store, root);
  }
  assertOpen() {
    if (this.closed) throw fail('HISTORY_SEARCH_RELEASED');
    this.root.cursor(); this.arena.assertOpen();
  }
  // Complete membership remains reader-owned. No turnKeys/UUID array export.
  hasTurnKey(key) { this.assertOpen(); return this.arena.state().turnKeys.has(key); }
  hasEntryUuid(key) { this.assertOpen(); return this.arena.state().entryUuids.has(key); }
  hasEntryKey(key) { this.assertOpen(); return this.arena.state().entryKeys.has(key); }
  currentKeys(index) {
    this.assertOpen();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.header.total) return null;
    const ranges = this.arena.state().matchRanges;
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (ranges[mid].end <= index) lo = mid + 1; else hi = mid;
    }
    const range = lo < ranges.length ? ranges[lo] : null;
    return range && range.start <= index ? range.keys : null;
  }
  stats() { this.assertOpen(); return { ...this.metrics, ownership: this.arena.inspectOwnership(),
    retainedMatches: this.header.returned, matchRanges: this.arena.state().matchRanges.length,
    nativeMemoryBounded: false, nativeMemoryMeasured: false, bodyBoundary: 'BodyOPEN: one full content String plus locale lowercase' }; }
  fork() {
    this.assertOpen();let root,frozen;
    try{root=this.root.fork();frozen=forkFrozenCanonical(this.store,this.frozen);
      return new PagedHistorySearchPresentation(this.store,root,frozen,this.header,this.viewRevisionToken,this.metrics);
    }catch(error){root?.release();frozen?.release();throw error;}
  }
  release() {
    if (this.closed) return; this.closed = true;
    let error;
    for (const close of [() => this.arena.close(), () => this.root.release(), () => this.frozen.release()]) {
      try { close(); } catch (e) { error ||= e; }
    }
    if (error) throw error;
  }
  close() { this.release(); }
}

async function preparePagedHistorySearchRoot(store, rawCanonical, { options = {}, control } = {}) {
  control?.assertCurrent();
  const opts = querySnapshot(options);
  if (!isHistoryPagedCursor(rawCanonical?.entries) || rawCanonical.entries.kind !== 'array')
    throw fail('HISTORY_SEARCH_CANONICAL_ARRAY_REQUIRED');
  // Validate same store before retaining anything. This may wrap a logical
  // cursor in constant metadata; it does not decode entries or their bodies.
  store.transaction(() => store.referenceForCursor(rawCanonical.entries));
  let frozen, arena, lease, presentation, transferred = false;
  const endBuild = store.beginBuild();
  const metrics = { rows: 0, maxResidentRowProjections: 0, maxContentChars: 0,
    fullMatchDTOs: 0, pagedMarkers: true };
  try {
    // Independent Source pins BEFORE the first asynchronous content read.
    frozen = forkFrozenCanonical(store, rawCanonical);
    arena = new HistoryProjectionArena(store);
    const state = arena.step(() => {
      const s = arena.state(); s.matches = arena.make('array'); s.turnKeys = arena.make('set');
      s.entryUuids = arena.make('set');s.entryKeys=arena.make('set'); s.matchRanges = arena.make('array');
      s.canonicalEntries = frozen.entries; s.sessionMeta = frozen.sessionMeta;
      return s;
    });
    let currentRow;
    const scan = createHistorySearchAccumulator(opts, {
      matches: state.matches, turnKeys: state.turnKeys,
      // Legacy array insertion semantics matter only in the legacy response;
      // this new profile needs complete UUID membership, not an exported list.
      entryUuids: { push: key => {
        state.entryUuids.add(key);
        historySearchEntryKeys(identityProjection(currentRow,control),{seen:{has:()=>false,add(){}},keys:{push:id=>state.entryKeys.add(id)}});
      } },
      createEntryKeys: () => ({ keys: arena.make('array'), seen: arena.make('set') }),
      copyTurnKeys: keys => keys,
      appendMatch(match) {
        // All remaining match fields use the unmodified matcher. Full entryRef
        // is a same-store immutable cursor, not the small identity projection.
        state.matches.push({ ...match, entryRef: match.entryRef ? currentRow.field('entryRef') : null });
        metrics.fullMatchDTOs++;
      },
      entryMatches(start, end, keys) {
        const set = arena.make('set');
        for (const key of keys) set.add(key);
        state.matchRanges.push(arena.record({ start, end, keys: set }));
      },
    });
    for (let index = 0; index < frozen.entries.length; index++) {
      control?.assertCurrent(); currentRow = frozen.entries.at(index);
      const entry = identityProjection(currentRow, control);
      for (const name of ['role', 'serviceCarrier', 'imageCount', 'physicalSessionId', 'sessionId'])
        entry[name] = scalar(currentRow.field(name), { control });
      // BodyOPEN intentionally retains exact JS String + toLocaleLowerCase,
      // including locale-dependent expansion, lone surrogates, NUL and CRLF.
      entry.content = await materializeHistoryCursor(currentRow.field('content'), { control });
      const images = currentRow.field('imagePaths');
      entry.imagePaths = images.kind === 'array' && images.length ? [null] : [];
      control?.assertCurrent(); arena.step(() => scan.accept(entry, index));
      metrics.rows++; metrics.maxResidentRowProjections = 1;
      metrics.maxContentChars = Math.max(metrics.maxContentChars, typeof entry.content === 'string' ? entry.content.length : 0);
      if (control?.checkpoint) await control.checkpoint();
      else await new Promise(resolve => setImmediate(resolve));
    }
    control?.assertCurrent();
    const summary = scan.result();
    arena.step(() => { lease = arena.publish(); });
    const token = revision(lease, frozen, opts);
    const header = Object.freeze({ readProfile: PROFILE, searchSchema1: 1, total: summary.total,
      entryTotal: summary.entryTotal, offset: summary.offset, limit: opts.limit,
      returned: state.matches.length, truncated: summary.truncated, markerCoverage: 'complete',
      currentMatchCoverage: 'complete', viewRevisionToken: token });
    presentation = new PagedHistorySearchPresentation(store, lease, frozen, header, token, metrics);
    control?.assertCurrent();
    const result = { ...rawCanonical, readProfile: PROFILE, root: lease, entries: lease.cursor().field('matches'),
      sessionMeta: lease.cursor().field('sessionMeta'), ...(frozen.checkpoint ? { checkpoint: frozen.checkpoint } : {}),
      sourceSnapshot: frozen.sourceSnapshot, searchPresentation: presentation, searchHeader: header,
      viewRevisionToken: token, release: () => presentation.release() };
    transferred = true; return result;
  } finally {
    // Preserve the original cancellation/quota error; never retry or publish
    // a partial search. Unreachable pages are reclaimed by the existing GC.
    try { arena?.close(); } finally {
      try {
        if (!transferred) {
          if (presentation) presentation.release();
          else { try { lease?.release(); } finally { frozen?.release(); } }
        }
      } finally { endBuild(); }
    }
  }
}

// Parent MUST authenticate BOTH RootCaps to the same consumer, owner, source,
// session/cwd/generation BEFORE calling. Same-store is an additional local
// invariant, not cross-client/source authentication. This helper does no I/O
// outside that store, no body read, no mutation and exports only three scalars.
function aggregatePagedHistorySearchMarkers(searchPresentation, timelineView,
  { logicalRank, groupKey, currentMatchIndex } = {}, { control } = {}) {
  if (!(searchPresentation instanceof PagedHistorySearchPresentation)
    || searchPresentation.store !== timelineView?.store) throw fail('HISTORY_SEARCH_SAME_STORE_REQUIRED');
  searchPresentation.assertOpen(); timelineView.assert(); control?.assertCurrent();
  if ((logicalRank !== undefined) === (groupKey !== undefined)) throw fail('HISTORY_SEARCH_TARGET_REQUIRED');
  const currentKeys = searchPresentation.currentKeys(currentMatchIndex);
  const covered = currentMatchIndex == null || currentKeys !== null;
  let match = false, current = false;
  const accept = rank => {
    control?.assertCurrent();
    const row = timelineView.actualRow(rank), entry = identityProjection(row, control);
    // A visitor sink avoids even a selected row's Native alias set/array.
    // Duplicate keys are harmless for Boolean membership; filtering/order are
    // still exactly the shared historySearchEntryKeys helper's contract.
    historySearchEntryKeys(entry, { seen: { has: () => false, add() {} }, keys: { push(key) {
      match ||= searchPresentation.hasTurnKey(key);
      current ||= !!currentKeys?.has(key);
    } } });
  };
  if (groupKey !== undefined) {
    if (typeof groupKey !== 'string' || groupKey.length !== 64) throw fail('HISTORY_SEARCH_GROUP_KEY');
    const group = timelineView.group(groupKey);
    if (!group) throw fail('HISTORY_SEARCH_GROUP_NOT_FOUND');
    const ranks = group.field('memberRanks');
    if (ranks.kind !== 'array') throw fail('HISTORY_SEARCH_GROUP_MEMBERS_REQUIRED');
    for (let i = 0; i < ranks.length; i++) {
      accept(ranks.at(i).scalar());
      if (match && (current || !currentKeys)) break;
    }
  } else accept(logicalRank);
  control?.assertCurrent();
  return Object.freeze({ match, current, currentMatchCovered: covered });
}
module.exports = { preparePagedHistorySearchRoot, aggregatePagedHistorySearchMarkers,
  PagedHistorySearchPresentation, HISTORY_SEARCH_PROFILE: PROFILE };
