'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, chips: 256, images: 64, parts: 4096 });
const fail = (detail, statusCode = 400) => {
  throw Object.assign(new Error('Invalid structured authoring: ' + detail), {
    code: 'structured_authoring_invalid', statusCode, submitted: false,
  });
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + ' must be an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(label + '.' + key + ' unsupported');
}
function string(value, label, { optional = false, nonempty = false, max = LIMITS.bytes } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || (nonempty && (!value || value.trim() !== value)) || value.length > max
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(label + ' invalid string');
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(label + ' invalid integer');
}
function absolutePath(value, label) {
  string(value, label, { nonempty: true, max: 8192 });
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail(label + ' must be an absolute path');
}
let codecs;
function loadCodecs() {
  return codecs ||= Promise.all(['composer-chips.mjs', 'prompt-image-attachments.mjs']
    .map(name => import(pathToFileURL(path.join(__dirname, '..', 'shared', name)).href)));
}

/** Pure authoring preparation. Never reads linked files, imports/uploads an
 * image, touches a draft, or starts a provider. PTY staging/audit stays below
 * the existing Send scenario. Public metadata is NOT delivery authority. */
async function prepareStructuredAuthoring(input) {
  object(input, ['version', 'text', 'parts', 'chips', 'imagePaths'], 'authoring');
  if (input.version !== 1) fail('version must be 1');
  if (own(input, 'text') === own(input, 'parts')) fail('provide exactly one of text or parts');
  if (!Array.isArray(input.chips) || input.chips.length > LIMITS.chips) fail('chips invalid');
  if (!Array.isArray(input.imagePaths) || input.imagePaths.length > LIMITS.images) fail('imagePaths invalid');
  const chipIds = new Set();
  const chips = input.chips.map(chip => {
    object(chip, ['id', 'kind', 'text', 'label', 'sourceKey', 'contextUpdateId', 'inheritanceDepth',
      'inheritanceParentLabel', 'attachmentKind', 'filePath', 'role', 'sha256', 'bytes', 'createdAt'], 'chip');
    string(chip.id, 'chip.id', { nonempty: true, max: 256 });
    if (chipIds.has(chip.id)) fail('duplicate chip.id');
    chipIds.add(chip.id);
    if (!['prompt', 'paste'].includes(chip.kind)) fail('chip.kind unsupported');
    string(chip.text, 'chip.text');
    if (!chip.text && chip.attachmentKind !== 'file') fail('empty chip');
    for (const key of ['label', 'sourceKey', 'contextUpdateId', 'inheritanceParentLabel']) {
      string(chip[key], 'chip.' + key, { optional: true, nonempty: true, max: 8192 });
      if (typeof chip[key] === 'string' && /[\0\r\n]/.test(chip[key])) fail('multiline chip metadata');
    }
    if (own(chip, 'inheritanceDepth')) integer(chip.inheritanceDepth, 'inheritanceDepth');
    if (own(chip, 'createdAt')) integer(chip.createdAt, 'createdAt');
    const result = { ...chip };
    if (own(chip, 'attachmentKind')) {
      if (chip.attachmentKind !== 'file' || chip.kind !== 'prompt') fail('attachmentKind unsupported');
      if (['contextUpdateId', 'inheritanceDepth', 'inheritanceParentLabel'].some(key => own(chip, key))) fail('saved-prompt metadata on context-file chip');
      absolutePath(chip.filePath, 'chip.filePath');
      if (chip.text.includes('\0')) fail('binary context-file content');
      if (!['source', 'instructions'].includes(chip.role)) fail('context-file role invalid');
      const sha256 = crypto.createHash('sha256').update(chip.text, 'utf8').digest('hex');
      const bytes = Buffer.byteLength(chip.text, 'utf8');
      if (own(chip, 'sha256') && (typeof chip.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(chip.sha256)
        || chip.sha256.toLowerCase() !== sha256)) fail('context-file sha256 mismatch');
      if (own(chip, 'bytes') && chip.bytes !== bytes) fail('context-file bytes mismatch');
      Object.assign(result, { sha256, bytes });
    } else if (['filePath', 'role', 'sha256', 'bytes'].some(key => own(chip, key))) fail('file metadata without file chip');
    if (chip.kind === 'paste' && ['sourceKey', 'contextUpdateId', 'inheritanceDepth', 'inheritanceParentLabel'].some(key => own(chip, key))) fail('prompt metadata on paste chip');
    return result;
  });
  const imageIds = new Set();
  const images = input.imagePaths.map(ref => {
    object(ref, ['id', 'path', 'assetId', 'mediaType', 'size', 'availability', 'error'], 'image');
    integer(ref.id, 'image.id', 1);
    if (imageIds.has(ref.id)) fail('duplicate image.id');
    imageIds.add(ref.id);
    if (ref.availability !== undefined && !['available', 'missing'].includes(ref.availability)) fail('image availability invalid');
    if (ref.path !== '' || ref.availability !== 'missing') absolutePath(ref.path, 'image.path');
    if (/[\]\r\n\0]/.test(ref.path)) fail('image path cannot be represented safely');
    string(ref.assetId, 'image.assetId', { optional: true, nonempty: true, max: 512 });
    if (ref.assetId !== undefined && !/^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(ref.assetId)) fail('image.assetId invalid');
    if (ref.mediaType !== null) string(ref.mediaType, 'image.mediaType', { optional: true, max: 256 });
    if (ref.mediaType && !/^image\/[a-z0-9.+-]+$/i.test(ref.mediaType)) fail('image.mediaType invalid');
    string(ref.error, 'image.error', { optional: true, max: 2048 });
    if (ref.size !== undefined) integer(ref.size, 'image.size');
    return { ...ref };
  });
  const [composer, imageCodec] = await loadCodecs();
  let authoring, prompt, usedImages, transportParts;
  if (own(input, 'parts')) {
    if (!Array.isArray(input.parts) || input.parts.length > LIMITS.parts) fail('parts invalid');
    const usedPasteIds = new Set();
    const usedImageIds = new Set();
    const imageOrder = [];
    const parts = input.parts.map(part => {
      object(part, part?.kind === 'text' ? ['kind', 'text'] : part?.kind === 'paste' ? ['kind', 'chipId'] : ['kind', 'imageId'], 'part');
      if (part.kind === 'text') string(part.text, 'part.text');
      else if (part.kind === 'paste') {
        if (!chips.some(chip => chip.id === part.chipId && chip.kind === 'paste') || usedPasteIds.has(part.chipId)) fail('paste part identity invalid');
        usedPasteIds.add(part.chipId);
      } else if (part.kind === 'image') {
        if (!imageIds.has(part.imageId)) fail('image part identity invalid');
        usedImageIds.add(part.imageId);
        imageOrder.push(part.imageId);
      } else fail('part.kind unsupported');
      return { ...part };
    });
    if (chips.some(chip => chip.kind === 'paste' && !usedPasteIds.has(chip.id))) fail('unreferenced paste chip');
    if (images.some(ref => !usedImageIds.has(ref.id))) fail('unreferenced image');
    usedImages = imageOrder.map(id => images.find(ref => ref.id === id));
    authoring = { version: 1, parts, chips, imagePaths: images };
    transportParts = parts;
  } else {
    string(input.text, 'authoring.text');
    if (chips.some(chip => chip.kind === 'paste') && composer.getUnboundPasteMarkers(input.text, chips).length) fail('stale or unbound paste marker; use portable parts when editing');
    const inspection = imageCodec.inspectPromptImageAttachments(input.text, images);
    if (inspection.blocking) fail(inspection.firstBlocking.error);
    const ids = imageCodec.collectPromptImageRefIds(input.text);
    if (images.some(ref => !ids.has(ref.id))) fail('unreferenced image');
    usedImages = imageCodec.collectPromptImageOccurrences(input.text).map(({ id }) => images.find(ref => ref.id === id));
    authoring = { version: 1, text: input.text, chips, imagePaths: images };
    const pasteRanges = composer.getPasteMarkerHighlightRanges(input.text, chips);
    const ranges = [...pasteRanges.map(range => ({ ...range, part: { kind: 'paste', chipId: range.id } })),
      ...imageCodec.collectPromptImageOccurrences(input.text).map(range => ({ ...range, part: { kind: 'image', imageId: range.id } }))]
      .sort((a, b) => a.start - b.start);
    transportParts = [];
    const anchored = new Set(pasteRanges.map(range => range.id));
    for (const chip of chips.filter(chip => chip.kind === 'paste' && !anchored.has(chip.id))) {
      if (transportParts.length) transportParts.push({ kind: 'text', text: '\n\n' });
      transportParts.push({ kind: 'paste', chipId: chip.id });
    }
    if (transportParts.length && input.text) transportParts.push({ kind: 'text', text: '\n\n' });
    let cursor = 0;
    for (const range of ranges) {
      if (range.start < cursor) fail('overlapping authoring references');
      if (range.start > cursor) transportParts.push({ kind: 'text', text: input.text.slice(cursor, range.start) });
      transportParts.push(range.part); cursor = range.end;
    }
    if (cursor < input.text.length) transportParts.push({ kind: 'text', text: input.text.slice(cursor) });
  }
  const imageRanges = [];
  let bodyStart = 0;
  prompt = composer.serializeComposerDraft({ parts: transportParts, chips,
    renderImage: id => imageCodec.buildPromptImagePayload(`[Image #${id}]`, images),
    onBody: body => { bodyStart = body.start; },
    onImageRange: range => {
      const ref = images.find(ref => ref.id === range.id);
      if (ref.path && ref.availability !== 'missing') imageRanges.push({ start: range.start, end: range.end, path: ref.path });
    },
  });
  if (imageRanges.length > LIMITS.images) fail('image occurrence limit exceeded', 413);
  if (Buffer.byteLength(JSON.stringify(authoring), 'utf8') > LIMITS.bytes || Buffer.byteLength(prompt, 'utf8') > LIMITS.bytes) fail('size limit exceeded', 413);
  const trimmedPrefix = prompt.length - prompt.trimStart().length;
  prompt = prompt.trim(); // Same outer normalization as desktop/public Send.
  if (!prompt) fail('empty message');
  const normalizedBodyStart = Math.min(prompt.length, Math.max(0, bodyStart - trimmedPrefix));
  return {
    prompt, authoringSnapshot: { ...authoring,
      editorText: authoring.parts ? composer.composerTextFromParts(authoring.parts, chips) : authoring.text },
    // Authoring IDs stay editable/client-owned. Native image slots on the new
    // send are numbered in transport occurrence order, including repetitions.
    // A declared missing image is an imageError text part, not a native slot.
    presentationSnapshot: { promptChips: chips.filter(chip => chip.kind === 'prompt'), imagePaths: usedImages
      .filter(ref => ref.path && ref.availability !== 'missing')
      .map((ref, index) => ({ ...ref, id: index + 1 })),
      authoringTransport: { sourceHash: hash(prompt), bodyLength: prompt.length - normalizedBodyStart,
        bodyHash: hash(prompt.slice(normalizedBodyStart)),
        imageRanges: imageRanges.map(range => ({ ...range, start: range.start - trimmedPrefix, end: range.end - trimmedPrefix })) },
    },
    contextFiles: chips.filter(chip => chip.attachmentKind === 'file').map(chip => ({
      label: chip.label, path: chip.filePath, role: chip.role, sha256: chip.sha256, bytes: chip.bytes,
    })),
  };
}

