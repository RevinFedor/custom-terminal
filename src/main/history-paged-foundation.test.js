'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { HistoryPagedStore, isHistoryPagedCursor } = require('./history-paged-store');
const { createPagedJsonProjection } = require('./history-paged-json');
const { encodeHistoryStream } = require('./history-stream-codec');

function storeFor(t, options = {}) {
  const store = new HistoryPagedStore({ pageBytes: 1024, indexBytes: 2048, residentPages: 3, ...options });
  t.after(() => store.close());
  return store;
}
async function wire(cursor) {
  let text = '';
  for await (const bytes of encodeHistoryStream(cursor, { frameBytes: 1024 })) text += bytes.toString();
  return text; // Small semantic fixtures only. Large tests use incremental hashes.
}
function smallText(cursor) {
  assert.ok(cursor.length <= 256, 'test must not build a large oracle String');
  return [...cursor.textChunks()].join('');
}
function parseParts(store, parts) {
  const parser = createPagedJsonProjection(store, { selectedTokenBytes: 64 });
  let offset = 0;
  for (const text of parts) {
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length; at += 64) {
      const part = bytes.subarray(at, at + 64); parser.write(part, offset); offset += part.length;
    }
  }
  return { ...parser.finish(offset), stats: parser.stats() };
}

test('explicit cursors preserve sparse arrays, aliases, Map/Set identity and own fields at capture time', async t => {
  const store = storeFor(t);
  const shared = { text: 'old' }, sparse = new Array(4);
  sparse[1] = shared; sparse.extra = shared;
  const input = { shared, sparse, map: new Map([[shared, shared]]), set: new Set([shared]) };
  const lease = store.captureLegacy(input), root = lease.cursor();
  assert.equal(Array.isArray(root), false); assert.ok(isHistoryPagedCursor(root));
  assert.equal(root.field('shared').identity(), root.field('sparse').at(1).identity());
  assert.equal(root.field('shared').identity(), root.field('sparse').field('extra').identity());
  assert.equal(root.field('sparse').at(0).kind, 'undefined');
  shared.text = 'new'; sparse[1] = null;
  assert.equal(await wire(root), '{"shared":{"text":"old"},"sparse":[null,{"text":"old"},null,null],"map":{},"set":{}}');
  lease.release(); assert.throws(() => root.field('shared'), { code: 'history_lease_released' });
});

test('fork is zero-page CoW; one ordinal replacement does not mutate either old lease', async t => {
  const store = storeFor(t);
  const old = store.captureLegacy([{ id: 'a' }, { id: 'b' }]), before = store.stats().pagesWritten;
  const fork = old.fork();
  assert.equal(store.stats().pagesWritten, before);
  const replacement = store.captureLegacy({ id: 'c' });
  const next = store.withOrdinal(fork.cursor(), 1, replacement.cursor());
  assert.equal(await wire(old.cursor()), '[{"id":"a"},{"id":"b"}]');
  assert.equal(await wire(fork.cursor()), '[{"id":"a"},{"id":"b"}]');
  assert.equal(await wire(next.cursor()), '[{"id":"a"},{"id":"c"}]');
  fork.release(); old.release(); replacement.release(); next.release();
});

