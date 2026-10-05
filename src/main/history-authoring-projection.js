'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { readPersistedCodexImageRequestProjection } = require('./codex-image-request-projection');
const { codexCanonicalUserMessageMatch } = require('./codex-prompt-audit');
const { readOwnedAttachmentProjection } = require('./owned-mobile-attachments');
const { normalizeStoredAssetId } = require('./prompt-queue-assets');

const KIND = 'authoring-projection';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const nonempty = value => typeof value === 'string' && value.length > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

function projectionText(parts, mode) {
  return parts.map(part => part.kind === 'text' ? part.text
    : part.kind === 'file' ? (mode === 'transport' || mode === 'image-request' ? part.transportPath : part.sourcePath)
    : mode === 'image-request' ? part.marker
    : mode === 'request' ? part.marker
      : mode === 'transport' ? part.transportPath : `[Image #${part.id}]`).join('');
}

// This normalizes TRUSTED stored sidecars, not client-provided presentation
// input. Creation below requires a confirmed exact receipt. Text parts are
// never scanned for paths/markers: an identical literal path remains text.
function normalizeHistoryAuthoringProjection(value) {
  if (value?.kind !== KIND || value.version !== 1 || !Array.isArray(value.parts)
    || !value.parts.length || value.parts.length > 8193) return null;
  const nativeSlots = value.carrier === 'native-image-slots';
  if (value.carrier != null && !nativeSlots) return null;
  const origin = value.origin, binding = value.binding;
  if (!origin || ['tabId', 'handoffId', 'operationKey', 'attemptId', 'sessionId'].some(k => !nonempty(origin[k]))
    || !binding || !nonempty(binding.sessionId) || !timestamp(binding.auditTimestamp)
    || !nonempty(binding.entryUuid) && !nonempty(binding.sourceIdentity)
    || !['audit', 'mapped-copy'].includes(binding.kind)) return null;
  if (binding.kind === 'audit' && binding.sessionId !== origin.sessionId) return null;
  if (binding.kind === 'mapped-copy' && (!nonempty(binding.copiedFromSessionId)
    || binding.copiedFromSessionId === binding.sessionId)) return null;
  const parts = []; let slot = 0, sourceOffset = 0, files = 0;
  for (const part of value.parts) {
    if (part?.kind === 'text' && typeof part.text === 'string') {
      parts.push({ kind: 'text', text: part.text }); sourceOffset += part.text.length;
    } else if (part?.kind === 'image' && part.id === ++slot
      && nonempty(part.marker) && nonempty(part.sourcePath) && path.isAbsolute(part.sourcePath)
      && nonempty(part.transportPath) && path.isAbsolute(part.transportPath) && !/\s/.test(part.transportPath)) {
      parts.push({ kind: 'image', id: part.id, marker: part.marker,
        sourcePath: part.sourcePath, transportPath: part.transportPath });
      sourceOffset += part.marker.length;
    } else if (part?.kind === 'file' && path.isAbsolute(part.sourcePath || '')
      && path.isAbsolute(part.transportPath || '') && typeof part.assetId === 'string'
      && normalizeStoredAssetId(part.assetId) === part.assetId
      && part.assetId.includes('.document.') && path.basename(part.transportPath) === part.assetId) {
      parts.push({ kind: 'file', sourcePath: part.sourcePath, transportPath: part.transportPath, assetId: part.assetId });
      sourceOffset += part.sourcePath.length; files++;
    } else return null;
  }
  if ((!slot && !files) || slot > 64 || sourceOffset > 8 * 1024 * 1024) return null;
  const request = projectionText(parts, 'request'), transport = projectionText(parts, 'transport');
  if (sha(request) !== value.requestSha256 || sha(transport) !== value.transportSha256
    || (nativeSlots ? binding.transportHash !== value.canonicalHash || !/^[a-f0-9]{16}$/.test(value.canonicalHash)
      : binding.transportHash !== promptAuditFingerprint(transport))) return null;
  let cursor = 0; const images = parts.filter(part => part.kind === 'image');
  const imageRequest = projectionText(parts, 'image-request');
  let imageOffset = 0;
  const imageRanges = [];
  for (const part of parts) {
    if (part.kind === 'image') imageRanges.push({ start: imageOffset, end: imageOffset + part.marker.length, path: part.sourcePath });
    imageOffset += part.kind === 'text' ? part.text.length : part.kind === 'file' ? part.transportPath.length : part.marker.length;
  }
  try {
    const replay = buildCodexImagePastePlan(imageRequest, sourcePath => {
      const image = images[cursor++];
      return image?.sourcePath === sourcePath
        ? { success: true, path: sourcePath, inputPath: image.transportPath }
        : { success: false };
    }, { authoringTransport: { sourceHash: sha(imageRequest), imageRanges } });
    if (replay.text !== transport || replay.missing.length || cursor !== images.length) return null;
  } catch { return null; }
  return { kind: KIND, version: 1,
    ...(nativeSlots ? { carrier: 'native-image-slots', canonicalHash: value.canonicalHash } : {}),
    origin: Object.fromEntries(['tabId', 'handoffId', 'operationKey', 'attemptId', 'sessionId'].map(k => [k, origin[k]])),
    binding: { kind: binding.kind, sessionId: binding.sessionId, auditTimestamp: timestamp(binding.auditTimestamp),
      transportHash: binding.transportHash, entryUuid: binding.entryUuid || null,
      sourceIdentity: binding.sourceIdentity || null,
      ...(binding.kind === 'mapped-copy' ? { copiedFromSessionId: binding.copiedFromSessionId } : {}) },
    parts, requestSha256: value.requestSha256, transportSha256: value.transportSha256 };
}

