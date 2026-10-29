'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createJsonProjection } = require('./codex-resume-source');

const statKey = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const yieldToMainDefault = () => new Promise(resolve => setImmediate(resolve));
const META_SCHEMA = { type: true, payload: { id: true } };

/**
 * A physical byte -> line locator, not a transcript or a lifecycle owner.
 * Count LF bytes (including empty/malformed rows), project only the first
 * session_meta, then let the canonical reader parse the ONE requested row.
 * No tool/assistant/compacted bodies enter the raw records LRU.
 */
function createCodexAuditAddressReader({
  readJsonlRange,
  chunkBytes = 256 * 1024,
  maxFiles = 24,
  maxAddressesPerFile = 128,
  yieldToMain = yieldToMainDefault,
  log = console,
} = {}) {
  if (typeof readJsonlRange !== 'function') throw new TypeError('readJsonlRange required');
  const views = new Map(), flights = new Map();
  const counters = { scans: 0, scanBytes: 0, bodyBytes: 0, verificationBytes: 0,
    cacheHits: 0, recordsParsed: 0, metadataRows: 0, rejected: 0 };
  const highWaterMark = Math.max(1, Math.min(256 * 1024, Number(chunkBytes) || 256 * 1024));
  const fileLimit = Math.max(1, Math.min(24, Number(maxFiles) || 24));
  const addressLimit = Math.max(1, Math.min(128, Number(maxAddressesPerFile) || 128));

  async function* chunks(handle, endByte) {
    const buffer = Buffer.allocUnsafe(highWaterMark);
    let position = 0;
    while (position < endByte) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, endByte - position), position);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
      position += bytesRead;
    }
  }

  async function scan(handle, filePath, size, offset, metrics, bytesKind = 'scanBytes') {
    counters.scans++;
    let chunkStart = 0, lineStart = 0, lineCount = 0, locator = null;
    let metadataFound = false, metadataId, metadataOffset, parser = createJsonProjection(META_SCHEMA);
    const recordHash = createHash('sha256');
    // Own the descriptor until final validation. Breaking a ReadStream async
    // iterator can close its borrowed fd even with autoClose:false on Node18.
    for await (const chunk of chunks(handle, size)) {
      counters[bytesKind] += chunk.length;
      metrics[bytesKind] += chunk.length;
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? chunk.length : newline;
        if (lineStart === offset) recordHash.update(chunk.subarray(cursor, newline < 0 ? end : end + 1));
        // Reuse the validating Resume projection for uncommon metadata after
        // other records, escaped keys, duplicate keys and giant ignored values.
        // After the first metadata row there is no JSON work in this scan.
        if (!metadataFound) parser.write(chunk.subarray(cursor, end).toString('latin1'), chunkStart + cursor);
        if (newline < 0) break;
        const endByte = chunkStart + newline + 1;
        if (offset >= lineStart && offset < endByte) {
          if (offset !== lineStart) return null;
          locator = { fromByte: lineStart, toByte: endByte, startLine: lineCount };
        }
        if (!metadataFound) {
          const result = parser.finish(endByte - 1);
          if (result.valid && result.value?.type === 'session_meta') {
            metadataFound = true;
            metadataId = result.value.payload?.id;
            metadataOffset = lineStart;
            counters.metadataRows++;
          } else parser = createJsonProjection(META_SCHEMA);
        }
        lineCount++;
        lineStart = endByte;
        cursor = newline + 1;
        if (metadataFound && locator) {
          return { metadataId, metadataOffset, locator, recordDigest: recordHash.digest('hex') };
        }
      }
      chunkStart += chunk.length;
      // An already buffered read must still release main's event loop.
      await yieldToMain();
    }
    // The canonical range reader does not assign a UUID to an unfinished tail.
    return null;
  }

  async function verifyAddress(handle, filePath, size, candidate, metrics) {
    const current = await scan(handle, filePath, size, candidate.locator.fromByte, metrics, 'verificationBytes');
    // This proves a physical address, not the entire transcript's immutability:
    // first metadata owner/location + LF-derived coordinates + exact raw target.
    // Unrelated tool bytes cannot change __line; hashing all of them added
    // seconds of CPU while providing no additional address evidence.
    return current !== null && JSON.stringify(current) === JSON.stringify(candidate);
  }

  async function readInner(filePath, offset) {
    if (!filePath || !Number.isSafeInteger(offset) || offset < 0) return null;
    const started = performance.now();
    const metrics = { scanBytes: 0, bodyBytes: 0, verificationBytes: 0, cacheHit: 0 };
    let handle, accepted = false;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const before = await handle.stat();
      if (before.size <= offset || statKey(before) !== statKey(await fs.promises.stat(filePath))) return null;
      const version = statKey(before);
      let view = views.get(filePath);
      if (view?.version !== version) { views.delete(filePath); view = null; }
      let candidate = view?.addresses.get(offset);
      if (candidate) { counters.cacheHits++; metrics.cacheHit = 1; }
      else candidate = await scan(handle, filePath, before.size, offset, metrics);
      if (!candidate) return null;
      const { locator } = candidate;
      const recordHash = createHash('sha256');
      const parsed = await readJsonlRange(filePath, locator.fromByte, locator.toByte - 1, {
        lineCount: locator.startLine,
        onChunk: chunk => { counters.bodyBytes += chunk.length; metrics.bodyBytes += chunk.length; recordHash.update(chunk); },
      });
      counters.recordsParsed += parsed.records.length;
      if (parsed.errors || parsed.records.length !== 1 || parsed.leftoverBuffer?.length
        || recordHash.digest('hex') !== candidate.recordDigest) return null;
      const record = parsed.records[0];
      if (record.__byteOffset !== offset || record.__line !== locator.startLine) return null;
      let after = await handle.stat();
      if (!sameFile(before, after) || after.size < before.size
        || statKey(after) !== statKey(await fs.promises.stat(filePath))) return null;
      if (statKey(before) !== statKey(after)) {
        // Same-size rewrite is not an append. Growth alone proves nothing
        // either: a rewrite+growth can preserve the target text/offset while
        // changing its physical line number. Recount the prefix and verify
        // metadata + raw target. Genuine concurrent append stays supported.
        if (after.size === before.size || !await verifyAddress(handle, filePath, after.size, candidate, metrics)) return null;
        const verified = await handle.stat();
        if (!sameFile(after, verified) || verified.size < after.size
          || (verified.size === after.size && statKey(verified) !== statKey(after))
          || statKey(verified) !== statKey(await fs.promises.stat(filePath))) return null;
        after = verified;
      }
      const nextVersion = statKey(after);
      const addresses = view?.version === nextVersion ? view.addresses : new Map();
      addresses.delete(offset); addresses.set(offset, candidate);
      while (addresses.size > addressLimit) addresses.delete(addresses.keys().next().value);
      views.delete(filePath); views.set(filePath, { version: nextVersion, addresses });
      while (views.size > fileLimit) views.delete(views.keys().next().value);
      accepted = true;
      // Deliberately not a general transcript/source proof for Fork or Resume.
      return { record, sessionId: candidate.metadataId };
    } finally {
      if (!accepted) { views.delete(filePath); counters.rejected++; }
      await handle?.close();
      const ended = performance.now();
      log.log?.('[CodexAuditAddressRead] outcome=' + (accepted ? 'address' : 'unproven')
        + ' file=' + path.basename(filePath)
        + ' startAbs=' + (performance.timeOrigin + started).toFixed(1)
        + ' endAbs=' + (performance.timeOrigin + ended).toFixed(1)
        + ' scanBytes=' + metrics.scanBytes
        + ' bodyBytes=' + metrics.bodyBytes
        + ' verificationBytes=' + metrics.verificationBytes
        + ' cacheHit=' + metrics.cacheHit
        + ' ms=' + (ended - started).toFixed(1));
    }
  }

  function read(filePath, offset) {
    // Serialise one file, not the whole app. Overlapping audits share the
    // completed locator cache, never a raw-record promise from an older read.
    const next = (flights.get(filePath) || Promise.resolve()).catch(() => {}).then(() => readInner(filePath, offset));
    flights.set(filePath, next);
    next.finally(() => { if (flights.get(filePath) === next) flights.delete(filePath); }).catch(() => {});
    return next;
  }
  return { read, clear: () => views.clear(), stats: () => ({ ...counters, files: views.size,
    addresses: [...views.values()].reduce((sum, view) => sum + view.addresses.size, 0), inflight: flights.size }) };
}

module.exports = { createCodexAuditAddressReader };
