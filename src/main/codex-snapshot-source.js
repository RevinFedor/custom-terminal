'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const invalidated = () => Object.assign(new Error('Codex snapshot source changed during read'),
  { code: 'CODEX_SOURCE_READ_INVALIDATED' });
const identity = stat => stat.fileIdentity || stat.dev + ':' + stat.ino;
const shape = source => JSON.stringify([source.kind, source.viewOwnerSessionId, source.revisionKey,
  source.eventKey, source.manifestDigest, source.childPrefix, source.segments.map(part => [
    part.segmentId, part.filePath, part.physicalSessionId, part.fromByte, part.startLine,
    !!part.frozen, part.frozen ? part.toByte : null, part.endLine, part.digest])]);

// Request-local byte witnesses, not a parser/cache or writer authority. The
// canonical reader records hashes while scanning exactly the captured ranges.
async function captureCodexSnapshotSource(source, { assertCurrent = () => {}, onRead = () => {} } = {}) {
  const files = new Map(), ranges = [], capturedAt = Date.now();
  let closed = false;
  const assertStat = (expected, actual) => {
    if (!actual.isFile?.() || identity(expected) !== identity(actual) || actual.size < expected.size
      || actual.size === expected.size && (actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs)) throw invalidated();
  };
  const assert = () => { if (assertCurrent() === false) throw invalidated(); };
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([...files.values()].map(file => file.handle.close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  const hashRange = async (filePath, fromByte, toByte) => {
    const hash = createHash('sha256'); let bytes = 0;
    if (toByte > fromByte) for await (const chunk of fs.createReadStream(filePath, {
      fd: files.get(filePath).handle.fd, autoClose: false, start: fromByte, end: toByte - 1, highWaterMark: 256 * 1024,
    })) { hash.update(chunk); bytes += chunk.length; onRead(chunk.length); assert(); }
    if (bytes !== toByte - fromByte) throw invalidated();
    return hash.digest('hex');
  };
  try {
    assert();
    for (const part of source.segments) {
      if (!Number.isSafeInteger(part.fromByte) || !Number.isSafeInteger(part.toByte) || part.fromByte < 0
        || part.toByte < part.fromByte || part.toByte > part.sourceSnapshot?.size) throw invalidated();
      if (!files.has(part.filePath)) {
        const handle = await fs.promises.open(part.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        files.set(part.filePath, { handle, expected: part.sourceSnapshot });
        assertStat(part.sourceSnapshot, await handle.stat());
        assertStat(part.sourceSnapshot, await fs.promises.lstat(part.filePath));
      } else if (identity(files.get(part.filePath).expected) !== identity(part.sourceSnapshot)) throw invalidated();
      assert();
    }
    if (source.childPrefix) {
      const part = source.segments.at(-1), prefix = source.childPrefix;
      if (await hashRange(part.filePath, prefix.fromByte, prefix.toByte) !== prefix.digest) throw invalidated();
      ranges.push({ filePath: part.filePath, fromByte: prefix.fromByte, toByte: prefix.toByte, hash: prefix.digest });
    }
    return {
      get closed() { return closed; },
      capturedAt,
      record(part, hash) { if (part.frozen && part.digest !== hash) throw invalidated();
        ranges.push({ filePath: part.filePath, fromByte: part.fromByte, toByte: part.toByte, hash }); },
      async validate(latest) {
        assert();
        if (!latest?.success || shape(source) !== shape(latest)) throw invalidated();
        for (let index = 0; index < source.segments.length; index++) {
          const part = source.segments[index], next = latest.segments[index];
          if (identity(part.sourceSnapshot) !== identity(next.sourceSnapshot)
            || next.sourceSnapshot.size < part.sourceSnapshot.size || next.toByte < part.toByte) throw invalidated();
        }
        for (const range of ranges) {
          if (await hashRange(range.filePath, range.fromByte, range.toByte) !== range.hash) throw invalidated();
        }
        for (const [filePath, file] of files) {
          assertStat(file.expected, await file.handle.stat());
          assertStat(file.expected, await fs.promises.lstat(filePath));
        }
        assert();
      },
      assertCurrent: assert,
      snapshotId: () => createHash('sha256').update(shape(source)).update(JSON.stringify(ranges)).digest('hex'),
      close,
    };
  } catch (error) { await close(); throw error; }
}

module.exports = { captureCodexSnapshotSource };
