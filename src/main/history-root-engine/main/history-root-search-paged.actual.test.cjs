'use strict';
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), v8 = require('node:v8');
const MAIN=__dirname,ROOT=path.resolve(__dirname,'../../../..');
const shared=require('../shared/history-search.cjs'),original=require('../../../shared/history-search.cjs');
const {preparePagedHistorySearchRoot:prepare,aggregatePagedHistorySearchMarkers:aggregate}=require('./history-root-search-paged');
const SQLite=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const { HistoryPagedStore, materializeHistoryCursorSync: mat } = require(path.join(MAIN, 'history-paged-store'));
const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
const { forkFrozenCanonical } = require(path.join(MAIN, 'history-frozen-canonical'));
const { createTimelineLogicalRoot } = require(path.join(MAIN, 'timeline-root-logical'));
const { createTimelineRootView } = require(path.join(MAIN, 'timeline-root-view'));
const { HistoryRootReadPlane } = require(path.join(MAIN, 'history-root-read-plane'));
const EVIDENCE=process.env.NOTED_PAGED_SEARCH_EVIDENCE;assert(EVIDENCE&&path.isAbsolute(EVIDENCE));
fs.mkdirSync(EVIDENCE, { recursive: true });
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'V8 TOTAL <=128MiB');
let peakFixtureBytes = 0, peakHeapTotal = 0, parityCases = 0, wirePages = 0;
const fixtureDirs = new Set();
function sample() {
  let bytes = 0;
  for (const dir of fixtureDirs) for (const name of fs.readdirSync(dir)) {
    const stat = fs.lstatSync(path.join(dir, name)); assert(!stat.isSymbolicLink()); bytes += stat.size;
  }
  peakFixtureBytes = Math.max(peakFixtureBytes, bytes); assert(bytes <= 64 * 1024 ** 2, 'ALL own fixtures <=64MiB');
  peakHeapTotal = Math.max(peakHeapTotal, process.memoryUsage().heapTotal);
  assert(process.memoryUsage().heapTotal <= 128 * 1024 ** 2);
}
const control = { assertCurrent() {}, async checkpoint() { sample(); await new Promise(resolve => setImmediate(resolve)); } };
function pins(store) {
  return { leases: store.stats().leases, builders: store.stats().activeBuilders,
    pins: store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n };
}
function gc(store) {
  for (let i = 0; i < 100000; i++) if (store.collectStep(128).complete) return;
  assert.fail('finite GC work exhausted');
}
function publish(store, value) {
  const arena = new HistoryProjectionArena(store);
  try { return arena.step(() => arena.publish(value)); } finally { arena.close(); }
}
function raw(store, entries) {
  const root = publish(store, { entries }), metadata = publish(store, { sessionId: 's', source: 'fixture' });
  let released = false;
  return { success: true, representation: 'codex-canonical-root-v1', semanticSnapshotComplete: true,
    root, entries: root.cursor().field('entries'), sessionMeta: metadata.cursor(),
    sourceSnapshot: { sessionId: 's', revision: 'fixture', cwd: '/fixture', generation: 'fixture-generation' },
    release() { if (released) return; released = true; root.release(); metadata.release(); } };
}
function fixture(t, diskBytes = 28 * 1024 ** 2) {
  const dir = fs.mkdtempSync(path.join(EVIDENCE, 'fixture-'));
  fixtureDirs.add(dir);
  const store = new HistoryPagedStore({ filename: path.join(dir, 'pages.sqlite'), Database: SQLite, diskBytes });
  const held = [];
  const hold = x => { held.push(x); return x; };
  t.after(() => {
    try {
      for (let i = held.length - 1; i >= 0; i--) held[i].release();
      assert.deepEqual(pins(store), { leases: 0, builders: 0, pins: 0 });
      gc(store);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pages').get().n, 0);
      const stats = store.stats();
      assert(stats.peakCachedPages <= 3); assert(stats.peakIndexBytes <= 2048);
      assert(stats.peakPageWriteBytes <= 1024); assert(stats.peakPageReadBytes <= 1024);
      assert.equal(store.db.pragma('journal_mode', { simple: true }), 'delete');
      assert.equal(store.db.pragma('synchronous', { simple: true }), 2);
      sample();
    } finally {
      store.close(); fs.rmSync(dir, { recursive: true }); fixtureDirs.delete(dir); global.gc?.();
    }
  });
  return { store, hold, raw: entries => hold(raw(store, entries)) };
}
const user = (uuid, content = '', extra = {}) => ({ uuid, type: 'user', role: 'user', content, sessionId: 's', ...extra });
const assistant = (uuid, content, extra = {}) => ({ uuid, type: 'assistant', role: 'assistant', content, sessionId: 's', ...extra });
const entries = [
  assistant('orphan', 'needle before a user'),
  user('u0', 'plain', { sourceIdentity: 'sid0', entryRef: { sourceIdentity: 'ref0', ordinal: 2 },
    sourceIdentityAliases: ['inherited:ancestor', 'sid0', '', null, 17, 'key\ud800', 'key\0', 'key\r\n'], uuidAliases: ['old-u0', 'inherited:ancestor'] }),
  assistant('a0', 'NEEDLE needle aaa İSTANBUL ΣΟΣ 😀 \ud800 \udc00 A\0B\r\nC', { physicalSessionId: 'physical', entryRef: { sourceIdentity: 'a-ref', ordinal: 3, extra: { proof: 'kept' } } }),
  user('service', 'needle service', { serviceCarrier: true }),
  assistant('a1', 'needle after service'),
  user('images', '', { imageCount: 3 }),
  user('paths', '', { imagePaths: ['unused-image-path'] }),
  assistant('images-answer', 'needle images answer'),
  user('u2', 'İσς ΣΟΣ aaa\0\r\n😀 \ud800', { uuidAliases: ['old-u2'], sourceIdentityAliases: ['inherited:2'] }),
  assistant('a2', 'x'.repeat(510) + '😀 NEEDLE ' + 'x'.repeat(40) + '\ud800\0\r\nEND'),
  { role: 'user', content: 'needle missing UUID' },
  user('duplicate', 'needle one'), user('duplicate', 'needle two'),
];

