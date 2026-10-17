import {
  buildPasteChipMarker,
  buildHistoryComposerPresentationParts,
  getPasteMarkerHighlightRanges,
  insertComposerSnapshotAtSelection,
  normalizeComposerChips,
  serializeComposerDraft,
  shouldCreatePasteChip,
} from './composerChips.mjs';

export const NOTED_COMPOSER_SNAPSHOT_FLAVOR = 'application/x-noted-terminal-composer-snapshot';

const IMAGE_MARKER_SOURCE = String.raw`(?<!\\)\[Image\s+#?(\d+)\]`;
const PASTE_MARKER_SOURCE = String.raw`\[Pasted Content ([0-9   ]+) chars\]`;
const PORTABLE_IMAGE_PATH_SOURCE = String.raw`\[imagePath:\s*([^\]\r\n]+?)\s*\]`;

const createImageMarkerRegex = () => new RegExp(IMAGE_MARKER_SOURCE, 'gi');
const createPasteMarkerRegex = () => new RegExp(PASTE_MARKER_SOURCE, 'g');
const createPortableImagePathRegex = () => new RegExp(PORTABLE_IMAGE_PATH_SOURCE, 'gi');

const promptPayload = (chip) => serializeComposerDraft({ chips: [chip] });
const promptReplayIdentity = (chip) => {
  if (chip.contextUpdateId) return ['context', chip.contextUpdateId];
  if (chip.attachmentKind === 'file') return ['file', chip.filePath, chip.role || 'source'];
  if (chip.sourceKey || chip.replaySourceKey) return ['source', chip.sourceKey || chip.replaySourceKey];
  return ['chip', chip.replayChipId || chip.id];
};
const promptReplayKey = (chip) => JSON.stringify([promptReplayIdentity(chip), promptPayload(chip)]);

/** Clipboard replay is not picker upsert: keep the current revision and add a
 * different one, but do not attach an exact already-owned prompt a second time.
 * Inline paste chips retain their positional, intentionally repeatable meaning. */
export function insertHistoryClipboardSnapshotAtSelection({
  chips = [], insertedChips = [], pendingContextUpdates = [], dismissedContextUpdateIds = [], ...options
} = {}) {
  const current = normalizeComposerChips(chips);
  const seen = new Set(current.filter(chip => chip.kind === 'prompt').map(promptReplayKey));
  const sourceKeys = new Set(current.filter(chip => chip.kind === 'prompt').map(chip => chip.sourceKey).filter(Boolean));
  const ids = new Set(current.map(chip => chip.id));
  const dismissed = new Set(dismissedContextUpdateIds);
  const pending = pendingContextUpdates.filter(update => update.status === 'pending'
    && !(update.memberIds?.length ? update.memberIds : [update.id]).every(id => dismissed.has(id)));
  const replay = normalizeComposerChips(insertedChips).flatMap(chip => {
    if (chip.kind !== 'prompt') return [chip];
    const key = promptReplayKey(chip);
    if (seen.has(key)) return [];
    if (chip.contextUpdateId && pending.some(update => (
      [update.id, ...(update.memberIds || [])].includes(chip.contextUpdateId)
      && update.text === chip.text && update.title === chip.label
    ))) return [];
    seen.add(key);
    const next = { ...chip };
    // The picker codec replaces matching sourceKeys. Preserve both revisions
    // here, retaining provenance for a subsequent replay of the same revision.
    if (next.sourceKey && sourceKeys.has(next.sourceKey)) {
      next.replaySourceKey = next.sourceKey;
      delete next.sourceKey;
    }
    if (next.sourceKey) sourceKeys.add(next.sourceKey);
    if (ids.has(next.id)) next.replayChipId = next.replayChipId || next.id;
    ids.add(next.id);
    return [next];
  });
  return insertComposerSnapshotAtSelection({ ...options, chips: current, insertedChips: replay });
}

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

/** Reverse the durable History presentation into the authoring snapshot that
 * produced it. Prompt chips stay detached; paste bodies return to exact inline
 * markers; proven image slots keep their managed refs and order. */
