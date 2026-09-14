'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { readPersistedCodexImageRequestProjection } = require('./codex-image-request-projection');

const KIND = 'authoring-projection';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const nonempty = value => typeof value === 'string' && value.length > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

function projectionText(parts, mode) {
  return parts.map(part => part.kind === 'text' ? part.text
    : mode === 'request' ? part.marker
      : mode === 'transport' ? part.transportPath : `[Image #${part.id}]`).join('');
}

// This normalizes TRUSTED stored sidecars, not client-provided presentation
// input. Creation below requires a confirmed exact receipt. Text parts are
// never scanned for paths/markers: an identical literal path remains text.
function normalizeHistoryAuthoringProjection(value) {
  if (value?.kind !== KIND || value.version !== 1 || !Array.isArray(value.parts)
    || !value.parts.length || value.parts.length > 129) return null;
  const origin = value.origin, binding = value.binding;
  if (!origin || ['tabId', 'handoffId', 'operationKey', 'attemptId', 'sessionId'].some(k => !nonempty(origin[k]))
    || !binding || !nonempty(binding.sessionId) || !timestamp(binding.auditTimestamp)
    || !nonempty(binding.entryUuid) && !nonempty(binding.sourceIdentity)
    || !['audit', 'mapped-copy'].includes(binding.kind)) return null;
  if (binding.kind === 'audit' && binding.sessionId !== origin.sessionId) return null;
  if (binding.kind === 'mapped-copy' && (!nonempty(binding.copiedFromSessionId)
    || binding.copiedFromSessionId === binding.sessionId)) return null;
  const parts = []; let slot = 0, sourceOffset = 0; const ranges = [];
  for (const part of value.parts) {
    if (part?.kind === 'text' && typeof part.text === 'string') {
      parts.push({ kind: 'text', text: part.text }); sourceOffset += part.text.length;
    } else if (part?.kind === 'image' && part.id === ++slot
      && nonempty(part.marker) && nonempty(part.sourcePath) && path.isAbsolute(part.sourcePath)
      && nonempty(part.transportPath) && path.isAbsolute(part.transportPath) && !/\s/.test(part.transportPath)) {
      parts.push({ kind: 'image', id: part.id, marker: part.marker,
        sourcePath: part.sourcePath, transportPath: part.transportPath });
      ranges.push({ start: sourceOffset, end: sourceOffset + part.marker.length, path: part.sourcePath });
      sourceOffset += part.marker.length;
    } else return null;
  }
  if (!slot || slot > 64 || sourceOffset > 8 * 1024 * 1024) return null;
  const request = projectionText(parts, 'request'), transport = projectionText(parts, 'transport');
  if (sha(request) !== value.requestSha256 || sha(transport) !== value.transportSha256
    || binding.transportHash !== promptAuditFingerprint(transport)) return null;
  let cursor = 0; const images = parts.filter(part => part.kind === 'image');
  try {
    const replay = buildCodexImagePastePlan(request, sourcePath => {
      const image = images[cursor++];
      return image?.sourcePath === sourcePath
        ? { success: true, path: sourcePath, inputPath: image.transportPath }
        : { success: false };
    }, { authoringTransport: { sourceHash: value.requestSha256, imageRanges: ranges } });
    if (replay.text !== transport || replay.missing.length || cursor !== images.length) return null;
  } catch { return null; }
  return { kind: KIND, version: 1,
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
  if (!proof?.authoringTransport || receipt.canonicalReason !== 'codex_image_path_alias_exact'
    || !audit || audit.attemptId !== record.attemptId || audit.provider !== 'codex'
    || !nonempty(audit.sessionId) || audit.sessionId !== record.sessionId
    || receipt.sessionId !== audit.sessionId || receipt.actualHash !== proof.transportHash
    || audit.promptHash !== proof.transportHash || !timestamp(audit.auditTimestamp)
    || timestamp(receipt.auditTimestamp) !== timestamp(audit.auditTimestamp)) return null;
  if (!readPersistedCodexImageRequestProjection(record).valid) return null;
  const ranges = proof.authoringTransport.imageRanges;
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
    origin: { tabId: record.tabId, handoffId: record.handoffId, operationKey: record.operationKey,
      attemptId: record.attemptId, sessionId: audit.sessionId },
    binding: { kind: 'audit', sessionId: audit.sessionId, entryUuid: audit.entryUuid || null,
      sourceIdentity: audit.sourceIdentity || null, auditTimestamp: audit.auditTimestamp, transportHash: proof.transportHash },
    parts, requestSha256: sha(proof.requestText), transportSha256: sha(receipt.transportText) });
}

function projectHistoryAuthoringEntry(value, row, entry, imagePaths) {
  const projection = normalizeHistoryAuthoringProjection(value);
  if (!projection || row?.toolType !== 'codex') return null;
  const bound = projection.binding;
  const physicalSession = entry?.physicalSessionId || entry?.sessionId;
  if (row.sessionId !== bound.sessionId || physicalSession !== bound.sessionId
    || timestamp(row.auditTimestamp) !== bound.auditTimestamp
    || timestamp(entry.timestamp) !== bound.auditTimestamp || row.transportHash !== bound.transportHash) return null;
  const sources = [entry.sourceIdentity, ...(Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : [])].filter(nonempty);
  if (entry.uuid !== bound.entryUuid && (!bound.sourceIdentity || !sources.includes(bound.sourceIdentity))) return null;
  const content = typeof entry.fullText === 'string' ? entry.fullText : entry.content;
  if (typeof content !== 'string' || sha(content) !== projection.transportSha256) return null;
  const images = projection.parts.filter(part => part.kind === 'image');
  if (!Array.isArray(imagePaths) || imagePaths.length !== images.length
    || images.some(image => !imagePaths.some(ref => ref.id === image.id && ref.path === image.sourcePath))) return null;
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
  projectHistoryAuthoringEntry, rebindHistoryAuthoringProjection };
