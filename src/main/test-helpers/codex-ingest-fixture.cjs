'use strict';

// A finite source/oracle builder. It writes and hashes one small pattern at
// a time; neither the fixture nor the oracle owns the large field/record.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { HistoryProjectionArena, projectionArenaOf } = require('../history-projection-arena');
const text = require('../history-paged-text');
const { intervalAudit } = require('./codex-root-fixture.cjs');
const MARKER = 'ONLY_V7_STREAMED_FIELD_MARKER';
const PATTERN = 'aРусский😀\\"\ud800\nZ';

function* pieces(chars, pattern = PATTERN) {
  while (chars >= pattern.length) { yield pattern; chars -= pattern.length; }
  if (chars) yield pattern.slice(0, chars);
}
function quotedPiece(value, layers = 1) {
  for (let i = 0; i < layers; i++) value = JSON.stringify(value).slice(1, -1);
  return value;
}
function* substituted(source, chars, { pattern = PATTERN, layers = 1, marker = MARKER } = {}) {
  let from = 0, at;
  while ((at = source.indexOf(marker, from)) >= 0) {
    yield source.slice(from, at);
    for (const piece of pieces(chars, pattern)) yield quotedPiece(piece, layers);
    from = at + marker.length;
  }
  yield source.slice(from);
}
function writer(filePath, firstLine = 0) {
  let offset = fs.statSync(filePath).size, line = firstLine;
  return {
    record(record, chars = 0, options = {}) {
      const located = { ...record, __line: line++, __byteOffset: offset };
      for (const part of substituted(JSON.stringify(record), chars, options)) {
        fs.appendFileSync(filePath, part); offset += Buffer.byteLength(part);
      }
      fs.appendFileSync(filePath, '\n'); offset++;
      return located;
    },
    get offset() { return offset; }, get line() { return line; },
  };
}
function expected(rows, chars, options = {}) {
  const digest = crypto.createHash('sha256'), ids = crypto.createHash('sha256');
  let bytes = 0, count = 0;
  const add = part => { digest.update(part); bytes += Buffer.byteLength(part); };
  add('[');
  for (const row of rows) {
    if (count) add(',');
    ids.update(String(count++) + ':' + row.uuid + '\n');
    for (const part of substituted(JSON.stringify(row), chars, options)) add(part);
  }
  add(']');
  return { hash: digest.digest('hex'), ids: ids.digest('hex'), bytes, rows: count };
}
function fingerprint(chars, pattern = PATTERN, algorithm = 'sha1') {
  const hash = crypto.createHash(algorithm);
  for (const part of pieces(chars, pattern)) hash.update(part);
  return hash.digest('hex');
}
function fieldDigest(cursor) {
  let chars = 0; const hash = crypto.createHash('sha256');
  for (const part of cursor.textChunks()) { hash.update(Buffer.from(part, 'utf16le')); chars += part.length; }
  return { chars, hash: hash.digest('hex') };
}
function expectedField(chars, pattern = PATTERN) {
  const hash = crypto.createHash('sha256');
  for (const part of pieces(chars, pattern)) hash.update(Buffer.from(part, 'utf16le'));
  return { chars, hash: hash.digest('hex') };
}

