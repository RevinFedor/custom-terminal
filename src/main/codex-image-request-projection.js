'use strict';

const path = require('node:path');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { attachmentProjectionSourceRecord } = require('./owned-mobile-attachments');

const KIND = 'codex-image-path-aliases';
const SCOPE_FIELDS = ['tabId', 'handoffId', 'operationKey', 'attemptId'];
const fullHash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');

function imageRefIdentity(ref) {
  return {
    path: String(ref?.path || ''),
    assetId: String(ref?.assetId || ''),
    mediaType: String(ref?.mediaType || ''),
    size: Number(ref?.size || 0),
  };
}

/** Exact application-owned image marker -> PTY alias mapping, before Enter. */
function createCodexImageRequestProjection({ requestText, transportText, segments, imageRefs, authoringTransport = null, stages = null, ...scope } = {}) {
  if (Array.isArray(stages) && stages.length) return createImageTransformProjection({
    requestText, transportText, imageRefs, authoringTransport, stages, ...scope,
  });
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
  if (!proof || proof.kind !== KIND || ![1, 2].includes(proof.version)) return refused('image-request-projection-missing');
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
    ...(proof.version === 2 ? { stages: proof.stages } : {}),
    ...(proof.version === 2 ? { createdAt: proof.createdAt } : {}),
  });
  if (!replay || replay.requestHash !== proof.requestHash || replay.transportHash !== proof.transportHash
    || JSON.stringify(replay.images) !== JSON.stringify(proof.images)
    || proof.version === 2 && JSON.stringify(replay) !== JSON.stringify(proof)) {
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
  if (audit?.imageRequestProjection?.version === 2) {
    const validated = validateCodexImageRequestProjection({ tabId, record, audit });
    if (!validated.valid) return { applied: false, reason: validated.reason };
    const match = require('./codex-prompt-audit').matchCodexImageTransformCarrier(audit, result?.actualText);
    if (result?.success !== true || typeof result.actualText !== 'string' || !match
      || result.actualHash !== promptAuditFingerprint(result.actualText) || result.actualLen !== result.actualText.length
      || result.expectedHash !== validated.transportHash || result.expectedLen !== validated.transportLength) {
      return { applied: false, reason: 'image-transform-native-carrier-mismatch' };
    }
    const actualPaths = result.actualImagePaths || [];
    if (actualPaths.length && (actualPaths.length !== audit.imageRequestProjection.images.length
      || actualPaths.some((value, index) => ![audit.imageRequestProjection.images[index].sourcePath,
        audit.imageRequestProjection.images[index].transportPath].includes(value)))) {
      return { applied: false, reason: 'image-provider-paths-mismatch' };
    }
    return { ...validated, applied: true, canonicalReason: 'codex_image_request_transform' };
  }
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

// Replay only outcomes durably produced by Main before its first payload write.
// No disk access, fresh staging or inference from a client imageError flag.
function replayImageTransformStage(input, stage, authoringTransport) {
  if (!stage || !['preflight', 'staging'].includes(stage.stage) || !Array.isArray(stage.outcomes)
    || !stage.outcomes.length || stage.outcomes.length > 4096 || stage.inputHash !== fullHash(input)
    || stage.inputLength !== input.length) return null;
  let index = 0, invalid = false;
  const replay = buildCodexImagePastePlan(input, (sourcePath, occurrence) => {
    const outcome = stage.outcomes[index++];
    if (!outcome || outcome.sourcePath !== sourcePath.trim() || outcome.marker !== occurrence.marker
      || outcome.sourceRange?.start !== occurrence.start || outcome.sourceRange?.end !== occurrence.end) {
      invalid = true; return { success: false, error: 'invalid-outcome' };
    }
    if (outcome.kind === 'unavailable') {
      if (typeof outcome.error !== 'string' || !outcome.error || outcome.error.length > 8192) invalid = true;
      return { success: false, path: sourcePath.trim(), error: outcome.error };
    }
    if (stage.stage === 'preflight' && outcome.kind === 'retained') return {
      success: true, path: sourcePath.trim(), inputPath: occurrence.marker,
    };
    if (stage.stage === 'staging' && outcome.kind === 'image' && path.isAbsolute(outcome.text)
      && !/\s/.test(outcome.text)) return { success: true, path: sourcePath.trim(), inputPath: outcome.text };
    invalid = true; return { success: false, error: 'invalid-outcome-kind' };
  }, { authoringTransport, missingCode: stage.stage === 'preflight' ? 'queue_image_path_unavailable' : 'codex_image_path_unavailable' });
  const actual = stage.stage === 'preflight' ? { ...replay.transform, stage: 'preflight',
    outcomes: replay.transform.outcomes.map(outcome => outcome.kind === 'image' ? { ...outcome, kind: 'retained' } : outcome) } : replay.transform;
  if (invalid || index !== stage.outcomes.length || JSON.stringify(actual) !== JSON.stringify(stage)) return null;
  return { text: replay.text, authoringTransport: { sourceHash: fullHash(replay.text),
    imageRanges: actual.outcomes.filter(outcome => outcome.kind === 'retained').map(outcome => ({
      ...outcome.outputRange, path: /\[imagePath:\s*([^\]\r\n]+?)\s*\]/i.exec(outcome.marker)[1],
    })) } };
}

