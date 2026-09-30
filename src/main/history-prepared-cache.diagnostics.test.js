'use strict';

// Actual SQLite/cache functions, temporary synthetic sources only. Run with
// ELECTRON_RUN_AS_NODE=1 and the repository's Electron (Node 18 / SQLite ABI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const Database = require('better-sqlite3');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { applyHistoryRowWindow } = require('./history-entry-window');

const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const last = (events, operation) => events.filter(event => event.operation === operation).at(-1);
const secret = 'PRIVATE-PAYLOAD-CONTENT';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-cache-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'cache');
  const filePath = path.join(root, 'private-source.jsonl');
  fs.writeFileSync(filePath, 'synthetic source');
  const stat = fs.statSync(filePath);
  const owner = { sessionId: 'diagnostic-session', cwd: root, tabId: 'test-tab' };
  const source = { filePath, sessionId: owner.sessionId, size: stat.size, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino, sourceGeneration: 'private-generation' };
  const events = [];
  const cache = new HistoryPreparedCache({ directory, onDiagnostic: event => events.push(event), ...options });
  const entries = Array.from({ length: 80 }, (_, i) => ({ uuid: 'row-' + i, role: 'assistant', sessionId: owner.sessionId,
    content: secret + i, actions: [{ tool: '__raw__', rawTool: { toolName: 'Read', args: { file_path: filePath }, result: secret } }] }));
  const context = 'private-context';
  return { root, directory, filePath, stat, source, owner, events, cache, entries, context,
    save: () => cache.savePrepared({ owner, source, context, entries }),
    read: extra => cache.readPrepared({ owner, filePath, stat, context, ...extra }),
    continuation: () => cache.saveContinuation(owner, source, { sourceProof: [secret], graph: secret }),
    db: callback => { const db = new Database(cache.filename(owner)); try { return callback(db); } finally { db.close(); } },
  };
}
function replaceMeta(f, key, value) {
  const body = v8.serialize(value);
  f.db(db => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?,?)').run(key, body, checksum(body)));
}
function readers(f, cache = f.cache) {
  const descriptor = { eventKey: secret, manifest: { manifestDigest: secret }, payloadPolicy: secret };
  return {
    readPrepared: () => cache.readPrepared({ owner: f.owner, filePath: f.filePath, stat: f.stat, context: f.context }),
    readContinuation: () => cache.readContinuation(f.owner, f.filePath, f.stat),
    readTimeline: () => cache.readTimeline(f.owner, f.filePath, f.stat),
    readSource: () => cache.readSource(f.owner), readSourceProof: () => cache.readSourceProof(f.owner),
    readPayload: () => cache.readPayload(f.owner, secret, f.source),
    readVirtualProjection: () => cache.readVirtualProjection(f.owner, descriptor),
    readVirtualState: () => cache.readVirtualState(f.owner, descriptor),
  };
}

test('disk page hit after RAM release reports its own index miss and bounded hydrated bytes', async t => {
  const f = fixture(t);
  assert.equal(await f.save(), true);
  assert.equal(last(f.events, 'savePrepared').outcome, 'stored');
  assert.ok(last(f.events, 'savePrepared').bytes > 0);
  assert.equal(last(f.events, 'savePrepared').kind, 'view');
  f.cache.clearMemory();
  assert.equal(last(f.events, 'clearMemory').layer, 'memory');
  const before = f.cache.stats();
  f.events.length = 0;
  const hydrate = { centerUuid: 'row-8', radius: 2, alwaysHydrateTail: 1 };
  const result = f.read({ hydrate });
  // Disk stubs have always been JSON encoded (omitting undefined properties).
  assert.deepEqual(result.entries, JSON.parse(JSON.stringify(applyHistoryRowWindow(f.entries, hydrate).entries)));
  const hit = last(f.events, 'readPrepared');
  assert.equal(hit.outcome, 'hit'); assert.equal(hit.reason, 'disk-hit');
  assert.equal(hit.indexOutcome, 'miss'); assert.equal(hit.indexReason, 'not-in-memory');
  assert.equal(hit.pageRows, 6); assert.equal(hit.rows, f.entries.length);
  assert.equal(hit.bytes, f.cache.stats().pageBytes - before.pageBytes);
  assert.equal(hit.snapshotBytes, f.stat.size); assert.equal(hit.sourceBytes, f.stat.size);
  assert.equal(f.cache.stats().continuationBytes, before.continuationBytes);
  assert.equal(hit.sessionId, f.owner.sessionId); assert.match(hit.cacheKey, /^[a-f0-9]{64}$/);
  assert.equal(f.events.length, 2, 'one index summary and one page result, never one event per row');
  f.read({ hydrate });
  assert.equal(last(f.events, 'readPrepared').indexOutcome, 'hit');
});

