'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFER, PRESENCE, ITEMS, RANGE, createJsonProjection,
  readProjectedValue, readProjectedJsonlRange } = require('./codex-json-projection');
const { createJsonProjection: createResumeProjection } = require('./codex-resume-source');
const { readJsonlRange } = require('./ipc/codex-data')._api;
const MiB = 1024 * 1024;

test('located projection captures headers and deferred bytes in one validating pass', async t => {
  const large = 'x'.repeat(2 * MiB);
  const payload = { ignored: large, type: 'old', role: 'assistant' };
  const encoded = JSON.stringify({ type: 'response_item', payload }).replace('"type":"old"', '"type":"old","t\\u0079pe":"message"');
  const schema = { type: true, payload: { [DEFER]: { type: true, role: true } } };
  const result = project(encoded, schema, 32768);
  assert.equal(result.valid, true);
  assert.deepEqual(result.value.payload.value, { type: 'message', role: 'assistant' });
  assert.equal(result.value.payload[RANGE], true);
  assert.deepEqual(JSON.parse(encoded.slice(result.value.payload.from, result.value.payload.to)), { ...payload, type: 'message' });
  assert.ok(result.stats.maxBufferedBytes < 34000);
  for (const value of [large, 1e100, null, ['ignored']]) {
    const text = JSON.stringify({ payload: value });
    const next = project(text, schema, 32768);
    assert.equal(next.valid, true);
    assert.equal(next.value.payload[RANGE], true);
    assert.ok(next.stats.maxBufferedBytes < 34000, 'scalar payload is not retained');
  }
  const file = fixture(t, encoded + '\n');
  const loc = result.value.payload;
  const hydrated = await readProjectedValue(file, loc, { type: true, role: true });
  assert.deepEqual(hydrated, loc.value);
});

function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-json-projection-'));
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function project(text, schema, chunkBytes = 13, offset = 0) {
  const bytes = Buffer.from(text), parser = createJsonProjection(schema);
  for (let at = 0; at < bytes.length; at += chunkBytes) {
    parser.write(bytes.subarray(at, at + chunkBytes).toString('latin1'), offset + at);
  }
  return { ...parser.finish(offset + bytes.length), stats: parser.stats() };
}

test('chunk splits preserve UTF-8, escaped/duplicate/prototype keys and JSON scalar semantics', () => {
  const schema = { text: true, number: true, payload: { model: true }, list: { [ITEMS]: { text: true } } };
  Object.defineProperty(schema, '__proto__', { value: true, enumerable: true });
  schema.constructor = true;
  const corpus = [
    '{"text":"old","t\\u0065xt":"Русский 🙂 日\\n\\\"\\\\","number":-1.25e+17,"payload":{"model":"old","m\\u006fdel":"new","ignored":[1,null]},"list":[{"text":"a"},{"text":"b"}],"__proto__":42,"constructor":"own","ignored":{"text":"fake"}}',
    '{"payload":{"model":"stale"},"payload":null,"text":null,"number":1e999,"list":[]}',
    '{"text":"\\uD800\\uDC00\\uDFFF","number":-0,"list":[null,42,"string",false,{"text":"last"}]}',
  ];
  for (const text of corpus) {
    const expected = JSON.parse(text);
    delete expected.ignored;
    if (expected.payload) delete expected.payload.ignored;
    for (let split = 1; split <= 37; split++) {
      const result = project(text, schema, split);
      assert.equal(result.valid, true, 'split ' + split);
      assert.deepEqual(result.value, expected);
      assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
    }
  }
});

test('selected key names and searchable strings have no fixed size rejection/truncation', () => {
  const key = '🙂'.repeat(300) + 'k'.repeat(1300);
  const escapedKey = '"' + [...key].map(char => char === 'k' ? '\\u006b' : char).join('') + '"';
  const text = 'selected Русский 🙂 '.repeat(80000);
  const result = project('{' + escapedKey + ':' + JSON.stringify(text) + '}', { [key]: true }, 32768);
  assert.equal(result.valid, true);
  assert.equal(result.value[key], text);
});