function checkMembership(presentation, expected) {
  for (const key of expected.turnKeys) assert.equal(presentation.hasTurnKey(key), true, key);
  for (const key of expected.entryUuids) assert.equal(presentation.hasEntryUuid(key), true, key);
  for (const key of ['absent', 'needle', 'a-ref', 'orphan']) {
    assert.equal(presentation.hasTurnKey(key), expected.turnKeys.includes(key));
    assert.equal(presentation.hasEntryUuid(key), expected.entryUuids.includes(key));
  }
}
async function compare(f, data, options) {
  const expected = original.searchHistoryEntries(data, options);
  assert.deepEqual(shared.searchHistoryEntries(data, options), expected, 'unchanged Native response');
  const result = await prepare(f.store, f.source, { options, control });
  try {
    assert.deepEqual(mat(result.entries), expected.matches, JSON.stringify(options));
    assert.deepEqual({ total: result.searchHeader.total, entryTotal: result.searchHeader.entryTotal,
      offset: result.searchHeader.offset, truncated: result.searchHeader.truncated },
    { total: expected.total, entryTotal: expected.entryTotal, offset: expected.offset, truncated: expected.truncated });
    assert.match(result.viewRevisionToken, /^[a-f0-9]{64}$/);
    assert.equal(result.viewRevisionToken, result.searchHeader.viewRevisionToken);
    assert.equal(result.searchHeader.readProfile, 'history-search-v1');
    assert(result.entries.length <= Math.min(5000, Math.max(1, Math.floor(Number(options.limit) || 100))));
    checkMembership(result.searchPresentation, expected);
    const stats = result.searchPresentation.stats();
    assert.equal(stats.fullMatchDTOs, expected.matches.length);
    assert.equal(stats.ownership.nativeRows, 0); assert.equal(stats.ownership.nativeMapEntries, 0);
    assert(stats.ownership.handleCache <= 3);
    parityCases++;
  } finally { result.release(); gc(f.store); sample(); }
}