test('actual index budget eviction and oversized indices leave disk capabilities intact', async t => {
  const f = fixture(t);
  await f.save();
  f.cache.indexMemoryBudget = f.cache.indexMemoryBytes;
  const second = { ...f.owner, sessionId: 'second-owner' };
  await f.cache.savePrepared({ owner: second, source: f.source, context: f.context, entries: f.entries });
  assert.equal(last(f.events, 'rememberIndex').evictedCount, 1);
  assert.ok(last(f.events, 'rememberIndex').evictedBytes > 0);
  assert.equal(last(f.events, 'rememberIndex').reason, 'index-budget');
  assert.ok(f.read());
  assert.equal(last(f.events, 'readPrepared').outcome, 'hit');
  assert.equal(last(f.events, 'readPrepared').indexOutcome, 'miss');
  f.cache.indexMemoryBudget = 0; f.cache.clearMemory();
  assert.ok(f.read());
  assert.equal(last(f.events, 'readPrepared').indexRetained, false);
  assert.equal(last(f.events, 'rememberIndex').outcome, 'skipped');
  assert.equal(f.cache.indexMemoryBytes, 0);
  assert.equal(f.cache.recentRemovals.size, 0, 'RAM eviction never becomes a disk removal reason');
});

test('each read identifies a cold missing file without scanning directories', t => {
  const f = fixture(t);
  const readdir = fs.readdirSync, lstat = fs.lstatSync;
  fs.readdirSync = fs.lstatSync = () => { throw new Error('unexpected diagnostic scan'); };
  try {
    for (const [operation, read] of Object.entries(readers(f))) {
      f.events.length = 0;
      assert.equal(read(), null);
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].operation, operation);
      assert.equal(f.events[0].reason, 'no-file'); assert.equal(f.events[0].outcome, 'miss');
    }
  } finally { fs.readdirSync = readdir; fs.lstatSync = lstat; }
});

test('quota eviction is reported by prune and the exact subsequent read; rewrite clears its remembered reason', async t => {
  const f = fixture(t); await f.save(); f.continuation();
  const originalBudget = f.cache.maxBytes;
  const bytes = fs.statSync(f.cache.filename(f.owner)).size;
  f.events.length = 0; f.cache.maxBytes = 0; f.cache.prune();
  assert.equal(f.events.length, 1, 'a quota scan emits an aggregate, not one event per file');
  const eviction = last(f.events, 'prune');
  assert.equal(eviction.reason, 'disk-quota'); assert.equal(eviction.evictedCount, 1);
  assert.equal(eviction.evictedBytes, bytes); assert.equal(eviction.budgetBytes, 0);
  assert.equal(f.read(), null); assert.equal(last(f.events, 'readPrepared').reason, 'disk-quota');
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  assert.equal(last(f.events, 'readContinuation').reason, 'disk-quota');
  f.cache.maxBytes = originalBudget; assert.equal(await f.save(), true); assert.ok(f.read());
  fs.unlinkSync(f.cache.filename(f.owner));
  assert.equal(f.read(), null); assert.equal(last(f.events, 'readPrepared').reason, 'no-file');
});

test('a just-written file pruned by the same operation is not diagnosed as stored', t => {
  const f = fixture(t, { maxBytes: 1 });
  assert.equal(f.continuation(), null);
  const event = last(f.events, 'saveContinuation');
  assert.equal(event.outcome, 'miss'); assert.equal(event.reason, 'disk-quota');
  assert.equal(f.cache.stats().diskBytes, 0);
});

