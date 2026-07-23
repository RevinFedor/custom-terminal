const VALID_IMAGE_MARKER_SOURCE = String.raw`(?<!\\)\[Image\s+#?(\d+)\]`;

/**
 * Common structural shape shared by History and Run After. Individual stores
 * may require more metadata, but the insertion helper only owns identity/path.
 *
 * @typedef {{
 *   id: number,
 *   path: string,
 *   assetId?: string,
 *   mediaType?: string | null,
 *   size?: number,
 *   availability?: 'available' | 'missing',
 *   error?: string,
 * }} PromptImageAttachmentRef
 */

function createValidImageMarkerRegex() {
  return new RegExp(VALID_IMAGE_MARKER_SOURCE, 'gi');
}

export function collectPromptImageRefIds(text) {
  const ids = new Set();
  const re = createValidImageMarkerRegex();
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const id = Number(match[1]);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

export function getPromptImageMarkerHighlightRanges(text, imagePaths = []) {
  const refsById = new Map((imagePaths || []).map((ref) => [Number(ref?.id), ref]));
  const ranges = [];
  const re = createValidImageMarkerRegex();
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const id = Number(match[1]);
    const ref = refsById.get(id);
    if (!ref?.path || ref.availability === 'missing') continue;
    ranges.push({ start: match.index, end: match.index + match[0].length, id });
  }
  return ranges;
}

export function hasMalformedPromptImageMarker(text, imagePaths = []) {
  const value = String(text || '');
  const refs = imagePaths || [];
  const knownIds = new Set(refs.map((ref) => Number(ref?.id)));
  const validIds = collectPromptImageRefIds(value);
  if (Array.from(validIds).some((id) => !knownIds.has(id))) return true;

  const withoutValidMarkers = value.replace(createValidImageMarkerRegex(), '');
  if (/\[\s*Image\b/i.test(withoutValidMarkers)) return true;
  if (/(?:^|[^\[])\bImage\s+#?\d+\s*\]/i.test(withoutValidMarkers)) return true;
  return refs.some((ref) => {
    const id = Number(ref?.id);
    if (validIds.has(id)) return false;
    return new RegExp(String.raw`\bImage\s+#?${id}\b`, 'i').test(withoutValidMarkers);
  });
}

export function retainPromptImageRefsForText(text, imagePaths = []) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) return [];
  if (hasMalformedPromptImageMarker(text, imagePaths)) return imagePaths;
  const ids = collectPromptImageRefIds(text);
  if (ids.size === 0) return [];
  return imagePaths.filter((ref) => ids.has(Number(ref?.id)));
}

export function haveSamePromptImageRefs(left = [], right = []) {
  const fingerprint = (refs) => (Array.isArray(refs) ? refs : [])
    .map((ref) => [
      Number(ref?.id) || 0,
      String(ref?.assetId || ''),
      String(ref?.path || ''),
    ])
    .sort((a, b) => a[0] - b[0])
    .map((parts) => parts.join('\u0000'));
  const leftFingerprint = fingerprint(left);
  const rightFingerprint = fingerprint(right);
  return leftFingerprint.length === rightFingerprint.length
    && leftFingerprint.every((value, index) => value === rightFingerprint[index]);
}

export function buildPromptImagePayload(text, imagePaths = [], {
  missingCode = 'queued_image_path_unavailable',
} = {}) {
  const byId = new Map();
  for (const ref of imagePaths || []) byId.set(Number(ref?.id), ref);

  return String(text || '')
    .replace(createValidImageMarkerRegex(), (_match, rawId) => {
      const id = Number(rawId);
      const resolved = byId.get(id);
      if (!resolved?.path || resolved.availability === 'missing') {
        return `[imageError: ${missingCode} #${rawId}]`;
      }
      return `[imagePath: ${resolved.path}]`;
    })
    .replace(/\[Image\s*\]/gi, `[imageError: ${missingCode} #unknown]`);
}

export function getPromptImageAttachmentState({
  text = '',
  images = 0,
  imagePaths = [],
  attachmentState,
} = {}) {
  if (attachmentState === 'materializing') return 'materializing';
  if (attachmentState === 'missing') return 'missing';
  if (images > 0 && /\[imageError:\s*[^\]\r\n]+\]/i.test(String(text || ''))) return 'missing';
  if (hasMalformedPromptImageMarker(text, imagePaths)) return 'missing';
  if (/\[Image\s*\]/i.test(String(text || ''))) return 'missing';
  const ids = collectPromptImageRefIds(text);
  if (ids.size === 0) return 'ready';
  const byId = new Map((imagePaths || []).map((ref) => [Number(ref?.id), ref]));
  for (const id of ids) {
    const ref = byId.get(id);
    if (!ref?.path || ref.availability === 'missing') return 'missing';
  }
  return attachmentState === 'missing' ? 'missing' : 'ready';
}

/**
 * @param {{
 *   text?: string,
 *   imagePaths?: PromptImageAttachmentRef[],
 *   start?: number,
 *   end?: number,
 *   insertedText?: string,
 *   insertedImagePaths?: PromptImageAttachmentRef[],
 * }} [options]
 */
export function insertPromptImageAttachments({
  text = '',
  imagePaths = [],
  start,
  end,
  insertedText = '',
  insertedImagePaths = [],
} = {}) {
  const currentText = String(text || '');
  const from = Math.max(0, Math.min(Number.isFinite(Number(start)) ? Number(start) : currentText.length, currentText.length));
  const to = Math.max(from, Math.min(Number.isFinite(Number(end)) ? Number(end) : from, currentText.length));
  const currentRefs = retainPromptImageRefsForText(currentText, imagePaths || []);
  const sourceById = new Map((insertedImagePaths || []).map((ref) => [Number(ref?.id), ref]));

  let maxId = 0;
  for (const ref of currentRefs) maxId = Math.max(maxId, Number(ref?.id) || 0);
  for (const id of collectPromptImageRefIds(currentText)) maxId = Math.max(maxId, id);

  const remappedBySourceId = new Map();
  const addedRefs = [];
  const missingSourceIds = [];
  const remappedText = String(insertedText || '').replace(createValidImageMarkerRegex(), (marker, rawId) => {
    const sourceId = Number(rawId);
    const sourceRef = sourceById.get(sourceId);
    if (!sourceRef?.path) {
      if (!missingSourceIds.includes(sourceId)) missingSourceIds.push(sourceId);
      return marker;
    }
    let remapped = remappedBySourceId.get(sourceId);
    if (!remapped) {
      remapped = {
        ...sourceRef,
        id: ++maxId,
      };
      remappedBySourceId.set(sourceId, remapped);
      addedRefs.push(remapped);
    }
    return `[Image #${remapped.id}]`;
  });

  const nextText = currentText.slice(0, from) + remappedText + currentText.slice(to);
  const nextRefs = retainPromptImageRefsForText(nextText, [...currentRefs, ...addedRefs]);
  return {
    text: nextText,
    imagePaths: nextRefs,
    caret: from + remappedText.length,
    addedImagePaths: addedRefs,
    missingSourceIds,
  };
}

export function normalizePromptImageIdentity(text) {
  return String(text || '')
    .replace(/\[imagePath:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[imageError:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[Image(?:\s+#?\d+)?\]/gi, ' [Image] ')
    .replace(/\s+/g, ' ')
    .trim();
}