for (const indexBytes of [0, 2048]) for (const chars of [1024, 16 * 1024, 256 * 1024]) {
  test('existing parser sink: ' + chars + ' chars, input64/index' + indexBytes + ', no whole decoded leaf', async t => {
    const store = storeFor(t, { indexBytes });
    const expected = crypto.createHash('sha256');
    function* input() {
      yield '{"leaf":"';
      for (let offset = 0; offset < chars; offset += 32) {
        const part = 'x'.repeat(Math.min(32, chars - offset));
        expected.update(part, 'utf16le'); yield part;
      }
      yield '"}';
    }
    const parsed = parseParts(store, input());
    assert.equal(parsed.valid, true);
    const leaf = parsed.lease.cursor().field('leaf'), actual = crypto.createHash('sha256');
    let length = 0;
    for (const part of leaf.textChunks()) { actual.update(part, 'utf16le'); length += part.length; assert.ok(part.length <= 512); }
    assert.equal(actual.digest('hex'), expected.digest('hex'));
    assert.equal(length, chars);
    assert.equal(parsed.stats.legacyInputPeakStringChars, 0);
    assert.ok(parsed.stats.maxTokenBytes <= 64);
    assert.ok(parsed.stats.peakPageReadBytes <= 1024);
    assert.ok(parsed.stats.peakPageWriteBytes <= 1024);
    assert.ok(parsed.stats.peakCachedPages <= 3);
    assert.ok(parsed.stats.peakIndexBytes <= indexBytes);
    assert.equal(parsed.stats.canonicalReducerRouted, false, 'must not rename this module test into canonical acceptance');
    t.diagnostic(JSON.stringify({ chars, indexBytes, stats: parsed.stats, scope: 'parser/store only; canonical remains RED' }));
    parsed.lease.release();
  });
}

test('escaped keys/Unicode/lone surrogates/duplicate keys keep exact parsed semantics', async t => {
  const store = storeFor(t);
  const input = '{"\\u0061":"old","a":"\\ud800\\u0041😀\\\\\\\"\\n","__proto__":{"safe":true},"empty":[],"nil":null}';
  const parsed = parseParts(store, [input]);
  assert.equal(parsed.valid, true);
  assert.deepEqual(JSON.parse(await wire(parsed.lease.cursor())), JSON.parse(input));
  parsed.lease.release();
});

test('partial tail and malformed value never publish a lease; old pinned value survives collection', async t => {
  const store = storeFor(t);
  const old = store.captureLegacy({ text: 'committed' });
  const partial = parseParts(store, ['{"text":"', 'x'.repeat(1024)]);
  assert.equal(partial.valid, false); assert.equal(partial.lease, null);
  const invalid = parseParts(store, ['{"a":[1,]}']);
  assert.equal(invalid.valid, false); assert.equal(invalid.lease, null);
  let done = false;
  for (let step = 0; step < 1000 && !done; step++) done = store.collectStep(3).complete;
  assert.equal(done, true);
  assert.equal(smallText(old.cursor().field('text')), 'committed');
  old.release();
});

test('backing failure propagates as failure, not an invalid/empty source record', t => {
  const store = storeFor(t);
  const parser = createPagedJsonProjection(store, { selectedTokenBytes: 64 });
  const original = store.put.bind(store);
  let writes = 0;
  store.put = (...args) => { if (++writes === 3) throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' }); return original(...args); };
  assert.throws(() => parser.write('{"text":"x"}', 0), { code: 'ENOSPC' });
});

test('durable pin/reopen and explicit leases preserve a frozen source after source truncate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-paged-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'pages.sqlite'), source = path.join(dir, 'own.json');
  fs.writeFileSync(source, '{"text":"frozen"}');
  let store = new HistoryPagedStore({ filename });
  const parsed = parseParts(store, [fs.readFileSync(source, 'utf8')]);
  const descriptor = parsed.lease.descriptor;
  store.replacePin('checkpoint-own', parsed.lease.cursor());
  parsed.lease.release(); store.close();
  fs.writeFileSync(source, '');
  store = new HistoryPagedStore({ filename }); t.after(() => store.close());
  const restored = store.open(descriptor);
  assert.equal(await wire(restored.cursor()), '{"text":"frozen"}');
  restored.release(); store.removePin('checkpoint-own');
});

test('cyclic legacy aliases remain aliases; JSON codec rejects a cycle without a full DTO rebuild', async t => {
  const store = storeFor(t), input = {};
  input.self = input;
  const lease = store.captureLegacy(input);
  assert.equal(lease.cursor().identity(), lease.cursor().field('self').identity());
  await assert.rejects(wire(lease.cursor()), /circular structure/);
  lease.release();
});

