export const DEFAULT_AI_COMPOSER_CHIP_THRESHOLD = 800;
export const MIN_AI_COMPOSER_CHIP_THRESHOLD = 100;
export const MAX_AI_COMPOSER_CHIP_THRESHOLD = 100_000;

const PASTED_CONTENT_OPEN = '<pasted_content>';
const PASTED_CONTENT_CLOSE = '</pasted_content>';

export function normalizeComposerChipThreshold(
  value,
  fallback = DEFAULT_AI_COMPOSER_CHIP_THRESHOLD,
) {
  const fallbackProvided = fallback !== null
    && fallback !== undefined
    && String(fallback).trim() !== '';
  const normalizedFallback = fallbackProvided && Number.isFinite(Number(fallback))
    ? Math.round(Number(fallback))
    : DEFAULT_AI_COMPOSER_CHIP_THRESHOLD;
  const valueProvided = value !== null
    && value !== undefined
    && String(value).trim() !== '';
  const numeric = valueProvided && Number.isFinite(Number(value))
    ? Math.round(Number(value))
    : normalizedFallback;
  return Math.max(
    MIN_AI_COMPOSER_CHIP_THRESHOLD,
    Math.min(MAX_AI_COMPOSER_CHIP_THRESHOLD, numeric),
  );
}

export function shouldCreatePasteChip(text, threshold) {
  return String(text || '').length > normalizeComposerChipThreshold(threshold);
}

/**
 * Inline anchor a paste chip leaves in the draft text, at the caret position it
 * was pasted into: `[Pasted Content 1 692 chars]`.
 *
 * A pasted blob is part of the sentence being written, so it must sit INSIDE
 * the line — `текст [Pasted Content 1 692 chars] ещё текст` — not on a strip
 * above the field. A textarea cannot host DOM inside its value, so the anchor
 * lives in the text and the styled block is painted by the highlight layer
 * over it, exactly like `[Image #1]`.
 *
 * The blob itself stays in the chip store: putting 50 KB into the visible
 * draft would make the field unusable. Marker → chip is matched by id, and a
 * chip whose marker is gone is dropped, so no orphaned bodies accumulate.
 */
const PASTE_MARKER_SOURCE = String.raw`\[Pasted Content ([0-9   ]+) chars\]`;

const createPasteMarkerRegex = () => new RegExp(PASTE_MARKER_SOURCE, 'g');

const formatPasteMarkerCount = (chars) => Number(chars || 0).toLocaleString('ru-RU');

export function buildPasteChipMarker(chip) {
  return '[Pasted Content ' + formatPasteMarkerCount((chip?.text || '').length) + ' chars]';
}

/** Byte ranges of every paste marker that still has a matching chip. */
export function getPasteMarkerHighlightRanges(text, chips = []) {
  const markers = normalizeComposerChips(chips)
    .filter((chip) => chip.kind === 'paste')
    .map((chip) => ({ id: chip.id, marker: buildPasteChipMarker(chip) }));
  if (markers.length === 0) return [];
  const value = String(text || '');
  const ranges = [];
  const re = createPasteMarkerRegex();
  // Markers with the same char count are indistinguishable in the text, so a
  // repeated paste of equal-length blobs is matched positionally: the Nth
  // occurrence belongs to the Nth chip with that marker.
  const usedByMarker = new Map();
  let match;
  while ((match = re.exec(value)) !== null) {
    const found = match[0];
    const seen = usedByMarker.get(found) || 0;
    const candidates = markers.filter((entry) => entry.marker === found);
    const chip = candidates[seen];
    usedByMarker.set(found, seen + 1);
    if (!chip) continue;
    ranges.push({ start: match.index, end: match.index + found.length, id: chip.id });
  }
  return ranges;
}

/**
 * Drops chips whose marker no longer appears in the text. Deleting the marker
 * with Backspace is the natural way to remove the blob, and without this the
 * body would silently ride along into the sent prompt.
 */
export function retainPasteChipsForText(text, chips = []) {
  const current = normalizeComposerChips(chips);
  const pasteChips = current.filter((chip) => chip.kind === 'paste');
  if (pasteChips.length === 0) return current;
  const liveIds = new Set(getPasteMarkerHighlightRanges(text, current).map((range) => range.id));
  return current.filter((chip) => chip.kind !== 'paste' || liveIds.has(chip.id));
}

