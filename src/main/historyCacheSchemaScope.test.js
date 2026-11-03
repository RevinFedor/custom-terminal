// The prepared-history cache key must rotate when the MEANING of a stored row
// changes, and must NOT rotate for unrelated Main edits.
//
// Both directions are real failures with different costs:
//   too wide  -> every reinstall discards the warm cache (measured 01.11:
//                101 entries / 2.3 GB evicted as `obsolete-version`, then
//                2051 ms cold read for 1513 entries on every tab switch)
//   too narrow -> rows written by the OLD parser are reused by the NEW one and
//                history is silently shown wrong. This is the dangerous side,
//                so most assertions below guard it.
//
// Run: node --test src/main/historyCacheSchemaScope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  HISTORY_CACHE_SCHEMA_FILES,
  HISTORY_CACHE_NEUTRAL_FILES,
  selectHistoryCacheSchemaFiles,
  assertHistoryCacheScopeLoaded,
} = require('./history-cache-schema-scope');

const SRC_ROOT = path.resolve(__dirname, '..');

// Mirrors the worker: same inputs, same order, same mode tag.
function fingerprint(relativePaths, { mode = 'scope:format-v1', bytesOf } = {}) {
  const digest = crypto.createHash('sha256');
  digest.update('v8-fixed');
  digest.update(mode);
  for (const relative of relativePaths) {
    digest.update(relative);
    digest.update(bytesOf(relative));
  }
  return digest.digest('hex').slice(0, 20);
}

function bytesFromDisk(relative) {
  return fs.readFileSync(path.join(SRC_ROOT, relative));
}

test('every listed schema file exists on disk', () => {
  // A rename that is not reflected here would shrink the key silently, which
  // is the exact drift `assertHistoryCacheScopeLoaded` exists to catch — but
  // only at runtime. Catch it at test time too.
  for (const relative of HISTORY_CACHE_SCHEMA_FILES) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, relative)),
      'listed schema file is missing from disk: ' + relative);
  }
});

test('the worker itself is part of its own key', () => {
  // It builds the rows. A change to its preparation logic must rotate the key
  // even if no other listed file moved.
  assert.ok(HISTORY_CACHE_SCHEMA_FILES.includes('main/history-read-worker.js'));
});

test('a change to a FORMAT file rotates the key', () => {
  const loaded = [...HISTORY_CACHE_SCHEMA_FILES];
  const { included } = selectHistoryCacheSchemaFiles(loaded);
  const before = fingerprint(included, { bytesOf: bytesFromDisk });
  const after = fingerprint(included, {
    bytesOf: relative => relative === 'main/history-payload-dehydrate.js'
      ? Buffer.from('CHANGED PARSER')
      : bytesFromDisk(relative),
  });
  assert.notEqual(before, after, 'editing the dehydrator must invalidate stored rows');
});

test('each listed file individually rotates the key', () => {
  // Guards the dangerous direction file by file: no entry may be inert.
  const { included } = selectHistoryCacheSchemaFiles([...HISTORY_CACHE_SCHEMA_FILES]);
  const base = fingerprint(included, { bytesOf: bytesFromDisk });
  for (const target of included) {
    const mutated = fingerprint(included, {
      bytesOf: relative => relative === target ? Buffer.from('X') : bytesFromDisk(relative),
    });
    assert.notEqual(mutated, base, 'file does not affect the key: ' + target);
  }
});

test('an unrelated Main edit does NOT rotate the key', () => {
  // The whole point of narrowing. `claude-prompt-audit.js` is loaded by the
  // reader through database.js but cannot change a stored row.
  const loaded = [...HISTORY_CACHE_SCHEMA_FILES, 'main/claude-prompt-audit.js', 'main/main.js'];
  const { included } = selectHistoryCacheSchemaFiles(loaded);
  assert.ok(!included.includes('main/claude-prompt-audit.js'));
  assert.ok(!included.includes('main/main.js'));
  const before = fingerprint(included, { bytesOf: bytesFromDisk });
  const after = fingerprint(included, { bytesOf: bytesFromDisk });
  assert.equal(before, after);
});

