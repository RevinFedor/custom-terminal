'use strict';

// Exact JSON wire encoding for an already-owned History DTO. This bounds the
// ADDITIONAL encoding/transport buffers, not the input graph, a toJSON result,
// the receiver's JSON.parse, or OS/kernel/zlib memory. No body truncation.
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const { currentReadControl } = require('./history-read-control');

const DEFAULT_CHUNK_BYTES = 16 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));

function* quoted(value, scalarChars, stats) {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + scalarChars);
    // JSON.stringify escapes lone surrogates. Preserve a real pair across
    // our own boundary so it stays the same JSON string, not two lone escapes.
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800
      && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00
      && value.charCodeAt(end) <= 0xdfff) {
      if (end - start === 1) end++;
      else end--;
    }
    const piece = value.slice(start, end);
    stats.maxScalarChars = Math.max(stats.maxScalarChars, piece.length);
    yield JSON.stringify(piece).slice(1, -1);
    start = end;
  }
  yield '"';
}

function* jsonTokens(root, scalarChars, stats) {
  const ancestors = new Set();
  function prepare(value, key) {
    if (value !== null && (typeof value === 'object' || typeof value === 'bigint')
      && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
    return value;
  }
  function* visit(value, depth) {
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (value === null) { yield 'null'; return; }
    switch (typeof value) {
      case 'string': yield* quoted(value, scalarChars, stats); return;
      case 'number': yield Number.isFinite(value) ? String(value === 0 ? 0 : value) : 'null'; return;
      case 'boolean': yield value ? 'true' : 'false'; return;
      case 'bigint': throw new TypeError('Do not know how to serialize a BigInt');
      case 'object': break;
      default: throw new TypeError('History response is not a JSON value');
    }
    if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        yield '[';
        const length = value.length;
        for (let i = 0; i < length; i++) {
          if (i) yield ',';
          const item = prepare(value[i], String(i));
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') yield 'null';
          else yield* visit(item, depth + 1);
        }
        yield ']';
      } else {
        yield '{';
        let first = true;
        // Wire History is an exclusively owned plain-data snapshot, not a
        // mutable live store. for-in avoids an additional Object.keys array.
        // Inherited properties are never serialized.
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const item = prepare(value[key], key);
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          if (!first) yield ',';
          first = false;
          yield* quoted(key, scalarChars, stats);
          yield ':';
          yield* visit(item, depth + 1);
        }
        yield '}';
      }
    } finally { ancestors.delete(value); }
  }
  yield* visit(prepare(root, ''), 0);
}

function statistics(target = {}) {
  Object.assign(target, { chunks: 0, utf8Bytes: 0, maxChunkBytes: 0,
    maxScalarChars: 0, maxDepth: 0, maxCodecOwnedBytes: 0 });
  return target;
}

async function* encodeHistoryJson(values, { ndjson = false, control = currentReadControl(),
  chunkBytes = DEFAULT_CHUNK_BYTES, stats: target } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 32 || chunkBytes > 1024 * 1024) {
    throw new TypeError('history_codec_chunk_size_invalid');
  }
  const stats = statistics(target);
  const scalarChars = Math.max(2, Math.floor(chunkBytes / 6));
  let buffer = Buffer.allocUnsafe(chunkBytes), used = 0;
  function* tokens() {
    if (!ndjson) { yield* jsonTokens(values, scalarChars, stats); return; }
    for (const value of values) { yield* jsonTokens(value, scalarChars, stats); yield '\n'; }
  }
  for (const token of tokens()) {
    control?.assertCurrent();
    const bytes = Buffer.from(token, 'utf8');
    stats.maxCodecOwnedBytes = Math.max(stats.maxCodecOwnedBytes, buffer.length + bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(chunkBytes - used, bytes.length - offset);
      bytes.copy(buffer, used, offset, offset + count); used += count; offset += count;
      if (used === chunkBytes) {
        stats.chunks++; stats.utf8Bytes += used;
        stats.maxChunkBytes = Math.max(stats.maxChunkBytes, used);
        yield buffer;
        // Readable/pipeline own only their configured bounded queues; yield
        // does not mean that this particular chunk has reached the client.
        // It is also a cooperative cancellation boundary for long text.
        if (control) await control.checkpoint(); else await tick();
        buffer = Buffer.allocUnsafe(chunkBytes); used = 0;
      }
    }
  }
  control?.assertCurrent();
  if (used) {
    stats.chunks++; stats.utf8Bytes += used;
    stats.maxChunkBytes = Math.max(stats.maxChunkBytes, used);
    yield buffer.subarray(0, used);
  }
}

async function sendHistoryWire(res, status, values, options = {}) {
  const { ndjson = false, control = currentReadControl(), onPhase = () => {},
    chunkBytes = DEFAULT_CHUNK_BYTES, stats } = options;
  control?.assertCurrent();
  if (res.writableEnded || res.destroyed) return;
  const accept = String(res.req?.headers?.['accept-encoding'] || '');
  const br = ndjson && /\bbr\b/.test(accept), gzip = !br && /\bgzip\b/.test(accept);
  const source = Readable.from(encodeHistoryJson(values, { ndjson, control, chunkBytes, stats }),
    { objectMode: false, highWaterMark: chunkBytes });
  const compressor = br ? zlib.createBrotliCompress({ chunkSize: Math.max(64, chunkBytes),
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } })
    : gzip ? zlib.createGzip({ level: 4, chunkSize: Math.max(64, chunkBytes) }) : null;
  const headers = {
    'Content-Type': ndjson ? 'application/x-ndjson; charset=utf-8' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': ndjson ? 'Authorization, Content-Type, Accept' : 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': ndjson ? 'GET, POST, OPTIONS' : 'GET, POST, PATCH, DELETE, OPTIONS',
    'Vary': ndjson ? 'Accept-Encoding, Accept' : 'Accept-Encoding',
    ...(br ? { 'Content-Encoding': 'br' } : gzip ? { 'Content-Encoding': 'gzip' } : {}),
    ...(ndjson ? { 'Cache-Control': 'no-cache' } : {}),
  };
  // No Content-Length: exact JSON is sent with ordinary streaming HTTP framing.
  // This avoids a full stringify + gzipSync + whole-wire allocation in Main.
  const streams = compressor ? [source, compressor, res] : [source, res];
  try {
    control?.assertCurrent();
    onPhase('stream-encode-begin');
    res.writeHead(status, headers);
    await pipeline(...streams, ...(control?.signal ? [{ signal: control.signal }] : []));
    control?.assertCurrent();
    onPhase('stream-encode-end', stats || {});
  } catch (error) {
    source.destroy();
    compressor?.destroy();
    control?.assertCurrent(); // Convert transport AbortError to typed consumer revocation.
    throw error;
  }
}

const sendHistoryJson = (res, status, body, options) => sendHistoryWire(res, status, body, options);
const sendHistoryNdjson = (res, values, options) => sendHistoryWire(res, 200, values, { ...options, ndjson: true });
module.exports = { encodeHistoryJson, sendHistoryJson, sendHistoryNdjson, DEFAULT_CHUNK_BYTES };
