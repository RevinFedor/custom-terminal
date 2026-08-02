import { resolveMarkerAwareWordCaret } from './composerChips.mjs';

export interface ComposerMarkerRange {
  start: number;
  end: number;
}

/**
 * Minimal surface both composer flavours provide: the real `<textarea>` and the
 * CodeMirror-backed ComposerEditor, whose event facade exposes the same
 * `value` / selection / `setSelectionRange` contract on `currentTarget`.
 * Typing against that shared shape keeps ONE motion rule for both editors.
 */
export interface ComposerWordMotionEvent {
  key?: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
  currentTarget: {
    value: string;
    selectionStart: number | null;
    selectionEnd: number | null;
    setSelectionRange: (start: number, end?: number, direction?: 'forward' | 'backward' | 'none') => void;
  };
}

/**
 * Opt+Arrow that treats an opaque composer marker as ONE object.
 *
 * `[Pasted Content 1 500 chars]` and `[Image #1]` are single things to the
 * user, but word-wise motion sees ordinary words and brackets: crossing one
 * took five presses, and each intermediate stop left the caret inside the
 * marker — the exact positions where typing corrupts it and silently detaches
 * the attached blob or image.
 *
 * The handler returns `true` only when it actually moved the caret. Everywhere
 * else it returns `false` so the browser keeps its native word-wise behaviour
 * (locale rules, punctuation, accessibility) untouched — the shortcut is
 * modified across markers, not reimplemented.
 *
 * Ranges are the SAME spans the highlight layer paints, passed in by the
 * caller. Re-deriving them here would let motion and highlight drift apart.
 */
export function applyMarkerAwareWordMotion(
  event: ComposerWordMotionEvent,
  ranges: ComposerMarkerRange[],
  onCaretChange?: (selection: { start: number; end: number }) => void,
): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey) return false;
  const forward = event.key === 'ArrowRight';
  const backward = event.key === 'ArrowLeft';
  if (!forward && !backward) return false;
  if (ranges.length === 0) return false;

  const textarea = event.currentTarget;
  const selectionStart = textarea.selectionStart ?? 0;
  const selectionEnd = textarea.selectionEnd ?? selectionStart;
  // With a live selection and no Shift the anchor side is not recoverable from
  // the DOM; guessing it would shrink or flip what the user selected.
  if (selectionStart !== selectionEnd && !event.shiftKey) return false;

  const caret = forward ? selectionEnd : selectionStart;
  const next = resolveMarkerAwareWordCaret({
    text: textarea.value,
    caret,
    direction: forward ? 'forward' : 'backward',
    ranges,
  }) as number | null;
  if (next === null || next === undefined) return false;

  event.preventDefault();
  if (event.shiftKey) {
    const anchor = forward ? selectionStart : selectionEnd;
    const from = Math.min(anchor, next);
    const to = Math.max(anchor, next);
    textarea.setSelectionRange(from, to, forward ? 'forward' : 'backward');
    onCaretChange?.({ start: from, end: to });
    return true;
  }
  textarea.setSelectionRange(next, next);
  onCaretChange?.({ start: next, end: next });
  return true;
}
