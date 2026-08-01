'use strict';

// Regression coverage for the "phantom draft" class of false positives.
//
// The Claude composer proof reads the logical row that owns the xterm cursor and
// treats everything right of the last `❯` as the current draft. That is only
// true when the cell content right of the marker was written by the SAME redraw
// that placed the cursor. A partial repaint which rewrites `❯ ` without erasing
// to end-of-line leaves the previous frame's characters physically in the row;
// the cursor sits at column 2 while stale glyphs still occupy columns 2..N.
//
// Production incident 2026-07-29 (tab-2599, session ff7d9b60): the screen proof
// reported `found` with preview "на вкладку, переживает перезапуск, гасят друг
// друга оставь" four times while the authoritative Ctrl+G external-editor grab
// returned chars=0 every time. The phrase does not exist contiguously anywhere
// in the session JSONL — it is a mosaic of residual cells, not a real draft.
//
// These tests pin the discriminator that must survive any future fix: a row
// whose text is longer than the cursor column, with no evidence that the trailing
// cells belong to the current frame, must not be reported as a proven draft.

const assert = require('node:assert/strict');
const test = require('node:test');
const { Terminal } = require('@xterm/headless');
const { parseClaudeComposerCurrentFrame } = require('./claude-composer-proof');

function writeAll(term, chunks) {
  return chunks.reduce(
    (chain, chunk) => chain.then(() => new Promise((resolve) => {
      if (typeof chunk === 'object' && chunk && Array.isArray(chunk.resize)) {
        term.resize(chunk.resize[0], chunk.resize[1]);
        resolve();
        return;
      }
      term.write(chunk, resolve);
    })),
    Promise.resolve(),
  );
}

function snapshotOf(term) {
  const buf = term.buffer.active;
  const start = buf.viewportY;
  const end = Math.min(start + term.rows, buf.length);
  const lines = [];
  for (let row = start; row < end; row += 1) {
    const line = buf.getLine(row);
    if (!line) continue;
    let occupiedEndX = 0;
    let promptCellX = null;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth?.() === 0) continue;
      const chars = String(cell.getChars?.() || '');
      if (chars.includes('❯') || chars.includes('›')) promptCellX = x;
      if (chars.replace(/[▌█]/g, '').trim()) {
        occupiedEndX = x + Math.max(1, Number(cell.getWidth?.()) || 1);
      }
    }
    lines.push({
      row,
      text: line.translateToString(true),
      wrapped: !!line.isWrapped,
      occupiedEndX,
      promptCellX,
    });
  }
  return {
    source: 'headless-main',
    baseY: buf.baseY,
    viewportY: buf.viewportY,
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    rows: term.rows,
    cols: term.cols,
    lines,
  };
}

async function frameAfter(chunks, { cols = 82, rows = 18 } = {}) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  await writeAll(term, chunks);
  return snapshotOf(term);
}

// The exact phrase from the production incident.
const INCIDENT_DRAFT = 'на вкладку, переживает перезапуск, гасят друг друга оставь';

const TRANSCRIPT = Array.from({ length: 12 }, (_, index) =>
  '❯ old user prompt ' + index + '\r\n\r\n  assistant answer ' + index + '\r\n\r\n');

test('positive control: text actually typed into the composer is a proven draft', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT, '❯ ' + INCIDENT_DRAFT,
  ]);
  const proof = parseClaudeComposerCurrentFrame(snapshot);
  assert.equal(proof.proofOutcome, 'found');
  assert.equal(proof.hasDraft, true);
  assert.equal(proof.text, INCIDENT_DRAFT);
});

test('negative control: a repaint that erases the line proves an empty composer', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT,
    '❯ ' + INCIDENT_DRAFT,
    // What ansi-escapes eraseLines()/log-update actually emits: CR + erase line.
    '\r\x1b[2K', '❯ ',
  ]);
  const proof = parseClaudeComposerCurrentFrame(snapshot);
  assert.equal(proof.proofOutcome, 'absent');
  assert.equal(proof.hasDraft, false);
});

test('a partial repaint without erase-to-EOL must not be reported as a real draft', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT,
    '❯ ' + INCIDENT_DRAFT,
    // Marker repainted in place, no erase: cursor returns to column 2 while the
    // previous frame's glyphs still occupy the rest of the row.
    '\r', '❯ ',
  ]);
  const proof = parseClaudeComposerCurrentFrame(snapshot);

  assert.equal(snapshot.cursorX, 2, 'cursor parks right after the marker');
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.hasDraft, null);
  assert.equal(proof.proofReason, 'composer-content-after-cursor');
  assert.equal(proof.exactCaptureRecommended, true);
});

test('cursor column contradicts the row text when leftovers survive a repaint', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT, '❯ ' + INCIDENT_DRAFT, '\r', '❯ ',
  ]);
  const proof = parseClaudeComposerCurrentFrame(snapshot);
  const promptLine = snapshot.lines.find((line) => line.row === proof.promptRow);

  // This is the signal a corrected proof can key on without a new PTY channel:
  // a real typed draft leaves the caret at the end of its own text, whereas
  // stale cells extend far beyond the caret.
  assert.ok(promptLine, 'prompt row is inside the visible frame');
  assert.ok(
    promptLine.text.trimEnd().length > snapshot.cursorX,
    'row content extends past the cursor, so the tail cannot be current-frame input',
  );
});

test('a genuinely typed draft keeps the caret at the end of its own text', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT, '❯ ' + INCIDENT_DRAFT,
  ]);
  const promptLine = snapshot.lines.find((line) => line.row === snapshot.baseY + snapshot.cursorY);
  assert.ok(promptLine);
  assert.equal(
    promptLine.text.trimEnd().length,
    snapshot.cursorX,
    'for real input the caret sits exactly at the end of the row content',
  );
});

test('a real draft with the caret moved into its text is ambiguous, never empty', async () => {
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', ...TRANSCRIPT, '❯ ' + INCIDENT_DRAFT,
    '\x1b[10D',
  ]);
  const proof = parseClaudeComposerCurrentFrame(snapshot);
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.exactCaptureRecommended, true);
});

test('reflow can splice unrelated leftovers into one row after a resize', async () => {
  // Fragments from different earlier frames end up on one logical line once
  // xterm reflows, which is how the incident preview read as a plausible
  // sentence that exists nowhere in the transcript.
  const snapshot = await frameAfter([
    '\x1b[2J\x1b[H', 'filler\r\n',
    '❯ на вкладку, переживает перезапуск, гасят друг друга оставь TAIL',
    '\r', '❯ ',
    { resize: [82, 16] },
  ], { cols: 40, rows: 16 });
  const proof = parseClaudeComposerCurrentFrame(snapshot);
  assert.ok(
    ['found', 'absent', 'unknown'].includes(proof.proofOutcome),
    'reflow path stays a defined outcome instead of throwing',
  );
});