function historyAuthoringProjectionFromReceipt(record) {
  if (record?.state !== 'confirmed' || record.provider !== 'codex') return null;
  const receipt = record.receipt, audit = record.auditIdentity, proof = receipt?.imageRequestProjection;
  const nativeSlots = receipt?.canonicalReason === 'codex_image_placeholder_canonical';
  if (receipt?.ownedAttachmentProjection) return ownedHistoryAuthoringProjection(record);
  if ((!nativeSlots && (!proof?.authoringTransport || receipt.canonicalReason !== 'codex_image_path_alias_exact'))
    || !proof || (nativeSlots && (receipt.canonicalized !== true || receipt.exactAuditConfirmed !== true))
    || !audit || audit.attemptId !== record.attemptId || audit.provider !== 'codex'
    || !nonempty(audit.sessionId) || audit.sessionId !== record.sessionId
    || receipt.sessionId !== audit.sessionId || (!nativeSlots && receipt.actualHash !== proof.transportHash)
    || audit.promptHash !== receipt.actualHash || !timestamp(audit.auditTimestamp)
    || timestamp(receipt.auditTimestamp) !== timestamp(audit.auditTimestamp)) return null;
  if (!readPersistedCodexImageRequestProjection(record).valid) return null;
  let ranges = proof.authoringTransport?.imageRanges;
  if (nativeSlots && !ranges) {
    // Introspect the SAME proven paste formatter. No path/count matching or
    // second image grammar: only occurrences actually staged by this request.
    let index = 0;
    const replay = buildCodexImagePastePlan(proof.requestText, sourcePath => {
      const image = proof.images[index++];
      return image?.sourcePath === sourcePath.trim()
        ? { success: true, path: image.sourcePath, inputPath: image.transportPath } : { success: false };
    }, { includeSourceRanges: true });
    if (replay.text !== receipt.transportText || replay.missing.length || index !== proof.images.length) return null;
    ranges = replay.segments.filter(part => part.kind === 'image').map(part => ({ ...part.sourceRange, path: part.sourcePath }));
  }
  if (!Array.isArray(ranges) || !ranges.length || ranges.length !== proof.images.length) return null;
  const parts = []; let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    const image = proof.images[index];
    if (range.path !== image.sourcePath) return null;
    if (range.start > cursor) parts.push({ kind: 'text', text: proof.requestText.slice(cursor, range.start) });
    parts.push({ kind: 'image', id: index + 1, marker: proof.requestText.slice(range.start, range.end),
      sourcePath: image.sourcePath, transportPath: image.transportPath });
    cursor = range.end;
  }
  if (cursor < proof.requestText.length) parts.push({ kind: 'text', text: proof.requestText.slice(cursor) });
  return normalizeHistoryAuthoringProjection({ kind: KIND, version: 1,
    ...(nativeSlots ? { carrier: 'native-image-slots', canonicalHash: receipt.actualHash } : {}),
    origin: { tabId: record.tabId, handoffId: record.handoffId, operationKey: record.operationKey,
      attemptId: record.attemptId, sessionId: audit.sessionId },
    binding: { kind: 'audit', sessionId: audit.sessionId, entryUuid: audit.entryUuid || null,
      sourceIdentity: audit.sourceIdentity || null, auditTimestamp: audit.auditTimestamp, transportHash: receipt.actualHash },
    parts, requestSha256: sha(proof.requestText), transportSha256: sha(receipt.transportText) });
}