test('load order does not change the key', () => {
  // require.cache order depends on how the process warmed up; the key must not.
  const forward = selectHistoryCacheSchemaFiles([...HISTORY_CACHE_SCHEMA_FILES]);
  const reversed = selectHistoryCacheSchemaFiles([...HISTORY_CACHE_SCHEMA_FILES].reverse());
  assert.deepEqual(forward.included, reversed.included);
  assert.deepEqual(forward.included, [...forward.included].sort());
});

test('a missing listed file is reported as drift, not silently dropped', () => {
  // The failure this protects against: someone renames the dehydrator, the
  // list keeps the old name, the key stops covering the new parser, and old
  // rows are reused under new code.
  const loaded = HISTORY_CACHE_SCHEMA_FILES.filter(n => n !== 'main/history-payload-dehydrate.js');
  const { included, missing } = selectHistoryCacheSchemaFiles(loaded);
  assert.deepEqual(missing, ['main/history-payload-dehydrate.js']);
  assert.ok(!included.includes('main/history-payload-dehydrate.js'));
  const drift = assertHistoryCacheScopeLoaded(missing);
  assert.ok(drift && drift.startsWith('history_cache_schema_scope_drift:'),
    'drift must be reported so the caller can widen the key');
  assert.match(drift, /history-payload-dehydrate\.js/);
});

test('no drift reported when every listed file is loaded', () => {
  const { missing } = selectHistoryCacheSchemaFiles([...HISTORY_CACHE_SCHEMA_FILES, 'main/main.js']);
  assert.deepEqual(missing, []);
  assert.equal(assertHistoryCacheScopeLoaded(missing), null);
});

test('the two modes cannot collide on identical bytes', () => {
  // The drift fallback hashes a different file set under the same algorithm.
  // Without the mode tag, a narrow set that happens to equal a wide one would
  // reuse the other mode's rows.
  const files = ['main/history-prepared-cache.js'];
  const narrow = fingerprint(files, { mode: 'scope:format-v1', bytesOf: bytesFromDisk });
  const wide = fingerprint(files, { mode: 'scope:all', bytesOf: bytesFromDisk });
  assert.notEqual(narrow, wide);
});

test('schema and neutral lists are disjoint and free of duplicates', () => {
  const schema = new Set(HISTORY_CACHE_SCHEMA_FILES);
  assert.equal(schema.size, HISTORY_CACHE_SCHEMA_FILES.length, 'duplicate entry in schema list');
  const neutral = new Set(HISTORY_CACHE_NEUTRAL_FILES);
  assert.equal(neutral.size, HISTORY_CACHE_NEUTRAL_FILES.length, 'duplicate entry in neutral list');
  for (const name of neutral) {
    assert.ok(!schema.has(name), 'file classified both ways: ' + name);
  }
});

test('the real worker source is covered by the scope it declares', () => {
  // Executes the actual selection against the worker's real dependency list,
  // rather than re-stating the list. Catches a require() that was added to the
  // worker for format work but never classified.
  const source = fs.readFileSync(path.join(SRC_ROOT, 'main/history-read-worker.js'), 'utf8');
  const required = [...source.matchAll(/require\('\.\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)'\)/g)]
    .map(match => 'main/' + match[1] + '.js');
  const classified = new Set([...HISTORY_CACHE_SCHEMA_FILES, ...HISTORY_CACHE_NEUTRAL_FILES]);
  const unclassified = [...new Set(required)]
    .filter(name => fs.existsSync(path.join(SRC_ROOT, name)))
    .filter(name => !classified.has(name));
  assert.deepEqual(unclassified, [],
    'the worker requires modules nobody classified as format-affecting or neutral: '
    + unclassified.join(', ') + ' — add each to history-cache-schema-scope.js');
});