test('forced leaf hash collision still requires an exact chunk comparison', t => {
  const store = storeFor(t, { textDigestFactory: () => ({ update() {}, digest() { return 'forced-collision'; } }) });
  const a = store.captureLegacy('a'.repeat(1024)), b = store.captureLegacy('a'.repeat(1023) + 'b');
  const same = store.captureLegacy('a'.repeat(1024));
  assert.equal(a.cursor().textEquals(b.cursor()), false);
  assert.equal(a.cursor().textEquals(same.cursor()), true);
  a.release(); b.release(); same.release();
});

test('100 parser ancestors use one resident frame and survive split boundaries', t => {
  const store = storeFor(t, { pageBytes: 256, indexBytes: 0 });
  const parsed = parseParts(store, ['['.repeat(100), '"deep"', ']'.repeat(100)]);
  assert.equal(parsed.valid, true); assert.equal(parsed.stats.maxParserFrames, 100);
  assert.equal(parsed.stats.residentParserFrames, 0);
  let cursor = parsed.lease.cursor();
  for (let i = 0; i < 100; i++) cursor = cursor.at(0);
  assert.equal(smallText(cursor), 'deep'); parsed.lease.release();
});

test('active ingest lease prevents collection; abort retains the prior durable publication', async t => {
  const store = storeFor(t), old = store.captureLegacy({ text: 'old' });
  store.replacePin('last-valid', old.cursor());
  const parser = createPagedJsonProjection(store, { selectedTokenBytes: 64 });
  parser.write('{"text":"partial', 0);
  assert.equal(store.collectStep(1).blockedByBuilders, 1);
  parser.abort(); assert.equal(store.stats().activeBuilders, 0);
  assert.equal(await wire(old.cursor()), '{"text":"old"}');
  old.release(); store.removePin('last-valid');
  let done = false;
  for (let i = 0; i < 1000 && !done; i++) done = store.collectStep(3).complete;
  assert.equal(done, true);
  assert.equal(store.sql('SELECT count(*) AS n FROM hp_pages').get().n, 0);
});

test('failed durable replacement rolls back to the old pin without a RAM fallback', async t => {
  const store = storeFor(t), old = store.captureLegacy({ text: 'old' });
  store.replacePin('last-valid', old.cursor());
  const next = store.captureLegacy({ text: 'new' });
  store.db.exec("CREATE TRIGGER reject_own_publication BEFORE INSERT ON hp_pins WHEN NEW.name='last-valid' BEGIN SELECT RAISE(ABORT,'fixture ENOSPC publication'); END;");
  assert.throws(() => store.replacePin('last-valid', next.cursor()), /ENOSPC publication/);
  const row = store.sql('SELECT page FROM hp_pins WHERE name=?').get('last-valid');
  assert.equal(row.page, old.descriptor.page);
  assert.equal(await wire(old.cursor()), '{"text":"old"}');
  old.release(); next.release();
});

test('integer own keys keep JSON.parse enumeration order without walking sparse ordinal holes', async t => {
  const store = storeFor(t, { pageBytes: 256 });
  const input = '{"x":0,"4294967294":"max","12":"twelve","1":"one","01":"not-index","12":"last"}';
  const parsed = parseParts(store, [input]);
  assert.equal(parsed.valid, true);
  assert.equal(await wire(parsed.lease.cursor()), JSON.stringify(JSON.parse(input)));
  parsed.lease.release();
});

test('root primitives preserve JSON scalar semantics and nested stack backing errors propagate', async t => {
  const store = storeFor(t);
  for (const input of ['null', 'true', '-0', '1e999', '"text"']) {
    const parsed = parseParts(store, [input]);
    assert.equal(parsed.valid, true);
    assert.equal(await wire(parsed.lease.cursor()), JSON.stringify(JSON.parse(input)));
    parsed.lease.release();
  }
  const parser = createPagedJsonProjection(store);
  const oldPut = store.put.bind(store);
  store.put = () => { throw Object.assign(new Error('fixture stack ENOSPC'), { code: 'ENOSPC' }); };
  assert.throws(() => parser.write('[[', 0), { code: 'ENOSPC' });
  store.put = oldPut;
  assert.equal(store.stats().activeBuilders, 0);
});
