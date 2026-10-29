'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { CodexRolloutReadViews, decodeZstd } = require('./codex-rollout-read-views');
const { createReadControl, withReadControl } = require('./history-read-control');

function compressed(bytes) {
  if (zlib.zstdCompressSync) return zlib.zstdCompressSync(bytes);
  return execFileSync('zstd', ['-q', '-c'], { input: bytes });
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-readviews-test-'));
  const source = path.join(root, 'rollout-11111111-1111-4111-8111-111111111111.jsonl.zst');
  const bytes = Buffer.from('{"type":"session_meta","payload":{"id":"test"}}\n{"text":"Привет 😀"}\n');
  await fs.writeFile(source, compressed(bytes));
  const views = new CodexRolloutReadViews({ tempRoot: root, diskFloorBytes: 0, ...options });
  const control = createReadControl();
  t.after(async () => { control.finish(); await views.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, source, bytes, views, control, prepare: () => views.prepare(source, { control }) };
}

test('compressed read is byte-exact, seekable, cached, and never materializes/deletes the provider file', async t => {
  let decodes = 0;
  const f = await fixture(t, { decoder: async (...args) => { decodes++; return decodeZstd(...args); } });
  const original = await fs.readFile(f.source), one = await f.prepare(), two = await f.prepare();
  assert.equal(decodes, 1); assert.equal(one.filePath, two.filePath);
  assert.deepEqual(await fs.readFile(one.filePath), f.bytes);
  const h = await fs.open(one.filePath, 'r');
  try { const b = Buffer.alloc(8); await h.read(b, 0, b.length, 7); assert.deepEqual(b, f.bytes.subarray(7, 15)); }
  finally { await h.close(); }
  assert.deepEqual(await fs.readFile(f.source), original);
  await assert.rejects(fs.stat(f.source.slice(0, -4)), { code: 'ENOENT' });
  assert.deepEqual(f.views.backingPaths(one.filePath), [f.source.slice(0, -4), f.source]);
});

test('native resume wins over an old read view and invalidates its backing certificate', async t => {
  const f = await fixture(t), old = await f.prepare(), plain = f.source.slice(0, -4);
  await fs.writeFile(plain, Buffer.concat([f.bytes, Buffer.from('{"new":"writer"}\n')]));
  assert.equal((await f.prepare()).filePath, plain);
  await assert.rejects(f.views.assertCurrent(old.filePath), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('one cancelled borrower cannot cancel another borrower of the same transcode', async t => {
  const entered = deferred(), release = deferred(); let decodes = 0;
  const f = await fixture(t, { admitRead: async () => { entered.resolve(); await release.promise; },
    decoder: async (...args) => { decodes++; return decodeZstd(...args); } });
  const abort = new AbortController(), a = createReadControl({ signal: abort.signal }), b = createReadControl();
  t.after(() => { a.finish(); b.finish(); });
  const first = f.views.prepare(f.source, { control: a });
  const rejected = assert.rejects(first, { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  await entered.promise;
  const second = f.views.prepare(f.source, { control: b });
  // Register B's demand before revoking A, without a time-based wait.
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await rejected;
  release.resolve(); const result = await second;
  assert.deepEqual(await fs.readFile(result.filePath), f.bytes); assert.equal(decodes, 1);
  b.finish();
});

test('last-demand cancellation removes partial decoded bytes but preserves the original', async t => {
  const entered = deferred();
  const f = await fixture(t, { decoder: async (_source, target, { signal }) => {
    await fs.writeFile(target, 'partial'); entered.resolve();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { code: 'HISTORY_READ_CONSUMER_REVOKED' })), { once: true }));
  } });
  const abort = new AbortController(), control = createReadControl({ signal: abort.signal });
  const read = f.views.prepare(f.source, { control });
  const rejected = assert.rejects(read, { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  await entered.promise; abort.abort(); await rejected; control.finish();
  // Await the actual owned decoder cleanup, not an arbitrary delay.
  await f.views.admission.acquire().then(release => release());
  assert.equal(f.views.stats().entries, 0);
  assert.ok((await fs.stat(f.source)).isFile());
  if (f.views.ownedRoot) assert.deepEqual(await fs.readdir(f.views.ownedRoot), ['.noted-readview-owner.json']);
});

test('capacity refusal and corrupt compressed data never turn into source deletion', async t => {
  const f = await fixture(t, { freeBytes: async () => 32 * 1024 * 1024 + 4 });
  await assert.rejects(f.prepare(), { code: 'CODEX_COMPRESSED_READ_DISK_CAPACITY' });
  assert.ok((await fs.stat(f.source)).isFile()); assert.equal(f.views.stats().entries, 0);
  const other = await fixture(t); await fs.writeFile(other.source, 'not a zstd frame');
  await assert.rejects(other.prepare());
  assert.equal(await fs.readFile(other.source, 'utf8'), 'not a zstd frame');
});

test('source rewrite during decoding refuses publication of the old representation', async t => {
  const f = await fixture(t, { decoder: async (source, target, options) => {
    const count = await decodeZstd(source, target, options);
    await fs.writeFile(source, compressed(Buffer.from('new source\n'))); return count;
  } });
  await assert.rejects(f.prepare(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(f.views.stats().entries, 0);
});

test('authorized in-place preparation preserves logical bytes and performs no-clobber native materialization', async t => {
  const f = await fixture(t), view = await f.prepare();
  const result = await f.views.materializeForMutation(view.filePath);
  assert.equal(result.filePath, f.source.slice(0, -4)); assert.equal(result.representationMaterialized, true);
  assert.deepEqual(await fs.readFile(result.filePath), f.bytes);
  await assert.rejects(fs.stat(f.source), { code: 'ENOENT' });
});

test('Electron-compatible PATH zstd fallback decodes without a Codex process or model turn', async t => {
  const f = await fixture(t, { decoder: (source, target, options) => decodeZstd(source, target, { ...options, preferNative: false }) });
  const result = await f.prepare(); assert.deepEqual(await fs.readFile(result.filePath), f.bytes);
});
