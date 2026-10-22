'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { LEAF, createJsonProjection, readProjectedJsonlRange } = require('./codex-json-projection');
const { createJsonStringDecoder, streamSourceLeaf, readSourceLeafPage } = require('./history-source-leaf');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-source-leaf-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'own.jsonl');
}
// This oracle generates bounded chunks directly. It does not retain the full
// value or a second parsed graph in the measured process.
function writeCorpus(filename, records, leafChars) {
  const fd = fs.openSync(filename, 'w'), expected = createHash('sha256');
  try {
    for (let index = 0; index < records; index++) {
      fs.writeSync(fd, '{"id":' + index + ',"text":"');
      for (let done = 0; done < leafChars;) {
        const chars = Math.min(257, leafChars - done), text = 'x'.repeat(chars);
        fs.writeSync(fd, text); expected.update(text); done += chars;
      }
      fs.writeSync(fd, '"}\n');
    }
  } finally { fs.closeSync(fd); }
  return expected.digest('hex');
}

for (const size of [1024, 16 * 1024, 256 * 1024]) {
  test('LEAF-' + size + ': selected token64B/frame1KiB, full length/hash without full materialization', async t => {
    const filename = temporary(t), expected = writeCorpus(filename, 1, size), metrics = {};
    let count = 0, length = 0, maxRead = 0, maxDecoded = 0;
    const actual = createHash('sha256');
    const result = await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, {
      schema: { id: true, text: LEAF }, selectedTokenBytes: 64, highWaterMark: 1024, metrics,
      async onRecord(record) {
        assert.equal(record.id, count++);
        assert.equal(record.text.totalChars, size);
        const leafMetrics = {};
        for await (const text of streamSourceLeaf({ filePath: filename, ref: record.text,
          chunkBytes: 1024, metrics: leafMetrics })) { length += text.length; actual.update(text); }
        assert.equal(leafMetrics.verified, true);
        maxRead = Math.max(maxRead, leafMetrics.maxReadChunkBytes);
        maxDecoded = Math.max(maxDecoded, leafMetrics.maxDecodedChunkBytes);
      },
    });
    assert.equal(result.parsed, 1); assert.equal(count, 1); assert.equal(length, size);
    assert.equal(actual.digest('hex'), expected);
    assert.ok(metrics.maxTokenBytes <= 64, JSON.stringify(metrics));
    assert.ok(metrics.maxChunkBytes <= 1024); assert.ok(maxRead <= 1024); assert.ok(maxDecoded <= 1024);
  });
}

for (const records of [1, 10, 100]) {
  test('RECORDS-' + records + ': ordered IDs, no collector, one consumer record', async t => {
    const filename = temporary(t), expected = writeCorpus(filename, records, 1024), actual = createHash('sha256');
    const metrics = {}; let count = 0;
    const result = await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, {
      schema: { id: true, text: LEAF }, selectedTokenBytes: 64, highWaterMark: 1024, metrics,
      async onRecord(record) {
        assert.equal(record.id, count++);
        for await (const chunk of streamSourceLeaf({ filePath: filename, ref: record.text, chunkBytes: 1024 })) actual.update(chunk);
      },
    });
    assert.equal(result.parsed, records); assert.equal(count, records);
    assert.equal(actual.digest('hex'), expected);
    assert.equal(metrics.maxCollectedRecords, 0); assert.equal(metrics.maxConsumerRecords, 1);
    assert.ok(metrics.maxTokenBytes <= 64);
  });
}