test('targeted invalidation has a different miss reason and does not invalidate unrelated sources', async t => {
  const f = fixture(t); await f.save();
  f.cache.invalidate(f.filePath + '-different');
  assert.equal(last(f.events, 'invalidate').reason, 'no-matching-source'); assert.ok(f.read());
  f.cache.invalidate(f.filePath);
  assert.equal(last(f.events, 'invalidate').removedCount, 1);
  assert.equal(f.read(), null); assert.equal(last(f.events, 'readPrepared').reason, 'invalidation');
});

test('missing continuation, continuation source, view and timeline remain distinct', async t => {
  const f = fixture(t); await f.save();
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  assert.equal(last(f.events, 'readContinuation').reason, 'missing-continuation-source');
  f.continuation();
  f.db(db => db.prepare('DELETE FROM meta WHERE key=?').run('continuation'));
  let restored = 0;
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat, () => restored++), null);
  assert.equal(restored, 1, 'the existing onRestore call order is preserved');
  assert.equal(last(f.events, 'readContinuation').reason, 'missing-continuation');
  assert.equal(f.read({ kind: 'base' }), null);
  assert.equal(last(f.events, 'readPrepared').reason, 'missing-prepared-view');
  assert.equal(f.cache.readTimeline(f.owner, f.filePath, f.stat), null);
  assert.equal(last(f.events, 'readTimeline').reason, 'missing-timeline');
});

for (const change of ['rewrite', 'replace', 'truncate', 'append']) test('real source ' + change + ' retains page/continuation validation', async t => {
  const f = fixture(t); await f.save(); f.continuation();
  if (change === 'rewrite') {
    fs.writeFileSync(f.filePath, 'replacement data'); // Same byte length.
    fs.utimesSync(f.filePath, new Date(1), new Date(1));
  } else if (change === 'replace') {
    fs.writeFileSync(f.filePath + '.new', 'replacement data'); fs.renameSync(f.filePath + '.new', f.filePath);
  } else if (change === 'truncate') fs.truncateSync(f.filePath, 1);
  else fs.appendFileSync(f.filePath, ' appended');
  const stat = fs.statSync(f.filePath);
  const expected = { rewrite: 'source-rewritten', replace: 'source-identity-mismatch', truncate: 'source-truncated', append: 'source-size-mismatch' }[change];
  assert.equal(f.read({ stat }), null); assert.equal(last(f.events, 'readPrepared').reason, expected);
  const continuation = f.cache.readContinuation(f.owner, f.filePath, stat);
  if (change === 'append') {
    assert.deepEqual(continuation, { snapshot: f.source, state: { sourceProof: [secret], graph: secret } });
    assert.equal(last(f.events, 'readContinuation').reason, 'append-compatible');
  } else { assert.equal(continuation, null); assert.equal(last(f.events, 'readContinuation').reason, expected); }
});

test('owner, source path, context, session and payload generation rejections never disclose their values', async t => {
  const f = fixture(t); await f.save(); f.continuation();
  assert.equal(f.read({ context: secret }), null); assert.equal(last(f.events, 'readPrepared').reason, 'context-mismatch');
  assert.equal(f.read({ filePath: f.filePath + '-other' }), null); assert.equal(last(f.events, 'readPrepared').reason, 'source-path-mismatch');
  assert.equal(f.cache.savePayload(f.owner, secret, { body: secret }), true);
  assert.deepEqual(f.cache.readPayload(f.owner, secret, f.source), { body: secret });
  assert.equal(f.cache.readPayload(f.owner, secret, { ...f.source, sourceGeneration: secret }), null);
  assert.equal(last(f.events, 'readPayload').reason, 'source-generation-mismatch');
  assert.equal(f.cache.readPayload(f.owner, 'missing', f.source), null);
  assert.equal(last(f.events, 'readPayload').reason, 'missing-payload');
  replaceMeta(f, 'continuationSource', { ...f.source, sessionId: 'other-session' });
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  assert.equal(last(f.events, 'readContinuation').reason, 'session-mismatch');
  replaceMeta(f, 'owner', secret);
  assert.equal(f.cache.readSource(f.owner), null); assert.equal(last(f.events, 'readSource').reason, 'owner-mismatch');
  assert.ok(!JSON.stringify(f.events).includes(secret)); assert.ok(!JSON.stringify(f.events).includes(f.root));
});