/**
 * Clipboard flavor Voice Record sets alongside the plain text when the payload
 * is dictated speech. Its presence — not the text length — decides that the
 * paste must land as ordinary editable text.
 *
 * Custom clipboard types survive an Electron→Electron copy/paste, so this is a
 * one-line change on the Voice Record side (add the flavor next to the text it
 * already writes) and needs nothing from the OS. Until that ships this check is
 * simply always false, so behavior is unchanged.
 */
export const DICTATION_CLIPBOARD_FLAVOR = 'application/x-voice-record-dictation';

export function isDictationClipboardPayload(clipboardData) {
  if (!clipboardData) return false;
  const types = clipboardData.types;
  if (!types) return false;
  // DataTransfer.types is a DOMStringList in some engines — no .includes().
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === DICTATION_CLIPBOARD_FLAVOR) return true;
  }
  return false;
}

export function isTerminalOnlyComposerDraft(text) {
  return String(text || '').trimStart().startsWith('/');
}

export function isPlainTextPasteShortcut(event = {}) {
  const key = String(event.key || '').toLowerCase();
  return event.metaKey === true
    && event.shiftKey === true
    && event.altKey !== true
    && event.ctrlKey !== true
    && (event.code === 'KeyV' || key === 'v');
}

function normalizeChip(raw) {
  if (!raw || (raw.kind !== 'prompt' && raw.kind !== 'paste')) return null;
  const id = String(raw.id || '').trim();
  const text = String(raw.text || '');
  if (!id || !text) return null;
  return {
    ...raw,
    id,
    kind: raw.kind,
    text,
    ...(typeof raw.label === 'string' && raw.label.trim()
      ? { label: raw.label.trim() }
      : {}),
    ...(typeof raw.sourceKey === 'string' && raw.sourceKey.trim()
      ? { sourceKey: raw.sourceKey.trim() }
      : {}),
  };
}

/**
 * Adds a chip without mutating the input array.
 *
 * Saved prompts use sourceKey as their stable identity. Selecting the same
 * prompt/variation again refreshes the existing chip in place while retaining
 * its id and visual position. Paste chips are never deduplicated because the
 * user may intentionally paste the same text more than once.
 */
export function upsertComposerChip(chips, rawChip) {
  const chip = normalizeChip(rawChip);
  const current = normalizeComposerChips(chips);
  if (!chip) return current;

  if (chip.kind === 'prompt' && chip.sourceKey) {
    const existingIndex = current.findIndex((item) => (
      item.kind === 'prompt' && item.sourceKey === chip.sourceKey
    ));
    if (existingIndex >= 0) {
      const next = current.slice();
      next[existingIndex] = {
        ...chip,
        id: current[existingIndex].id,
      };
      return next;
    }
  }

  return [...current, chip];
}

export function normalizeComposerChips(chips) {
  const next = [];
  for (const rawChip of Array.isArray(chips) ? chips : []) {
    const chip = normalizeChip(rawChip);
    if (!chip) continue;

    if (chip.kind === 'prompt' && chip.sourceKey) {
      const existingIndex = next.findIndex((item) => (
        item.kind === 'prompt' && item.sourceKey === chip.sourceKey
      ));
      if (existingIndex >= 0) {
        next[existingIndex] = {
          ...chip,
          id: next[existingIndex].id,
        };
        continue;
      }
    }

    next.push(chip);
  }
  return next;
}

export function removeComposerChip(chips, chipId) {
  const id = String(chipId || '');
  return normalizeComposerChips(chips).filter((chip) => chip.id !== id);
}

export function haveSameComposerChips(left, right) {
  const a = normalizeComposerChips(left);
  const b = normalizeComposerChips(right);
  return a.length === b.length && a.every((chip, index) => {
    const other = b[index];
    return chip.id === other.id
      && chip.kind === other.kind
      && chip.text === other.text
      && chip.label === other.label
      && chip.sourceKey === other.sourceKey;
  });
}

function composerDraftSeparator(left, right) {
  if (!left || !right) return '';
  const trailingNewlines = left.match(/\n+$/)?.[0].length || 0;
  const leadingNewlines = right.match(/^\n+/)?.[0].length || 0;
  return '\n'.repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines));
}

/**
 * Returns ownership of a queued/rejected authoring snapshot without replacing
 * text or chips that the user created after the handoff began.
 *
 * Prompt chips normally deduplicate by sourceKey while the user is selecting
 * them in one draft. Once two independently-authored drafts are merged, the
 * same sourceKey represents two intents and both must survive.
 */