test('exact original matcher, content/snippet/UTF16 parity, all types and page offsets', async t => {
  const f = fixture(t); f.source = f.raw(entries);
  const queries = ['needle', 'aaa', 'İ', 'i\u0307', 'ΣΟΣ', 'ς', '😀', '\ud800', '\udc00', '\0', '\r\n', '', 'no-match'];
  for (const query of queries) {
    for (const type of ['all', 'user', 'assistant', 'user-images'])
      await compare(f, entries, { query, type, offset: (parityCases % 3) * 2, limit: 2 });
  }
  for (const options of [{ query: 'needle', offset: 0 }, { query: 'needle', offset: 1000, limit: 100 },
    { query: 'needle', offset: -4, limit: 10000 }, { query: null, type: 'unknown', offset: '1.9', limit: '2.9' },
    { query: '', type: 'user-images', limit: 1 }, { query: 'e', type: 'user', limit: -1 }]) await compare(f, entries, options);
  assert.deepEqual(shared.historySearchEntryKeys(Object.create({ uuid: 'u', sourceIdentityAliases: ['inherited'] })), ['u', 'inherited']);
  assert.deepEqual(shared.historySearchEntryKeys({ uuid: 'u', uuidAliases: 'a😀' }), original.historySearchEntryKeys({ uuid: 'u', uuidAliases: 'a😀' }));
});

async function view(f, source, { outline = null, options = {} } = {}) {
  let annotations;
  if (outline) {
    const root = publish(f.store, { notes: [], outline, promptSummaries: [], turnActionOverrides: [] });
    const wrap = held => ({ root: held, revision: 'ann', notes: held.cursor().field('notes'), outline: held.cursor().field('outline'),
      promptSummaries: held.cursor().field('promptSummaries'), turnActionOverrides: held.cursor().field('turnActionOverrides'),
      hasRewindMarker: () => false, fork: () => wrap(held.fork()), release: () => held.release() });
    annotations = wrap(root);
  }
  let logical, optionRoot;
  try {
    logical = await createTimelineLogicalRoot(f.store, source, { annotations, control });
    optionRoot = publish(f.store, { sourceGeneration: 'fixture-generation', ...options });
    return f.hold(await createTimelineRootView({ store: f.store, logicalRoot: logical, optionsRoot: optionRoot, control }));
  } finally { logical?.release(); optionRoot?.release(); annotations?.release(); }
}
function groups(v, kind) { return mat(v.root.field(kind)); }
function expectedAggregate(data, search, currentIndex) {
  const current = original.searchHistoryEntries(data.search, { query: search.query, type: search.type, offset: currentIndex, limit: 1 }).matches[0];
  const all = original.searchHistoryEntries(data.search, search), set = new Set(all.turnKeys), currentSet = new Set(current?.turnKeys || []);
  return { match: data.rows.some(e => original.historySearchEntryKeys(e).some(k => set.has(k))),
    current: data.rows.some(e => original.historySearchEntryKeys(e).some(k => currentSet.has(k))), currentMatchCovered: currentIndex >= 0 && currentIndex < all.total };
}