function createImageTransformProjection({ requestText, transportText, imageRefs, authoringTransport = null, stages, createdAt = Date.now(), ...scope }) {
  if (SCOPE_FIELDS.some(field => typeof scope[field] !== 'string' || !scope[field])
    || typeof requestText !== 'string' || typeof transportText !== 'string' || stages.length > 2
    || stages[0]?.stage === 'staging' && stages.length !== 1
    || stages.length === 2 && stages[1]?.stage !== 'staging' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  let current = requestText, plan = authoringTransport;
  try {
    if (plan) require('./structured-authoring').validateAuthoringTransport(current, plan);
    for (const stage of stages) {
      const replay = replayImageTransformStage(current, stage, plan);
      if (!replay) return null;
      current = replay.text; plan = replay.authoringTransport;
    }
  } catch { return null; }
  if (current !== transportText || current === requestText) return null;
  const positive = stages.at(-1).stage === 'staging' ? stages.at(-1).outcomes.filter(outcome => outcome.kind === 'image') : [];
  const refs = Array.isArray(imageRefs) ? imageRefs : [];
  if (positive.length !== refs.length) return null;
  const images = positive.map((outcome, index) => ({ sourcePath: outcome.sourcePath, transportPath: outcome.text,
    ref: imageRefIdentity(refs[index]), transportRange: { ...outcome.outputRange } }));
  if (images.some(image => image.ref.path !== image.sourcePath)) return null;
  return { kind: KIND, version: 2, createdAt, ...Object.fromEntries(SCOPE_FIELDS.map(field => [field, scope[field]])),
    requestText, requestHash: promptAuditFingerprint(requestText), requestLength: requestText.length,
    transportHash: promptAuditFingerprint(transportText), transportLength: transportText.length,
    ...(authoringTransport ? { authoringTransport: JSON.parse(JSON.stringify(authoringTransport)) } : {}),
    images, stages: JSON.parse(JSON.stringify(stages)) };
}

// Final durable owner rechecks the same stored pre-Enter plan and native
// carrier. An allowlisted reason/arbitrary caller hash cannot promote a send.
function validateCodexImageTransformPromotion(record, evidence, auditInput = null) {
  if (record?.receipt?.imageRequestProjection?.version !== 2) return { valid: false, reason: 'image-transform-persisted-proof-missing' };
  const saved = readPersistedCodexImageRequestProjection(record);
  if (!saved.valid) return saved;
  const identity = evidence?.actualIdentity, boundary = record.transcriptBoundary || record.receipt?.transcriptBoundary;
  if (!identity || typeof identity.sessionId !== 'string' || !Number.isFinite(Date.parse(identity.timestamp))
    || auditInput && (identity.sessionId !== auditInput.sessionId || evidence.actualHash !== auditInput.actualHash)
    || boundary?.sessionId === identity.sessionId && boundary?.filePath && !identity.filePath
    || !require('./codex-prompt-audit').codexAuditRecordIsAfterBoundary({ preSubmitBoundary: boundary,
      sentAt: record.receipt.imageRequestProjection.createdAt }, identity)) {
    return { valid: false, reason: 'image-transform-causal-carrier-missing' };
  }
  const result = evidence && { ...evidence, success: true,
    expectedHash: saved.transportHash, expectedLen: saved.transportLength };
  const projected = projectCodexImageAuditToRequest({ tabId: record.tabId, record, audit: saved.audit, result });
  return projected.applied ? { valid: true, ...projected } : { valid: false, reason: projected.reason };
}

module.exports = {
  createCodexImageRequestProjection,
  projectCodexImageAuditToRequest,
  readPersistedCodexImageRequestProjection,
  validateCodexImageRequestProjection,
  validateCodexImageTransformPromotion,
};
