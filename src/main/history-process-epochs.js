'use strict';

// SharedArrayBuffer cannot be assumed to cross an Electron utility-process
// boundary. Keep Main's existing in-memory proof authoritative, and expose its
// small epoch control plane through one private boot file. Only Main writes.
// This file contains counters, never source content, cache rows or tab data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SLOTS } = require('./history-worker-epochs');
const MAGIC = Buffer.from('NTHREP01');
const HEADER = 32, STRIDE = 8, LENGTH = HEADER + SLOTS * STRIDE;
const unknown = () => Object.assign(new Error('History source fence unavailable'), { code: 'HISTORY_READER_FENCE_UNAVAILABLE' });
const invalidated = () => Object.assign(new Error('History source fence changed during observation'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });

function readExact(fd, buffer, position) {
  if (fs.readSync(fd, buffer, 0, buffer.length, position) !== buffer.length) throw unknown();
}
function writeExact(fd, buffer, position) {
  if (fs.writeSync(fd, buffer, 0, buffer.length, position) !== buffer.length) throw unknown();
}

function createProcessEpochOwner({ sourceEpochs, sourceRewriteEpochs, directory = os.tmpdir() }) {
  let root, filePath, fd, version = 0n, available = true, disposed = false;
  try {
    root = fs.mkdtempSync(path.join(directory, 'noted-history-epochs-'));
    fs.chmodSync(root, 0o700);
    filePath = path.join(root, 'epochs');
    fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    const data = Buffer.alloc(LENGTH);
    MAGIC.copy(data); data.writeUInt32LE(SLOTS, 16); data.writeUInt32LE(LENGTH, 20);
    for (let slot = 0; slot < SLOTS; slot++) {
      data.writeInt32LE(Atomics.load(sourceEpochs, slot), HEADER + slot * STRIDE);
      data.writeInt32LE(Atomics.load(sourceRewriteEpochs, slot), HEADER + slot * STRIDE + 4);
    }
    writeExact(fd, data, 0);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    throw Object.assign(unknown(), { cause: error });
  }
  const sequence = Buffer.alloc(8), row = Buffer.alloc(STRIDE);
  return {
    filePath,
    get available() { return available && !disposed; },
    publish(slots) {
      if (!available || disposed) throw unknown();
      try {
        sequence.writeBigUInt64LE(++version); writeExact(fd, sequence, 8); // odd: update in progress
        for (const slot of new Set(slots)) {
          if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw unknown();
          row.writeInt32LE(Atomics.load(sourceEpochs, slot), 0);
          row.writeInt32LE(Atomics.load(sourceRewriteEpochs, slot), 4);
          writeExact(fd, row, HEADER + slot * STRIDE);
        }
        sequence.writeBigUInt64LE(++version); writeExact(fd, sequence, 8);
      } catch (error) {
        available = false;
        // An odd, short or otherwise unavailable fence is never 'current'.
        // Main rejects all replies too, even if this best-effort mark fails.
        try { row.writeUInt32LE(1, 0); writeExact(fd, row.subarray(0, 4), 24); } catch {}
        throw Object.assign(unknown(), { cause: error });
      }
    },
    // The caller must wait for a proven child exit. A send/kill error is not
    // death proof and must not delete the file under a still-running reader.
    disposeAfterExit() {
      if (disposed) return; disposed = true; available = false;
      fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function openProcessEpochReader(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size !== LENGTH) { fs.closeSync(fd); throw unknown(); }
  const first = Buffer.alloc(HEADER), last = Buffer.alloc(HEADER), data = Buffer.alloc(LENGTH - HEADER);
  const sourceEpochs = new Int32Array(SLOTS), sourceRewriteEpochs = new Int32Array(SLOTS);
  let closed = false, observedVersion = null;
  function refresh() {
    if (closed) throw unknown();
    try {
      if (fs.fstatSync(fd).size !== LENGTH) throw unknown();
      readExact(fd, first, 0);
      if (!first.subarray(0, 8).equals(MAGIC) || first.readUInt32LE(16) !== SLOTS
        || first.readUInt32LE(20) !== LENGTH || first.readUInt32LE(24)) throw unknown();
      const version = first.readBigUInt64LE(8);
      if (version & 1n) throw invalidated();
      if (version !== observedVersion) readExact(fd, data, HEADER);
      readExact(fd, last, 0);
      if (!first.equals(last)) throw invalidated();
      if (version === observedVersion) return { sourceEpochs, sourceRewriteEpochs };
      // Publish mirrors only after a complete even-version observation.
      for (let slot = 0; slot < SLOTS; slot++) {
        sourceEpochs[slot] = data.readInt32LE(slot * STRIDE);
        sourceRewriteEpochs[slot] = data.readInt32LE(slot * STRIDE + 4);
      }
      observedVersion = version;
      return { sourceEpochs, sourceRewriteEpochs };
    } catch (error) {
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED' || error.code === 'HISTORY_READER_FENCE_UNAVAILABLE') throw error;
      throw Object.assign(unknown(), { cause: error });
    }
  }
  try { refresh(); } catch (error) { fs.closeSync(fd); closed = true; throw error; }
  return { sourceEpochs, sourceRewriteEpochs, refresh,
    close() { if (!closed) { closed = true; fs.closeSync(fd); } },
  };
}

module.exports = { createProcessEpochOwner, openProcessEpochReader };