export function mergeComposerAuthoringSnapshot({
  currentText = '',
  currentChips = [],
  restoredText = '',
  restoredChips = [],
  mode = 'append',
  createChipId = (chip, index) => (
    `composer-restored-${chip.kind}-${Date.now().toString(36)}-${index}`
  ),
} = {}) {
  const current = String(currentText || '');
  const restored = String(restoredText || '');
  let text = current;
  if (restored && restored !== current) {
    if (!current) {
      text = restored;
    } else if (mode === 'prepend') {
      text = restored + composerDraftSeparator(restored, current) + current;
    } else {
      text = current + composerDraftSeparator(current, restored) + restored;
    }
  }

  const normalizedCurrent = normalizeComposerChips(currentChips);
  const currentSourceKeys = new Set(
    normalizedCurrent
      .filter((chip) => chip.kind === 'prompt' && chip.sourceKey)
      .map((chip) => chip.sourceKey),
  );
  const usedIds = new Set(normalizedCurrent.map((chip) => chip.id));
  const normalizedRestored = normalizeComposerChips(restoredChips).map((chip, index) => {
    const next = { ...chip };
    if (usedIds.has(next.id)) {
      const requested = String(createChipId(next, index) || '').trim()
        || `composer-restored-${next.kind}-${Date.now().toString(36)}-${index}`;
      let id = requested;
      let collision = 1;
      while (usedIds.has(id)) id = `${requested}-${collision++}`;
      next.id = id;
    }
    usedIds.add(next.id);
    if (
      next.kind === 'prompt'
      && next.sourceKey
      && currentSourceKeys.has(next.sourceKey)
    ) {
      delete next.sourceKey;
    }
    return next;
  });

  const chips = mode === 'prepend'
    ? [...normalizedRestored, ...normalizedCurrent]
    : [...normalizedCurrent, ...normalizedRestored];
  return {
    text,
    chips: normalizeComposerChips(chips),
  };
}

/**
 * Composer transport order is deliberate:
 * 1. saved-prompt chips as plain prompt text;
 * 2. manual paste chips wrapped in <pasted_content>;
 * 3. the editable textarea text.
 *
 * Prompt chips are an authoring affordance, not a new PTY protocol. Their
 * presentation metadata is persisted separately after post-Enter audit, so
 * the agent still receives the exact plain prompt text.
 */
export function serializeComposerDraft({ text = '', chips = [] } = {}) {
  const normalized = normalizeComposerChips(chips);
  const promptParts = normalized
    .filter((chip) => chip.kind === 'prompt')
    .map((chip) => chip.text);
  const editableText = String(text || '');

  // An anchored paste expands IN PLACE, because the user put it at a specific
  // point of the sentence and the agent must read it there. Ranges are applied
  // back-to-front so earlier offsets stay valid.
  const anchored = getPasteMarkerHighlightRanges(editableText, normalized);
  const chipById = new Map(normalized.map((chip) => [chip.id, chip]));
  const anchoredIds = new Set(anchored.map((range) => range.id));
  let inlinedText = editableText;
  for (let i = anchored.length - 1; i >= 0; i -= 1) {
    const range = anchored[i];
    const chip = chipById.get(range.id);
    if (!chip) continue;
    inlinedText = inlinedText.slice(0, range.start)
      + `${PASTED_CONTENT_OPEN}\n${chip.text}\n${PASTED_CONTENT_CLOSE}`
      + inlinedText.slice(range.end);
  }

  // Chips without a marker keep the historical prefix placement: drafts
  // created before anchors existed, and any path that adds a chip without
  // touching the text, must still send their content.
  const pasteParts = normalized
    .filter((chip) => chip.kind === 'paste' && !anchoredIds.has(chip.id))
    .map((chip) => `${PASTED_CONTENT_OPEN}\n${chip.text}\n${PASTED_CONTENT_CLOSE}`);

  return [
    ...promptParts,
    ...pasteParts,
    ...(inlinedText ? [inlinedText] : []),
  ].join('\n\n');
}

/**
 * Removes the exact prompt-chip prefix from display text without changing the
 * canonical transport value kept on the history entry. If the sidecar and
 * durable prompt disagree, fail closed: show the full text and no chips.
 */
