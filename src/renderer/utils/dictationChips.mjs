// Dictation chips: a Voice Record take finishing INSIDE the History composer.
//
// When the user ends a global dictation while the composer is focused, Voice
// Record does not paste. It asks the terminal to drop an inline placeholder at
// the caret and keeps committing the speech tail on its side; the resolved
// text later replaces the placeholder exactly where it sits.
//
// The placeholder is a TEXT MARKER, same family as `[Pasted Content …]` and
// `[Image saving…]`: it lives in the draft string, so it survives restarts,
// undo, and tab switches with zero extra persistence. Everything volatile
// (label, status, armed auto-send) lives in the chip registry next to it and
// is re-derivable: a marker without a registry entry is adopted as `stale`
// (the take may still be retried by its id — the id IS the Voice Record
// history timestamp).

const MARKER_PREFIX = '[Dictating ';
const MARKER_SUFFIX = ']';

// Chip ids arrive as `vr-<ts>` from Voice Record. Keep the charset closed so
// user prose can never accidentally parse as a marker.
const MARKER_RE_SOURCE = String.raw`\[Dictating (vr-[0-9]+)\]`;
const createMarkerRegex = () => new RegExp(MARKER_RE_SOURCE, 'g');

export function buildDictationMarker(chipId) {
  return MARKER_PREFIX + String(chipId || '').trim() + MARKER_SUFFIX;
}

export function isDictationChipId(chipId) {
  return /^vr-[0-9]+$/.test(String(chipId || ''));
}

/** Layout-independent Option+1 send intent in the History composer. `key`
 * is layout/Option transformed on macOS (`¡`, etc.); physical `code` is the
 * stable identity. Chromium can omit `code` for the first Option/dead-key
 * event, so the unambiguous top-row `keyCode=49` is the bounded fallback used
 * by Voice Record's own shortcut capture too. Exact modifiers keep it
 * disjoint from browser/OS chords. */
export function isDictationAutoEnterShortcut(event) {
  const native = event?.nativeEvent || event || {};
  const code = String(event?.code || native.code || '');
  const legacyKeyCode = Number(event?.keyCode || native.keyCode || event?.which || native.which || 0);
  const isDigitOne = code === 'Digit1'
    || ((!code || code === 'Dead' || code === 'Unidentified') && legacyKeyCode === 49);
  return isDigitOne
    && (event?.altKey ?? native.altKey) === true
    && (event?.metaKey ?? native.metaKey) !== true
    && (event?.ctrlKey ?? native.ctrlKey) !== true
    && (event?.shiftKey ?? native.shiftKey) !== true
    && native.isComposing !== true;
}

/** Voice Record history timestamp encoded in the chip id — the retry key. */
export function dictationChipTs(chipId) {
  const m = /^vr-([0-9]+)$/.exec(String(chipId || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every dictation marker present in the text, in document order.
 * Returns [{ start, end, id }].
 */
export function getDictationMarkerRanges(text) {
  const value = String(text || '');
  const ranges = [];
  const re = createMarkerRegex();
  let match;
  while ((match = re.exec(value)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, id: match[1] });
  }
  return ranges;
}

export function hasDictationMarkers(text) {
  return getDictationMarkerRanges(text).length > 0;
}

/**
 * Replace one marker with its resolved text (or with nothing for an empty
 * take). Returns { text, caret, replaced: {from, to, insert} } or null when
 * the marker is no longer in the draft — the user deleted the chip, which is
 * the "cancel insertion" gesture, so a late resolution must NOT re-add text.
 */
export function resolveDictationMarker({ text, chipId, replacement = '' }) {
  const value = String(text || '');
  const range = getDictationMarkerRanges(value).find((r) => r.id === chipId);
  if (!range) return null;
  let insert = String(replacement || '');
  if (insert) {
    // The resolved speech becomes part of the sentence around it: keep one
    // breathing space on each side unless the neighbour is already whitespace
    // or an edge. Without this "текст[распознанное]текст" glues words.
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    if (before && !/\s$/.test(before)) insert = ' ' + insert;
    if (after && !/^\s/.test(after)) insert = insert + ' ';
  } else {
    // Empty take: also swallow ONE space the marker insertion left behind so
    // the draft returns to exactly what it was before the dictation started.
    const after = value.slice(range.end);
    const before = value.slice(0, range.start);
    if (/^\s/.test(after) && before && /\s$/.test(before)) {
      return {
        text: before + after.slice(1),
        caret: range.start,
        replaced: { from: range.start, to: range.end + 1, insert: '' },
      };
    }
  }
  return {
    text: value.slice(0, range.start) + insert + value.slice(range.end),
    caret: range.start + insert.length,
    replaced: { from: range.start, to: range.end, insert },
  };
}

/**
 * Chip label shown in the token layer. `label` is the latest tail Voice
 * Record recognised; the ⏎ prefix is the visible half
 * of "auto-send is armed for this draft".
 */
export function dictationTokenLabel(entry, { armed = false } = {}) {
  const status = entry?.status || 'pending';
  const base = String(entry?.label || '').trim();
  if (status === 'error') return '⚠ ' + (base || 'диктовка') + ' — повторить';
  if (status === 'stale') return '⏸ ' + (base || 'диктовка') + ' — повторить';
  const words = base ? base : 'диктовка…';
  return (armed ? '⏎ ' : '') + words;
}

/**
 * Registry reconciliation against the current draft text.
 * - entries whose marker is gone are dropped (chip deleted by the user);
 * - markers without an entry are adopted as `stale` (restart orphan) so the
 *   user still sees a retryable chip instead of raw bracket text.
 * Returns { entries, changed }.
 */
export function reconcileDictationEntries(text, entries = []) {
  const ranges = getDictationMarkerRanges(text);
  const present = new Set(ranges.map((r) => r.id));
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && present.has(entry.id)) byId.set(entry.id, entry);
  }
  let changed = byId.size !== (Array.isArray(entries) ? entries.length : 0);
  const next = [];
  for (const range of ranges) {
    const existing = byId.get(range.id);
    if (existing) {
      next.push(existing);
    } else {
      changed = true;
      next.push({ id: range.id, status: 'stale', label: '', createdAt: Date.now() });
    }
  }
  return { entries: next, changed };
}

export function hasPendingDictation(entries = []) {
  return (Array.isArray(entries) ? entries : []).some((e) => e && e.status === 'pending');
}

/**
 * Send gate. Any dictation marker still in the text blocks a submit: a
 * pending one would send the placeholder instead of the speech, an
 * error/stale one would send literal bracket junk. The caller either waits
 * (auto-send), retries, or deletes the marker.
 */
export function dictationBlocksSend(text) {
  return hasDictationMarkers(text);
}
