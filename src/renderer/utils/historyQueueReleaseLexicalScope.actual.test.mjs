import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const filename = new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url).pathname;
const source = fs.readFileSync(filename, 'utf8');

// Bind the ACTUAL complete module without loading/executing its imports or an
// App. Unlike an extracted JSX VM, no imaginary helper is injected here.
function unresolvedControlValues(text) {
  const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === filename ? file : undefined;
  host.fileExists = name => name === filename;
  host.readFile = name => name === filename ? text : undefined;
  const program = ts.createProgram([filename], options, host), checker = program.getTypeChecker();
  const control = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'HistorySendQueueReleaseAction');
  assert.ok(control);
  const bad = new Set();
  function visit(node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const property = ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isJsxAttribute(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node;
      const intrinsic = (ts.isJsxOpeningElement(parent) || ts.isJsxClosingElement(parent)
        || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node && /^[a-z]/.test(node.text);
      if (!property && !intrinsic && !checker.getSymbolAtLocation(node)) bad.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(control);
  return [...bad].sort();
}

test('actual full-module scope rejects the original foreign-local handler and resolves every CURRENT recovery-control value', () => {
  const legacy = source.replace('onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={async event => {',
    'onMouseDown={stopActionPropagation} onClick={async event => {');
  assert.notEqual(legacy, source, 'the same exact introduced JSX boundary must be compared');
  assert.deepEqual(unresolvedControlValues(legacy), ['stopActionPropagation']);
  assert.deepEqual(unresolvedControlValues(source), []);
});