export function buildHistoryMessageComposerSnapshot({
  text = '',
  chips = [],
  imagePaths = [],
} = {}) {
  const presentation = buildHistoryComposerPresentationParts({ text, chips, imagePaths });
  const parts = Array.isArray(presentation.parts)
    ? presentation.parts.map((part) => ({ ...part }))
    : [];
  const sourcePromptChips = normalizeComposerChips(chips)
    .filter((chip) => chip.kind === 'prompt');
  const promptChips = [];
  const usedSourcePrompts = new Set();
  const appendPromptChip = (presented) => {
    // Deferred wrappers need not have sidecars. Do not let their prefix shift
    // the attached prompt's identity or borrow metadata from an equal body.
    const source = sourcePromptChips.find(chip => !usedSourcePrompts.has(chip)
      && promptPayload(chip) === promptPayload(presented));
    if (source) usedSourcePrompts.add(source);
    promptChips.push(source || presented);
  };
  let cursor = 0;

  // Prompt wrappers are a transport prefix. Remove exactly the one separator
  // after each leading prompt, preserving any additional user whitespace.
  while (cursor < parts.length && parts[cursor]?.kind === 'prompt') {
    appendPromptChip(parts[cursor].chip);
    cursor += 1;
    if (parts[cursor]?.kind !== 'text') continue;
    const original = String(parts[cursor].text || '');
    const stripped = original.replace(/^(?:\r?\n){2}/, '');
    if (stripped) {
      parts[cursor] = { ...parts[cursor], text: stripped };
      break;
    }
    cursor += 1;
  }

  let editableText = '';
  const pasteChips = [];
  const refsById = new Map();
  let pasteIndex = 0;
  for (const part of parts.slice(cursor)) {
    if (part?.kind === 'text') {
      editableText += String(part.text || '');
      continue;
    }
    if (part?.kind === 'prompt') {
      appendPromptChip(part.chip);
      continue;
    }
    if (part?.kind === 'paste') {
      const pasteText = String(part.text || '');
      const paste = {
        id: `history-copy-paste-${pasteIndex++}-${pasteText.length}`,
        kind: 'paste',
        label: 'Вставка',
        text: pasteText,
        ...(part.messageReference ? { messageReference: part.messageReference } : {}),
      };
      pasteChips.push(paste);
      editableText += buildPasteChipMarker(paste);
      continue;
    }
    if (part?.kind === 'image' && part.ref?.path) {
      const id = Number(part.ref.id || part.id);
      if (!Number.isInteger(id) || id < 1) continue;
      if (!refsById.has(id)) refsById.set(id, { ...part.ref, id });
      editableText += `[Image #${id}]`;
    }
  }

  return {
    version: 1,
    text: editableText,
    chips: normalizeComposerChips([...promptChips, ...pasteChips]),
    imagePaths: Array.from(refsById.values()),
  };
}

export function normalizeHistoryMessageComposerSnapshot(value) {
  if (!value || Number(value.version) !== 1 || typeof value.text !== 'string') return null;
  const imagePaths = [];
  const usedImageIds = new Set();
  for (const raw of Array.isArray(value.imagePaths) ? value.imagePaths : []) {
    const id = Number(raw?.id);
    const path = typeof raw?.path === 'string' ? raw.path.trim() : '';
    if (!Number.isInteger(id) || id < 1 || usedImageIds.has(id) || !path.startsWith('/')) continue;
    usedImageIds.add(id);
    imagePaths.push({
      id,
      path,
      ...(typeof raw.assetId === 'string' && raw.assetId ? { assetId: raw.assetId } : {}),
      ...(typeof raw.mediaType === 'string' ? { mediaType: raw.mediaType } : {}),
      ...(Number.isFinite(Number(raw.size)) ? { size: Number(raw.size) } : {}),
      availability: raw.availability === 'missing' ? 'missing' : 'available',
    });
  }
  return {
    version: 1,
    text: value.text,
    chips: normalizeComposerChips(value.chips),
    imagePaths,
  };
}

/** Plain text remains useful outside Noted Terminal, while the paired snapshot
 * restores all attachment identities when pasted back into its composer. */
export function buildHistoryMessageClipboardPayload(input = {}) {
  const snapshot = buildHistoryMessageComposerSnapshot(input);
  const body = buildComposerClipboardText({
    text: snapshot.text,
    selectionStart: 0,
    selectionEnd: snapshot.text.length,
    chips: snapshot.chips,
    imagePaths: snapshot.imagePaths,
  }).text;
  const promptPrefix = serializeComposerDraft({
    text: '',
    chips: snapshot.chips.filter((chip) => chip.kind === 'prompt'),
  });
  return {
    text: [promptPrefix, body].filter(Boolean).join('\n\n'),
    snapshot,
  };
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
      // Keep the source path inside the explicit error segment. The missing
      // file has no usable attachment ref, but authoring UI still needs to
      // identify the exact portable path before Send.
      output += `[imageError: portable_image_path_unavailable #${marker.id} path=${marker.path}]`;
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