test('PRESENCE preserves JSON type/nullness while ignored nested bodies stay absent', () => {
  const bodies = [null, true, false, -0, 1e30, 'image🙂', { nested: ['body'] }, ['body']];
  const expected = [null, 0, 0, 0, 0, '', {}, []];
  for (let index = 0; index < bodies.length; index++) {
    const result = project(JSON.stringify({ value: bodies[index] }), { value: PRESENCE }, 1);
    assert.equal(result.valid, true);
    assert.deepEqual(result.value, { value: expected[index] });
  }
});

test('projected ranges match readJsonlRange physical offsets, lines, whitespace and error accounting', async t => {
  const lines = [
    '{"text":"prefix🙂"}',
    '\ufeff\u3000 {"text":"Юникод 日", "ignored":[1,2]}\u00a0\v\f\r',
    '', '   ', '\ufeff\u2000',
    '{"text":"discard","ignored":{"trailing":true,}}',
    '{"text":"last"}',
  ];
  const tail = '{"text":"unfinished🙂"';
  const file = fixture(t, lines.join('\n') + '\n' + tail);
  const startByte = Buffer.byteLength(lines[0] + '\n');
  const endByte = fs.statSync(file).size - 1;
  const expectedLocators = [];
  const raw = await readJsonlRange(file, startByte, endByte, {
    lineCount: 51, onRecord: (_, loc) => expectedLocators.push(loc),
  });
  for (const highWaterMark of [1, 2, 3, 7, 32, 1024]) {
    const records = [], locators = [], metrics = {};
    const result = await readProjectedJsonlRange(file, startByte, endByte, {
      schema: { text: true }, startLine: 51, highWaterMark, metrics,
      onRecord: (record, loc) => { records.push(record); locators.push(loc); },
    });
    assert.deepEqual(records, raw.records.map(({ ignored, ...record }) => record));
    assert.deepEqual(locators, expectedLocators);
    assert.equal(result.parsed, raw.parsed);
    assert.equal(result.errors, raw.errors);
    assert.equal(result.lineCount, raw.lineCount);
    assert.equal(result.partialBytes, raw.leftoverBuffer.length);
    assert.equal(metrics.maxChunkBytes, Math.min(highWaterMark, endByte - startByte + 1));
    assert.ok(metrics.maxBufferedBytes >= metrics.maxChunkBytes);
    assert.deepEqual(result.partial, { filePath: file, fromByte: endByte + 1 - Buffer.byteLength(tail),
      toByte: endByte + 1, startLine: raw.lineCount });
  }
  const first = expectedLocators[0], records = [];
  const exact = await readProjectedJsonlRange(file, first.fromByte, first.toByte - 1, {
    schema: { text: true }, lineCount: first.startLine, onRecord: record => records.push(record),
  });
  assert.equal(exact.parsed, 1);
  assert.equal(exact.partialBytes, 0);
  assert.equal(records[0].text, 'Юникод 日');
  assert.equal(records[0].__line, 51);
  assert.deepEqual(await readProjectedJsonlRange(file, first.fromByte, first.fromByte - 1), {
    parsed: 0, errors: 0, lineCount: 0, partialBytes: 0,
    partial: { filePath: file, fromByte: first.fromByte, toByte: first.fromByte, startLine: 0 },
  });
});

