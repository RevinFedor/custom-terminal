'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), { code, statusCode: 409 });
const presentationFields = new Set(['status', 'title', 'text', 'path', 'source_tab_id', 'before_hash', 'after_hash',
  'before_text', 'after_text', 'start_line', 'end_line', 'file_changes_json']);

// Hash large string fields individually; the proof never contains their bodies.
function fieldsHash(record, omitted = new Set()) {
  return digest(JSON.stringify(Object.keys(record).filter(key => !omitted.has(key)).sort().map(key => {
    const value = record[key], encoded = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
    return [key, typeof value, digest(encoded)];
  })));
}
function rewindMember(row, presentedText, changes = []) {
  const file = ['file', 'file-batch'].includes(row.kind) && changes.length > 0;
  return { id: row.id, version: 1, hash: fieldsHash(row, new Set(['status'])),
    textHash: presentedText == null ? null : digest(presentedText),
    ...(file ? { fileCommon: fieldsHash(row, presentationFields),
      fileVersions: changes.map(change => fieldsHash(change, new Set(['acknowledgedText']))) } : {}) };
}
function rewindMemberMatches(member, row, changes = []) {
  const current = rewindMember(row, null, changes);
  if (member.hash === current.hash) return true;
  if (!member.fileVersions?.length || !current.fileVersions?.length || member.fileCommon !== current.fileCommon) return false;
  const available = new Map();
  for (const version of member.fileVersions) available.set(version, (available.get(version) || 0) + 1);
  return current.fileVersions.every(version => {
    const count = available.get(version) || 0;
    if (!count) return false;
    available.set(version, count - 1); return true;
  });
}
function sealRewindSnapshot(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return 'rctx1.' + encoded + '.' + signature;
}
function openRewindSnapshot(token, key) {
  if (typeof token !== 'string' || !token.startsWith('rctx1.') || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw error('self_rewind_context_snapshot_invalid');
  const at = token.lastIndexOf('.'), encoded = token.slice(6, at), signature = token.slice(at + 1);
  const expected = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(signature)
    || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw error('self_rewind_context_snapshot_invalid');
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw error('self_rewind_context_snapshot_invalid'); }
}
module.exports = { fieldsHash, rewindMember, rewindMemberMatches, sealRewindSnapshot, openRewindSnapshot };