test('actual Timeline automatic/semantic closed group: hit only hidden child; exact aliases and current outside held page', async t => {
  const f = fixture(t), tag = { kind: 'prompt-origin', source: 'terminal-mcp' };
  const data = [user('first', 'head misses', { semanticTags: [tag] }),
    user('hidden', 'needle hidden needle', { semanticTags: [tag], sourceIdentity: 'sid-hidden',
      entryRef: { sourceIdentity: 'ref-hidden' }, sourceIdentityAliases: ['ancestor-hidden'], uuidAliases: ['old-hidden'] }),
    user('last', 'miss', { semanticTags: [tag] }), user('ordinary', 'needle different turn')];
  const source = f.raw(data), v = await view(f, source);
  const search = f.hold(await prepare(f.store, source, { options: { query: 'needle', offset: 2, limit: 1 }, control }));
  assert.equal(mat(search.entries)[0].entryUuid, 'ordinary', 'held page does not contain hidden child');
  const auto = groups(v, 'automatic')[0]; assert(auto && auto.memberRanks.length === 3 && auto.expanded === false);
  assert.equal(v.resolve({ logicalRank: 1 }).visualRank, v.resolve({ logicalRank: 0 }).visualRank);
  assert.deepEqual(aggregate(search.searchPresentation, v, { logicalRank: 0, currentMatchIndex: 0 }), { match: false, current: false, currentMatchCovered: true });
  assert.deepEqual(aggregate(search.searchPresentation, v, { groupKey: auto.key, currentMatchIndex: 0 }),
    expectedAggregate({ search: data, rows: data.slice(0, 3) }, { query: 'needle' }, 0));
  assert.deepEqual(aggregate(search.searchPresentation, v, { groupKey: auto.key, currentMatchIndex: 2 }), { match: true, current: false, currentMatchCovered: true });
  assert.deepEqual(aggregate(search.searchPresentation, v, { groupKey: auto.key, currentMatchIndex: 99 }), { match: true, current: false, currentMatchCovered: false });
  assert.deepEqual(aggregate(search.searchPresentation, v, { groupKey: auto.key }), { match: true, current: false, currentMatchCovered: true });
  assert.throws(() => aggregate(search.searchPresentation, v, { groupKey: 'f'.repeat(64) }), { code: 'HISTORY_SEARCH_GROUP_NOT_FOUND' });
  assert.throws(() => aggregate(search.searchPresentation, v, { groupKey: auto.key, logicalRank: 0 }), { code: 'HISTORY_SEARCH_TARGET_REQUIRED' });
  const semanticData = [user('s1', 'head'), user('s2', 'needle hidden child'), user('s3', 'tail')], semanticSource = f.raw(semanticData);
  const outline = { schemaVersion: 2, outline: { groups: [{ id: 'semantic', title: 'Title', memberUuids: ['s1', 's2', 's3'], members: [] }], turns: [], metaPrompts: [] } };
  const sv = await view(f, semanticSource, { outline, options: { expandedLayout: true, expandedSemantic: [] } });
  const ss = f.hold(await prepare(f.store, semanticSource, { options: { query: 'needle' }, control }));
  const sg = groups(sv, 'semantic')[0]; assert(sg && !sg.expanded);
  assert.equal(sv.resolve({ logicalRank: 1 }).representative.kind, 'semantic-header');
  assert.deepEqual(aggregate(ss.searchPresentation, sv, { groupKey: sg.key, currentMatchIndex: 0 }), { match: true, current: true, currentMatchCovered: true });
  // Probe each exact helper channel using separate logical identity rows. No
  // matched UUID fallback is allowed; all five channels come from shared code.
  for (const field of ['uuid', 'sourceIdentity', 'entryRef', 'sourceIdentityAliases', 'uuidAliases']) {
    const id = field === 'uuid' ? 'hidden' : field === 'sourceIdentity' ? 'sid-hidden' : field === 'entryRef' ? 'ref-hidden' : field === 'sourceIdentityAliases' ? 'ancestor-hidden' : 'old-hidden';
    const row = user('alias-probe-' + field, 'unused', { [field]: field === 'entryRef' ? { sourceIdentity: id } : field.endsWith('Aliases') ? [id] : id });
    const aliasView = await view(f, f.raw([row]));
    assert.deepEqual(aggregate(search.searchPresentation, aliasView, { logicalRank: 0, currentMatchIndex: 1 }), { match: true, current: true, currentMatchCovered: true });
  }
  sample();
});

test('assistant matching marks preceding ordinary user, service carriers do not steal turn; image-only and orphan provenance', async t => {
  const f = fixture(t), source = f.raw(entries), v = await view(f, source);
  const result = f.hold(await prepare(f.store, source, { options: { query: 'needle', type: 'assistant', offset: 1000 }, control }));
  assert.equal(result.entries.length, 0);
  const all = original.searchHistoryEntries(entries, { query: 'needle', type: 'assistant', limit: 5000 });
  for (let index = 0; index < entries.length; index++) {
    for (let current = 0; current < all.total; current++) {
      const want = expectedAggregate({ search: entries, rows: [entries[index]] }, { query: 'needle', type: 'assistant' }, current);
      assert.deepEqual(aggregate(result.searchPresentation, v, { logicalRank: index, currentMatchIndex: current }), want);
    }
  }
  const image = f.hold(await prepare(f.store, source, { options: { query: '', type: 'user-images', offset: 1, limit: 1 }, control }));
  assert.equal(image.searchHeader.total, 2); assert.equal(mat(image.entries)[0].entryUuid, 'paths');
  assert.deepEqual(aggregate(image.searchPresentation, v, { logicalRank: 5, currentMatchIndex: 0 }), { match: true, current: true, currentMatchCovered: true });
});