test('previous schema observation explains a version miss without a new hot-read scan', t => {
  const f = fixture(t, { schema: '1-aa' }); f.continuation();
  const events = [];
  const cache = new HistoryPreparedCache({ directory: f.directory, schema: '1-bb', onDiagnostic: event => events.push(event) });
  const readdir = fs.readdirSync;
  fs.readdirSync = () => { throw new Error('no schema search on a cache read'); };
  try { assert.equal(cache.readContinuation(f.owner, f.filePath, f.stat), null); }
  finally { fs.readdirSync = readdir; }
  const miss = last(events, 'readContinuation');
  assert.equal(miss.reason, 'version-mismatch'); assert.equal(miss.cacheVersion, 'v1-bb');
  assert.equal(miss.otherVersion, 'v1-aa'); assert.equal(miss.otherVersionObserved, true);
  assert.ok(f.cache.readContinuation(f.owner, f.filePath, f.stat), 'the old version remains usable by its own owner');
});

test('old-version hints and invalidation summaries remain bounded across many actual SQLite files', t => {
  const f = fixture(t, { schema: '1-aa' }); f.continuation();
  for (let i = 0; i < 300; i++) fs.copyFileSync(f.cache.filename(f.owner), f.cache.filename({ sessionId: 'old-' + i }));
  const events = [];
  const cache = new HistoryPreparedCache({ directory: f.directory, schema: '1-bb', onDiagnostic: event => events.push(event) });
  assert.equal(cache.otherVersions.size, 256); assert.equal(events.length, 1);
  assert.equal(last(events, 'prune').fileCount, 301);
  f.events.length = 0; f.cache.invalidate();
  assert.equal(f.events.length, 1); assert.equal(last(f.events, 'invalidate').removedCount, 301);
  cache.prune(); assert.equal(cache.otherVersions.size, 0);
  assert.equal(cache.readSource(f.owner), null); assert.equal(last(events, 'readSource').reason, 'no-file');
});

for (const corrupt of ['checksum', 'sqlite', 'serialization-version', 'index']) test('actual corrupt cache falls back with reason: ' + corrupt, async t => {
  const f = fixture(t); await f.save(); f.continuation();
  if (corrupt === 'checksum') f.db(db => db.prepare("UPDATE meta SET checksum='bad' WHERE key='continuation'").run());
  else if (corrupt === 'sqlite') fs.writeFileSync(f.cache.filename(f.owner), secret.repeat(512));
  else if (corrupt === 'serialization-version') {
    const body = Buffer.from([255, 255, 255, 255, 255]);
    f.db(db => db.prepare("UPDATE meta SET body=?,checksum=? WHERE key='continuation'").run(body, checksum(body)));
  } else {
    f.db(db => db.prepare("UPDATE rows SET index_hash='bad' WHERE pos=0").run()); f.cache.clearMemory();
  }
  const operation = corrupt === 'index' ? 'readPrepared' : 'readContinuation';
  assert.equal(corrupt === 'index' ? f.read() : f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  const expected = { checksum: 'checksum-mismatch', sqlite: 'sqlite-corrupt', 'serialization-version': 'serialization-version', index: 'index-corrupt' }[corrupt];
  assert.equal(last(f.events, operation).reason, expected); assert.equal(last(f.events, operation).outcome, 'error');
  assert.equal(fs.existsSync(f.cache.filename(f.owner)), false);
  assert.equal(f.cache.readSource(f.owner), null); assert.equal(last(f.events, 'readSource').reason, expected);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'synthetic source');
});

