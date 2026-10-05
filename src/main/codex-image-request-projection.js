'use strict';

const path = require('node:path');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { attachmentProjectionSourceRecord } = require('./owned-mobile-attachments');

const KIND = 'codex-image-path-aliases';
const SCOPE_FIELDS = ['tabId', 'handoffId', 'operationKey', 'attemptId'];

function imageRefIdentity(ref) {
  return {
    path: String(ref?.path || ''),
    assetId: String(ref?.assetId || ''),
    mediaType: String(ref?.mediaType || ''),
    size: Number(ref?.size || 0),
  };
}

/** Exact application-owned image marker -> PTY alias mapping, before Enter. */
function createCodexImageRequestProjection({ requestText, transportText, segments, imageRefs, authoringTransport = null, ...scope } = {}) {
  if (SCOPE_FIELDS.some(field => typeof scope[field] !== 'string' || !scope[field])) return null;
  if (typeof requestText !== 'string' || typeof transportText !== 'string') return null;
  const imageSegments = (Array.isArray(segments) ? segments : []).filter(segment => segment?.kind === 'image');
  const refs = Array.isArray(imageRefs) ? imageRefs : [];
  if (imageSegments.length === 0 || refs.length !== imageSegments.length) return null;
  const images = imageSegments.map((segment, index) => ({
    sourcePath: String(segment.sourcePath || ''),
    transportPath: String(segment.text || ''),
    ref: imageRefIdentity(refs[index]),
  }));
  if (images.some(image => !path.isAbsolute(image.sourcePath)
    || !path.isAbsolute(image.transportPath) || /\s/.test(image.transportPath)
    || image.ref.path !== image.sourcePath)) return null;
  let index = 0;
  let replay;
  try { replay = buildCodexImagePastePlan(requestText, sourcePath => {
    const image = images[index++];
    return image && image.sourcePath === sourcePath.trim()
      ? { success: true, path: image.sourcePath, inputPath: image.transportPath }
      : { success: false, error: 'image-source-order-mismatch' };
  }, { authoringTransport }); } catch { return null; }
  if (replay.missing.length > 0 || index !== images.length || replay.text !== transportText) return null;
  const requestHash = promptAuditFingerprint(requestText);
  const transportHash = promptAuditFingerprint(transportText);
  if (requestHash === transportHash) return null;
  return Object.freeze({
    kind: KIND,
    version: 1,
    ...Object.fromEntries(SCOPE_FIELDS.map(field => [field, scope[field]])),
    requestText,
    requestHash,
    requestLength: requestText.length,
    transportHash,
    transportLength: transportText.length,
    ...(authoringTransport ? { authoringTransport: Object.freeze({ sourceHash: authoringTransport.sourceHash,
      imageRanges: Object.freeze(authoringTransport.imageRanges.map(range => Object.freeze({ ...range }))) }) } : {}),
    images: Object.freeze(images.map(image => Object.freeze({ ...image, ref: Object.freeze(image.ref) }))),
  });
}

// Validate the persisted application transformation independently of any
// provider response. Recovery must establish this before transcript matching,
// not manufacture a successful canonical result just to validate metadata.
function validateCodexImageRequestProjection({ tabId, record, audit } = {}) {
  record = attachmentProjectionSourceRecord(record);
  const proof = audit?.imageRequestProjection;
  const refused = reason => ({ valid: false, reason });
  if (!proof || proof.kind !== KIND || proof.version !== 1) return refused('image-request-projection-missing');
  if (record?.provider !== 'codex') return refused('image-request-provider-mismatch');
  const scope = {
    tabId,
    handoffId: audit.handoffId,
    operationKey: audit.sendOperationKey,
    attemptId: audit.sendAttemptId,
  };
  for (const field of SCOPE_FIELDS) {
    if (!scope[field] || proof[field] !== scope[field] || record[field] !== scope[field]) {
      return refused('image-request-' + field + '-mismatch');
    }
  }
  if (record.promptHash !== proof.requestHash || record.promptLength !== proof.requestLength) {
    return refused('image-request-identity-mismatch');
  }
  if (audit.expectedHash !== proof.transportHash || audit.expectedLen !== proof.transportLength) {
    return refused('image-transport-identity-mismatch');
  }
  const paths = Array.isArray(audit.expectedImagePaths) ? audit.expectedImagePaths : [];
  if (!Array.isArray(proof.images) || paths.length !== proof.images.length
    || paths.some((value, index) => value !== proof.images[index].transportPath)) {
    return refused('image-transport-paths-mismatch');
  }
  const replay = createCodexImageRequestProjection({
    ...scope,
    requestText: proof.requestText,
    transportText: audit.expectedText,
    segments: proof.images.map(image => ({ kind: 'image', text: image.transportPath, sourcePath: image.sourcePath })),
    imageRefs: audit.expectedImageRefs,
    authoringTransport: proof.authoringTransport || null,
  });
  if (!replay || replay.requestHash !== proof.requestHash || replay.transportHash !== proof.transportHash
    || JSON.stringify(replay.images) !== JSON.stringify(proof.images)) {
    return refused('image-request-reconstruction-mismatch');
  }
  return {
    valid: true,
    requestHash: proof.requestHash,
    requestLength: proof.requestLength,
    transportHash: proof.transportHash,
    transportLength: proof.transportLength,
    imageCount: proof.images.length,
    kind: KIND,
  };
}

