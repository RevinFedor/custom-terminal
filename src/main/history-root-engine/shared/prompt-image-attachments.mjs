const VALID_IMAGE_MARKER_SOURCE = String.raw`(?<!\\)\[Image\s+#?(\d+)\]`;
const IMAGE_ERROR_MARKER_SOURCE = String.raw`\[imageError(?:\s*:\s*[^\]\r\n]+)?\]`;

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

function createImageErrorMarkerRegex() {
  return new RegExp(IMAGE_ERROR_MARKER_SOURCE, 'gi');
}

export function getPromptImageErrorTokenLabel(marker = '') {
  const value = String(marker || '');
  if (!/^\[imageError\b/i.test(value)) return value;
  const rawId = /#(\d+)/.exec(value);
  return rawId ? `imageError #${rawId[1]}` : 'imageError';
}

/**
 * Presentation ranges for transient/import failures shared by History and
 * Run After. The full serialized imageError remains in the document so copy,
 * diagnostics, undo and transport keep the exact reason/path. Only its idle
 * presentation is replaced by a compact atomic token; clicking that token
 * lets ComposerEditor reveal the original source for explicit editing.
 */
export function getPromptImageStatusTokenRanges(text = '') {
  const value = String(text || '');
  const statusPattern = /\[Image saving…\]|\[imagePath:\s*[^\]\r\n]+\]|\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/gi;
  const result = [];
  let match;
  while ((match = statusPattern.exec(value)) !== null) {
    const marker = match[0];
    const explicitError = /^\[imageError\b/i.test(marker);
    result.push({
      start: match.index,
      end: match.index + marker.length,
      kind: marker === '[Image saving…]' ? 'pending' : 'error',
      label: explicitError ? getPromptImageErrorTokenLabel(marker) : marker,
      replace: explicitError,
    });
  }
  return result;
}

function promptImageIssueExcerpt(value, start, end, radius = 36) {
  const text = String(value || '');
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || from);
  const excerptStart = Math.max(0, from - radius);
  const excerptEnd = Math.min(text.length, to + radius);
  return (excerptStart > 0 ? '…' : '')
    + text.slice(excerptStart, excerptEnd).replace(/\s+/g, ' ').trim()
    + (excerptEnd < text.length ? '…' : '');
}

/**
 * Separates a known attachment whose bytes are unavailable from an ambiguous
 * authoring marker. The former can travel as an explicit imageError segment;
 * the latter must remain fail-closed because no exact attachment identity can
 * be proven.
 *
 * @returns {{
 *   issues: Array<{
 *     kind: 'unavailable' | 'error-marker' | 'unbound' | 'malformed',
 *     blocking: boolean,
 *     id: number | null,
 *     marker: string,
 *     path: string | null,
 *     error: string | null,
 *     start: number,
 *     end: number,
 *     excerpt: string,
 *   }>,
 *   blocking: boolean,
 *   unavailable: boolean,
 *   firstBlocking: object | null,
 *   firstUnavailable: object | null,
 * }}
 */
export function inspectPromptImageAttachments(text = '', imagePaths = []) {
  const value = String(text || '');
  const refsById = new Map((imagePaths || []).map((ref) => [Number(ref?.id), ref]));
  const issues = [];
  const unknownIds = new Set();

  const markerRe = createValidImageMarkerRegex();
  let match;
  while ((match = markerRe.exec(value)) !== null) {
    const id = Number(match[1]);
    const ref = refsById.get(id);
    if (!ref) {
      unknownIds.add(id);
      issues.push({
        kind: 'unbound',
        blocking: true,
        id,
        marker: match[0],
        path: null,
        error: 'attachment_identity_missing',
        start: match.index,
        end: match.index + match[0].length,
        excerpt: promptImageIssueExcerpt(value, match.index, match.index + match[0].length),
      });
      continue;
    }
    if (!ref.path || ref.availability === 'missing') {
      issues.push({
        kind: 'unavailable',
        blocking: false,
        id,
        marker: match[0],
        path: typeof ref.path === 'string' && ref.path.trim() ? ref.path.trim() : null,
        error: ref.error || (!ref.path ? 'image_path_missing' : 'image_unavailable'),
        start: match.index,
        end: match.index + match[0].length,
        excerpt: promptImageIssueExcerpt(value, match.index, match.index + match[0].length),
      });
    }
  }

  const errorRe = createImageErrorMarkerRegex();
  while ((match = errorRe.exec(value)) !== null) {
    const rawId = /#(\d+)/.exec(match[0]);
    const rawPath = /\bpath=([^\]\r\n]+?)\s*\]$/i.exec(match[0]);
    issues.push({
      kind: 'error-marker',
      blocking: false,
      id: rawId ? Number(rawId[1]) : null,
      marker: match[0],
      path: rawPath?.[1]?.trim() || null,
      error: 'explicit_image_error',
      start: match.index,
      end: match.index + match[0].length,
      excerpt: promptImageIssueExcerpt(value, match.index, match.index + match[0].length),
    });
  }

  // Unknown complete markers were already reported precisely above. A second
  // generic issue would only duplicate the warning. Any remaining malformed
  // shape is a cut/missing bracket or an unnumbered authoring marker.
  if (hasMalformedPromptImageMarker(value, imagePaths) && unknownIds.size === 0) {
    const masked = value
      .replace(createValidImageMarkerRegex(), (marker) => ' '.repeat(marker.length))
      .replace(createImageErrorMarkerRegex(), (marker) => ' '.repeat(marker.length));
    const malformedMatch = /\[\s*Image\b[^\r\n]*?(?:\]|$)|(?:^|[^\[])\bImage\s+#?\d+\s*\]/i.exec(masked);
    const start = malformedMatch?.index ?? Math.max(0, masked.search(/\bImage\b/i));
    const marker = malformedMatch?.[0]?.trim() || '[Image marker]';
    const end = Math.min(value.length, start + Math.max(1, malformedMatch?.[0]?.length || marker.length));
    issues.push({
      kind: 'malformed',
      blocking: true,
      id: null,
      marker,
      path: null,
      error: 'image_marker_malformed',
      start,
      end,
      excerpt: promptImageIssueExcerpt(value, start, end),
    });
  }

  const firstBlocking = issues.find((issue) => issue.blocking) || null;
  const firstUnavailable = issues.find((issue) => !issue.blocking) || null;
  return {
    issues,
    blocking: !!firstBlocking,
    unavailable: !!firstUnavailable,
    firstBlocking,
    firstUnavailable,
  };
}

