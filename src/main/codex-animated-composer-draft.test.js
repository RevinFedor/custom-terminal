'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { Terminal } = require('@xterm/headless');
const readiness = require('./codex-tui-readiness');
const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const part = name => {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};
const constants = source.split('\n').filter(line => /^const CODEX_(?:EMPTY_COMPOSER_HINT|NON_DRAFT_LINE)_RE =/.test(line)).join('\n');
const functions = vm.runInNewContext(constants + '\n' + part('getLogicalLineSnapshotAt')
  + '\n' + part('extractCodexDraftFromLine') + '\n({getLogicalLineSnapshotAt,extractCodexDraftFromLine})', {
  ...readiness,
  describeXtermCellStyle: () => ({}), xtermStyleHasNonDefaultBg: () => false,
});

test('headless animated composer becomes readable, while real braille user text is preserved and guarded', async (t) => {
  const terminal = new Terminal({ cols: 90, rows: 10, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  await write('⠁ ⠐ ›⠃private draft\r\n⢀ ⠈ gpt-6-astra max');
  const snapshot = functions.getLogicalLineSnapshotAt(terminal.buffer.active, 0);
  const parsed = functions.extractCodexDraftFromLine(snapshot);
  assert.equal(readiness.hasCodexComposerPromptGlyph(snapshot.text), true);
  assert.equal(parsed.hasDraft, true, 'decoration never turns non-empty input into empty proof');
  assert.equal(parsed.text, '⠃private draft', 'user braille is not stripped');
  const frame = readiness.selectCodexCurrentInteractiveFrameText([
    { text: snapshot.text }, { text: terminal.buffer.active.getLine(1).translateToString(true) },
  ]);
  assert.equal(readiness.inspectCodexInputReadyTextCore(frame, '', {
    requireSyncMarker: false, requireInitializedComposer: true,
  }).ready, true, 'ready and hasDraft are independent');
});

test('a decorated placeholder is never sufficient empty-input proof without cell/exact capture evidence', async (t) => {
  const terminal = new Terminal({ cols: 90, rows: 10, allowProposedApi: true });
  t.after(() => terminal.dispose());
  await new Promise(resolve => terminal.write('⠁ ›⠃\x1b[2mAsk Codex to do anything\x1b[0m', resolve));
  const snapshot = functions.getLogicalLineSnapshotAt(terminal.buffer.active, 0);
  const parsed = functions.extractCodexDraftFromLine(snapshot);
  assert.equal(parsed.hasDraft, true, 'non-dim decoration keeps the conservative exact-Copy fallback');
  assert.equal(parsed.text, '⠃Ask Codex to do anything');
});