test('independent frozen cut survives parent/root release and GC; same UUID/counts different content produce different page and aggregate', async t => {
  const f = fixture(t), a = f.raw([user('same0', 'needle A'), user('same1', 'miss A')]);
  const frozen = forkFrozenCanonical(f.store, a); f.hold(frozen);
  const va = await view(f, frozen);
  const sa = f.hold(await prepare(f.store, frozen, { options: { query: 'needle', limit: 1 }, control }));
  a.release(); frozen.release(); gc(f.store);
  assert.equal(mat(sa.entries)[0].snippet, 'needle A');
  const b = f.raw([user('same0', 'miss B'), user('same1', 'needle B')]), vb = await view(f, b);
  const sb = f.hold(await prepare(f.store, b, { options: { query: 'needle', limit: 1 }, control }));
  b.release(); gc(f.store);
  assert.equal(sa.searchHeader.total, sb.searchHeader.total);
  assert.notEqual(sa.viewRevisionToken, sb.viewRevisionToken);
  assert.equal(mat(sa.entries)[0].entryUuid, 'same0'); assert.equal(mat(sb.entries)[0].entryUuid, 'same1');
  assert.equal(mat(sb.entries)[0].snippet, 'needle B');
  assert.deepEqual(aggregate(sa.searchPresentation, va, { logicalRank: 0, currentMatchIndex: 0 }), { match: true, current: true, currentMatchCovered: true });
  assert.deepEqual(aggregate(sb.searchPresentation, vb, { logicalRank: 0, currentMatchIndex: 0 }), { match: false, current: false, currentMatchCovered: true });
  sa.release(); assert.throws(() => mat(sa.entries), { code: 'history_lease_released' });
  assert.throws(() => aggregate(sa.searchPresentation, va, { logicalRank: 0 }), { code: 'HISTORY_SEARCH_RELEASED' });
});

test('cancellation after content read and after publish, quota rollback, same-store guards and exact pin accounting', async t => {
  const f = fixture(t), source = f.raw(entries), before = pins(f.store);
  let checkpoints = 0;
  const cancelled = Object.assign(new Error('fixture cancel'), { code: 'FIXTURE_CANCELLED' });
  const cancel = { assertCurrent() { if (checkpoints === 2) throw cancelled; }, async checkpoint() { checkpoints++; } };
  await assert.rejects(prepare(f.store, source, { options: { query: 'needle' }, control: cancel }), error => error === cancelled);
  assert.deepEqual(pins(f.store), before); gc(f.store);
  let assertions = 0, cutAt;
  const audit = { assertCurrent() { assertions++; if (assertions === cutAt) throw cancelled; }, async checkpoint() {} };
  const complete = await prepare(f.store, source, { options: { query: 'needle' }, control: audit }); complete.release(); gc(f.store);
  cutAt = assertions; assertions = 0;
  await assert.rejects(prepare(f.store, source, { options: { query: 'needle' }, control: audit }), error => error === cancelled);
  assert.deepEqual(pins(f.store), before);
  const budget = f.store.diskBudget; f.store.diskBudget = f.store.diskUsage();
  await assert.rejects(prepare(f.store, source, { options: { query: 'needle' }, control }), e => e.code === 'HISTORY_BACKING_FULL' || e.code === 'ERR_SQLITE_ERROR');
  f.store.diskBudget = budget; assert.deepEqual(pins(f.store), before); gc(f.store);
  const foreign = fixture(t), foreignSource = foreign.raw(entries), foreignPins = pins(foreign.store);
  await assert.rejects(prepare(f.store, foreignSource, { options: { query: 'needle' }, control }), { code: 'history_foreign_root' });
  assert.deepEqual(pins(foreign.store), foreignPins); assert.deepEqual(pins(f.store), before);
  const s = f.hold(await prepare(f.store, source, { options: { query: 'needle' }, control }));
  const fv = await view(foreign, foreignSource);
  assert.throws(() => aggregate(s.searchPresentation, fv, { logicalRank: 0 }), { code: 'HISTORY_SEARCH_SAME_STORE_REQUIRED' });
});