test('UTF16: escape/UTF8 boundaries, astral pair, lone surrogate, duplicate-key last value', async t => {
  const filename = temporary(t);
  const text = 'é🤖\n\r\t\\/"\b\f\uD800X\uDC00終';
  const json = JSON.stringify({ text });
  fs.writeFileSync(filename, json);
  const parser = createJsonProjection({ text: LEAF }, { selectedTokenBytes: 64 });
  const bytes = Buffer.from(json);
  for (let i = 0; i < bytes.length; i++) parser.write(bytes.subarray(i, i + 1).toString('latin1'), i);
  const value = parser.finish(bytes.length);
  assert.equal(value.valid, true); assert.equal(value.value.text.totalChars, text.length);
  assert.equal(value.value.text.contentHash, createHash('sha256').update(text).digest('hex'));
  const page = await readSourceLeafPage({ filePath: filename, ref: value.value.text, offset: 0, limit: 1024, chunkBytes: 8 });
  assert.equal(page.payload, text);
  const duplicate = createJsonProjection({ text: LEAF }, { selectedTokenBytes: 64 });
  const encoded = '{"text":"first","text":"last"}'; duplicate.write(encoded, 0);
  assert.equal(duplicate.finish(encoded.length).value.text.contentHash, createHash('sha256').update('last').digest('hex'));
});

test('PAGE-MISS: read exact token after restart, full hash validates unseen suffix; no History callback', async t => {
  const filename = temporary(t); writeCorpus(filename, 1, 256 * 1024);
  let ref;
  await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, {
    schema: { text: LEAF }, highWaterMark: 1024, selectedTokenBytes: 64, onRecord: record => { ref = JSON.parse(JSON.stringify(record.text)); },
  });
  const metrics = {};
  const page = await readSourceLeafPage({ filePath: filename, ref, offset: 4096, limit: 100, chunkBytes: 1024, metrics });
  assert.equal(page.payload, 'x'.repeat(100)); assert.equal(page.nextOffset, 4196);
  assert.equal(metrics.sourceBytes, ref.to - ref.from); assert.equal(metrics.verified, true);
  const fd = fs.openSync(filename, 'r+'); fs.writeSync(fd, Buffer.from('z'), 0, 1, ref.to - 2); fs.closeSync(fd);
  await assert.rejects(readSourceLeafPage({ filePath: filename, ref, offset: 0, limit: 10, chunkBytes: 1024 }),
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('PAGE-UTF16: cursor never skips a pair and invalid low-surrogate offset is rejected', async t => {
  const filename = temporary(t), input = 'x🤖y'; fs.writeFileSync(filename, JSON.stringify(input));
  const parser = createJsonProjection(LEAF, { selectedTokenBytes: 64 });
  const bytes = fs.readFileSync(filename); parser.write(bytes.toString('latin1'), 0);
  const ref = parser.finish(bytes.length).value;
  const first = await readSourceLeafPage({ filePath: filename, ref, offset: 0, limit: 2, chunkBytes: 8 });
  assert.equal(first.payload, 'x'); assert.equal(first.nextOffset, 1);
  const second = await readSourceLeafPage({ filePath: filename, ref, offset: 1, limit: 2, chunkBytes: 8 });
  assert.equal(second.payload, '🤖'); assert.equal(second.nextOffset, 3);
  await assert.rejects(readSourceLeafPage({ filePath: filename, ref, offset: 2, limit: 2 }), /history_payload_range_invalid/);
});

test('TAIL: newline commit only; arbitrary chunk splitting does not retain partial giant token', async t => {
  const filename = temporary(t); fs.writeFileSync(filename, '{"text":"ok"}\n{"text":"' + 'x'.repeat(4096));
  const metrics = {}; let records = 0;
  const result = await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, {
    schema: { text: LEAF }, highWaterMark: 1024, selectedTokenBytes: 64, metrics, onRecord: () => { records++; },
  });
  assert.equal(records, 1); assert.equal(result.parsed, 1); assert.equal(result.partialBytes, 4105);
  assert.ok(metrics.maxTokenBytes <= 64); assert.ok(!result.leftoverBuffer);
});

test('ABORT: consumer cancellation is not source invalidation and closes one source handle', async t => {
  const filename = temporary(t); writeCorpus(filename, 1, 4096); let ref, revoked = false, reads = 0;
  await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, { schema: { text: LEAF }, onRecord: record => { ref = record.text; } });
  const abort = Object.assign(Error('consumer-revoked'), { code: 'HISTORY_READ_CANCELLED' });
  const iterator = streamSourceLeaf({ filePath: filename, ref, chunkBytes: 1024,
    control: { assertCurrent() { if (revoked) throw abort; } } });
  for await (const _chunk of iterator) { reads++; revoked = true; break; }
  assert.equal(reads, 1);
  revoked = false;
  await assert.rejects(async () => {
    for await (const _chunk of streamSourceLeaf({ filePath: filename, ref, chunkBytes: 1024,
      control: { assertCurrent() { if (revoked) throw abort; } } })) revoked = true;
  }, error => error === abort);
});

