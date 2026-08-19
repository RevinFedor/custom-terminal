import { insertPromptImageAttachments } from './promptImageAttachments.mjs';
import { normalizeComposerChips } from './composerChips.mjs';

/**
 * Interrupt recovery has three materially different outcomes:
 *
 * - a durable user row already exists: Stop only interrupted execution and
 *   must not return/suppress the accepted prompt;
 * - the terminal returned the prompt: ownership goes back to the composer;
 * - neither proof exists yet: keep the handoff visible as pending instead of
 *   guessing that the message was cancelled.
 */
export function resolveInterruptedPromptOwnership({
  durablePromptExists = false,
  returnedDraftExists = false,
  returnedDraftMatchesHandoff = false,
} = {}) {
  if (durablePromptExists) return 'durable';
  if (returnedDraftExists && returnedDraftMatchesHandoff) return 'restore';
  if (returnedDraftExists) return 'unrelated-draft';
  return 'pending';
}

const normalizeInterruptedPromptDraftProof = (value) => String(value || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '')
  .replace(/~\]/g, '')
  .replace(/\r\n?/g, '\n')
  .replace(/\[imagePath:\s*[^\]\r\n]+?\s*\]/gi, '[Image]')
  .replace(/\[imageError:\s*[^\]\r\n]+?\s*\]/gi, '[Image]')
  .replace(/\[Image(?:\s+#?\d+)?\]/gi, '[Image]')
  .trim();

/**
 * Interrupt recovery may accept only the transformations already performed by
 * the terminal transport: CRLF canonicalization, paste control fragments and
 * image placeholder aliases. Interior whitespace remains identity-bearing — a
 * tab, an extra space or a newline cannot prove ownership of another draft.
 */
export function interruptedPromptDraftMatchesHandoff({
  returnedDraft = '',
  presentationText = '',
  transportText = '',
} = {}) {
  const returned = normalizeInterruptedPromptDraftProof(returnedDraft);
  if (!returned) return false;
  return [presentationText, transportText].some((candidate) => (
    normalizeInterruptedPromptDraftProof(candidate) === returned
  ));
}

function separatorBetween(left, right) {
  if (!left || !right) return '';
  const trailingNewlines = left.match(/\n+$/)?.[0].length || 0;
  const leadingNewlines = right.match(/^\n+/)?.[0].length || 0;
  return '\n'.repeat(Math.max(0, 2 - trailingNewlines - leadingNewlines));
}

function defaultRestoredChipId(chip, index) {
  return `history-restored-${chip.kind}-${Date.now().toString(36)}-${index}`;
}

/**
 * A failed pre-submit handoff returns ownership of the old authoring snapshot
 * to History. If the user has already started a new draft, restore by
 * prepending instead of overwriting:
 * - attachment ids from the old snapshot are remapped around the new draft;
 * - old chips receive fresh ids so trailing/remove actions stay unambiguous;
 * - a prompt sourceKey collision keeps both authoring intents instead of
 *   letting normal prompt-chip dedupe discard the failed snapshot.
 */
export function mergeFailedHistoryAuthoringSnapshot({
  currentText = '',
  currentImages = [],
  currentChips = [],
  snapshotText = '',
  snapshotImages = [],
  snapshotChips = [],
  createChipId = defaultRestoredChipId,
} = {}) {
  const nextCurrentText = String(currentText || '');
  const failedText = String(snapshotText || '');
  const insertion = failedText + separatorBetween(failedText, nextCurrentText);
  const inserted = insertPromptImageAttachments({
    text: nextCurrentText,
    imagePaths: currentImages,
    start: 0,
    end: 0,
    insertedText: insertion,
    insertedImagePaths: snapshotImages,
  });

  const normalizedCurrentChips = normalizeComposerChips(currentChips);
  const currentSourceKeys = new Set(
    normalizedCurrentChips
      .filter((chip) => chip.kind === 'prompt' && chip.sourceKey)
      .map((chip) => chip.sourceKey),
  );
  const usedIds = new Set(normalizedCurrentChips.map((chip) => chip.id));
  const restoredChips = normalizeComposerChips(snapshotChips).map((chip, index) => {
    const requestedId = String(createChipId(chip, index) || '').trim()
      || defaultRestoredChipId(chip, index);
    let id = requestedId;
    let collision = 1;
    while (usedIds.has(id)) {
      id = `${requestedId}-${collision++}`;
    }
    usedIds.add(id);

    const restored = { ...chip, id };
    if (
      restored.kind === 'prompt'
      && restored.sourceKey
      && currentSourceKeys.has(restored.sourceKey)
    ) {
      // The new and failed drafts are two separate authoring intents now.
      // Keeping the shared sourceKey would make normalizeComposerChips replace
      // one with the other.
      delete restored.sourceKey;
    }
    return restored;
  });

  return {
    text: inserted.text,
    images: inserted.imagePaths,
    chips: normalizeComposerChips([...restoredChips, ...normalizedCurrentChips]),
    restoredChipCount: restoredChips.length,
    remappedImageCount: inserted.addedImagePaths.length,
    missingImageSourceIds: inserted.missingSourceIds,
  };
}

/**
 * Restore an accepted FIFO batch before whatever the user typed afterwards.
 * Applying snapshots newest→oldest through the single-snapshot prepend rule
 * yields A,B,C,current without inventing a second ordering algorithm.
 */
export function mergeFailedHistoryAuthoringSnapshots({
  currentText = '',
  currentImages = [],
  currentChips = [],
  snapshots = [],
  createChipId = defaultRestoredChipId,
} = {}) {
  let text = String(currentText || '');
  let images = currentImages;
  let chips = currentChips;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index] || {};
    const merged = mergeFailedHistoryAuthoringSnapshot({
      currentText: text,
      currentImages: images,
      currentChips: chips,
      snapshotText: snapshot.text || '',
      snapshotImages: snapshot.images || [],
      snapshotChips: snapshot.chips || [],
      createChipId,
    });
    text = merged.text;
    images = merged.images;
    chips = merged.chips;
  }
  return { text, images, chips };
}
