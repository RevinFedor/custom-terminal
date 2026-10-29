'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { readLatestCodexContextObservation: read, codexContextObservationFromRecord: observation } = require('./codex-context-usage');
const token = used => ({ type: 'event_msg', payload: { type: 'token_count',
  info: { last_token_usage: { total_tokens: used }, model_context_window: 1000 } } });

// Finite test oracle owns the complete small fixture. Product reads stay
// reverse/chunked; the oracle deliberately has no carry/framing implementation.
function reference(bytes, { endOffset = bytes.length, maxBytes = bytes.length } = {}) {
  const end = Math.max(0, Math.min(bytes.length, endOffset));
  if (!end) return { kind: 'unknown', reason: 'empty-range', scannedBytes: 0 };
  const start = Math.max(0, end - Math.max(1, maxBytes));
  let text = bytes.subarray(start, end).toString('utf8');
  if (start > 0) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
  let parseErrors = 0;
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line.trim()); } catch { parseErrors++; continue; }
    const value = observation(record);
    if (value) return { ...value, source: 'rollout-tail', parseErrors };
  }
  return { kind: 'unknown', reason: start > 0 ? 'no-context-observation-in-bounded-tail' : 'no-context-observation', parseErrors };
}

async function fixture(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-tail-linear-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl'); await fs.writeFile(file, bytes); return file;
}

test('reverse framing preserves complete selection at UTF8, CRLF, invalid-line and byte-budget boundaries', async t => {
  const bytes = Buffer.from(JSON.stringify(token(830)) + '\r\n'
    + JSON.stringify({ text: 'A😀Б\u0000\ud800' }) + '\ninvalid-json\n'
    + JSON.stringify({ type: 'compacted', timestamp: 'T' }) + '\n'
    + JSON.stringify(token(120)) + '\n{"incomplete":');
  const file = await fixture(t, bytes), emoji = bytes.indexOf(Buffer.from('😀'));
  const ends = [...new Set([0, 1, 2, emoji, emoji + 1, emoji + 2, emoji + 3, emoji + 4, bytes.length - 1, bytes.length])];
  for (const endOffset of ends) for (const maxBytes of [1, 19, bytes.length]) for (const chunkBytes of [1, 3, 7, 64]) {
    const options = { endOffset, maxBytes, chunkBytes }, stats = {};
    const result = await read(file, { ...options, framingStats: stats }), expected = reference(bytes, options);
    if (expected.scannedBytes === 0) assert.deepEqual(result, expected);
    else {
      const { scannedBytes, ...value } = result;
      assert.deepEqual(value, expected, JSON.stringify(options));
      assert.ok(scannedBytes <= Math.min(endOffset, maxBytes));
      assert.ok(stats.copiedBytes <= 2 * scannedBytes);
      assert.ok(stats.maxCarryBlocks <= Math.ceil(stats.maxCarryBytes / Math.min(65536, endOffset, maxBytes)));
    }
  }
});

test('one long unrelated record is fully inspected with linear carry copies and bounded block count', async t => {
  const bytes = Buffer.from(JSON.stringify(token(420)) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024 * 1024) + '😀\u0000\ud800' } }) + '\r\n');
  const file = await fixture(t, bytes), stats = {};
  const result = await read(file, { maxBytes: bytes.length, chunkBytes: 4096, framingStats: stats });
  const { scannedBytes, ...value } = result;
  assert.deepEqual(value, reference(bytes));
  assert.equal(scannedBytes, bytes.length);
  assert.equal(result.contextPct, 42);
  assert.ok(stats.maxCarryBytes > 1024 * 1024 - 4096);
  assert.ok(stats.copiedBytes <= 2 * scannedBytes);
  assert.ok(stats.maxCarryBlocks <= 17);
  assert.equal(stats.lineAssemblies, 1);
  assert.deepEqual(await read(file, { maxBytes: bytes.length, chunkBytes: 4096,
    framingStats: Object.freeze({}) }), result, 'optional diagnostic counters cannot break a complete read');
});

test('a large compact still wins over older usage and remains unknown if cut by the byte budget', async t => {
  const bytes = Buffer.from(JSON.stringify(token(900)) + '\n'
    + JSON.stringify({ type: 'compacted', payload: { replacement_history: [{ text: 'Ж😀'.repeat(40000) }] } }));
  const file = await fixture(t, bytes), stats = {};
  const result = await read(file, { maxBytes: bytes.length, chunkBytes: 37, framingStats: stats });
  const { scannedBytes, ...value } = result;
  assert.deepEqual(value, reference(bytes));
  assert.equal(result.kind, 'invalidated'); assert.ok(scannedBytes <= bytes.length);
  assert.ok(stats.copiedBytes <= 2 * scannedBytes);
  const bounded = await read(file, { maxBytes: 1024, chunkBytes: 37 });
  assert.equal(bounded.kind, 'unknown'); assert.equal(bounded.scannedBytes, 1024);
});