test('DEFER exposes exact selected value bytes, handles duplicate keys, and hydrates with a second projection', async t => {
  const body = { items: [{ text: 'Русский 🙂 ' + 'z'.repeat(2 * MiB), output: 'ignored' }], ignored: 'big' };
  const prefix = '{"text":"prefix🙂"}\n';
  const line = '{"selected":"old","s\\u0065lected": \t' + JSON.stringify(body) + ',"after":42}\n';
  const file = fixture(t, prefix + line);
  let record, loc;
  await readProjectedJsonlRange(file, Buffer.byteLength(prefix), fs.statSync(file).size - 1, {
    schema: { selected: DEFER, after: true }, startLine: 8, highWaterMark: 7,
    onRecord: (value, locator) => { record = value; loc = locator; },
  });
  const selected = record.selected;
  assert.equal(selected[RANGE], true);
  assert.equal(selected.from, Buffer.byteLength(prefix + line.slice(0, line.indexOf('{"items"'))));
  assert.equal(selected.to - selected.from, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(record.after, 42);
  assert.deepEqual(loc, { filePath: file, fromByte: Buffer.byteLength(prefix),
    toByte: fs.statSync(file).size, startLine: 8 });
  const hydrated = await readProjectedValue(file, selected, { items: { [ITEMS]: { text: true } } }, { highWaterMark: 32768 });
  assert.deepEqual(hydrated, { items: [{ text: body.items[0].text }] });
  for (const value of ['"Русский🙂"', '123.5e-2', 'null', '[1,"日"]']) {
    const direct = fixture(t, value);
    const range = project(value, DEFER, 1).value;
    assert.equal(range.from, 0);
    assert.equal(range.to, Buffer.byteLength(value));
    const schema = value[0] === '[' ? { [ITEMS]: true } : true;
    assert.deepEqual(await readProjectedValue(direct, range, schema), JSON.parse(value));
  }
});

test('2–16 MiB ignored output, strings, keys and numbers keep encoded buffering and JSON.parse arguments bounded', async t => {
  for (const size of [2 * MiB, 16 * MiB]) {
    const text = 'x'.repeat(size), number = '9'.repeat(size);
    const file = fixture(t, '{"text":"kept","ignored":{"output":"' + text
      + '","' + text + '":"' + text + '","number":' + number + '},"last":true}\n');
    const metrics = {};
    let maxParseBytes = 0, parseCalls = 0, record;
    const nativeParse = JSON.parse;
    JSON.parse = function (input, ...args) {
      maxParseBytes = Math.max(maxParseBytes, Buffer.byteLength(input)); parseCalls++;
      return nativeParse(input, ...args);
    };
    try {
      await readProjectedJsonlRange(file, 0, fs.statSync(file).size - 1, {
        schema: { text: true, last: true }, highWaterMark: 32768, metrics,
        onRecord: value => { record = value; },
      });
    } finally { JSON.parse = nativeParse; }
    assert.deepEqual(record, { text: 'kept', last: true, __line: 0, __byteOffset: 0 });
    assert.ok(metrics.maxBufferedBytes <= 32768 + 1024, JSON.stringify(metrics));
    assert.ok(metrics.maxTokenBytes <= 1024);
    assert.ok(metrics.maxChunkBytes <= 32768);
    assert.ok(metrics.maxRecordBytes > size * 4);
    assert.equal(metrics.bytes, fs.statSync(file).size);
    assert.ok(parseCalls > 0);
    assert.ok(maxParseBytes <= 1024, 'largest JSON.parse input = ' + maxParseBytes);
    t.diagnostic(JSON.stringify({ ignoredMiB: size / MiB, ...metrics, maxParseBytes }));
  }
});

test('malformed ignored subtrees reject the entire record, including suffixes after giant tokens', async t => {
  const badValues = ['01', '-01', '+1', '.1', '1.', '1e', '1e+', '1e-+', 'tru', 'falsex', 'nul',
    '[1,]', '{"x":true,}', '{"x" 1}', '[1 2]', '"bad\\q"', '"bad\\uQQQQ"', '"bad\tcontrol"',
    '"unclosed', 'true true', '\u00a042', '"' + 'z'.repeat(2 * MiB) + '\\q"', '9'.repeat(2 * MiB) + 'x'];
  const lines = badValues.map(value => '{"text":"must not escape","ignored":' + value + '}');
  lines.push('{"text":"must not escape","' + 'k'.repeat(2 * MiB) + '\\q":null}');
  const file = fixture(t, lines.join('\n') + '\n{"text":"good"}\n');
  const raw = await readJsonlRange(file, 0, fs.statSync(file).size - 1);
  for (const highWaterMark of [32768, 65536]) {
    const records = [];
    const result = await readProjectedJsonlRange(file, 0, fs.statSync(file).size - 1, {
      schema: { text: true }, highWaterMark, onRecord: record => records.push(record),
    });
    assert.equal(result.errors, lines.length);
    assert.equal(result.errors, raw.errors);
    assert.equal(result.parsed, 1);
    assert.deepEqual(records, raw.records);
  }
  for (const value of badValues.slice(0, -2)) for (let split = 1; split <= 8; split++) {
    assert.equal(project('{"text":"bad","ignored":' + value + '}', { text: true }, split).valid, false);
  }
  const badFile = fixture(t, '{"text":"bad","ignored":[1,]}');
  await assert.rejects(readProjectedValue(badFile, { from: 0, to: fs.statSync(badFile).size }, { text: true }),
    /codex-resume-source-changed/);
});

test('partial tails stay uncommitted, can be rescanned by locator, and do not retain giant text', async t => {
  const committed = '{"text":"first"}\n', next = Buffer.from('{"text":"next🙂"}\n');
  const cut = next.indexOf(Buffer.from('🙂')) + 2;
  const file = fixture(t, Buffer.concat([Buffer.from(committed), next.subarray(0, cut)]));
  const seen = [];
  const before = await readProjectedJsonlRange(file, 0, fs.statSync(file).size - 1, {
    schema: { text: true }, highWaterMark: 3, onRecord: value => seen.push(value.text),
  });
  assert.deepEqual(seen, ['first']);
  assert.equal(before.errors, 0);
  assert.equal(before.partialBytes, cut);
  fs.appendFileSync(file, next.subarray(cut));
  const after = await readProjectedJsonlRange(file, before.partial.fromByte, fs.statSync(file).size - 1, {
    schema: { text: true }, startLine: before.partial.startLine, highWaterMark: 3,
    onRecord: value => seen.push(value.text),
  });
  assert.deepEqual(seen, ['first', 'next🙂']);
  assert.equal(after.lineCount, 2);
  assert.equal(after.partialBytes, 0);
  const giant = fixture(t, committed + '{"ignored":"' + 'x'.repeat(16 * MiB));
  const metrics = {};
  const partial = await readProjectedJsonlRange(giant, 0, fs.statSync(giant).size - 1, {
    schema: { text: true }, metrics, highWaterMark: 32768,
  });
  assert.equal(partial.parsed, 1);
  assert.equal(partial.errors, 0);
  assert.equal(partial.partialBytes, fs.statSync(giant).size - Buffer.byteLength(committed));
  assert.ok(metrics.maxBufferedBytes <= 32768 + 1024);
  assert.equal(Object.hasOwn(partial, 'leftoverBuffer'), false);
  // Even a complete JSON value without a physical newline is an uncommitted tail.
  const noNewline = fixture(t, '{"text":"complete"}');
  assert.equal((await readProjectedJsonlRange(noNewline, 0, fs.statSync(noNewline).size - 1,
    { schema: { text: true } })).parsed, 0);
});

test('awaited visitors serialize consumption/progress and propagate consumer failures', async t => {
  const file = fixture(t, '{"text":"one"}\n{"text":"two"}\n');
  let entered, release;
  const atConsumer = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  t.after(release);
  const seen = [], progress = [];
  const pending = readProjectedJsonlRange(file, 0, fs.statSync(file).size - 1, {
    schema: { text: true }, highWaterMark: 1024,
    onProgress: bytes => progress.push(bytes),
    onRecord: async record => { seen.push(record.text); if (seen.length === 1) { entered(); await wait; } },
  });
  await atConsumer;
  assert.deepEqual(seen, ['one']);
  assert.deepEqual(progress, []);
  release();
  const result = await pending;
  assert.deepEqual(seen, ['one', 'two']);
  assert.deepEqual(progress, [fs.statSync(file).size]);
  assert.equal(result.parsed, 2);
  await assert.rejects(readProjectedJsonlRange(file, 0, fs.statSync(file).size - 1, {
    schema: { text: true }, onRecord: async () => { throw Error('consumer failed'); },
  }), /consumer failed/);
});

test('Resume wrapper keeps the default schema and explicit schema compatibility', () => {
  const text = '{"type":"event_msg","payload":{"type":"user_message","message":"deferred","output":"ignored"}}';
  const parser = createResumeProjection();
  parser.write(text, 100);
  const result = parser.finish(100 + Buffer.byteLength(text));
  assert.equal(result.valid, true);
  assert.equal(result.value.type, 'event_msg');
  assert.equal(result.value.payload.type, 'user_message');
  assert.equal(result.value.payload.message[RANGE], true);
  assert.equal(Object.hasOwn(result.value.payload, 'output'), false);
  const explicit = createResumeProjection({ payload: { output: true } });
  explicit.write(text, 0);
  assert.deepEqual(explicit.finish(text.length).value, { payload: { output: 'ignored' } });
});