export function splitPromptChipPresentation({ text = '', chips = [] } = {}) {
  const value = String(text || '');
  const promptChips = normalizeComposerChips(chips)
    .filter((chip) => chip.kind === 'prompt');
  if (promptChips.length === 0) {
    return { matched: false, text: value, chips: [] };
  }
  const prefix = promptChips.map((chip) => chip.text).join('\n\n');
  if (value === prefix) {
    return { matched: true, text: '', chips: promptChips };
  }
  const separator = '\n\n';
  if (value.startsWith(prefix + separator)) {
    return {
      matched: true,
      text: value.slice(prefix.length + separator.length),
      chips: promptChips,
    };
  }
  return { matched: false, text: value, chips: [] };
}

/**
 * Splits durable user text into ordinary text and pasted-content parts.
 * Prompt-chip presentation is attached by durable entry UUID outside the
 * transport text.
 */
export function parsePastedContentParts(value) {
  const text = String(value || '');
  const parts = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openAt = text.indexOf(PASTED_CONTENT_OPEN, cursor);
    if (openAt < 0) {
      const tail = text.slice(cursor);
      if (tail) parts.push({ kind: 'text', text: tail });
      break;
    }

    const contentStart = openAt + PASTED_CONTENT_OPEN.length;
    const closeAt = text.indexOf(PASTED_CONTENT_CLOSE, contentStart);
    if (closeAt < 0) {
      const tail = text.slice(cursor);
      if (tail) parts.push({ kind: 'text', text: tail });
      break;
    }

    const before = text.slice(cursor, openAt);
    if (before) parts.push({ kind: 'text', text: before });

    let content = text.slice(contentStart, closeAt);
    if (content.startsWith('\r\n')) content = content.slice(2);
    else if (content.startsWith('\n')) content = content.slice(1);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    else if (content.endsWith('\n')) content = content.slice(0, -1);
    parts.push({ kind: 'paste', text: content });
    cursor = closeAt + PASTED_CONTENT_CLOSE.length;
  }

  return parts;
}

/**
 * One Claude turn has two deliberate text projections during native Rewind:
 * - `fullText` is the durable transport text restored after Enter;
 * - `menuText` is the ordinary user text Claude shows in its /rewind row.
 *
 * Claude collapses <pasted_content> bodies in the native picker. Matching the
 * picker against the expanded body makes a logically present turn impossible
 * to find, so the scenario layer removes only proven paste wrappers and keeps
 * the surrounding text in its original order. A paste-only turn stays on the
 * old full-text fallback until its native picker representation is observed;
 * that is fail-closed rather than guessing from an opaque body.
 */
export function buildClaudeRewindPromptProjection(value) {
  const fullText = String(value || '').trim();
  const parts = parsePastedContentParts(fullText);
  const pastePartCount = parts.filter((part) => part.kind === 'paste').length;
  const ordinaryParts = parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text);
  const ordinaryText = ordinaryParts.join(' ').replace(/\s+/g, ' ').trim();
  const normalizedFullText = fullText.replace(/\s+/g, ' ').trim();

  return {
    fullText,
    menuText: pastePartCount > 0 && ordinaryText
      ? ordinaryText
      : normalizedFullText,
    menuSource: pastePartCount > 0 && ordinaryText
      ? 'ordinary-text-outside-paste'
      : 'full-text',
    pastePartCount,
    ordinaryPartCount: ordinaryParts.length,
  };
}

const createHistoryImageMarkerRegex = () => new RegExp(
  String.raw`(?<!\\)(?:\[Image\s+#?(\d+)\]|\[imagePath:\s*([^\]\r\n]+?)\s*\])`,
  'gi',
);

