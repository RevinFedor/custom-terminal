import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function effect(file, marker) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selected;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes(marker)) selected = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(selected);
  return ts.transpileModule('const install=' + selected + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
for (const [name, file, marker] of [
  ['history/settings', './OrchestrationStatusChip.tsx', 'if (!historyOpen && !settingsOpen)'],
  ['shared message/continuation preview', './RequestDetailsPopover.tsx', 'const onKeyDown ='],
]) test('actual ' + name + ' Escape closes only its popup before terminal target input', () => {
  const listeners = [], removed = [], closed = [];
  const context = { historyOpen: true, settingsOpen: false, messagePreviewRef: { current: null },
    rootRef: { current: { contains: () => false } }, anchor: { contains: () => false }, previewRef: { current: null },
    setHistoryOpen: value => closed.push(['history', value]), setSettingsOpen: value => closed.push(['settings', value]),
    closeMessage() {}, onClose: () => closed.push(['message']),
    document: { addEventListener: (...args) => listeners.push(args), removeEventListener: (...args) => removed.push(args) } };
  const install = vm.runInNewContext(effect(file, marker) + ';install;', context), cleanup = install();
  const key = listeners.find(row => row[0] === 'keydown');
  assert.equal(key[2], true, 'must precede the xterm target, not run after its Escape write');
  let prevented = 0, stopped = 0;
  key[1]({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(prevented, 1); assert.equal(stopped, 1); assert.ok(closed.length);
  const before = closed.length;
  key[1]({ key: 'Enter', defaultPrevented: false }); assert.equal(closed.length, before);
  if (name === 'history/settings') {
    context.messagePreviewRef.current = {};
    key[1]({ key: 'Escape', defaultPrevented: false }); assert.equal(closed.length, before, 'child preview owns this Escape');
  }
  cleanup(); assert.ok(removed.some(row => row[0] === 'keydown' && row[1] === key[1] && row[2] === true));
});