test('virtual projection/state reasons, source proof and successful timeline retain their values', t => {
  const f = fixture(t); f.continuation();
  assert.deepEqual(f.cache.readSource(f.owner), f.source);
  assert.deepEqual(f.cache.readSourceProof(f.owner), [secret]);
  assert.equal(f.cache.saveTimeline(f.owner, f.source, f.entries, { secret }), undefined);
  assert.deepEqual(f.cache.readTimeline(f.owner, f.filePath, f.stat).entries, f.entries);
  const descriptor = { eventKey: secret, manifest: { manifestDigest: secret }, payloadPolicy: secret };
  assert.equal(f.cache.readVirtualProjection(f.owner, descriptor), null);
  assert.equal(last(f.events, 'readVirtualProjection').reason, 'missing-virtual-projection');
  assert.equal(f.cache.readVirtualState(f.owner, descriptor), null);
  assert.equal(last(f.events, 'readVirtualState').reason, 'missing-virtual-state');
  assert.equal(f.cache.saveVirtualProjection(f.owner, { ...descriptor, historyEntries: f.entries }), undefined);
  const state = { descriptor, childSnapshot: f.source, childProof: [secret], privateGraph: secret };
  const pending = new Map([[secret, { body: secret }]]); f.cache.pendingPayloads = () => pending;
  assert.equal(f.cache.saveVirtualState(f.owner, state), true); assert.equal(pending.size, 0);
  assert.deepEqual(f.cache.readVirtualState(f.owner, descriptor), state);
  assert.ok(last(f.events, 'readVirtualState').bytes > 0);
  assert.equal(f.cache.readVirtualProjection(f.owner, descriptor).historyEntries, undefined);
  for (const [change, reason] of [[{ eventKey: 'other' }, 'event-key-mismatch'], [{ manifest: { manifestDigest: 'other' } }, 'manifest-mismatch']]) {
    assert.equal(f.cache.readVirtualProjection(f.owner, { ...descriptor, ...change }), null);
    assert.equal(last(f.events, 'readVirtualProjection').reason, reason);
    assert.equal(f.cache.readVirtualState(f.owner, { ...descriptor, ...change }), null);
    assert.equal(last(f.events, 'readVirtualState').reason, reason);
  }
  assert.equal(f.cache.readVirtualState(f.owner, { ...descriptor, payloadPolicy: 'other' }), null);
  assert.equal(last(f.events, 'readVirtualState').reason, 'payload-policy-mismatch');
});

test('disabled initialization and all disabled reads/writes report without leaking filesystem errors', async t => {
  const f = fixture(t);
  const events = [], warnings = [];
  const warn = console.warn; console.warn = message => warnings.push(message);
  let cache;
  try { cache = new HistoryPreparedCache({ directory: f.filePath, onDiagnostic: event => events.push(event) }); }
  finally { console.warn = warn; }
  assert.equal(cache.enabled, false); assert.equal(last(events, 'initialize').outcome, 'disabled');
  for (const [operation, read] of Object.entries(readers(f, cache))) {
    assert.equal(read(), null); assert.equal(last(events, operation).reason, 'disabled');
  }
  assert.equal(cache.saveContinuation(f.owner, f.source, {}), null);
  assert.equal(last(events, 'saveContinuation').outcome, 'disabled');
  assert.equal(await cache.savePrepared({ owner: f.owner, source: f.source, entries: f.entries }), null);
  assert.equal(last(events, 'savePrepared').outcome, 'disabled');
  cache.prune(); cache.invalidate();
  assert.equal(last(events, 'prune').outcome, 'disabled'); assert.equal(last(events, 'invalidate').outcome, 'disabled');
  assert.ok(!JSON.stringify({ events, warnings }).includes(f.root));
});

