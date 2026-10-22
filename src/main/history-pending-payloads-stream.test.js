'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { HistoryPendingPayloads, readChunkedPayload, initializePayloadChunks } = require('./history-pending-payloads');

const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-stream-pending-'));
  const pending = new HistoryPendingPayloads({ directory, chunkChars: 512, ...options });
  t.after(() => { pending.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { pending, directory };
}
const metadata = text => ({ totalChars: text.length, contentHash: digest(text) });
const staged = pending => pending.db.prepare('SELECT count(*) AS n FROM payload_staging_chunks').get().n;

for (const totalChars of [1024, 16 * 1024, 256 * 1024]) {
  test('PENDING-STREAM-' + totalChars + ':1KiB chunks and full ordered hash/length with incremental oracle', async t => {
    const { pending } = fixture(t), expected = crypto.createHash('sha256');
    // Two bounded producers, never a second complete payload/graph in heap.
    function* input() { for (let offset = 0; offset < totalChars; offset += 257) yield 'q'.repeat(Math.min(257, totalChars - offset)); }
    for (const chunk of input()) expected.update(chunk);
    const contentHash = expected.digest('hex');
    await pending.setChunks('result:own', input(), { totalChars, contentHash });
    const actual = crypto.createHash('sha256'); let offset = 0;
    do {
      const page = pending.readPage('result:own', { offset, limit: 511, expectedContentHash: contentHash });
      assert.equal(page.offset, offset); assert.equal(page.totalChars, totalChars);
      assert.equal(page.contentHash, contentHash); actual.update(page.payload); offset += page.payload.length;
      assert.equal(page.nextOffset, offset < totalChars ? offset : null);
    } while (offset < totalChars);
    assert.equal(offset, totalChars); assert.equal(actual.digest('hex'), contentHash);
    assert.ok(pending.metrics.peakChunkBytes <= 1024); assert.equal(staged(pending), 0);
    assert.equal(pending.chunkWrites.size, 0); assert.equal(pending.size, 1);
  });
}

test('PENDING-UTF16: split surrogate/lone surrogate, empty text and legacy set/get retain exact content', async t => {
  const { pending } = fixture(t, { chunkChars: 1 });
  const text = 'a😀\uD800z';
  await pending.setChunks('value', ['a', '\uD83D', '\uDE00', '\uD800', 'z'], metadata(text));
  assert.equal(pending.get('value'), text);
  assert.equal(pending.readPage('value', { offset: 1, limit: 2 }).payload, '😀');
  assert.throws(() => pending.readPage('value', { offset: 2, limit: 2 }), /history_payload_range_invalid/);
  await pending.setChunks('empty', [], metadata('')); assert.equal(pending.get('empty'), '');
  pending.set('value', text); assert.equal(pending.get('value'), text);
});

test('PENDING-FAILED-HASH-LENGTH: no partial replacement and no orphan chunks', async t => {
  const { pending } = fixture(t); pending.set('value', 'trusted');
  await assert.rejects(pending.setChunks('value', ['other'], metadata('wrong')), { code: 'history_payload_changed' });
  await assert.rejects(pending.setChunks('value', ['too long'], metadata('short')), { code: 'history_payload_changed' });
  assert.equal(pending.get('value'), 'trusted'); assert.equal(staged(pending), 0);
  assert.equal(pending.size, 1); assert.equal(pending.metrics.stagedChars, 7);
});

test('PENDING-FINAL-PROOF: producer final rejection cannot publish previously yielded bytes', async t => {
  const { pending } = fixture(t); pending.set('value', 'trusted');
  let unblock, reached; const barrier = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const changed = Object.assign(Error('source proof changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  const input = (async function* () { yield 'n'.repeat(1024); reached(); await barrier; throw changed; })();
  const writing = pending.setChunks('value', input, metadata('n'.repeat(1024)));
  const failure = assert.rejects(writing, error => error === changed);
  await ready; assert.equal(pending.get('value'), 'trusted'); assert.ok(staged(pending) > 0);
  unblock(); await failure;
  assert.equal(pending.get('value'), 'trusted'); assert.equal(staged(pending), 0);
});

test('PENDING-VALIDATE-SOURCE: final fence rejection remains invalidation, never cache miss or cancellation', async t => {
  const { pending } = fixture(t); pending.set('value', 'trusted');
  await assert.rejects(pending.setChunks('value', ['new'], { ...metadata('new'), validateSource: async () => false }),
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(pending.get('value'), 'trusted'); assert.equal(staged(pending), 0);
});

test('PENDING-C-BEFORE-UNWIND: A cleanup cannot overwrite/delete a newer successful C', async t => {
  const { pending } = fixture(t); pending.set('value', 'trusted');
  let unblock, reached; const barrier = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const writing = pending.setChunks('value', (async function* () { yield 'a'.repeat(1024); reached(); await barrier; yield 'late'; })(),
    metadata('a'.repeat(1024) + 'late'));
  const failure = assert.rejects(writing, { code: 'HISTORY_PAYLOAD_STAGING_SUPERSEDED' });
  await ready; await pending.setChunks('value', ['current'], metadata('current'));
  unblock(); await failure;
  assert.equal(pending.get('value'), 'current'); assert.equal(staged(pending), 0); assert.equal(pending.chunkWrites.size, 0);
});

test('PENDING-LAST-CLOSE: suspended A releases its own staging file and cannot damage C', async t => {
  const A = fixture(t).pending, C = fixture(t).pending;
  let unblock, reached; const barrier = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const writing = A.setChunks('value', (async function* () { yield 'a'.repeat(1024); reached(); await barrier; yield 'last'; })(),
    metadata('a'.repeat(1024) + 'last'));
  const failure = assert.rejects(writing, /history_pending_payloads_closed/);
  await ready; const filename = A.filename; A.close();
  await C.setChunks('value', ['C'], metadata('C')); unblock(); await failure;
  assert.equal(fs.existsSync(filename), false); assert.equal(C.get('value'), 'C');
});

test('PENDING-SLOW-CANCEL: no input prefetch; original typed cancellation survives cleanup', async t => {
  let cancelled = false, resume, reached, yielded = 0;
  const stopped = Object.assign(Error('own consumer cancelled'), { code: 'HISTORY_READ_CANCELLED' });
  const ready = new Promise(resolve => { reached = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  const control = { assertCurrent() { if (cancelled) throw stopped; }, async checkpoint() { reached(); await barrier; this.assertCurrent(); } };
  const { pending } = fixture(t, { control }); pending.set('value', 'trusted');
  const writing = pending.setChunks('value', (async function* () { for (let index = 0; index < 3; index++) { yielded++; yield 'x'; } })(), metadata('xxx'));
  const failure = assert.rejects(writing, error => error === stopped);
  await ready; assert.equal(yielded, 1); cancelled = true; resume(); await failure;
  cancelled = false;
  assert.equal(pending.get('value'), 'trusted'); assert.equal(staged(pending), 0);
});

test('PENDING-ATOMIC-SQL: publication failure rolls back prior value and metadata', async t => {
  const { pending } = fixture(t); pending.set('value', 'trusted');
  // A bounded, deliberate SQL rejection exercises the transaction rollback;
  // no resource exhaustion or user data is involved.
  pending.db.exec(`CREATE TRIGGER reject_replacement BEFORE INSERT ON payload_index
    WHEN NEW.total_chars=3 BEGIN SELECT RAISE(ABORT,'own synthetic publication rejection'); END;`);
  await assert.rejects(pending.setChunks('value', ['new'], metadata('new')), /own synthetic publication rejection/);
  assert.equal(pending.get('value'), 'trusted'); assert.equal(staged(pending), 0);
});

test('PENDING-CACHE-RESTART: old five-column format,1KiB transfer and reopen retain content/hash', async t => {
  const { pending, directory } = fixture(t), filename = path.join(directory, 'cache.sqlite');
  let db = new Database(filename); t.after(() => { if (db.open) db.close(); });
  db.exec(`CREATE TABLE payload_index(id TEXT PRIMARY KEY,total_chars INTEGER NOT NULL,content_hash TEXT NOT NULL,
    chunks INTEGER NOT NULL,index_hash TEXT NOT NULL); CREATE TABLE payload_chunks(id TEXT,pos INTEGER,body BLOB,
    checksum TEXT,PRIMARY KEY(id,pos)); CREATE TABLE payloads(id TEXT PRIMARY KEY,body BLOB);`);
  const old = 'old', hash = digest(old), body = Buffer.from(old, 'utf16le');
  db.prepare('INSERT INTO payload_index VALUES(?,?,?,?,?)').run('legacy', old.length, hash, 1,
    digest(JSON.stringify(['legacy', old.length, hash, 1])));
  db.prepare('INSERT INTO payload_chunks VALUES(?,?,?,?)').run('legacy', 0, body,
    crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(readChunkedPayload(db, 'legacy').payload, old);
  initializePayloadChunks(db); assert.equal(readChunkedPayload(db, 'legacy').payload, old);
  const text = 'x'.repeat(2048) + '😀';
  await pending.setChunks('new', ['x'.repeat(1024), 'x'.repeat(1024), '\uD83D', '\uDE00'], metadata(text));
  await pending.transferToAsync(db); db.close(); db = new Database(filename);
  const restored = readChunkedPayload(db, 'new');
  assert.equal(restored.payload, text); assert.equal(restored.contentHash, digest(text));
  assert.equal(readChunkedPayload(db, 'legacy').payload, old);
  db.close();
});
