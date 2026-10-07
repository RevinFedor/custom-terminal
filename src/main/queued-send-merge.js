'use strict';

const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { isServicePromptEntry } = require('../shared/prompt-origin.cjs');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { validateOwnedAttachmentSnapshot } = require('./owned-mobile-attachments');

const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code, disposition: 'not-applied' }); };
const clone = value => JSON.parse(JSON.stringify(value));
let codecs;
const loadCodecs = () => codecs ||= Promise.all(['composer-chips.mjs', 'prompt-image-attachments.mjs']
  .map(file => import(pathToFileURL(path.join(__dirname, '../shared', file)).href)));

function mergeableQueuedSend(item, record, request) {
  return item?.state === 'waiting' && record && !record.attemptId
    && ['reserved', 'preparing'].includes(record.state) && record.surface === 'desktop-history'
    && request?.source === 'history-panel' && !request.recordWithoutReply && !request.promptQueueIntent
    && !request.sendRunId && !isServicePromptEntry(request.presentationSnapshot)
    && ['claude', 'codex'].includes(record.provider);
}

function queuedSendMergeCompatible(left, right) {
  // One merged message has one destination/settings intent. No hidden choice
  // of a different model, writer, draft owner or explicit command execution.
  const fields = ['provider', 'toolType', 'expectedTarget', 'cwd', 'settingsIntent', 'model', 'effort',
    'thinking', 'ownership', 'returnDraftOnConflict', 'requireLive', 'sendSurface', 'source'];
  return fields.every(key => fingerprintAgentSendRequest(left?.[key] ?? null)
    === fingerprintAgentSendRequest(right?.[key] ?? null));
}

async function composeQueuedSendMerge({ left, right, leftRecord, rightRecord, requestId }) {
  if (!queuedSendMergeCompatible(left, right)) fail('send_queue_merge_incompatible');
  const [composer, images] = await loadCodecs();
  const prompt = left.prompt + '\n\n' + right.prompt;
  const offset = left.prompt.length + 2;
  const handoffId = 'queued-merge:' + requestId;
  const operationKey = `history:${leftRecord.tabId}:${handoffId}`;
  const imageRanges = (request, delta) => buildCodexImagePastePlan(request.prompt,
    sourcePath => ({ success: true, path: sourcePath, inputPath: sourcePath }), {
      authoringTransport: request.presentationSnapshot?.authoringTransport || null, includeSourceRanges: true,
    }).segments.filter(part => part.kind === 'image').map(part => ({
      start: part.sourceRange.start + delta, end: part.sourceRange.end + delta, path: part.sourcePath,
    }));
  const transport = { sourceHash: sha(prompt), bodyHash: sha(prompt), bodyLength: prompt.length,
    imageRanges: [...imageRanges(left, 0), ...imageRanges(right, offset)] };
  const fileRanges = [...(left.presentationSnapshot?.authoringTransport?.fileRanges || []),
    ...(right.presentationSnapshot?.authoringTransport?.fileRanges || []).map(ref => ({ ...ref,
      start: ref.start + offset, end: ref.end + offset }))];
  if (fileRanges.length) transport.fileRanges = fileRanges;

  const authoring = request => request.authoringSnapshot || { editorText: request.prompt,
    chips: request.presentationSnapshot?.promptChips || [], imagePaths: request.presentationSnapshot?.imagePaths || [] };
  const first = authoring(left), second = authoring(right);
  const rich = images.insertPromptImageAttachments({ text: first.editorText + '\n\n', imagePaths: first.imagePaths || [],
    insertedText: second.editorText, insertedImagePaths: second.imagePaths || [] });
  if (rich.missingSourceIds.length
    || rich.imagePaths.length !== (first.imagePaths?.length || 0) + (second.imagePaths?.length || 0)) {
    fail('send_queue_merge_authoring_unavailable');
  }
  const mergedChips = composer.mergeComposerAuthoringSnapshot({ currentChips: first.chips || [], restoredChips: second.chips || [],
    createChipId: (_chip, index) => `merge-${requestId}-${index}` }).chips;
  if (mergedChips.length !== (first.chips?.length || 0) + (second.chips?.length || 0)) fail('send_queue_merge_authoring_unavailable');
  const presentationChips = composer.mergeComposerAuthoringSnapshot({
    currentChips: left.presentationSnapshot?.promptChips || [], restoredChips: right.presentationSnapshot?.promptChips || [],
    createChipId: (_chip, index) => `merge-prompt-${requestId}-${index}` }).chips;
  const presentation = { ...(right.presentationSnapshot || {}), ...(left.presentationSnapshot || {}),
    promptChips: presentationChips,
    imagePaths: [...(left.presentationSnapshot?.imagePaths || []), ...(right.presentationSnapshot?.imagePaths || [])]
      .map((ref, index) => ({ ...ref, id: index + 1 })), authoringTransport: transport,
    semanticTags: [...(left.presentationSnapshot?.semanticTags || []), ...(right.presentationSnapshot?.semanticTags || [])],
  };
  const request = { ...clone(left), prompt, handoffId, sendOperationKey: operationKey, workContextPrepared: true,
    presentationSnapshot: presentation, authoringSnapshot: { editorText: rich.text, chips: mergedChips, imagePaths: rich.imagePaths } };
  delete request.ownedAttachments;
  const refs = [], ranges = [], descriptors = [];
  for (const [original, record, delta] of [[left, leftRecord, 0], [right, rightRecord, offset]]) {
    const owned = original.ownedAttachments;
    if (!owned) continue;
    if (!validateOwnedAttachmentSnapshot(owned, original.prompt, record)) fail('attachment_snapshot_invalid');
    const refOffset = refs.length;
    refs.push(...clone(owned.refs));
    ranges.push(...owned.ranges.map(range => ({ ...range, start: range.start + delta,
      end: range.end + delta, refIndex: range.refIndex + refOffset })));
    descriptors.push(...(owned.fileDescriptors || []).map(ref => ({ ...ref,
      ...(Number.isSafeInteger(ref.refIndex) ? { refIndex: ref.refIndex + refOffset } : {}) })));
  }
  if (refs.length) request.ownedAttachments = { version: 1, tabId: leftRecord.tabId, handoffId, operationKey,
    requestFingerprint: fingerprintAgentSendRequest(request), sourceHash: sha(prompt), refs, ranges,
    fileDescriptors: descriptors, authoringTransport: { sourceHash: sha(prompt), imageRanges: transport.imageRanges } };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 8 * 1024 * 1024) fail('send_queue_merge_too_large');
  return { request, identity: { operationKey, tabId: leftRecord.tabId, handoffId, surface: 'desktop-history',
    provider: leftRecord.provider, sessionId: leftRecord.sessionId,
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length } };
}

module.exports = { mergeableQueuedSend, queuedSendMergeCompatible, composeQueuedSendMerge };