function ownedHistoryAuthoringProjection(record) {
  const { receipt, auditIdentity: audit } = record;
  const owned = readOwnedAttachmentProjection(record);
  if (!owned.valid || !audit || audit.attemptId !== record.attemptId || audit.provider !== 'codex'
    || !nonempty(audit.sessionId) || record.sessionId !== audit.sessionId || receipt.sessionId !== audit.sessionId
    || receipt.exactAuditConfirmed !== true || receipt.auditTimestamp !== audit.auditTimestamp
    || receipt.actualHash !== audit.promptHash) return null;
  const imageProof = receipt.imageRequestProjection;
  const nativeSlots = receipt.canonicalReason === 'codex_image_placeholder_canonical';
  if (imageProof ? !readPersistedCodexImageRequestProjection(record).valid
    : receipt.actualHash !== owned.preparedHash || receipt.transportText !== owned.proof.preparedText) return null;
  const request = owned.proof.requestText, snapshot = receipt.ownedAttachments;
  const replacements = snapshot.ranges.filter(range => snapshot.refs[range.refIndex].kind === 'file')
    .map(range => ({ ...range, part: { kind: 'file', sourcePath: snapshot.refs[range.refIndex].sourcePath,
      transportPath: owned.proof.paths[range.refIndex], assetId: snapshot.refs[range.refIndex].assetId } }));
  if (imageProof) {
    let index = 0;
    let plan;
    try { plan = buildCodexImagePastePlan(request, sourcePath => {
      const image = imageProof.images[index++];
      return image?.sourcePath === sourcePath ? { success: true, path: sourcePath, inputPath: image.transportPath } : { success: false };
    }, { authoringTransport: snapshot.authoringTransport || null, includeSourceRanges: true }); } catch { return null; }
    if (plan.missing.length || index !== imageProof.images.length) return null;
    for (const [slot, segment] of plan.segments.filter(part => part.kind === 'image').entries()) {
      replacements.push({ ...segment.sourceRange, part: { kind: 'image', id: slot + 1,
        marker: request.slice(segment.sourceRange.start, segment.sourceRange.end),
        sourcePath: segment.sourcePath, transportPath: segment.text } });
    }
  }
  replacements.sort((a, b) => a.start - b.start);
  const parts = []; let offset = 0;
  for (const replacement of replacements) {
    if (replacement.start < offset) return null;
    if (replacement.start > offset) parts.push({ kind: 'text', text: request.slice(offset, replacement.start) });
    parts.push(replacement.part); offset = replacement.end;
  }
  if (offset < request.length) parts.push({ kind: 'text', text: request.slice(offset) });
  return normalizeHistoryAuthoringProjection({ kind: KIND, version: 1,
    ...(nativeSlots ? { carrier: 'native-image-slots', canonicalHash: receipt.actualHash } : {}),
    origin: { tabId: record.tabId, handoffId: record.handoffId, operationKey: record.operationKey,
      attemptId: record.attemptId, sessionId: audit.sessionId },
    binding: { kind: 'audit', sessionId: audit.sessionId, entryUuid: audit.entryUuid || null,
      sourceIdentity: audit.sourceIdentity || null, auditTimestamp: audit.auditTimestamp, transportHash: receipt.actualHash },
    parts, requestSha256: sha(request), transportSha256: sha(receipt.transportText) });
}

// Read-only attachment DTO for an already owned local handoff. This is
// request->transport presentation proof, never a delivery/acceptance ACK.
function imagePresentationFromReceipt(record) {
  if (!readPersistedCodexImageRequestProjection(record).valid) return null;
  const receipt = record.receipt, images = receipt.imageRequestProjection.images;
  const refs = receipt.expectedImageRefs;
  if (!Array.isArray(refs) || refs.length !== images.length
    || images.some((image, index) => refs[index]?.path !== image.sourcePath)) return null;
  return { version: 1, operationKey: record.operationKey, attemptId: record.attemptId,
    requestHash: record.promptHash, imagePaths: refs.map((ref, index) => ({ ...ref, id: index + 1,
      path: images[index].sourcePath, sourcePath: images[index].sourcePath, transportPath: images[index].transportPath })) };
}

