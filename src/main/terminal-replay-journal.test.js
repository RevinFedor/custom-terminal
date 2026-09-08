const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { createTerminalReplayJournal } = require('./terminal-replay-journal');
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));

test('serialized baseline plus every raw chunk replays the actual xterm frame', async () => {
  const original = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const copy = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const addon = new SerializeAddon(); original.loadAddon(addon);
  const journal = createTerminalReplayJournal();
  try {
    await write(original, 'Select model\r\nold menu');
    journal.checkpoint(() => ({ rows: 8, cols: 40, writeSeq: 10, screen: addon.serialize({ scrollback: 0 }) }));
    for (const [index, chunk] of ['\x1b[2J\x1b[H', '› \x1b[2mAsk Codex', ' to do anything\x1b[0m\r\n', 'gpt-model max'].entries()) {
      journal.output(chunk, index + 11); await write(original, chunk);
    }
    const saved = journal.snapshot().current;
    await write(copy, saved.baseline.screen);
    for (const event of saved.events) await write(copy, event.data);
    const rows = t => Array.from({ length: t.rows }, (_, row) => t.buffer.active.getLine(row).translateToString(true));
    assert.equal(saved.complete, true);
    assert.deepEqual(rows(copy), rows(original));
    assert.equal(copy.buffer.active.cursorX, original.buffer.active.cursorX);
    assert.equal(copy.buffer.active.cursorY, original.buffer.active.cursorY);
  } finally { original.dispose(); copy.dispose(); }
});

test('overflow and a resize during pending writes remain explicit gaps', () => {
  const journal = createTerminalReplayJournal({ maxChars: 16 });
  journal.checkpoint(() => ({ screen: 'baseline' }));
  journal.output('a'.repeat(80), 1);
  assert.equal(journal.snapshot().current.complete, false);
  assert.ok(journal.snapshot().current.chars <= 16);
  journal.resize(80, 24, true);
  assert.equal(journal.snapshot().current.gapReason, 'resize-overlapped-pending-xterm-write');
});
