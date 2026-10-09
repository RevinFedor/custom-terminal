import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
test('actual Timeline has stable hook topology across pristine → adopted session → no session', () => {
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Timeline');
  assert.ok(component);
  const early = component.body.statements.find(node => ts.isIfStatement(node) && /!sessionId/.test(node.expression.getText(ast)));
  assert.ok(early);
  let lastHook = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z]/.test(node.expression.text)) lastHook = Math.max(lastHook, node.getStart(ast));
    ts.forEachChild(node, visit);
  }
  visit(component);
  assert.ok(early.getStart(ast) > lastHook, 'session return must come after every hook, including saved SC metadata');
});
