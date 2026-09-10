'use strict';

const fs = require('node:fs');
const MAX_EMPTY_PROOF_BYTES = 64 * 1024;

// A known session UUID can exist before there is a conversation to resume.
// This is a positive proof over a complete small file, never a missing-file,
// truncated prefix, failed parse, or empty Timeline fallback.
function isEmptyClaudeMetadata(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.uuid || record.parentUuid || record.message || record.content) return false;
  if (record.type === 'file-history-snapshot') {
    const backups = record.snapshot?.trackedFileBackups;
    return !!backups && typeof backups === 'object' && Object.keys(backups).length === 0;
  }
  if (record.type === 'queue-operation') {
    return record.operation === 'dequeue' && !record.content && !record.prompt;
  }
  return ['mode', 'permission-mode', 'custom-title', 'agent-name', 'agent-color', 'ai-title', 'slug']
    .includes(record.type);
}

function sameEmptyRestoreFile(proof, stat) {
  return !!proof && !!stat && proof.size === stat.size && proof.mtimeMs === stat.mtimeMs
    && proof.ctimeMs === stat.ctimeMs && proof.ino === stat.ino && proof.dev === stat.dev;
}

async function proveEmptyClaudeRestore(filePath) {
  if (!filePath) return null;
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_EMPTY_PROOF_BYTES) return null;
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || !sameEmptyRestoreFile(before, after)) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    for (const line of text.split('\n')) {
      if (line.trim() && !isEmptyClaudeMetadata(JSON.parse(line))) return null;
    }
    const proof = { filePath, size: after.size, mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev };
    return isEmptyClaudeRestoreCurrent(proof) ? proof : null;
  } catch { return null; }
  finally { if (handle) await handle.close(); }
}

function isEmptyClaudeRestoreCurrent(proof) {
  try { return sameEmptyRestoreFile(proof, fs.statSync(proof.filePath)); }
  catch { return false; }
}

module.exports = { proveEmptyClaudeRestore, isEmptyClaudeRestoreCurrent };
