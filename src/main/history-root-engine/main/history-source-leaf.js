'use strict';

// An internal, source-bound JSON string locator. It is not a replacement for
// public History text and is never permission to read an arbitrary path. The
// caller keeps its existing source/rewrite ticket and binds the physical file.
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');

const SOURCE_LEAF_VERSION = 'json-string-v1';
const isSourceLeaf = value => !!value && value.$historySourceLeaf === SOURCE_LEAF_VERSION;
const invalidated = reason => Object.assign(new Error(reason || 'History source leaf changed'), {
  code: 'CODEX_SOURCE_READ_INVALIDATED',
});

// crypto.update(chunk, 'utf8') replaces an isolated surrogate. Carry just the
// final high surrogate so a producer splitting a valid pair does not change
// the legacy SHA-256 of the complete decoded JS string.
function createLeafTextHash() {
  const hash = createHash('sha256');
  let high = '', done = false;
  return {
    update(text) {
      if (done) throw Error('history_leaf_hash_finished');
      text = high + text; high = '';
      if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1))) {
        high = text.at(-1); text = text.slice(0, -1);
      }
      if (text) hash.update(text, 'utf8');
    },
    digest() {
      if (done) throw Error('history_leaf_hash_finished');
      done = true; if (high) hash.update(high, 'utf8');
      return hash.digest('hex');
    },
  };
}

// Receives the encoded JSON token, including its two quotes, in byte chunks.
// No join of the encoded token or complete decoded value is performed. The
// decoder preserves JSON.parse(Buffer.toString('utf8')) UTF-16 semantics,
// including escapes, raw non-ASCII, replacement characters and lone surrogates.
function createJsonStringDecoder({ chunkChars = 32, onChunk = () => {} } = {}) {
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 1) throw Error('history_leaf_chunk_invalid');
  const utf8 = new StringDecoder('utf8'), hash = createLeafTextHash();
  let started = false, closed = false, escaped = false, unicode = '', remaining = 0;
  let output = '', totalChars = 0, maxBufferedChars = 0, finished = false;
  const flush = () => {
    if (!output) return;
    const chunk = output; output = '';
    totalChars += chunk.length; hash.update(chunk); onChunk(chunk);
  };
  const put = char => {
    output += char;
    maxBufferedChars = Math.max(maxBufferedChars, output.length);
    if (output.length === chunkChars) flush();
  };
  const consume = text => {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (!started) {
        if (char !== '"') throw invalidated('history_leaf_not_string');
        started = true; continue;
      }
      if (closed) throw invalidated('history_leaf_trailing_bytes');
      if (remaining) {
        if (!/[0-9a-fA-F]/.test(char)) throw invalidated('history_leaf_unicode');
        unicode += char;
        if (--remaining === 0) { put(String.fromCharCode(parseInt(unicode, 16))); unicode = ''; }
      } else if (escaped) {
        escaped = false;
        if (char === 'u') remaining = 4;
        else {
          const replacements = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!Object.hasOwn(replacements, char)) throw invalidated('history_leaf_escape');
          put(replacements[char]);
        }
      } else if (char === '\\') escaped = true;
      else if (char === '"') closed = true;
      else if (char.charCodeAt(0) < 32) throw invalidated('history_leaf_control');
      else put(char);
    }
  };
  return {
    write(bytes) {
      if (finished) throw Error('history_leaf_decoder_finished');
      const input = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes;
      // Bound the UTF-8 intermediate string too, even if a caller passes a
      // larger filesystem chunk. At most three pending UTF-8 bytes survive.
      for (let start = 0; start < input.length; start += chunkChars) {
        consume(utf8.write(input.subarray(start, start + chunkChars)));
      }
    },
    finish() {
      if (finished) throw Error('history_leaf_decoder_finished');
      finished = true; consume(utf8.end());
      if (!started || !closed || escaped || remaining) throw invalidated('history_leaf_incomplete');
      flush();
      return { totalChars, contentHash: hash.digest(), maxBufferedChars };
    },
    stats: () => ({ totalChars: totalChars + output.length, maxBufferedChars }),
  };
}

function validateSourceLeaf(ref) {
  if (!isSourceLeaf(ref) || !Number.isSafeInteger(ref.from) || ref.from < 0
    || !Number.isSafeInteger(ref.to) || ref.to - ref.from < 2
    || !Number.isSafeInteger(ref.totalChars) || ref.totalChars < 0
    || !/^[a-f0-9]{64}$/.test(ref.contentHash || '')) throw Error('history_source_leaf_invalid');
  return ref;
}
const physical = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  fileIdentity: stat.dev + ':' + stat.ino });
const samePhysical = (left, right) => left.size === right.size && left.mtimeMs === right.mtimeMs
  && left.ctimeMs === right.ctimeMs && left.fileIdentity === right.fileIdentity;