function readPersistedCodexImageRequestProjection(record) {
  record = attachmentProjectionSourceRecord(record);
  if (!record) return { valid: false, reason: 'attachment-projection-invalid' };
  const receipt = record?.receipt || {};
  const refused = reason => ({ valid: false, reason });
  if (receipt.operationKey !== record.operationKey || receipt.attemptId !== record.attemptId) {
    return refused('image-request-persisted-attempt-mismatch');
  }
  if (typeof receipt.promptText !== 'string' || typeof receipt.transportText !== 'string'
    || receipt.promptText !== receipt.imageRequestProjection?.requestText) {
    return refused('image-request-persisted-text-mismatch');
  }
  const audit = {
    handoffId: record.handoffId,
    sendOperationKey: record.operationKey,
    sendAttemptId: record.attemptId,
    expectedText: receipt.transportText,
    expectedHash: promptAuditFingerprint(receipt.transportText),
    expectedLen: receipt.transportText.length,
    expectedImagePaths: receipt.expectedImagePaths,
    expectedImageRefs: receipt.expectedImageRefs,
    imageRequestProjection: receipt.imageRequestProjection,
  };
  const validated = validateCodexImageRequestProjection({ tabId: record.tabId, record, audit });
  return validated.valid ? { ...validated, audit } : validated;
}

/**
 * Compose two different proofs, never relax hash equality generally:
 * application request -> exact staged image aliases -> canonical provider row.
 * The durable record continues to name the immutable original request.
 */
function projectCodexImageAuditToRequest({ tabId, record, audit, result } = {}) {
  const nativeSlots = result?.canonicalized === true
    && result.canonicalReason === 'codex_image_placeholder_canonical';
  const exactTransport = result?.canonicalized !== true
    && result?.actualText === audit?.expectedText
    && typeof result?.actualText === 'string'
    && result.actualHash === audit?.expectedHash
    && result.actualLen === audit?.expectedLen;
  if (result?.success !== true || (!nativeSlots && !exactTransport)) {
    return { applied: false, reason: 'image-provider-canonical-proof-missing' };
  }
  const validated = validateCodexImageRequestProjection({ tabId, record, audit });
  if (!validated.valid) return { applied: false, reason: validated.reason };
  if (result.expectedHash !== validated.transportHash || result.expectedLen !== validated.transportLength) {
    return { applied: false, reason: 'image-transport-identity-mismatch' };
  }
  if (exactTransport) {
    // Codex may retain the staged path as ordinary user text and read the
    // image from that exact path. This is a different carrier from [Image #N].
    // Equality alone is insufficient: the scope-bound, ordered source→alias
    // reconstruction above must prove every image replacement. If the native
    // record also names images, they must agree with that same mapping.
    const actualPaths = Array.isArray(result.actualImagePaths) ? result.actualImagePaths : [];
    const images = audit.imageRequestProjection.images;
    if (actualPaths.length > 0 && (actualPaths.length !== images.length
      || actualPaths.some((value, index) => value !== images[index].sourcePath
        && value !== images[index].transportPath))) {
      return { applied: false, reason: 'image-provider-paths-mismatch' };
    }
  }
  return { ...validated, applied: true,
    canonicalReason: nativeSlots ? result.canonicalReason : 'codex_image_path_alias_exact' };
}

module.exports = {
  createCodexImageRequestProjection,
  projectCodexImageAuditToRequest,
  readPersistedCodexImageRequestProjection,
  validateCodexImageRequestProjection,
};
