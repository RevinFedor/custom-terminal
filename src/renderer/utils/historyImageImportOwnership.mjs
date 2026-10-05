import { insertComposerSnapshotAtSelection } from './composerChips.mjs';
import { insertHistoryClipboardSnapshotAtSelection } from './composerClipboard.mjs';
import { insertPromptImageAttachments, retainPromptImageRefsForText } from './promptImageAttachments.mjs';

export const HISTORY_IMAGE_PENDING_MARKER = '[Image saving…]';

// Renderer reload is the lifetime boundary of clipboard promises. Persisted
// draft text has no executable operation; never leave its reserved progress
// label spinning forever, and never re-import the current (different) clipboard.
export function expireReloadedHistoryImageImports(drafts = {}) {
  return Object.fromEntries(Object.entries(drafts).map(([tabId, text]) => [tabId,
    String(text || '').replaceAll(HISTORY_IMAGE_PENDING_MARKER, '[imageError: image_import_interrupted]'),
  ]));
}

// Undo keeps the immutable operation handle with its authoring snapshot. Its
// completed result remains reachable even when the placeholder was absent at
// completion. Weak ownership releases large copied snapshots with Undo history.
const operations = new WeakMap();
const operationIds = new Map();
const finalized = new FinalizationRegistry(({ id, reference }) => {
  if (operationIds.get(id) === reference) operationIds.delete(id);
});
let nextOperationId = 0;