export function collectPromptImageRefIds(text) {
  return new Set(collectPromptImageOccurrences(text).map(item => item.id));
}

export function collectPromptImageOccurrences(text) {
  const occurrences = [];
  const re = createValidImageMarkerRegex();
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const id = Number(match[1]);
    if (Number.isFinite(id)) occurrences.push({ id, start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
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
  if (/\[imageError(?:\s*:\s*[^\]\r\n]+)?\]/i.test(String(text || ''))) return 'missing';
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

/**
 * Keeps a textarea selection attached to the same logical text after the
 * temporary image-saving marker is replaced with the durable image marker.
 */
export function remapPromptImageSelectionAfterReplacement({
  selectionStart = 0,
  selectionEnd = selectionStart,
  replacedStart = 0,
  replacedEnd = replacedStart,
  insertionCaret = replacedStart,
} = {}) {
  const from = Math.max(0, Number(replacedStart) || 0);
  const to = Math.max(from, Number(replacedEnd) || from);
  const caret = Math.max(from, Number(insertionCaret) || from);
  const delta = caret - to;
  const adjust = (position) => {
    const value = Math.max(0, Number(position) || 0);
    if (value >= to) return value + delta;
    if (value > from) return caret;
    return value;
  };

  return {
    start: adjust(selectionStart),
    end: adjust(selectionEnd),
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

/**
 * Classifies a clipboard selection that overlaps image markers.
 *
 * Copying is per-character, so a user can easily grab `[Image #1` without its
 * closing bracket. Such a fragment looks like an attachment but references
 * nothing: pasted back it either does nothing or, worse, collides with an
 * unrelated ref id. Whole markers are kept verbatim (the paste target can
 * re-attach them); partial ones are replaced by an explicit error marker so the
 * damage is visible in the pasted text instead of silently traveling as prose.
 *
 * @returns {{ text: string, partial: number, whole: number }}
 */
export function buildImageAwareClipboardText(text = '', selectionStart = 0, selectionEnd = 0) {
  const value = String(text || '');
  const start = Math.max(0, Math.min(Number(selectionStart) || 0, value.length));
  const end = Math.max(start, Math.min(Number(selectionEnd) || 0, value.length));
  const selected = value.slice(start, end);
  if (!selected) return { text: '', partial: 0, whole: 0 };

  // Markers fully inside the selection are fine as-is.
  const wholeInSelection = [];
  const re = createValidImageMarkerRegex();
  let match;
  while ((match = re.exec(value)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (from >= start && to <= end) {
      wholeInSelection.push({ from, to });
      continue;
    }
    // Any other overlap means the selection cut through this marker.
    if (from < end && to > start) {
      wholeInSelection.push({ from, to, partial: true });
    }
  }

  const partials = wholeInSelection.filter((entry) => entry.partial);
  if (partials.length === 0) {
    return { text: selected, partial: 0, whole: wholeInSelection.length };
  }

  // Rebuild the selection, replacing every cut fragment with an error marker.
  let out = '';
  let cursor = start;
  for (const entry of partials) {
    const clippedFrom = Math.max(entry.from, start);
    const clippedTo = Math.min(entry.to, end);
    if (clippedFrom > cursor) out += value.slice(cursor, clippedFrom);
    out += '[imageError]';
    cursor = clippedTo;
  }
  if (cursor < end) out += value.slice(cursor, end);
  return {
    text: out,
    partial: partials.length,
    whole: wholeInSelection.length - partials.length,
  };
}