test('hot disk hits do not add filesystem scans, and a nonce mismatch only reloads the index', async t => {
  const f = fixture(t); await f.save();
  const meta = f.db(db => v8.deserialize(db.prepare('SELECT body FROM meta WHERE key=?').get('view:view:test-tab').body));
  replaceMeta(f, 'view:view:test-tab', { ...meta, indexNonce: 'next-nonce' });
  const readdir = fs.readdirSync, lstat = fs.lstatSync;
  fs.readdirSync = fs.lstatSync = () => { throw new Error('unexpected diagnostic scan'); };
  try {
    assert.deepEqual(f.read().entries, f.entries);
    assert.equal(last(f.events, 'readPrepared').indexReason, 'nonce-mismatch');
    assert.equal(last(f.events, 'readPrepared').outcome, 'hit');
  } finally { fs.readdirSync = readdir; fs.lstatSync = lstat; }
});

test('orphan sidecars, active-file quota exclusions and filesystem failures produce bounded summaries', t => {
  const f = fixture(t); f.continuation();
  const filename = f.cache.filename(f.owner);
  const orphan = f.cache.filename({ sessionId: 'orphan' }); fs.writeFileSync(orphan + '-wal', 'synthetic sidecar');
  f.cache.prune(); assert.equal(last(f.events, 'prune').reason, 'orphan-sidecar');
  assert.equal(last(f.events, 'prune').removedCount, 1);
  assert.equal(fs.existsSync(orphan + '-wal'), false);
  f.cache.maxBytes = 0; f.cache.activeFiles.add(filename);
  f.cache.prune();
  assert.equal(last(f.events, 'prune').reason, 'active-files-over-budget');
  assert.equal(last(f.events, 'prune').activeCount, 1); assert.ok(fs.existsSync(filename));
  f.cache.activeFiles.delete(filename);
  const readdir = fs.readdirSync;
  const denied = Object.assign(new Error(secret + f.root), { code: 'EACCES' });
  fs.readdirSync = () => { throw denied; };
  try {
    assert.throws(() => f.cache.prune(), error => error === denied);
    assert.equal(last(f.events, 'prune').reason, 'permission-denied');
    assert.throws(() => f.cache.invalidate(), error => error === denied);
    assert.equal(last(f.events, 'invalidate').reason, 'permission-denied');
  } finally { fs.readdirSync = readdir; }
  assert.ok(!JSON.stringify(f.events).includes(secret)); assert.ok(!JSON.stringify(f.events).includes(f.root));
});

test('missing source/proof and corrupt async initialization are diagnosed without changing returned values', async t => {
  const f = fixture(t); f.continuation();
  f.db(db => db.prepare("DELETE FROM meta WHERE key IN ('source','sourceProof')").run());
  assert.equal(f.cache.readSource(f.owner), null); assert.equal(last(f.events, 'readSource').reason, 'missing-source');
  assert.equal(f.cache.readSourceProof(f.owner), null); assert.equal(last(f.events, 'readSourceProof').reason, 'missing-source-proof');
  fs.writeFileSync(f.cache.filename(f.owner), secret.repeat(512));
  assert.equal(await f.save(), null);
  assert.equal(last(f.events, 'savePrepared').reason, 'sqlite-corrupt'); assert.equal(last(f.events, 'savePrepared').outcome, 'error');
});