export function createHistoryImageImportOperation(ownerTabId) {
  const id = 'history-image-import:' + (globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}:${++nextOperationId}:${Math.random().toString(36).slice(2)}`);
  const operation = Object.freeze({ id, ownerTabId: String(ownerTabId || '') });
  operations.set(operation, { status: 'pending', outcome: null });
  const reference = new WeakRef(operation);
  operationIds.set(id, reference);
  finalized.register(operation, { id, reference });
  return operation;
}

function operationState(operation) {
  if (!operation || typeof operation !== 'object') return null;
  const original = operations.has(operation) ? operation : operationIds.get(operation.id)?.deref();
  return original?.ownerTabId === operation.ownerTabId ? operations.get(original) || null : null;
}

export function settleHistoryImageImportOperation(operation, outcome) {
  const state = operationState(operation);
  if (!state || state.status !== 'pending') return false;
  state.status = 'settled';
  state.outcome = outcome;
  return true;
}

export function getHistoryImageImportOutcome(operation) {
  const state = operationState(operation);
  if (state?.status === 'pending') return null;
  return state?.outcome || {
    snapshot: { text: '[imageError: image_import_operation_unavailable]', imagePaths: [], chips: [] },
    warning: 'The pending image import is no longer available. Copy the image again.',
  };
}

export function normalizeHistoryPendingImageImports(text, refs = [], ownerTabId = null) {
  const value = String(text || '');
  const candidates = (Array.isArray(refs) ? refs : []).filter(ref => ref?.operation?.id
    && typeof ref.operation.ownerTabId === 'string'
    && (!ownerTabId || ref.operation.ownerTabId === ownerTabId)
    && Number.isSafeInteger(ref.start) && ref.start >= 0
    && ref.end === ref.start + HISTORY_IMAGE_PENDING_MARKER.length
    && value.slice(ref.start, ref.end) === HISTORY_IMAGE_PENDING_MARKER);
  return candidates.filter(ref => candidates.filter(other => other.operation.id === ref.operation.id).length === 1
    && !candidates.some(other => other !== ref && other.start < ref.end && other.end > ref.start));
}

export function haveSameHistoryPendingImageImports(left = [], right = []) {
  return left.length === right.length && left.every((ref, index) => ref.start === right[index]?.start
    && ref.end === right[index]?.end && ref.operation.id === right[index]?.operation?.id
    && ref.operation.ownerTabId === right[index]?.operation?.ownerTabId);
}

/** Map only an exact, caller-owned edit range. Never rediscover identity by
 * looking for the first occurrence of the identical visible pending label. */
export function mapHistoryPendingImageImports(text, refs, { from, to, insert = '' }) {
  const replacement = String(insert || '');
  const nextText = String(text || '').slice(0, from) + replacement + String(text || '').slice(to);
  const delta = replacement.length - (to - from);
  const mapped = normalizeHistoryPendingImageImports(text, refs).flatMap(ref => {
    const overlaps = from < ref.end && to > ref.start;
    const insertedInside = from === to && from > ref.start && from < ref.end;
    if (overlaps || insertedInside) return [];
    const shift = to <= ref.start ? delta : 0;
    return [{ ...ref, start: ref.start + shift, end: ref.end + shift }];
  });
  return normalizeHistoryPendingImageImports(nextText, mapped);
}

export function prepareHistoryImageImport({ ownerTabId, text = '', images = [], chips = [],
  pendingImages = [], start = text.length, end = start } = {}) {
  const operation = createHistoryImageImportOperation(ownerTabId);
  const insertion = insertComposerSnapshotAtSelection({ text, chips,
    insertedText: HISTORY_IMAGE_PENDING_MARKER, selectionStart: start, selectionEnd: end });
  const from = insertion.caret - HISTORY_IMAGE_PENDING_MARKER.length;
  const to = Math.max(from, Math.min(end, text.length));
  return { ...insertion, operation,
    images: retainPromptImageRefsForText(insertion.text, images),
    pendingImages: [...mapHistoryPendingImageImports(text, pendingImages,
      { from, to, insert: HISTORY_IMAGE_PENDING_MARKER }),
    { operation, start: from, end: insertion.caret }].sort((a, b) => a.start - b.start),
  };
}

export function resolveHistoryImageImport({ operation, text = '', images = [], chips = [], pendingImages = [],
  pendingContextUpdates = [], dismissedContextUpdateIds = [] } = {}) {
  if (!operation?.id) return null;
  const outcome = getHistoryImageImportOutcome(operation);
  if (!outcome) return null;
  const owned = normalizeHistoryPendingImageImports(text, pendingImages, operation?.ownerTabId)
    .find(ref => ref.operation.id === operation.id);
  if (!owned) return null;
  const snapshot = outcome.snapshot;
  const imageInsertion = insertPromptImageAttachments({ text, imagePaths: images,
    start: owned.start, end: owned.end, insertedText: snapshot.text,
    insertedImagePaths: snapshot.imagePaths || [] });
  const insertedText = imageInsertion.text.slice(owned.start, imageInsertion.caret);
  const insertion = insertHistoryClipboardSnapshotAtSelection({ text, chips, insertedText,
    pendingContextUpdates, dismissedContextUpdateIds,
    insertedChips: snapshot.chips || [], selectionStart: owned.start, selectionEnd: owned.end });
  return { ...insertion, images: retainPromptImageRefsForText(insertion.text, imageInsertion.imagePaths),
    pendingImages: mapHistoryPendingImageImports(text, pendingImages,
      { from: owned.start, to: owned.end, insert: insertedText }),
    replacedStart: owned.start, replacedEnd: owned.end,
    warning: outcome.warning || (imageInsertion.missingSourceIds.length > 0
      ? 'One or more copied images are unavailable. Missing slots were replaced with imageError.' : null),
  };
}

/** The optional third editor argument is required for authoring mutations:
 * it is the real CodeMirror transaction, not a guessed text diff or key hint. */
export function deriveHistoryComposerAggregate(nextText, previous, transaction) {
  if (!transaction?.changes?.iterChanges || !transaction?.startState?.doc) {
    throw new Error('composer_transaction_context_unavailable');
  }
  let text = transaction.startState.doc.toString();
  let chips = previous?.chips || [];
  let pendingImages = previous?.pendingImages || [];
  const edits = [];
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    edits.push({ from, to, insert: inserted.toString() });
  });
  for (const edit of edits.reverse()) {
    pendingImages = mapHistoryPendingImageImports(text, pendingImages, edit);
    const insertion = insertComposerSnapshotAtSelection({ text, chips,
      insertedText: edit.insert, selectionStart: edit.from, selectionEnd: edit.to });
    text = insertion.text;
    chips = insertion.chips;
  }
  if (text !== nextText) throw new Error('composer_transaction_text_mismatch');
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    images: retainPromptImageRefsForText(nextText, previous?.images || []),
    chips,
    pendingImages,
  };
}