function projectHistoryAuthoringEntry(value, row, entry, imagePaths) {
  const projection = normalizeHistoryAuthoringProjection(value);
  if (!projection || row?.toolType !== 'codex') return null;
  const bound = projection.binding;
  const physicalSession = entry?.physicalSessionId || entry?.sessionId;
  if (row.sessionId !== bound.sessionId || physicalSession !== bound.sessionId
    || timestamp(row.auditTimestamp) !== bound.auditTimestamp
    || row.transportHash !== bound.transportHash) return null;
  const sources = [entry.sourceIdentity, ...(Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : [])].filter(nonempty);
  if (entry.uuid !== bound.entryUuid && (!bound.sourceIdentity || !sources.includes(bound.sourceIdentity))) return null;
  const content = typeof entry.fullText === 'string' ? entry.fullText : entry.content;
  if (typeof content !== 'string') return null;
  const nativeSlots = projection.carrier === 'native-image-slots';
  // response_item -> event_msg promotion keeps an exact physical alias but
  // may change the timestamp and native text hash. Only that proven carrier
  // relationship may use the same immutable authoring projection; ordinary
  // or same-text rows cannot bypass the original timestamp/hash boundary.
  const pairedCarrier = nativeSlots && bound.sourceIdentity
    && bound.sourceIdentity !== entry.sourceIdentity
    && (entry.sourceIdentityAliases || []).includes(bound.sourceIdentity)
    && timestamp(entry.promptPresentationAuditTimestamp) === timestamp(entry.timestamp)
    && entry.promptPresentationTransportHash === promptAuditFingerprint(content);
  if (timestamp(entry.timestamp) !== bound.auditTimestamp && !pairedCarrier) return null;
  if (!nativeSlots && sha(content) !== projection.transportSha256) return null;
  const images = projection.parts.filter(part => part.kind === 'image');
  if (!Array.isArray(imagePaths) || imagePaths.length !== images.length
    || images.some(image => !imagePaths.some(ref => ref.id === image.id && ref.path === image.sourcePath))) return null;
  if (nativeSlots) {
    const rawRefs = entry.imagePaths;
    const hash = entry.promptPresentationTransportHash || promptAuditFingerprint(content);
    if ((hash !== projection.canonicalHash && !pairedCarrier) || !Array.isArray(rawRefs) || rawRefs.length !== images.length
      || images.some((image, index) => rawRefs[index]?.id !== image.id
        || ![image.sourcePath, image.transportPath].includes(rawRefs[index]?.path))) return null;
    const match = codexCanonicalUserMessageMatch({ expectedText: projectionText(projection.parts, 'transport'),
      expectedImagePaths: images.map(image => image.transportPath) }, content);
    if (match?.reason !== 'codex_image_placeholder_canonical') return null;
    // Canonical native text (including a literal upload footer) is unchanged.
    // Original and staged paths annotate ONE occurrence, never two previews.
    const ownedDisplay = projection.parts.some(part => part.kind === 'file') ? projectionText(projection.parts, 'display') : null;
    return { ...entry, ...(ownedDisplay !== null ? { content: ownedDisplay,
      ...(typeof entry.fullText === 'string' ? { fullText: ownedDisplay } : {}) } : {}), imagePaths: images.map(image => ({ ...imagePaths.find(ref => ref.id === image.id),
      sourcePath: image.sourcePath, transportPath: image.transportPath })) };
  }
  const next = projectionText(projection.parts, 'display');
  return { ...entry, content: next, ...(typeof entry.fullText === 'string' ? { fullText: next } : {}) };
}

// Called only inside the existing proven metadata-copy transaction. Keep the
// immutable send origin, but bind the sidecar to the mapped physical child row.
function rebindHistoryAuthoringProjection(value, { sourceSessionId, childSessionId, mapping }) {
  const projection = normalizeHistoryAuthoringProjection(value);
  if (!projection || projection.binding.sessionId !== sourceSessionId
    || !nonempty(childSessionId) || childSessionId === sourceSessionId
    || projection.binding.transportHash !== mapping.sourceTransportHash
    || projection.binding.auditTimestamp !== timestamp(mapping.sourceAuditTimestamp)) return null;
  // Native text is not the staged-path text stored in parts. Rebind its exact
  // canonical audit hash, without reconstructing or rewriting the provider row.
  if (projection.carrier === 'native-image-slots') return normalizeHistoryAuthoringProjection({ ...projection,
    canonicalHash: mapping.childTransportHash, binding: { kind: 'mapped-copy', sessionId: childSessionId,
      entryUuid: mapping.childEntryUuid, sourceIdentity: null, auditTimestamp: mapping.childAuditTimestamp,
      transportHash: mapping.childTransportHash, copiedFromSessionId: sourceSessionId } });
  // The pre-existing remapper proves equality modulo newline encoding only.
  const parts = projection.binding.transportHash === mapping.childTransportHash ? projection.parts
    : projection.parts.map(part => part.kind === 'text'
      ? { ...part, text: part.text.replace(/\r\n?/g, '\n') } : part);
  return normalizeHistoryAuthoringProjection({ ...projection, parts,
    requestSha256: sha(projectionText(parts, 'request')), transportSha256: sha(projectionText(parts, 'transport')),
    binding: { kind: 'mapped-copy', sessionId: childSessionId, entryUuid: mapping.childEntryUuid,
      sourceIdentity: null, auditTimestamp: mapping.childAuditTimestamp,
      transportHash: mapping.childTransportHash, copiedFromSessionId: sourceSessionId } });
}

module.exports = { historyAuthoringProjectionFromReceipt, normalizeHistoryAuthoringProjection,
  projectHistoryAuthoringEntry, rebindHistoryAuthoringProjection, imagePresentationFromReceipt };