// Deferred context owns the prefix, not the user's body. Carry exact image
// offsets through that existing transformation only when the body hash proves
// it stayed intact. No search for a similar marker/path is an identity fallback.
function bindStructuredAuthoringPresentation(snapshot, originalPrompt, preparedPrompt) {
  const plan = snapshot?.authoringTransport;
  if (!plan) return snapshot;
  if (plan.sourceHash !== hash(originalPrompt) || preparedPrompt.length < plan.bodyLength
    || hash(preparedPrompt.slice(preparedPrompt.length - plan.bodyLength)) !== plan.bodyHash) fail('prepared context changed authoring body');
  const delta = preparedPrompt.length - originalPrompt.length;
  return { ...snapshot, authoringTransport: { sourceHash: hash(preparedPrompt),
    imageRanges: plan.imageRanges.map(range => ({ ...range, start: range.start + delta, end: range.end + delta })) } };
}

function validateStructuredSendEnvelope(body) {
  for (const key of ['prompt', 'text', 'prompts', 'promptRefs', 'files', 'contextFiles', 'attachments', 'presentationSnapshot']) {
    const value = body[key];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    fail('authoring cannot be combined with ' + key);
  }
  const provider = body.expectedToolType;
  const target = typeof body.expectedSessionId === 'string' && body.expectedSessionId.trim();
  // Claude's fully-deleted history has no SID to Resume. Explicit null uses
  // the existing first-send target/launch proof; it is not an invented UUID.
  const freshClaude = provider === 'claude' && body.expectedSessionId === null;
  if (!['codex', 'claude'].includes(provider) || (!target && !freshClaude)) fail('expectedSessionId/expectedToolType required');
  if (body.expectedBinding != null || body.ownerToken != null) {
    if (body.expectedBinding !== 'none' || !freshClaude || typeof body.ownerToken !== 'string'
      || !/^[A-Za-z0-9_-]{1,160}$/.test(body.ownerToken)) fail('expectedBinding none requires explicit null Claude SID and ownerToken');
  }
}

module.exports = { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation, STRUCTURED_AUTHORING_LIMITS: LIMITS };