test('existing signed root pages carry exact content; independent consumer/capacity/cancel/cleanup stay on same store', async t => {
  const f = fixture(t), source = f.raw(entries);
  let preparations = 0, projections = 0;
  const plane = new HistoryRootReadPlane({ store: f.store, maxRoots: 1,
    projectHistory: async () => { projections++; return forkFrozenCanonical(f.store, source); },
    prepareResult: async () => {preparations++;throw Error('search must not invoke the ordinary semantic preparer');} });
  f.hold({ release: () => plane.close() });
  const payload = { toolType: 'codex', sessionId: 's', cwd: '/fixture', tabId: 'tab', readProfile: 'history-search-v1',query:'needle',offset:2,limit:2 };
  const opened = await plane.open(payload, { consumerKey: 'consumer', control });
  const request = { ...opened, nodeToken: opened.root.nodeToken, kind: 'rowWindow', offset: 0, limit: 2,
    creditBytes: 16384, fields: ['entryUuid', 'snippet', 'offset', 'matchIndex', 'occurrence', 'turnKeys', 'entryRef'] };
  const packet = await plane.readPage(request, { consumerKey: 'consumer', control }); wirePages++;
  const expected = original.searchHistoryEntries(entries, payload).matches;
  assert.equal(packet.rows.length, 2);
  for (let i = 0; i < packet.rows.length; i++) for (const field of ['entryUuid', 'snippet', 'offset', 'matchIndex', 'occurrence'])
    assert.equal(packet.rows[i].fields[field].value, expected[i][field], field);
  assert(packet.creditBytesUsed <= request.creditBytes);
  await assert.rejects(plane.readPage(request, { consumerKey: 'foreign' }), { code: 'HISTORY_ROOT_OWNER_MISMATCH' });
  await assert.rejects(plane.readPage({ ...request, revision: 'changed' }, { consumerKey: 'consumer' }), { code: 'HISTORY_ROOT_OWNER_MISMATCH' });
  await assert.rejects(plane.open(payload, { consumerKey: 'consumer', control }), { code: 'HISTORY_ROOT_LEASE_LIMIT' });
  assert.equal(preparations, 0); assert.equal(projections, 1, 'capacity refuses before producer, no retry');
  plane.release(opened, { consumerKey: 'consumer' });
  await assert.rejects(plane.readPage(request, { consumerKey: 'consumer' }), { code: 'HISTORY_ROOT_RELEASED' });
  assert.equal(plane.stats().roots, 0);
  const before = pins(f.store); let n = 0;
  const cancel = { assertCurrent() { if (n) throw Object.assign(new Error('cancel'), { code: 'CANCELLED_OPEN' }); }, async checkpoint() { n++; } };
  await assert.rejects(plane.open(payload, { consumerKey: 'consumer', control: cancel }), { code: 'CANCELLED_OPEN' });
  assert.equal(plane.stats().roots, 0); assert.equal(plane.stats().opening, 0); assert.deepEqual(pins(f.store), before);
  plane.close();
});

test('many matches beyond page: paged sets/ranges and overlap occurrences without all-match DTO', async t => {
  const f = fixture(t), data = [user('many', 'a'.repeat(6001), { sourceIdentityAliases: Array.from({ length: 96 }, (_, i) => 'inherited-' + i) })];
  const source = f.raw(data);
  assert.equal(original.searchHistoryEntries(data, { query: 'aa', limit: 10000 }).matches.length, 5000);
  assert.equal(shared.searchHistoryEntries(data, { query: 'aa', limit: 10000 }).matches.length, 5000);
  for (const options of [{ query: 'aa', offset: 5998, limit: 100 }, { query: 'aa', offset: 0, limit: 100 }]) {
    const result = await prepare(f.store, source, { options, control });
    try {
      const expected = original.searchHistoryEntries(data, options);
      assert.deepEqual(mat(result.entries), expected.matches);
      assert.equal(result.searchHeader.total, 6000); assert.equal(result.entries.length, options.offset ? 2 : 100);
      assert.equal(result.searchPresentation.stats().fullMatchDTOs, result.entries.length);
      assert.equal(result.searchPresentation.stats().matchRanges, 1);
      assert.equal(result.searchPresentation.currentKeys(5999).has('inherited-95'), true);
      assert.equal(result.searchPresentation.stats().ownership.nativeRows, 0);
      sample();
    } finally { result.release(); gc(f.store); }
  }
});