async function* streamSourceLeaf({ filePath, ref, expectedSource = null, control = null,
  assertCurrent = null, validateSource = null, chunkBytes = 64 * 1024, metrics = null } = {}) {
  validateSourceLeaf(ref);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 8) throw Error('history_leaf_chunk_invalid');
  const check = () => { control?.assertCurrent(); assertCurrent?.(); };
  const verify = async () => {
    check();
    if (validateSource && await validateSource() === false) throw invalidated();
    check();
  };
  check();
  let handle, source, primaryError = null, readBytes = 0, queue = [];
  if (metrics) Object.assign(metrics, { sourceBytes: 0, maxReadChunkBytes: 0, maxDecodedChunkBytes: 0, verified: false });
  const decoder = createJsonStringDecoder({ chunkChars: Math.max(1, Math.floor(chunkBytes / 2)),
    onChunk(text) { queue.push(text); } });
  try {
    await verify();
    handle = await fs.promises.open(filePath, 'r'); check();
    source = physical(await handle.stat()); check();
    if (ref.to > source.size || expectedSource && !samePhysical(source, expectedSource)) throw invalidated();
    const stream = fs.createReadStream(filePath, { fd: handle.fd, autoClose: false,
      start: ref.from, end: ref.to - 1, highWaterMark: chunkBytes });
    for await (const bytes of stream) {
      check(); readBytes += bytes.length;
      decoder.write(bytes);
      if (metrics) { metrics.sourceBytes += bytes.length; metrics.maxReadChunkBytes = Math.max(metrics.maxReadChunkBytes, bytes.length); }
      for (const text of queue) {
        check(); if (metrics) metrics.maxDecodedChunkBytes = Math.max(metrics.maxDecodedChunkBytes, text.length * 2);
        yield text; check();
      }
      queue = [];
      if (control?.checkpoint) await control.checkpoint();
      else await new Promise(resolve => setImmediate(resolve));
      check();
    }
    const result = decoder.finish();
    if (readBytes !== ref.to - ref.from || result.totalChars !== ref.totalChars
      || result.contentHash !== ref.contentHash) throw invalidated('history_source_leaf_hash_changed');
    for (const text of queue) { check(); yield text; check(); }
    queue = [];
    const end = physical(await handle.stat()); check();
    const atPath = physical(await fs.promises.stat(filePath)); check();
    if (!samePhysical(source, end) || !samePhysical(source, atPath)) throw invalidated();
    await verify();
    if (metrics) metrics.verified = true;
  } catch (error) {
    if ((source || expectedSource) && ['ENOENT', 'ENOTDIR'].includes(error?.code)) {
      error = Object.assign(invalidated('history_source_leaf_removed'), { cause: error });
    }
    primaryError = error; throw error;
  } finally {
    queue = [];
    try { await handle?.close(); } catch (error) { if (!primaryError) throw error; }
  }
}

// A miss/restart page never rebuilds canonical History: it reads just this
// exact token. Validate the WHOLE leaf hash while retaining only the requested
// page (+ one UTF-16 unit at either edge), and publish only after final proof.
async function readSourceLeafPage(options = {}) {
  const { ref, offset = 0, limit } = options;
  validateSourceLeaf(ref);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.totalChars
    || !Number.isSafeInteger(limit) || limit < 2) throw Error('history_payload_range_invalid');
  const end = Math.min(ref.totalChars, offset + limit);
  const low = Math.max(0, offset - 1), high = Math.min(ref.totalChars, end + 1);
  let position = 0, selected = '';
  for await (const chunk of streamSourceLeaf(options)) {
    const from = Math.max(low, position), to = Math.min(high, position + chunk.length);
    if (to > from) selected += chunk.slice(from - position, to - position);
    position += chunk.length;
  }
  const char = at => selected.charCodeAt(at - low);
  if (offset > 0 && char(offset) >= 0xDC00 && char(offset) <= 0xDFFF
    && char(offset - 1) >= 0xD800 && char(offset - 1) <= 0xDBFF) throw Error('history_payload_range_invalid');
  let to = end;
  if (!options.exactRenderCap && to < ref.totalChars && char(to - 1) >= 0xD800
    && char(to - 1) <= 0xDBFF && char(to) >= 0xDC00 && char(to) <= 0xDFFF) to--;
  return { success: true, payload: selected.slice(offset - low, to - low), totalChars: ref.totalChars,
    offset, nextOffset: to < ref.totalChars ? to : null, contentHash: ref.contentHash, truncatedForRender: false };
}

module.exports = { SOURCE_LEAF_VERSION, isSourceLeaf, createLeafTextHash, createJsonStringDecoder,
  validateSourceLeaf, streamSourceLeaf, readSourceLeafPage };
