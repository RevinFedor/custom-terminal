'use strict';

// Upload -> existing durable asset owner -> immutable Send snapshot. This is
// a scoped path projection, not another prompt parser or provider executor.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeStoredAssetId, normalizeAssetId } = require('./prompt-queue-assets');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { buildCodexImagePastePlan } = require('./codex-image-transport');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const scopeFields = ['tabId', 'handoffId', 'operationKey'];
const fail = (code, statusCode = 409) => Object.assign(new Error(code), {
  code, statusCode, submitted: false, pasteWritten: false, enterWritten: false,
});

function scopeMatches(snapshot, scope) {
  return scopeFields.every(key => typeof scope?.[key] === 'string' && scope[key]
    && snapshot?.[key] === scope[key]);
}

async function uploadPathKey(rootDir, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\0\r\n]/.test(sourcePath)) {
    throw fail('attachment_path_invalid', 400);
  }
  const root = path.resolve(rootDir);
  const physicalRoot = await fs.promises.realpath(root);
  const candidate = path.resolve(sourcePath);
  const lexicalRoot = [root, physicalRoot].find(value => candidate.startsWith(value + path.sep));
  if (!lexicalRoot) throw fail('attachment_path_outside_owner', 403);
  const relative = path.relative(lexicalRoot, candidate);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[a-zA-Z0-9_-]+$/.test(parts[0])) {
    throw fail('attachment_path_outside_owner', 403);
  }
  return { key: parts.join('/'), id: parts[0], physicalRoot, candidate };
}

