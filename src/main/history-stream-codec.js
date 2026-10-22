'use strict';

// An incremental JSON encoder for reader-owned values, including immutable
// row cursors and large-leaf references. It never serializes a whole graph or
// joins a leaf. This bounds codec ownership, not a legacy producer's graph.
const { currentReadControl } = require('./history-read-control');
const DEFAULT_FRAME_BYTES = 16 * 1024;
const highSurrogate = n => n >= 0xd800 && n <= 0xdbff;
const lowSurrogate = n => n >= 0xdc00 && n <= 0xdfff;
const tick = () => new Promise(resolve => setImmediate(resolve));

function streamLimits({ frameBytes = DEFAULT_FRAME_BYTES, credits = 2 } = {}) {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 64 || frameBytes > 1024 * 1024
    || !Number.isSafeInteger(credits) || credits < 1 || credits > 8) {
    throw new TypeError('history_stream_limits_invalid');
  }
  return Object.freeze({ frameBytes, credits, windowBytes: frameBytes * credits });
}

async function* stringPieces(value, scalarChars, stats) {
  // Split the already-owned ordinary string without allocating a copy of it.
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + scalarChars);
    if (end < value.length && highSurrogate(value.charCodeAt(end - 1))
      && lowSurrogate(value.charCodeAt(end))) end--;
    if (end === start) end = start + 2;
    const piece = value.slice(start, end);
    stats.maxScalarChars = Math.max(stats.maxScalarChars, piece.length);
    yield piece;
    start = end;
  }
}

async function* quotePieces(pieces, scalarChars, stats, control) {
  yield '"';
  let pendingHigh = '';
  for await (const value of pieces) {
    control?.assertCurrent();
    if (typeof value !== 'string') throw new TypeError('history_leaf_chunk_not_string');
    // One UTF-16 code unit is the only carry between disk leaf chunks. A real
    // pair split by the reader must not be escaped as two lone surrogates.
    let start = 0;
    if (pendingHigh) {
      if (!value.length) continue;
      if (lowSurrogate(value.charCodeAt(0))) { yield JSON.stringify(pendingHigh + value[0]).slice(1, -1); start = 1; }
      else yield JSON.stringify(pendingHigh).slice(1, -1);
      pendingHigh = '';
    }
    let end = value.length;
    if (end > start && highSurrogate(value.charCodeAt(end - 1))) { pendingHigh = value[end - 1]; end--; }
    // readChunks itself must respect chunkBytes; even a legacy caller that
    // yields a large ordinary string cannot create a large codec allocation.
    for await (const piece of stringPieces(value.slice(start, end), scalarChars, stats)) {
      control?.assertCurrent();
      yield JSON.stringify(piece).slice(1, -1);
    }
  }
  if (pendingHigh) yield JSON.stringify(pendingHigh).slice(1, -1);
  yield '"';
}

async function* encodeHistoryStream(root, { format = 'json', frameBytes = DEFAULT_FRAME_BYTES,
  control = currentReadControl(), leafResolver = null, stats = {} } = {}) {
  streamLimits({ frameBytes });
  if (format !== 'json' && format !== 'ndjson') throw new TypeError('history_stream_format_invalid');
  Object.assign(stats, { frames: 0, utf8Bytes: 0, maxFrameBytes: 0, maxScalarChars: 0,
    maxCodecOwnedBytes: 0, maxDepth: 0, leafChunks: 0 });
  const scalarChars = Math.max(2, Math.floor(frameBytes / 6));
  const ancestors = new Set();
  const prepare = (value, key) => {
    if (leafResolver?.isReference?.(value)) return value;
    if (value !== null && (typeof value === 'object' || typeof value === 'bigint')
      && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
    return value;
  };
  async function* visit(value, depth) {
    control?.assertCurrent();
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (leafResolver?.isReference?.(value)) {
      const chunks = leafResolver.readChunks(value, { chunkBytes: frameBytes, control });
      async function* observed() { for await (const chunk of chunks) { stats.leafChunks++; yield chunk; } }
      yield* quotePieces(observed(), scalarChars, stats, control); return;
    }
    // A descriptor accidentally routed without its resolver must never become
    // apparent full History content on the wire.
    if (value && (value.$historyLeaf === 'v1' || value.$historySourceLeaf === 'json-string-v1')) {
      throw new TypeError('history_leaf_resolver_missing');
    }
    if (value === null) { yield 'null'; return; }
    switch (typeof value) {
      case 'string': yield* quotePieces(stringPieces(value, scalarChars, stats), scalarChars, stats, control); return;
      case 'number': yield Number.isFinite(value) ? String(value === 0 ? 0 : value) : 'null'; return;
      case 'boolean': yield value ? 'true' : 'false'; return;
      case 'bigint': throw new TypeError('Do not know how to serialize a BigInt');
      case 'object': break;
      default: throw new TypeError('History response is not a JSON value');
    }
    if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(value);
    try {
      if (Array.isArray(value) || typeof value[Symbol.asyncIterator] === 'function') {
        yield '[';
        let index = 0;
        for await (const raw of value) {
          if (index) yield ',';
          const item = prepare(raw, String(index++));
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') yield 'null';
          else yield* visit(item, depth + 1);
        }
        yield ']';
      } else {
        yield '{'; let first = true;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const item = prepare(value[key], key);
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          if (!first) yield ','; first = false;
          yield* quotePieces(stringPieces(key, scalarChars, stats), scalarChars, stats, control);
          yield ':'; yield* visit(item, depth + 1);
        }
        yield '}';
      }
    } finally { ancestors.delete(value); }
  }
  async function* tokens() {
    if (format === 'json') { yield* visit(prepare(root, ''), 0); return; }
    for await (const row of root) { yield* visit(prepare(row, ''), 0); yield '\n'; }
  }
  let buffer = Buffer.allocUnsafe(frameBytes), used = 0;
  for await (const token of tokens()) {
    control?.assertCurrent();
    const bytes = Buffer.from(token, 'utf8');
    stats.maxCodecOwnedBytes = Math.max(stats.maxCodecOwnedBytes, buffer.byteLength + bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(frameBytes - used, bytes.byteLength - offset);
      bytes.copy(buffer, used, offset, offset + count); used += count; offset += count;
      if (used === frameBytes) {
        stats.frames++; stats.utf8Bytes += used; stats.maxFrameBytes = Math.max(stats.maxFrameBytes, used);
        yield buffer;
        if (control) await control.checkpoint(); else await tick();
        buffer = Buffer.allocUnsafe(frameBytes); used = 0;
      }
    }
  }
  control?.assertCurrent();
  if (used) {
    stats.frames++; stats.utf8Bytes += used; stats.maxFrameBytes = Math.max(stats.maxFrameBytes, used);
    yield buffer.subarray(0, used);
  }
}

module.exports = { encodeHistoryStream, streamLimits, DEFAULT_FRAME_BYTES };
