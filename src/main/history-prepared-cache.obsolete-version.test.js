'use strict';

// The parser hash is part of the cache directory's own name, so a read must
// match it exactly: a previous build's directory can never be read again. It
// was nevertheless kept until quota pressure, which left 14.4 GiB of two dead
// builds inside the 20 GiB budget while the live build's own reads evicted each
// other, and 54 empty version folders behind them.
//
// These controls use the directory layout directly instead of the shared
// fixture, which cannot seed on this HEAD (6 of 9 retention tests fail
// identically on the untouched file).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HistoryPreparedCache } = require('./history-prepared-cache');

const key = char => String(char).repeat(64);

function layout(t, { schema = '1-beef', dirs = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-obsolete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'cache');
  for (const [name, files] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(directory, name), { recursive: true });
    for (const [file, bytes] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, name, file), Buffer.alloc(bytes, 1));
    }
  }
  const events = [];
  // The version-directory scan accepts a hex suffix only, exactly as the worker
  // produces it ('1-' + sha256.slice(0, 20)); a non-hex name is invisible to it.
  assert.match(schema, /^\d+-[a-f0-9]+$/, 'fixture schema must look like a real one');
  const cache = new HistoryPreparedCache({ directory, schema, maxBytes: 64 * 1024 ** 3,
    onDiagnostic: event => events.push(event) });
  const prune = events.filter(event => event.operation === 'prune').pop();
  return { root, directory, cache, events, prune,
    exists: (...parts) => fs.existsSync(path.join(directory, ...parts)) };
}

test('a previous build cache is dropped even with the budget far from full', t => {
  const f = layout(t, { dirs: {
    'v1-dead': { [key('a') + '.sqlite']: 4096, [key('b') + '.sqlite']: 2048 },
    'v1-beef': { [key('c') + '.sqlite']: 1024 },
  } });
  assert.equal(f.exists('v1-dead'), false,
    'an unreadable version must not wait for quota pressure to be collected');
  assert.equal(f.exists('v1-beef', key('c') + '.sqlite'), true,
    'the current version must be untouched');
  assert.equal(f.prune.obsoleteEvictedCount, 2);
  assert.equal(f.prune.evictedBytes, 6144);
  assert.equal(f.prune.reason, 'obsolete-version',
    'collecting a dead version is not disk pressure and must not be reported as it');
  assert.equal(f.prune.diskBytes, 1024,
    'reported usage must drop to the live version alone, or the budget stays falsely full');
});

test('emptied version folders do not accumulate', t => {
  const dirs = { 'v1-beef': { [key('c') + '.sqlite']: 1024 } };
  for (let i = 0; i < 12; i++) dirs['v1-dead' + i.toString(16)] = {};
  const f = layout(t, { dirs });
  for (let i = 0; i < 12; i++) {
    assert.equal(f.exists('v1-dead' + i.toString(16)), false, 'empty version folder ' + i);
  }
  assert.equal(f.exists('v1-beef'), true);
});

test('an unrelated folder beside the cache is never removed', t => {
  const f = layout(t, { dirs: {
    'v1-beef': { [key('c') + '.sqlite']: 1024 },
    'paged-read-plane': { 'page-0.bin': 2048 },
    'v1-dead': { [key('a') + '.sqlite']: 4096 },
  } });
  assert.equal(f.exists('paged-read-plane', 'page-0.bin'), true,
    'only directories matching the version pattern may be collected');
  assert.equal(f.exists('v1-dead'), false);
});

test('a file held open by a live read is deferred, and its folder survives', t => {
  const f = layout(t, { dirs: { 'v1-beef': { [key('c') + '.sqlite']: 1024 } } });
  const held = path.join(f.directory, 'v1-dead', key('d') + '.sqlite');
  fs.mkdirSync(path.dirname(held), { recursive: true });
  fs.writeFileSync(held, Buffer.alloc(8192, 1));
  f.cache.activeFiles.add(held);
  f.cache.prune();
  assert.equal(fs.existsSync(held), true,
    'an in-flight read must never have its file unlinked underneath it');
  const prune = f.events.filter(event => event.operation === 'prune').pop();
  assert.equal(prune.activeCount, 1);
  f.cache.activeFiles.delete(held);
  f.cache.prune();
  assert.equal(fs.existsSync(path.dirname(held)), false,
    'once released, the obsolete version is collected on the next sweep');
});
