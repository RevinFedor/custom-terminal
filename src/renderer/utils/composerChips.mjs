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
  const pasteParts = normalized
    .filter((chip) => chip.kind === 'paste')
    .map((chip) => `${PASTED_CONTENT_OPEN}\n${chip.text}\n${PASTED_CONTENT_CLOSE}`);
  const editableText = String(text || '');

  return [
    ...promptParts,
    ...pasteParts,
    ...(editableText ? [editableText] : []),
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
export function restoreComposerChipToText({
  text = '',
  chipText = '',
  selectionStart,
  selectionEnd,
} = {}) {
  const current = String(text || '');
  const insertion = String(chipText || '');
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