// Observe allocations at real conversion/import boundaries throughout the
// interval. This is stronger than transport counters, but still NOT a native
// allocator/RSS peak proof. No growing baseline/owner is subtracted.
async function observeInterval(indexBytes, operation) {
  const context = new AsyncLocalStorage(), tag = {}, excluded = { maxBufferFromChars: 0 };
  const active = () => context.getStore() === tag;
  const audit = intervalAudit(indexBytes), max = { jsonParseChars: 0, jsonStringifyChars: 0, numberInputChars: 0,
    bufferFromChars: 0, bufferToStringChars: 0, nativeImportArray: 0, nativeImportFields: 0,
    unboundedTextMaterializations: 0, maxUnboundedTextChars: 0, maxOwnKeyArray: 0,
    maxDecodedTextChars: 0, maxInputChunkBytes: 0, maxTokenBytes: 0,
    maxParserFrames: 0, residentParserFrames: 0, maxNumericScratchChars: 0 };
  const parse = JSON.parse, stringify = JSON.stringify, from = Buffer.from, number = Number,
    toString = Buffer.prototype.toString, encode = HistoryProjectionArena.prototype.encode;
  global.Number = new Proxy(number, { apply(target, self, args) {
    if (active() && typeof args[0] === 'string') max.numberInputChars = Math.max(max.numberInputChars, args[0].length);
    return Reflect.apply(target, self, args);
  } });
  JSON.parse = function(value, ...rest) {
    if (active() && typeof value === 'string') max.jsonParseChars = Math.max(max.jsonParseChars, value.length);
    return parse.call(this, value, ...rest);
  };
  JSON.stringify = function(...args) {
    const value = stringify.apply(this, args);
    if (active()) max.jsonStringifyChars = Math.max(max.jsonStringifyChars, value?.length || 0);
    return value;
  };
  Buffer.from = function(value, ...rest) {
    if (typeof value === 'string') {
      if (active()) max.bufferFromChars = Math.max(max.bufferFromChars, value.length);
      else if (value.length > excluded.maxBufferFromChars) {
        excluded.maxBufferFromChars = value.length;
        excluded.stack = new Error('outside the source read/encode async context').stack;
      }
    }
    return from.call(this, value, ...rest);
  };
  Buffer.prototype.toString = function(...args) {
    const value = toString.apply(this, args);
    if (active()) max.bufferToStringChars = Math.max(max.bufferToStringChars, value.length); return value;
  };
  HistoryProjectionArena.prototype.encode = function(value) {
    if (active() && value && typeof value === 'object' && !projectionArenaOf(value) && !text.isPagedText(value)) {
      if (Array.isArray(value)) max.nativeImportArray = Math.max(max.nativeImportArray, value.length);
      let count = 0; for (const key in value) if (Object.hasOwn(value, key)) count++;
      max.nativeImportFields = Math.max(max.nativeImportFields, count);
    }
    return encode.call(this, value);
  };
  const ingestPhases = {};
  const hooks = {
    observeRoot(stats) {
      audit.observe(stats);
      for (const key of Object.keys(max)) max[key] = Math.max(max[key], stats[key] || 0);
    },
    observeIngest(stats) {
      ingestPhases[stats.phase] = (ingestPhases[stats.phase] || 0) + 1;
      for (const key of Object.keys(max)) max[key] = Math.max(max[key], stats[key] || 0);
    },
  };
  try { return { value: await context.run(tag, () => operation(hooks)), max, audit, ingestPhases,
    outOfOperationAsyncContext: excluded }; }
  finally {
    JSON.parse = parse; JSON.stringify = stringify; Buffer.from = from; global.Number = number;
    Buffer.prototype.toString = toString; HistoryProjectionArena.prototype.encode = encode;
    context.disable();
  }
}
function assertBounded(interval) {
  const { max } = interval;
  assert.equal(max.unboundedTextMaterializations, 0, JSON.stringify(max));
  assert.equal(max.maxUnboundedTextChars, 0);
  assert.ok(max.jsonParseChars <= 1024, JSON.stringify(max));
  assert.ok(max.jsonStringifyChars <= 1024, JSON.stringify(max));
  assert.ok(max.numberInputChars <= 832, JSON.stringify(max));
  // Raw pages have a fixed 1368-character base64 representation; no line or
  // selected large field enters Buffer.from/toString/arena import whole.
  assert.ok(max.bufferFromChars <= 2048, JSON.stringify(max));
  assert.ok(max.bufferToStringChars <= 2048, JSON.stringify(max));
  assert.ok(max.maxDecodedTextChars <= 512);
  assert.ok(max.maxInputChunkBytes <= 64);
  assert.ok(max.maxTokenBytes <= 64);
  assert.ok(max.residentParserFrames <= 1);
  assert.ok(max.nativeImportArray <= 16, JSON.stringify(max));
  assert.ok(max.nativeImportFields <= 40, JSON.stringify(max));
}

module.exports = { MARKER, PATTERN, pieces, quotedPiece, substituted, writer, expected,
  fingerprint, fieldDigest, expectedField, observeInterval, assertBounded };