for (const mutation of ['append', 'truncate', 'replace', 'same-size', 'remove']) {
  test('SOURCE-' + mutation.toUpperCase() + ': change after admission rejects completion', async t => {
    const filename = temporary(t); writeCorpus(filename, 1, 4096); let ref;
    await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1,
      { schema: { text: LEAF }, onRecord: record => { ref = record.text; } });
    const iterator = streamSourceLeaf({ filePath: filename, ref, chunkBytes: 1024 });
    assert.equal((await iterator.next()).done, false);
    if (mutation === 'append') fs.appendFileSync(filename, ' ');
    else if (mutation === 'truncate') fs.truncateSync(filename, 2);
    else if (mutation === 'replace') {
      const replacement = filename + '.replacement'; writeCorpus(replacement, 1, 4096); fs.renameSync(replacement, filename);
    } else if (mutation === 'same-size') {
      const before = fs.statSync(filename), handle = fs.openSync(filename, 'r+');
      fs.writeSync(handle, Buffer.from('z'), 0, 1, ref.to - 2); fs.closeSync(handle);
      fs.utimesSync(filename, before.atime, before.mtime);
    } else fs.unlinkSync(filename);
    await assert.rejects(async () => { for await (const _chunk of iterator) {} }, { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  });
}

test('SOURCE-MISSING: missing before admission is unavailable; a saved physical witness makes removal invalidation', async t => {
  const filename = temporary(t); writeCorpus(filename, 1, 1024); let ref;
  await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1,
    { schema: { text: LEAF }, onRecord: record => { ref = record.text; } });
  const stat = fs.statSync(filename), expectedSource = { size: stat.size, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino };
  fs.unlinkSync(filename);
  await assert.rejects(async () => { for await (const _chunk of streamSourceLeaf({ filePath: filename, ref })) {} }, { code: 'ENOENT' });
  await assert.rejects(async () => { for await (const _chunk of streamSourceLeaf({ filePath: filename, ref, expectedSource })) {} },
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
});

test('TAIL-UTF8: partial astral bytes are not admitted, completion preserves exact decoded leaf', async t => {
  const filename = temporary(t), prefix = '{"text":"ok"}\n{"text":"';
  fs.writeFileSync(filename, Buffer.concat([Buffer.from(prefix), Buffer.from([0xF0, 0x9F])]));
  let count = 0;
  const options = { schema: { text: LEAF }, highWaterMark: 8, selectedTokenBytes: 64, onRecord: () => { count++; } };
  const first = await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1, options);
  assert.equal(count, 1); assert.ok(first.partialBytes > 0);
  fs.appendFileSync(filename, Buffer.from([0xA4, 0x96, 0x22, 0x7D, 0x0A]));
  let last;
  const second = await readProjectedJsonlRange(filename, 0, fs.statSync(filename).size - 1,
    { ...options, onRecord: record => { last = record.text; } });
  assert.equal(second.parsed, 2); assert.equal(second.partialBytes, 0);
  assert.equal((await readSourceLeafPage({ filePath: filename, ref: last, offset: 0, limit: 2, chunkBytes: 8 })).payload, '🤖');
});

test('MALFORMED: selected and ignored invalid escape remain invalid JSON; no descriptor publication', () => {
  for (const source of ['{"text":"bad\\q"}', '{"text":"ok","ignore":"bad\\u000x"}']) {
    const parser = createJsonProjection({ text: LEAF }, { selectedTokenBytes: 64 });
    parser.write(source, 0); assert.equal(parser.finish(source.length).valid, false);
  }
  const decoder = createJsonStringDecoder({ chunkChars: 1 }); decoder.write(Buffer.from('"a\\uD800"'));
  assert.equal(decoder.finish().totalChars, 2);
});