function splitHistoryImageParts(text, imagePaths = []) {
  const value = String(text || '');
  const refs = Array.isArray(imagePaths) ? imagePaths : [];
  const refsById = new Map(refs.map((ref) => [Number(ref?.id), ref]));
  const refsByPath = new Map(refs.flatMap((ref) => {
    const filePath = typeof ref?.path === 'string' ? ref.path.trim() : '';
    return filePath ? [[filePath, ref]] : [];
  }));
  const parts = [];
  const re = createHistoryImageMarkerRegex();
  let cursor = 0;
  let match;
  while ((match = re.exec(value)) !== null) {
    const markerId = match[1] ? Number(match[1]) : null;
    const portablePath = match[2] ? match[2].trim() : '';
    const ref = markerId !== null
      ? refsById.get(markerId)
      : refsByPath.get(portablePath);
    // A History image chip is proof-bearing UI: the exact slot must still own
    // an available ref. The marker alone is not enough (old transcripts and
    // pasted documentation can contain identical text).
    if (!ref?.path || ref.availability === 'missing') continue;
    if (match.index > cursor) {
      parts.push({ kind: 'text', text: value.slice(cursor, match.index) });
    }
    parts.push({
      kind: 'image',
      id: (markerId ?? Number(ref?.id)) || 0,
      marker: match[0],
      ...(ref ? { ref } : {}),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) parts.push({ kind: 'text', text: value.slice(cursor) });
  return parts;
}

/**
 * Builds the History-only visual projection of a sent composer snapshot.
 * The canonical transport text remains untouched; this function merely
 * replaces proven opaque regions with ordered presentation parts.
 *
 * Image-looking text inside <pasted_content> is intentionally never parsed:
 * the pasted blob owns those bytes and may contain logs or documentation.
 */
export function buildHistoryComposerPresentationParts({
  text = '',
  chips = [],
  imagePaths = [],
} = {}) {
  const promptPresentation = splitPromptChipPresentation({ text, chips });
  const parts = [];
  promptPresentation.chips.forEach((chip, index) => {
    if (index > 0) parts.push({ kind: 'text', text: '\n\n' });
    parts.push({ kind: 'prompt', chip });
  });
  if (promptPresentation.chips.length > 0 && promptPresentation.text) {
    parts.push({ kind: 'text', text: '\n\n' });
  }
  for (const part of parsePastedContentParts(promptPresentation.text)) {
    if (part.kind === 'paste') {
      parts.push(part);
      continue;
    }
    parts.push(...splitHistoryImageParts(part.text, imagePaths));
  }
  return {
    matchedPromptChips: promptPresentation.matched,
    parts,
  };
}

/**
 * Restores a chip into the exact saved/current textarea selection. No spacing
 * is invented: the chip body replaces the selection byte-for-byte and the
 * caret lands immediately after it.
 *
 * @param {{
 *   text?: string,
 *   chipText?: string,
 *   selectionStart?: number,
 *   selectionEnd?: number,
 * }} [options]
 */
export function insertComposerTextAtSelection({
  text = '',
  insertedText = '',
  selectionStart,
  selectionEnd,
} = {}) {
  const current = String(text || '');
  const insertion = String(insertedText || '');
  const start = Math.max(
    0,
    Math.min(
      Number.isFinite(Number(selectionStart)) ? Math.round(Number(selectionStart)) : current.length,
      current.length,
    ),
  );
  const end = Math.max(
    start,
    Math.min(
      Number.isFinite(Number(selectionEnd)) ? Math.round(Number(selectionEnd)) : start,
      current.length,
    ),
  );
  const nextText = current.slice(0, start) + insertion + current.slice(end);
  const caret = start + insertion.length;
  return {
    text: nextText,
    caret,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

/**
 * Inserts one complete authoring snapshot (text + chips) at a selection.
 *
 * Paste markers encode only the body length, so two equal-length blobs are
 * indistinguishable in the textarea. Their durable identity therefore lives
 * in chip order. Text and chips must be spliced atomically: appending the new
 * chip while inserting its marker before an older marker swaps the bodies on
 * serialization.
 */
export function insertComposerSnapshotAtSelection({
  text = '',
  chips = [],
  insertedText = '',
  insertedChips = [],
  selectionStart,
  selectionEnd,
  createChipId = (chip, index) => (
    `composer-inserted-${chip.kind}-${Date.now().toString(36)}-${index}`
  ),
} = {}) {
  const currentText = String(text || '');
  const insertionText = String(insertedText || '');
  const start = Math.max(
    0,
    Math.min(
      Number.isFinite(Number(selectionStart)) ? Math.round(Number(selectionStart)) : currentText.length,
      currentText.length,
    ),
  );
  const end = Math.max(
    start,
    Math.min(
      Number.isFinite(Number(selectionEnd)) ? Math.round(Number(selectionEnd)) : start,
      currentText.length,
    ),
  );

  const current = normalizeComposerChips(chips);
  const usedIds = new Set(current.map((chip) => chip.id));
  const inserted = normalizeComposerChips(insertedChips).map((chip, index) => {
    if (!usedIds.has(chip.id)) {
      usedIds.add(chip.id);
      return chip;
    }
    const requested = String(createChipId(chip, index) || '').trim()
      || `composer-inserted-${chip.kind}-${Date.now().toString(36)}-${index}`;
    let id = requested;
    let collision = 1;
    while (usedIds.has(id)) id = `${requested}-${collision++}`;
    usedIds.add(id);
    return { ...chip, id };
  });

  const currentRanges = getPasteMarkerHighlightRanges(currentText, current);
  const insertedRanges = getPasteMarkerHighlightRanges(insertionText, inserted);
  const currentAnchoredIds = new Set(currentRanges.map((range) => range.id));
  const insertedAnchoredIds = new Set(insertedRanges.map((range) => range.id));
  const chipById = new Map([...current, ...inserted].map((chip) => [chip.id, chip]));

  // A marker touched by the replaced selection no longer has a complete
  // textual anchor and must not survive as a hidden prefix attachment.
  const beforeIds = currentRanges
    .filter((range) => range.end <= start)
    .map((range) => range.id);
  const afterIds = currentRanges
    .filter((range) => range.start >= end)
    .map((range) => range.id);
  const anchoredOrder = [
    ...beforeIds,
    ...insertedRanges.map((range) => range.id),
    ...afterIds,
  ];
  const anchored = anchoredOrder.map((id) => chipById.get(id)).filter(Boolean);
  const currentUnanchored = current.filter((chip) => (
    chip.kind === 'paste' && !currentAnchoredIds.has(chip.id)
  ));
  const insertedUnanchored = inserted.filter((chip) => (
    chip.kind === 'paste' && !insertedAnchoredIds.has(chip.id)
  ));
  const promptChips = normalizeComposerChips([
    ...current.filter((chip) => chip.kind === 'prompt'),
    ...inserted.filter((chip) => chip.kind === 'prompt'),
  ]);

  const nextText = currentText.slice(0, start) + insertionText + currentText.slice(end);
  const caret = start + insertionText.length;
  return {
    text: nextText,
    chips: normalizeComposerChips([
      ...promptChips,
      // Anchored chips go first so legacy unanchored blobs of the same length
      // cannot steal a positional marker match.
      ...anchored,
      ...currentUnanchored,
      ...insertedUnanchored,
    ]),
    caret,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

export function restoreComposerChipToText({
  text = '',
  chipText = '',
  selectionStart,
  selectionEnd,
} = {}) {
  return insertComposerTextAtSelection({
    text,
    insertedText: chipText,
    selectionStart,
    selectionEnd,
  });
}

/**
 * Caret position after a word-wise move (Opt+Arrow) that must treat an opaque
 * marker as ONE object.
 *
 * A marker like `[Pasted Content 1 500 chars]` or `[Image #1]` is a single
 * thing to the user — it either is in the text or it is not. Word-wise motion,
 * however, sees ordinary words and brackets, so it stopped between `[` and
 * `Pasted`, then between `Pasted` and `Content`, and so on: five presses to
 * cross what reads as one token, each landing the caret in a place where
 * typing would corrupt the marker. Marker-aware motion collapses the whole
 * span into one step in either direction.
 *
 * `ranges` are the already-computed marker spans (paste anchors + image refs);
 * this helper deliberately does not re-parse text, so both marker families
 * share one rule and neither can drift from its own highlight layer.
 *
 * Returns null when the move is an ordinary one and the browser should handle
 * it — that keeps native word-wise semantics (locale, punctuation) intact
 * everywhere except across a marker.
 */
export function resolveMarkerAwareWordCaret({
  text = '',
  caret = 0,
  direction = 'forward',
  ranges = [],
} = {}) {
  const value = String(text || '');
  const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
  const spans = (Array.isArray(ranges) ? ranges : [])
    .filter((range) => range
      && Number.isFinite(Number(range.start))
      && Number.isFinite(Number(range.end))
      && Number(range.end) > Number(range.start))
    .map((range) => ({ start: Number(range.start), end: Number(range.end) }))
    .sort((left, right) => left.start - right.start);
  if (spans.length === 0) return null;

  if (direction === 'forward') {
    // Inside a marker, or sitting right at its opening bracket → jump past its
    // closing bracket in one move.
    const inside = spans.find((span) => position >= span.start && position < span.end);
    return inside ? inside.end : null;
  }

  // Backward: inside a marker, or right after its closing bracket → jump to
  // the opening bracket.
  const inside = spans.find((span) => position > span.start && position <= span.end);
  return inside ? inside.start : null;
}
