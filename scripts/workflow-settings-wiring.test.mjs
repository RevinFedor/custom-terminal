import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/renderer/components/UI/SettingsModal.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SettingsModal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' && node.arguments[0]?.getText(ast).includes('prevIsOpenRef.current = isOpen')) callback = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback, 'Actual requested-settings effect must exist');
const compiled = ts.transpileModule(`(${callback})()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

for (const initialTab of ['ai', 'fonts', 'colors', 'shortcuts']) {
  test(`Actual open effect preserves settings address ${initialTab}`, () => {
    const accepted = [];
    const context = { isOpen: true, initialTab, prevIsOpenRef: { current: false }, setActiveTab: value => accepted.push(value) };
    vm.runInNewContext(compiled, context);
    assert.deepEqual(accepted, [initialTab]);
    vm.runInNewContext(compiled, context);
    assert.equal(accepted.length, 1, 'Open effect does not override manual navigation while already open');
  });
}
test('Removed Directories address cannot select a nonexistent settings panel', () => {
  const context = { isOpen: true, initialTab: 'directories', prevIsOpenRef: { current: false }, setActiveTab: () => assert.fail('Unknown panel selected') };
  vm.runInNewContext(compiled, context);
});
