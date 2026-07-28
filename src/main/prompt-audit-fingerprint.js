'use strict';

const crypto = require('node:crypto');

// This is the transport identity emitted by Claude/Codex post-Enter audits.
// It is intentionally distinct from the full SHA-256 used to locate a prompt
// in a transcript. Every producer and consumer of PasteAudit identity must use
// this helper so the two proof domains cannot silently drift apart.
function promptAuditFingerprint(text) {
  return crypto
    .createHash('sha1')
    .update(String(text || ''))
    .digest('hex')
    .slice(0, 16);
}

module.exports = {
  promptAuditFingerprint,
};