async function importMobileUploads({ rootDir, attachments, assetStore, resolveRetained = () => null }) {
  if (!assetStore) throw fail('attachment_asset_owner_unavailable', 503);
  const refs = [], releases = [], imported = new Map();
  const release = () => { for (const done of releases.splice(0)) done(); };
  try {
    for (const attachment of attachments) {
      const sourcePath = attachment.path;
      let retained = resolveRetained(sourcePath, attachment.assetId || null);
      if (retained?.ambiguous) {
        if (attachment.assetId || !fs.existsSync(sourcePath)) throw fail('attachment_upload_identity_ambiguous');
        retained = null; // A new Send may capture an existing live upload; never guess an old copy.
      }
      if (retained && (retained.kind !== attachment.kind || attachment.id && retained.uploadId !== attachment.id)) {
        throw fail('attachment_upload_identity_mismatch', 403);
      }
      if (retained && (attachment.assetId || !fs.existsSync(sourcePath))) {
        const releaseAsset = await assetStore.lease(retained.assetId); releases.push(releaseAsset);
        const owned = await assetStore.verifyOwnedRef(retained, { touch: true });
        refs.push({ ...retained, sourcePath, name: attachment.name || retained.name, size: owned.size });
        continue;
      }
      const source = await uploadPathKey(rootDir, sourcePath);
      if (attachment.id && attachment.id !== source.id) throw fail('attachment_upload_identity_mismatch', 403);
      // No symlink escape, including after a restart when the upload's RAM
      // index is gone. /var and /private/var may name this same owned root.
      const parent = await fs.promises.realpath(path.dirname(source.candidate));
      if (parent !== path.join(source.physicalRoot, source.id)) throw fail('attachment_path_outside_owner', 403);
      const stat = await fs.promises.lstat(source.candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('attachment_path_outside_owner', 403);
      const key = source.key + ':' + attachment.kind;
      let owned = imported.get(key);
      if (!owned) {
        const handle = await fs.promises.open(source.candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw fail('attachment_source_changed');
          const result = await assetStore.importUploadHandle(handle, {
            kind: attachment.kind, name: attachment.name, path: sourcePath,
            mediaType: attachment.mimeType,
          });
          owned = result.ref; releases.push(result.release); imported.set(key, owned);
        } finally { await handle.close(); }
      }
      if (attachment.assetId && attachment.assetId !== owned.assetId) throw fail('attachment_upload_identity_mismatch', 403);
      refs.push({ sourcePath, sourceKey: source.key, uploadId: source.id,
        assetId: owned.assetId, kind: attachment.kind, name: attachment.name,
        mediaType: owned.mediaType, size: owned.size });
    }
    return { refs, release };
  } catch (error) {
    release();
    if (error.submitted === false) throw error;
    throw fail(error.code === 'ENOENT' ? 'attachment_missing' : 'attachment_storage_failed',
      error.code === 'ENOENT' ? 410 : 503);
  }
}

// Image occurrences come from the existing paste grammar, including typed
// authoring ranges when supplied. File ranges are emitted by the existing
// mobile attachment formatter; literal paths elsewhere are never scanned.
function createOwnedAttachmentSnapshot({ prompt, refs, fileRanges = [], authoringTransport = null, imageRefIndexes = null,
  requestFingerprint, ...scope }) {
  const ranges = fileRanges.map(range => ({ start: range.start, end: range.end,
    refIndex: Number.isSafeInteger(range.refIndex) ? range.refIndex
      : refs.findIndex(ref => ref.kind === 'file' && ref.sourcePath === range.sourcePath) }));
  const plan = buildCodexImagePastePlan(prompt, sourcePath => ({
    success: true, path: sourcePath, inputPath: sourcePath,
  }), { authoringTransport, includeSourceRanges: true });
  const images = plan.segments.filter(part => part.kind === 'image');
  if (imageRefIndexes && imageRefIndexes.length !== images.length) throw fail('attachment_authoring_changed');
  for (const [index, segment] of images.entries()) {
    const refIndex = imageRefIndexes ? imageRefIndexes[index]
      : refs.findIndex(ref => ref.kind === 'image' && ref.sourcePath === segment.sourcePath);
    if (refIndex < 0) continue;
    const marker = prompt.slice(segment.sourceRange.start, segment.sourceRange.end);
    const start = segment.sourceRange.start + marker.indexOf(segment.sourcePath);
    ranges.push({ start, end: start + segment.sourcePath.length, refIndex });
  }
  const snapshot = { version: 1, ...Object.fromEntries(scopeFields.map(key => [key, scope[key]])),
    requestFingerprint, sourceHash: sha(prompt), refs, ranges: ranges.sort((a, b) => a.start - b.start),
    fileDescriptors: fileRanges.map(range => ({ sourcePath: range.sourcePath, line: range.line,
      ...(Number.isSafeInteger(range.refIndex) ? { refIndex: range.refIndex } : {}) })),
    ...(imageRefIndexes ? { imageRefIndexes } : {}),
    ...(authoringTransport ? { authoringTransport: { sourceHash: sha(prompt), imageRanges: authoringTransport.imageRanges } } : {}) };
  if (!validateOwnedAttachmentSnapshot(snapshot, prompt, scope)) throw fail('attachment_snapshot_invalid');
  return snapshot;
}

function validateOwnedAttachmentSnapshot(snapshot, prompt, scope) {
  if (snapshot?.version !== 1 || !scopeMatches(snapshot, scope)
    || typeof prompt !== 'string' || sha(prompt) !== snapshot.sourceHash
    || typeof snapshot.requestFingerprint !== 'string' || !snapshot.requestFingerprint
    || !Array.isArray(snapshot.refs) || !snapshot.refs.length
    || !Array.isArray(snapshot.ranges)) return false;
  if (snapshot.refs.some(ref => !['image', 'file'].includes(ref?.kind)
    || !ref.assetId || normalizeStoredAssetId(ref.assetId) !== ref.assetId
    || (ref.kind === 'image' ? normalizeAssetId(ref.assetId) !== ref.assetId : !ref.assetId.includes('.document.'))
    || typeof ref.sourcePath !== 'string' || !path.isAbsolute(ref.sourcePath)
    || typeof ref.sourceKey !== 'string' || !ref.sourceKey || !ref.uploadId
    || !Number.isSafeInteger(ref.size) || ref.size < 0)) return false;
  let end = 0;
  for (const range of snapshot.ranges) {
    const ref = snapshot.refs[range?.refIndex];
    if (!ref || !Number.isSafeInteger(range.refIndex) || range.refIndex < 0
      || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < end || range.end <= range.start || range.end > prompt.length
      || prompt.slice(range.start, range.end) !== ref.sourcePath) return false;
    end = range.end;
  }
  return true;
}

function bindOwnedAttachmentSnapshot(snapshot, originalPrompt, preparedPrompt, { prefix = '', authoringTransport = null } = {}) {
  if (!snapshot) return null;
  if (!validateOwnedAttachmentSnapshot(snapshot, originalPrompt, snapshot)) throw fail('attachment_authoring_changed');
  if (!preparedPrompt.endsWith(originalPrompt)) {
    // The existing work-context owner may refresh one generated saved_prompt
    // wrapper, not just prepend a prefix. Reuse the original formatter's exact
    // file descriptors and image grammar against that owner's prepared text.
    // Never shift every image by a guessed global length delta in this case.
    if (!preparedPrompt.startsWith(prefix)) throw fail('attachment_authoring_changed');
    const body = preparedPrompt.slice(prefix.length);
    const descriptors = snapshot.fileDescriptors || [];
    for (const line of new Set((authoringTransport?.fileRanges ? [] : descriptors).map(item => item.line))) {
      if (typeof line !== 'string' || body.split('\n').filter(value => value === line).length
        !== descriptors.filter(value => value.line === line).length) throw fail('attachment_authoring_changed');
    }
    let after = prefix.length;
    const fileRanges = authoringTransport?.fileRanges || descriptors.map(item => {
      const at = preparedPrompt.indexOf(item.line, after);
      const start = at + item.line.indexOf(item.sourcePath); after = at + item.line.length;
      if (at < 0) throw fail('attachment_authoring_changed');
      return { ...item, start, end: start + item.sourcePath.length };
    });
    const rebound = createOwnedAttachmentSnapshot({ ...snapshot, prompt: preparedPrompt,
      fileRanges, authoringTransport });
    const occurrences = value => value.ranges.map(range => value.refs[range.refIndex].sourcePath);
    if (JSON.stringify(occurrences(rebound)) !== JSON.stringify(occurrences(snapshot))) throw fail('attachment_authoring_changed');
    return rebound;
  }
  const delta = preparedPrompt.length - originalPrompt.length;
  return { ...snapshot, sourceHash: sha(preparedPrompt),
    ranges: snapshot.ranges.map(range => ({ ...range, start: range.start + delta, end: range.end + delta })),
    ...(snapshot.authoringTransport ? { authoringTransport: { sourceHash: sha(preparedPrompt),
      imageRanges: snapshot.authoringTransport.imageRanges.map(range => ({ ...range, start: range.start + delta, end: range.end + delta })) } } : {}) };
}

function renderOwnedAttachmentTransport(snapshot, prompt, provider, paths) {
  if (!validateOwnedAttachmentSnapshot(snapshot, prompt, snapshot)
    || !['claude', 'codex'].includes(provider) || !Array.isArray(paths)
    || paths.length !== snapshot.refs.length || paths.some((value, index) =>
      !path.isAbsolute(value || '') || path.basename(value) !== snapshot.refs[index].assetId)) {
    throw fail('attachment_projection_invalid');
  }
  const replacements = snapshot.ranges.filter(range => provider !== 'codex' || snapshot.refs[range.refIndex].kind === 'file');
  let text = '', offset = 0;
  for (const range of replacements) {
    text += prompt.slice(offset, range.start) + paths[range.refIndex]; offset = range.end;
  }
  text += prompt.slice(offset);
  return { text, replacements };
}

async function prepareOwnedAttachmentTransport({ record, prompt, provider, assetStore, authoringTransport = null }) {
  const snapshot = record?.receipt?.ownedAttachments;
  if (!snapshot) return null;
  if (!record.attemptId || !validateOwnedAttachmentSnapshot(snapshot, prompt, record)
    || promptAuditFingerprint(prompt) !== record.promptHash || prompt.length !== record.promptLength) {
    throw fail('attachment_attempt_mismatch');
  }
  if (Boolean(authoringTransport) !== Boolean(snapshot.authoringTransport)
    || (authoringTransport && (authoringTransport.sourceHash !== snapshot.sourceHash
      || JSON.stringify(authoringTransport.imageRanges) !== JSON.stringify(snapshot.authoringTransport.imageRanges)))) {
    throw fail('attachment_authoring_changed');
  }
  const verified = [];
  try { for (const ref of snapshot.refs) verified.push(await assetStore.verifyOwnedRef(ref, { touch: true })); }
  catch { throw fail('attachment_owned_bytes_unavailable', 410); }
  const paths = verified.map(ref => ref.path);
  const rendered = renderOwnedAttachmentTransport(snapshot, prompt, provider, paths);
  const shift = position => rendered.replacements.reduce((value, range) => value
    + (range.end <= position ? paths[range.refIndex].length - (range.end - range.start) : 0), position);
  const plan = authoringTransport ? { sourceHash: sha(rendered.text),
    imageRanges: authoringTransport.imageRanges.map(range => ({ ...range, start: shift(range.start), end: shift(range.end) })) } : null;
  // Bind physical images by exact occurrence span, not by source path. Two
  // retained versions can legitimately use the same authored upload path.
  const imagePlan = buildCodexImagePastePlan(prompt, sourcePath => ({ success: true, path: sourcePath, inputPath: sourcePath }),
    { authoringTransport: snapshot.authoringTransport || null, includeSourceRanges: true });
  const imageRefs = imagePlan.segments.filter(part => part.kind === 'image').map(part => {
    const start = part.sourceRange.start + prompt.slice(part.sourceRange.start, part.sourceRange.end).indexOf(part.sourcePath);
    const range = snapshot.ranges.find(value => value.start === start && value.end === start + part.sourcePath.length
      && snapshot.refs[value.refIndex].kind === 'image');
    return range ? verified[range.refIndex] : { sourcePath: part.sourcePath, unowned: true };
  });
  return { text: rendered.text, authoringTransport: plan,
    imageRefs,
    projection: { kind: 'owned-mobile-attachment-paths', version: 1, ...Object.fromEntries(scopeFields.map(key => [key, record[key]])),
      attemptId: record.attemptId, provider, requestText: prompt, preparedText: rendered.text, paths,
      requestHash: record.promptHash, requestLength: record.promptLength,
      preparedHash: promptAuditFingerprint(rendered.text), preparedLength: rendered.text.length } };
}

function readOwnedAttachmentProjection(record) {
  const proof = record?.receipt?.ownedAttachmentProjection;
  if (!proof) return { valid: false, reason: 'attachment-projection-missing' };
  if (proof.kind !== 'owned-mobile-attachment-paths' || proof.version !== 1
    || typeof proof.requestText !== 'string' || typeof proof.preparedText !== 'string'
    || !scopeMatches(proof, record) || proof.attemptId !== record.attemptId
    || proof.provider !== record.provider || proof.requestText !== record.receipt.promptText
    || record.promptHash !== promptAuditFingerprint(proof.requestText)
    || record.promptLength !== proof.requestText.length || proof.requestHash !== record.promptHash
    || proof.requestLength !== record.promptLength) return { valid: false, reason: 'attachment-projection-owner-mismatch' };
  try {
    const snapshot = record.receipt.ownedAttachments;
    if (!validateOwnedAttachmentSnapshot(snapshot, proof.requestText, record)) throw new Error('snapshot');
    const rendered = renderOwnedAttachmentTransport(snapshot, proof.requestText, proof.provider, proof.paths);
    if (rendered.text !== proof.preparedText || proof.preparedHash !== promptAuditFingerprint(rendered.text)
      || proof.preparedLength !== rendered.text.length) throw new Error('text');
    return { valid: true, proof, requestHash: proof.requestHash, requestLength: proof.requestLength,
      preparedHash: proof.preparedHash, preparedLength: proof.preparedLength };
  } catch { return { valid: false, reason: 'attachment-projection-reconstruction-mismatch' }; }
}

function attachmentProjectionSourceRecord(record) {
  if (!record?.receipt?.ownedAttachmentProjection) return record;
  const checked = readOwnedAttachmentProjection(record);
  if (!checked.valid) return null;
  return { ...record, promptHash: checked.preparedHash, promptLength: checked.preparedLength,
    receipt: { ...record.receipt, promptText: checked.proof.preparedText, ownedAttachmentProjection: undefined } };
}

function projectOwnedAttachmentAuditToRequest(record, result) {
  const checked = readOwnedAttachmentProjection(record);
  if (!checked.valid || result?.success !== true || result.expectedHash !== checked.preparedHash
    || result.expectedLen !== checked.preparedLength) return { applied: false, reason: checked.reason || 'attachment-audit-mismatch' };
  return { applied: true, requestHash: checked.requestHash, requestLength: checked.requestLength,
    canonicalReason: result.canonicalReason || 'owned_mobile_attachment_paths' };
}

function attachmentOwnershipReceipt(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.refs) || !snapshot.refs.length) return null;
  return { version: 1, scope: 'mobile-upload', durable: true,
    count: snapshot.refs.length, images: snapshot.refs.filter(ref => ref.kind === 'image').length,
    files: snapshot.refs.filter(ref => ref.kind === 'file').length,
    imageOccurrences: snapshot.ranges.filter(range => snapshot.refs[range.refIndex]?.kind === 'image').length,
    fileOccurrences: snapshot.ranges.filter(range => snapshot.refs[range.refIndex]?.kind === 'file').length,
    refs: snapshot.refs.map((ref, index) => ({ index, uploadId: ref.uploadId, sourcePath: ref.sourcePath,
      assetId: ref.assetId, kind: ref.kind, name: ref.name, mediaType: ref.mediaType, size: ref.size })) };
}

module.exports = { importMobileUploads, uploadPathKey, createOwnedAttachmentSnapshot,
  validateOwnedAttachmentSnapshot, bindOwnedAttachmentSnapshot, prepareOwnedAttachmentTransport,
  renderOwnedAttachmentTransport,
  readOwnedAttachmentProjection, attachmentProjectionSourceRecord, projectOwnedAttachmentAuditToRequest,
  attachmentOwnershipReceipt };
