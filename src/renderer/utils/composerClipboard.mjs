import {
  buildPasteChipMarker,
  getPasteMarkerHighlightRanges,
  normalizeComposerChips,
  shouldCreatePasteChip,
} from './composerChips.mjs';

const IMAGE_MARKER_SOURCE = String.raw`(?<!\\)\[Image\s+#?(\d+)\]`;
const PASTE_MARKER_SOURCE = String.raw`\[Pasted Content ([0-9   ]+) chars\]`;
const PORTABLE_IMAGE_PATH_SOURCE = String.raw`\[imagePath:\s*([^\]\r\n]+?)\s*\]`;

const createImageMarkerRegex = () => new RegExp(IMAGE_MARKER_SOURCE, 'gi');
const createPasteMarkerRegex = () => new RegExp(PASTE_MARKER_SOURCE, 'g');
const createPortableImagePathRegex = () => new RegExp(PORTABLE_IMAGE_PATH_SOURCE, 'gi');

function clampSelection(value, selectionStart, selectionEnd) {
  const start = Math.max(0, Math.min(Number(selectionStart) || 0, value.length));
  const end = Math.max(start, Math.min(Number(selectionEnd) || 0, value.length));
  return { start, end };
}

function availableImageRefById(imagePaths = []) {
  return new Map(
    (Array.isArray(imagePaths) ? imagePaths : [])
      .filter((ref) => ref?.path && ref.availability !== 'missing')
      .map((ref) => [Number(ref.id), ref]),
  );
}

/**
 * Builds the single plain-text clipboard representation shared by the History
 * composer and Run after editor.
 *
 * Source ranges are classified before any replacement. This is important:
 * the body hidden behind a Pasted Content marker is opaque user text. A
 * literal `[Image #1]` inside that body must never consume an attachment from
 * the visible draft merely because expanding the paste happened first.
 */
export function buildComposerClipboardText({
  text = '',
  selectionStart = 0,
  selectionEnd = 0,
  chips = [],
  imagePaths = [],
} = {}) {
  const value = String(text || '');
  const { start, end } = clampSelection(value, selectionStart, selectionEnd);
  if (start === end) {
    return {
      text: '',
      handled: false,
      imageResolved: 0,
      imageMissing: 0,
      imagePartial: 0,
      pasteExpanded: 0,
      pasteMissing: 0,
    };
  }

  const replacements = [];
  const refsById = availableImageRefById(imagePaths);

  let imageResolved = 0;
  let imageMissing = 0;
  let imagePartial = 0;
  const imageRe = createImageMarkerRegex();
  let imageMatch;
  while ((imageMatch = imageRe.exec(value)) !== null) {
    const from = imageMatch.index;
    const to = from + imageMatch[0].length;
    if (from >= start && to <= end) {
      const ref = refsById.get(Number(imageMatch[1]));
      if (ref?.path) {
        imageResolved += 1;
        replacements.push({ from, to, text: `[imagePath: ${ref.path}]` });
      } else {
        imageMissing += 1;
        replacements.push({ from, to, text: '[imageError]' });
      }
      continue;
    }
    if (from < end && to > start) {
      imagePartial += 1;
      replacements.push({
        from: Math.max(from, start),
        to: Math.min(to, end),
        text: '[imageError]',
      });
    }
  }

  const normalizedChips = normalizeComposerChips(chips);
  const pasteRanges = getPasteMarkerHighlightRanges(value, normalizedChips);
  const pasteByRange = new Map(
    pasteRanges.map((range) => [`${range.start}:${range.end}`, range.id]),
  );
  const chipById = new Map(normalizedChips.map((chip) => [chip.id, chip]));
  let pasteExpanded = 0;
  let pasteMissing = 0;
  const pasteRe = createPasteMarkerRegex();
  let pasteMatch;
  while ((pasteMatch = pasteRe.exec(value)) !== null) {
    const from = pasteMatch.index;
    const to = from + pasteMatch[0].length;
    // A partial paste marker is ordinary visible text. Unlike an image slot it
    // cannot bind to a foreign hidden body, so guessing or inventing an error
    // would be more surprising than copying the selected characters literally.
    if (from < start || to > end) continue;
    const chipId = pasteByRange.get(`${from}:${to}`);
    const chip = chipId ? chipById.get(chipId) : null;
    if (chip?.kind === 'paste') {
      pasteExpanded += 1;
      replacements.push({ from, to, text: chip.text });
    } else {
      pasteMissing += 1;
      replacements.push({ from, to, text: '[pasteError]' });
    }
  }

  if (replacements.length === 0) {
    return {
      text: value.slice(start, end),
      handled: false,
      imageResolved,
      imageMissing,
      imagePartial,
      pasteExpanded,
      pasteMissing,
    };
  }

  replacements.sort((left, right) => left.from - right.from || left.to - right.to);
  let output = '';
  let cursor = start;
  for (const replacement of replacements) {
    if (replacement.from < cursor) continue;
    if (replacement.from > cursor) output += value.slice(cursor, replacement.from);
    output += replacement.text;
    cursor = replacement.to;
  }
  if (cursor < end) output += value.slice(cursor, end);

  return {
    text: output,
    handled: true,
    imageResolved,
    imageMissing,
    imagePartial,
    pasteExpanded,
    pasteMissing,
  };
}

