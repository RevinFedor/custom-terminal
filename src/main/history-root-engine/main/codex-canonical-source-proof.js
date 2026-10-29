'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const incarnation = stat => `${stat.dev}:${stat.ino}`;
const signature = stat => `${incarnation(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const canonicalRecordFingerprint = record => {
  const copy = { ...record };
  delete copy.__line; delete copy.__byteOffset; delete copy.__eventSequence;
  delete copy.__canonicalRawDigest;
  return digest(JSON.stringify(copy));
};

// Internal, in-process evidence from the FD that actually supplied the bytes.
// Never serialize this ticket into IPC or infer it from a later path-only stat.
function canonicalSourceTicket({ filePath, stat, start, bytes, isCurrent }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 2 * 1024 * 1024
    || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1
    || !Number.isSafeInteger(start) || start < 0) return null;
  let record;
  try { record = JSON.parse(bytes.subarray(0, -1).toString('utf8')); } catch { return null; }
  return Object.freeze({ version: 1, filePath, fileIdentity: incarnation(stat),
    start, end: start + bytes.length, digest: digest(bytes), recordDigest: canonicalRecordFingerprint(record),
    isCurrent: typeof isCurrent === 'function' ? isCurrent : () => false });
}

// Point verification of ONE already retained complete record, not a new scan.
// Growth during this read is NOT an exemption for a concurrent prefix rewrite.
async function verifyCanonicalSourceSpan(ticket, isCurrent, { io = fs.promises } = {}) {
  const current = () => isCurrent() && ticket?.isCurrent?.() === true;
  if (!ticket || !current()) return { ok: false, reason: 'source-ticket-revoked' };
  const fd = await io.open(ticket.filePath, 'r');
  try {
    if (!current()) return { ok: false, reason: 'owner-changed' };
    const before = await fd.stat();
    if (!current()) return { ok: false, reason: 'owner-changed' };
    const pathBefore = await io.stat(ticket.filePath);
    if (!current()) return { ok: false, reason: 'owner-changed' };
    if (incarnation(before) !== ticket.fileIdentity || signature(before) !== signature(pathBefore)
      || before.size < ticket.end) return { ok: false, reason: 'source-incarnation-changed' };
    const bytes = Buffer.alloc(ticket.end - ticket.start);
    let read = 0;
    while (read < bytes.length) {
      const result = await fd.read(bytes, read, bytes.length - read, ticket.start + read);
      if (!current()) return { ok: false, reason: 'owner-changed' };
      if (!result.bytesRead) return { ok: false, reason: 'source-short-read' };
      read += result.bytesRead;
    }
    const after = await fd.stat();
    if (!current()) return { ok: false, reason: 'owner-changed' };
    const pathAfter = await io.stat(ticket.filePath);
    if (!current()) return { ok: false, reason: 'owner-changed' };
    if (signature(before) !== signature(after) || signature(after) !== signature(pathAfter)) {
      return { ok: false, reason: 'source-changed-during-verification' };
    }
    if (bytes.at(-1) !== 10 || digest(bytes) !== ticket.digest) return { ok: false, reason: 'record-digest-mismatch' };
    return { ok: true, bytes: bytes.length };
  } finally { await fd.close(); }
}

module.exports = { canonicalSourceTicket, verifyCanonicalSourceSpan, canonicalRecordDigest: digest,
  canonicalRecordFingerprint };