test('native SQLITE_FULL and invalidated async transactions diagnose the exact write and preserve fallback', async t => {
  const f = fixture(t);
  let code;
  assert.equal(await f.cache.withAsyncDb(f.owner, async db => {
    db.pragma('max_page_count = 10');
    try { db.prepare('INSERT INTO payloads VALUES (?,?,?)').run('large', Buffer.alloc(2 * 1024 * 1024), 'fixture'); }
    catch (error) { code = error.code; throw error; }
  }), null);
  assert.equal(code, 'SQLITE_FULL'); assert.equal(last(f.events, 'writeAsync').reason, 'sqlite-full');
  assert.equal(f.cache.activeFiles.size, 0); assert.equal(f.cache.invalidatedFiles.size, 0);
  f.continuation();
  assert.equal(await f.cache.withAsyncDb(f.owner, async () => {
    f.cache.invalidate(f.filePath);
    assert.equal(last(f.events, 'invalidate').deferredCount, 1);
    return true;
  }), null);
  assert.equal(last(f.events, 'writeAsync').reason, 'write-invalidated');
  assert.equal(f.cache.readSource(f.owner), null); assert.equal(last(f.events, 'readSource').reason, 'invalidation');
  assert.equal(f.continuation(), true);
  const stale = Object.assign(new Error(secret + f.root), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  f.cache.assertCurrent = () => { throw stale; };
  await assert.rejects(f.cache.withAsyncDb(f.owner, async () => true), error => error === stale);
  assert.equal(last(f.events, 'writeAsync').reason, 'source-invalidated');
  assert.equal(f.cache.activeFiles.size, 0); assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('unexpected cache exceptions retain a safe source location instead of only a generic miss', t => {
  const f = fixture(t); f.continuation();
  const result = f.cache.withDb(f.owner, false, () => {
    const error = new TypeError(secret);
    error.stack = 'TypeError: ' + secret + '\n at read (/private/' + secret + '/history-reader.js:42:7)';
    throw error;
  }, 'readFixture');
  assert.equal(result, null);
  const diagnostic = last(f.events, 'readFixture');
  assert.equal(diagnostic.reason, 'cache-error'); assert.equal(diagnostic.errorName, 'TypeError');
  assert.equal(diagnostic.errorModule, 'history-reader_js'); assert.equal(diagnostic.errorLine, 42);
  assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('diagnostics have bounded scalar events/history, no bodies or full paths, and a failing hook cannot affect reads', async t => {
  const f = fixture(t); await f.save(); f.continuation();
  f.cache.savePayloads(f.owner, new Map([[secret, { body: secret, path: f.filePath }]]));
  for (const read of Object.values(readers(f))) read();
  for (const event of f.events) {
    assert.equal(Object.getPrototypeOf(event), Object.prototype);
    assert.ok(Object.values(event).every(value => ['string', 'number', 'boolean'].includes(typeof value)));
    assert.ok(Object.values(event).every(value => typeof value !== 'string' || value.length <= 128));
    assert.ok(JSON.stringify(event).length < 1500);
    for (const forbidden of ['body', 'text', 'payload', 'entries', 'filePath', 'cwd', 'context', 'error', 'message', 'stack']) assert.equal(event[forbidden], undefined);
  }
  assert.ok(!JSON.stringify(f.events).includes(secret)); assert.ok(!JSON.stringify(f.events).includes(f.root));
  const expected = f.read();
  f.cache.onDiagnostic = () => { throw new Error('collector failed'); };
  assert.deepEqual(f.read(), expected); assert.equal(await f.save(), true);
  const rewritten = f.read(); // savePrepared intentionally changes indexNonce.
  f.cache.onDiagnostic = async () => { throw new Error('async collector failed'); };
  assert.deepEqual(f.read(), rewritten);
  await new Promise(resolve => setImmediate(resolve));
  f.cache.onDiagnostic = event => f.events.push(event);
  const unusualOwner = { sessionId: f.filePath + secret, cwd: f.root };
  assert.equal(f.cache.readSource(unusualOwner), null);
  assert.match(last(f.events, 'readSource').sessionId, /^[a-f0-9]{64}$/);
  for (let i = 0; i < 300; i++) {
    const filename = f.cache.filename({ sessionId: 'bounded-' + i });
    fs.copyFileSync(f.cache.filename(f.owner), filename); f.cache.removeFile(filename, 'invalidation');
  }
  assert.equal(f.cache.recentRemovals.size, 256);
  assert.ok([...f.cache.recentRemovals.keys()].every(key => /^[a-f0-9]{64}$/.test(key)));
  f.cache.readSource({ sessionId: 'bounded-0' }); assert.equal(last(f.events, 'readSource').reason, 'no-file');
  f.cache.readSource({ sessionId: 'bounded-299' }); assert.equal(last(f.events, 'readSource').reason, 'invalidation');
  const afterRestart = new HistoryPreparedCache({ directory: f.directory });
  assert.equal(afterRestart.recentRemovals.size, 0, 'removal history is never made durable');
  assert.deepEqual(fs.readdirSync(f.cache.directory), [path.basename(f.cache.filename(f.owner))]);
});