/**
 * Parses the inter-application image transport without assigning local image
 * ids. Relative paths deliberately remain ordinary text: their base belongs
 * to the source editor and cannot be inferred safely at the destination.
 */
export function collectPortableImagePathMarkers(text = '') {
  const value = String(text || '');
  const markers = [];
  const re = createPortableImagePathRegex();
  let match;
  while ((match = re.exec(value)) !== null) {
    const filePath = String(match[1] || '').trim();
    if (!filePath.startsWith('/')) continue;
    markers.push({
      id: markers.length + 1,
      start: match.index,
      end: match.index + match[0].length,
      path: filePath,
      marker: match[0],
    });
  }
  return markers;
}

/**
 * Rewrites portable image markers after main-process materialization. Returned
 * refs keep the marker ids, so insertPromptImageAttachments can remap them
 * atomically against the destination draft's existing slots.
 */
export function buildPortableImageImportSnapshot(text = '', materializedRefs = []) {
  const value = String(text || '');
  const markers = collectPortableImagePathMarkers(value);
  if (markers.length === 0) {
    return { text: value, imagePaths: [], imported: 0, missing: 0 };
  }
  const refsById = new Map(
    (Array.isArray(materializedRefs) ? materializedRefs : [])
      .map((ref) => [Number(ref?.id), ref]),
  );
  const refs = [];
  let imported = 0;
  let missing = 0;
  let output = '';
  let cursor = 0;
  for (const marker of markers) {
    output += value.slice(cursor, marker.start);
    const ref = refsById.get(marker.id);
    if (ref?.path && ref.availability !== 'missing') {
      imported += 1;
      refs.push({ ...ref, id: marker.id });
      output += `[Image #${marker.id}]`;
    } else {
      missing += 1;
      output += `[imageError: portable_image_path_unavailable #${marker.id}]`;
    }
    cursor = marker.end;
  }
  output += value.slice(cursor);
  return { text: output, imagePaths: refs, imported, missing };
}

/**
 * Keeps imported image slots outside opaque large-paste bodies. A long plain
 * segment becomes the same Pasted Content chip the composer already uses;
 * image/error tokens stay visible at their exact positions. Short surrounding
 * text remains directly editable.
 */
export function collapsePortableImageImportSnapshot({
  text = '',
  imagePaths = [],
  threshold,
  createChipId = (_text, index) => `portable-paste-${Date.now().toString(36)}-${index}`,
  createdAt = Date.now(),
} = {}) {
  const value = String(text || '');
  const tokenRe = /(?<!\\)\[Image\s+#?\d+\]|\[imageError:\s*[^\]\r\n]+\]/gi;
  const chips = [];
  let output = '';
  let cursor = 0;
  let segmentIndex = 0;
  const appendPlain = (plain) => {
    if (!plain) return;
    if (!shouldCreatePasteChip(plain, threshold)) {
      output += plain;
      return;
    }
    const chip = {
      id: String(createChipId(plain, segmentIndex++) || '').trim()
        || `portable-paste-${Date.now().toString(36)}-${segmentIndex}`,
      kind: 'paste',
      text: plain,
      label: 'Вставка',
      createdAt,
    };
    chips.push(chip);
    output += buildPasteChipMarker(chip);
  };

  let match;
  while ((match = tokenRe.exec(value)) !== null) {
    appendPlain(value.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }
  appendPlain(value.slice(cursor));
  return {
    text: output,
    chips,
    imagePaths: Array.isArray(imagePaths) ? imagePaths : [],
  };
}
