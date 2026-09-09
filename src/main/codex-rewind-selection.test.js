'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { matchCodexRewindSelectedRows } = require('./codex-rewind-selection');
const { normalizeManualRewindText, readManualCodexRewindSelectedText } = require('./codex-manual-rewind');
const { stripLeadingCodexComposerPromptGlyph } = require('./codex-tui-readiness');

const target = '<context_file name="Inbox-retake-document.txt" path="/private/var/folders/72/jx261489331_qw1xj740p5lc0000gn/T/noted-terminal-mobile-attachments/60d7f853-a3ac-4a48-b6e3-d08a13b3f17b/Inbox-retake-document.txt" role="source" sha256="f01a3df8fec9abdc119d5c2088fdb0e25e193c1e396127e0067ab29c7d844736" bytes="9">\nTXT_9157\n\n</context_file>\n\nRead only the attached text document. Return its token.';
function fixture() {
  const split = target.replace('/72/jx', '/72/\njx').replace('60d7f853-a3ac', '60d7f853-\na3ac');
  const lines = split.split('\n').map((text, index) => ({ row: 33 + index,
    text: (index ? '  ' : '› ') + text, hasInverse: !!text, wrapped: false }));
  const active = { row: 33, hasInverse: true, text: readManualCodexRewindSelectedText(lines, 33) };
  return { success: true, lines, codexActivePrompt: active };
}

test('physical context_file path wraps match only within the active inverse cell', () => {
  const snapshot = fixture();
  assert.ok(snapshot.codexActivePrompt.text.includes('/72/\njx'));
  assert.equal(matchCodexRewindSelectedRows(snapshot, target).matched, true);
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  function extract(name) {
    let found;
    function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; else ts.forEachChild(node, visit); }
    visit(ast); assert.ok(found, name); return found.getText(ast);
  }
  const match = vm.runInNewContext(['buildCodexRewindAnchors', 'buildCodexShortRewindAnchors', 'matchCodexRewindActivePromptSnapshot'].map(extract).join('\n') + '\nmatchCodexRewindActivePromptSnapshot', {
    normalizeCandidate: normalizeManualRewindText, stripLeadingCodexComposerPromptGlyph, matchCodexRewindSelectedRows,
  });
  assert.equal(match(snapshot, target).matched, true, 'actual pre-Enter matcher consumes the row proof');
  const differentTail = fixture();
  differentTail.lines.at(-1).text += ' UNRELATED';
  assert.equal(match(differentTail, target).matched, false, 'a matching header cannot hide a visible contradictory tail');
});

test('selection proof rejects foreign row, missing style, row gaps and interior token spaces', () => {
  for (const change of [
    s => { s.codexActivePrompt.row = 99; },
    s => { s.codexActivePrompt.hasInverse = false; },
    s => { s.lines[1].row++; },
    s => { s.lines[1].text = s.lines[1].text.replace('jx2614', 'jx 2614'); },
    s => { s.lines[2].text = s.lines[2].text.replace('a3ac', 'b3ac'); },
  ]) {
    const s = fixture(); change(s);
    assert.notEqual(matchCodexRewindSelectedRows(s, target)?.matched, true, String(change));
  }
  const unselected = fixture();
  unselected.lines[1].hasInverse = false;
  assert.equal(matchCodexRewindSelectedRows(unselected, target), null);
});

test('source word/newline breaks remain distinct from spaces inside displayed rows', () => {
  const lines = ['› first words at a', '  word boundary; /a/long/', '  token and a final sentence.']
    .map((text, row) => ({ row, text, hasInverse: true, wrapped: false }));
  const s = { success: true, lines, codexActivePrompt: { row: 0, hasInverse: true } };
  assert.equal(matchCodexRewindSelectedRows(s, 'first words at a word boundary; /a/long/token and a final sentence.').matched, true);
  assert.equal(matchCodexRewindSelectedRows(s, 'first words at awordboundary; /a/long/token and a final sentence.').matched, false);
});
