'use strict';

const DEFAULT_TRACE_LIMIT = 48;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESC_RE = /\x1b[78]/g;

function boundedPush(items, value, limit) {
  items.push(value);
  const overflow = items.length - limit;
  if (overflow > 0) items.splice(0, overflow);
}

function visibleControl(sequence) {
  return String(sequence || '')
    .replace(/\x1b/g, '<ESC>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>');
}

function classifyCsi(sequence) {
  const value = String(sequence || '');
  if (/^\x1b\[\?2026[hl]$/.test(value)) {
    return value.endsWith('h') ? 'synchronized-output-begin' : 'synchronized-output-end';
  }
  if (/^\x1b\[\?25[hl]$/.test(value)) {
    return value.endsWith('h') ? 'cursor-show' : 'cursor-hide';
  }
  if (/^\x1b\[\?(?:47|1047|1049)[hl]$/.test(value)) {
    return value.endsWith('h') ? 'alternate-screen-enter' : 'alternate-screen-exit';
  }
  const final = value.at(-1) || '';
  if (final === 'J') return 'erase-display';
  if (final === 'K') return 'erase-line';
  if ('HfABCD EFGd'.replace(/\s/g, '').includes(final)) return 'cursor-move';
  if (final === 's') return 'cursor-save';
  if (final === 'u') return 'cursor-restore';
  if (final === 'r') return 'scroll-region';
  return 'csi';
}

function trailingEscapeFragment(value) {
  const text = String(value || '');
  const index = text.lastIndexOf('\x1b');
  if (index < 0) return '';
  const suffix = text.slice(index);
  if (suffix.length > 64) return '';
  // The last escape may be complete and followed by printable frame data.
  // Anchoring at end-of-string retained the whole suffix as carry in that
  // case, so the same DEC 2026 begin was counted again with the next chunk.
  if (/^\x1b\[[0-?]*[ -/]*[@-~]/.test(suffix) || /^\x1b[78]/.test(suffix)) return '';
  return suffix;
}

function countChar(text, wanted) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === wanted) count += 1;
  }
  return count;
}

function createTerminalRedrawTrace(limit = DEFAULT_TRACE_LIMIT) {
  return {
    limit: Math.max(8, Number(limit) || DEFAULT_TRACE_LIMIT),
    entries: [],
    ansiCarry: '',
    cursorVisible: null,
    cursorVisibilitySeq: null,
    synchronizedOutputOpen: false,
    synchronizedOutputSeq: null,
    synchronizedOutputGeneration: 0,
    alternateScreen: null,
    lastInput: null,
    lastResize: null,
    lastFlush: null,
  };
}

function recordTerminalOutput(trace, data, meta = {}) {
  if (!trace || !data) return null;
  const text = String(data);
  const combined = String(trace.ansiCarry || '') + text;
  const controls = [];
  for (const match of combined.matchAll(CSI_RE)) {
    const sequence = match[0];
    const kind = classifyCsi(sequence);
    controls.push({ kind, sequence: visibleControl(sequence) });
    if (kind === 'cursor-show' || kind === 'cursor-hide') {
      trace.cursorVisible = kind === 'cursor-show';
      trace.cursorVisibilitySeq = meta.seq ?? null;
    } else if (kind === 'synchronized-output-begin' || kind === 'synchronized-output-end') {
      trace.synchronizedOutputOpen = kind === 'synchronized-output-begin';
      trace.synchronizedOutputSeq = meta.seq ?? null;
      trace.synchronizedOutputGeneration = Number(trace.synchronizedOutputGeneration || 0) + 1;
    } else if (kind === 'alternate-screen-enter' || kind === 'alternate-screen-exit') {
      trace.alternateScreen = kind === 'alternate-screen-enter';
    }
  }
  for (const match of combined.matchAll(SINGLE_ESC_RE)) {
    controls.push({
      kind: match[0].endsWith('7') ? 'cursor-save' : 'cursor-restore',
      sequence: visibleControl(match[0]),
    });
  }
  trace.ansiCarry = trailingEscapeFragment(combined);
  const carriageReturns = countChar(text, '\r');
  const lineFeeds = countChar(text, '\n');
  if (controls.length === 0 && carriageReturns === 0 && lineFeeds === 0) return null;
  const entry = {
    kind: 'output',
    at: Number(meta.at) || Date.now(),
    seq: meta.seq ?? null,
    bytes: text.length,
    carriageReturns,
    lineFeeds,
    controls: controls.slice(-16),
    before: meta.before || null,
  };
  boundedPush(trace.entries, entry, trace.limit);
  return entry;
}

function recordTerminalFlush(trace, meta = {}) {
  if (!trace) return;
  trace.lastFlush = {
    at: Number(meta.at) || Date.now(),
    seq: meta.seq ?? null,
    chars: Number(meta.chars) || 0,
    items: Number(meta.items) || 0,
    after: meta.after || null,
  };
}

function classifyInput(data) {
  const value = String(data || '');
  if (value === '\x1b[I') return 'focus-in';
  if (value === '\x1b[O') return 'focus-out';
  if (value === '\x07') return 'ctrl-g';
  if (value === '\r' || value === '\n') return 'enter';
  if (value === '\x1b') return 'escape';
  if (value === '\x03') return 'ctrl-c';
  return /^[\x00-\x1f\x7f]+$/.test(value) ? 'control' : 'text';
}

function recordTerminalInput(trace, data, meta = {}) {
  if (!trace) return;
  trace.lastInput = {
    at: Number(meta.at) || Date.now(),
    kind: classifyInput(data),
    bytes: String(data || '').length,
    revision: Number.isFinite(Number(meta.revision)) ? Number(meta.revision) : null,
    origin: meta.origin || null,
  };
}

function recordTerminalResize(trace, cols, rows, meta = {}) {
  if (!trace) return;
  trace.lastResize = {
    at: Number(meta.at) || Date.now(),
    cols: Number(cols) || null,
    rows: Number(rows) || null,
  };
}

function snapshotTerminalRedrawTrace(trace, count = 16) {
  if (!trace) return null;
  return {
    cursorVisible: trace.cursorVisible,
    cursorVisibilitySeq: trace.cursorVisibilitySeq,
    synchronizedOutputOpen: trace.synchronizedOutputOpen === true,
    synchronizedOutputSeq: trace.synchronizedOutputSeq,
    synchronizedOutputGeneration: Number(trace.synchronizedOutputGeneration || 0),
    alternateScreen: trace.alternateScreen,
    lastInput: trace.lastInput ? { ...trace.lastInput } : null,
    lastResize: trace.lastResize ? { ...trace.lastResize } : null,
    lastFlush: trace.lastFlush ? { ...trace.lastFlush } : null,
    entries: trace.entries.slice(-Math.max(1, Number(count) || 16)),
  };
}

module.exports = {
  classifyCsi,
  classifyInput,
  createTerminalRedrawTrace,
  recordTerminalFlush,
  recordTerminalInput,
  recordTerminalOutput,
  recordTerminalResize,
  snapshotTerminalRedrawTrace,
};