test('many distinct marker turns on backing; early source release during build, scalar helper reads no bodies/writes', async t => {
  const f = fixture(t), data = Array.from({ length: 64 }, (_, i) => user('turn-' + i, 'needle ' + i,
    { sourceIdentity: 'source-' + i, sourceIdentityAliases: ['ancestor-' + i], uuidAliases: ['old-' + i] }));
  const source = f.raw(data);
  let released = false;
  const ctl = { assertCurrent() {}, async checkpoint() { if (!released) { released = true; source.release(); } await control.checkpoint(); } };
  const result = f.hold(await prepare(f.store, source, { options: { query: 'needle', offset: 2, limit: 3 }, control: ctl }));
  assert.equal(result.searchHeader.total, 64); assert.equal(result.entries.length, 3);
  for (let i = 0; i < 64; i++) for (const key of ['turn-', 'source-', 'ancestor-', 'old-']) assert(result.searchPresentation.hasTurnKey(key + i));
  assert.equal(result.searchPresentation.currentKeys(63).has('ancestor-63'), true);
  assert.equal(result.searchPresentation.stats().fullMatchDTOs, 3);
  gc(f.store);
  // Use the exact captured canonical entries under an independently owned root.
  const probeSource = f.raw([user('probe', 'body must not be touched', { uuidAliases: ['ancestor-63'] })]);
  const v = await view(f, probeSource);
  const originalActual = v.actualRow.bind(v);
  v.actualRow = rank => {
    const row = originalActual(rank);
    return new Proxy(row, { get(target, key) {
      if (key === 'field') return name => { assert.notEqual(name, 'content'); assert.notEqual(name, 'actions'); return target.field(name); };
      return Reflect.get(target, key);
    } });
  };
  const beforeWrites = f.store.stats().pagesWritten, beforePins = pins(f.store);
  assert.deepEqual(aggregate(result.searchPresentation, v, { logicalRank: 0, currentMatchIndex: 63 }), { match: true, current: true, currentMatchCovered: true });
  assert.equal(f.store.stats().pagesWritten, beforeWrites, 'pure aggregate performs no writes');
  assert.deepEqual(pins(f.store), beforePins);
});


test('truthy entryRef scalars and alias iterable/falsy semantics retain the Native response', async t => {
  const f = fixture(t), data = [user('scalar-ref', 'needle', { entryRef: 'entry-ref-string', uuidAliases: 0, sourceIdentityAliases: false }),
    user('numeric-ref', 'needle', { entryRef: 42, uuidAliases: null }),
    user('string-alias', 'needle', { entryRef: [], uuidAliases: 'a😀', sourceIdentityAliases: '' })];
  f.source = f.raw(data);
  await compare(f, data, { query: 'needle', limit: 3 });
});

test('actual SQLite FULL during requested page5000 releases all provisional pins and preserves source; no fallback/retry', async t => {
  const f = fixture(t, 4 * 1024 ** 2), source = f.raw([user('full', 'a'.repeat(6001))]), before = pins(f.store);
  let checkpoints = 0;
  const ctl = { assertCurrent() {}, async checkpoint() { checkpoints++; sample(); } };
  await assert.rejects(prepare(f.store, source, { options: { query: 'aa', limit: 5000 }, control: ctl }),
    e => e.code === 'ERR_SQLITE_ERROR' && e.errcode === 13);
  assert.deepEqual(pins(f.store), before);
  assert.equal(checkpoints, 0, 'single row failed inside original attempt; no shortened-page fallback');
  sample(); gc(f.store);
  assert.equal(mat(source.entries)[0].content.length, 6001);
  const recovered = await prepare(f.store, source, { options: { query: 'aa', offset: 5999, limit: 1 }, control });
  assert.equal(recovered.searchHeader.total, 6000); assert.equal(mat(recovered.entries)[0].offset, 5999);
  recovered.release();
});


test('released backing page IDs can be reused without reusing the opaque search cut identity', async t => {
  const f = fixture(t), a = f.raw([user('same', 'needle A')]);
  const first = await prepare(f.store, a, { options: { query: 'needle' }, control });
  const token = first.viewRevisionToken;
  assert.equal(mat(first.entries)[0].snippet, 'needle A');
  first.release(); a.release(); gc(f.store);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM hp_pages').get().n, 0);
  const b = f.raw([user('same', 'needle B')]);
  assert.deepEqual(a.root.descriptor, b.root.descriptor, 'actual SQL row IDs reused');
  const second = f.hold(await prepare(f.store, b, { options: { query: 'needle' }, control }));
  assert.notEqual(token, second.viewRevisionToken);
  assert.equal(mat(second.entries)[0].snippet, 'needle B');
});

test.after(() => {
  sample(); assert.equal(fixtureDirs.size, 0);
  fs.writeFileSync(path.join(EVIDENCE, 'metrics.json'), JSON.stringify({ parityCases, wirePages, peakFixtureBytes,
    peakHeapTotal, totalV8Limit: v8.getHeapStatistics().heap_size_limit, adapter: 'actual node:sqlite; production better-sqlite3 ABI not exercised',
    appUI: false, provider: false, globalMemoryClaim: false, fixtureResidue: 0 }, null, 2) + '\n');
});
