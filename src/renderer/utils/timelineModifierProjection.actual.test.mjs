import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let modifier;
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'TimelineSegmentRow') {
    modifier = node.attributes.properties.find(prop => ['isCmdHeld', 'forkCmdHeld'].includes(prop.name?.getText(ast)))?.initializer?.expression;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(modifier, 'actual row projection must expose its cursor-only modifier');
const projected = vm.runInNewContext('(isCmdHeld, forkMarkerVisible) => (' + modifier.getText(ast) + ')');

test('ordinary markers never receive a changing Cmd prop', () => {
  assert.equal(projected(false, false), false);
  assert.equal(projected(true, false), false);
});

test('fork cursor still observes both press and release on its same hit target', () => {
  assert.equal(projected(false, true), false);
  assert.equal(projected(true, true), true);
});

test('Cmd prop changes are bounded by fork markers, not the number of ordinary rows', () => {
  for (const total of [100, 1000, 3000]) {
    const forks = new Set([3, 9]);
    const changed = Array.from({length:total}, (_, index) => projected(false, forks.has(index)) !== projected(true, forks.has(index))).filter(Boolean).length;
    assert.equal(changed, forks.size);
  }
});
