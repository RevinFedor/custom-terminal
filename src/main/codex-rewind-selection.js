'use strict';
const { stripLeadingCodexComposerPromptGlyph } = require('./codex-tui-readiness');
const { normalizeManualRewindText } = require('./codex-manual-rewind');

// Native Codex wraps its own selected cell, often with isWrapped=false on
// xterm rows. Keep those recorded row boundaries; joining them with spaces
// invents characters inside context-file paths. No within-row space is erased.
function matchCodexRewindSelectedRows(snapshot, expectedText) {
  const active = snapshot?.codexActivePrompt;
  const rows = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const start = rows.findIndex(row => row.row === active?.row);
  if (snapshot?.success !== true || active?.hasInverse !== true || start < 0
    || rows[start].hasInverse !== true) return null;
  const expected = normalizeManualRewindText(expectedText);
  let offset = 0;
  let count = 0;
  const selectedRows = [];
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    if (index > start && Number(row.row) !== Number(rows[index - 1].row) + 1) return null;
    let text = String(row.text || '');
    if (!text.trim()) continue;
    if (row.hasInverse !== true) break;
    text = count === 0 ? stripLeadingCodexComposerPromptGlyph(text) : text.replace(/^\s{1,2}/, '');
    text = normalizeManualRewindText(text);
    if (!text) continue;
    // The only optional space is at a proven physical row boundary. It may
    // be a source newline/word break or a renderer break inside a long token.
    if (count > 0 && expected[offset] === ' ') offset++;
    if (!expected.startsWith(text, offset)) return { matched: false, reason: 'selected-row-contradicts-target' };
    selectedRows.push(text);
    offset += text.length;
    count++;
  }
  if (count < 2 || offset < 16 || expected.slice(0, offset).split(/\s+/).length < 3) return null;
  return { matched: true, reason: 'active-display-rows', text: expected.slice(0, offset), selectedRows };
}

module.exports = { matchCodexRewindSelectedRows };
