const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { classifyClaudePasteReadyFrame, expectedClaudePasteShape } = require('./claude-paste-submit-readiness');

async function snapshot(text, cols) {
  const terminal = new Terminal({ cols, rows: 12, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write('\x1b[2J\x1b[H' + text, resolve));
    const buffer = terminal.buffer.active;
    return { success: true, authoritativeFrameCommitted: true, writeSeq: 2, flushedSeq: 2,
      committedFrameGeneration: 2, baseY: buffer.baseY, cursorY: buffer.cursorY, cursorX: buffer.cursorX,
      lines: Array.from({ length: buffer.length }, (_, row) => ({ row,
        text: buffer.getLine(row).translateToString(true), wrapped: buffer.getLine(row).isWrapped })) };
  } finally { terminal.dispose(); }
}

test('real xterm soft wrapping does not turn a prompt glyph inside text into another input', async () => {
  const text = 'a'.repeat(35) + ' ❯';
  for (const cols of [20, 40, 100]) {
    const result = classifyClaudePasteReadyFrame({ snapshot: await snapshot('❯ ' + text, cols),
      identityCurrent: true, baselineCommittedFrameGeneration: 1, ...expectedClaudePasteShape(text) });
    assert.equal(result.action, 'ready', 'width=' + cols);
  }
});

test('status words inside a real input are not a Pasting or editor state', async () => {
  for (const text of ['Explain Pasting… and Enter', 'What does Save and close editor to continue mean?']) {
    const result = classifyClaudePasteReadyFrame({ snapshot: await snapshot('❯ ' + text, 100),
      identityCurrent: true, baselineCommittedFrameGeneration: 1, ...expectedClaudePasteShape(text) });
    assert.equal(result.action, 'ready', text);
  }
});

test('a separate actual Pasting status still blocks a final-looking pasted carrier', async () => {
  const result = classifyClaudePasteReadyFrame({
    snapshot: await snapshot('❯ [Pasted content #1]\r\nPasting…', 100),
    identityCurrent: true, baselineCommittedFrameGeneration: 1, expectedHasText: true,
  });
  assert.equal(result.reason, 'claude-still-pasting');
});
