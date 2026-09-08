import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../hooks/useAgentSettingsActivity.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('hook.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['snapshots', 'listeners', 'snapshot', 'accept']);
const parts = ast.statements.filter(node => (
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text)
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name?.text))
));
const code = ts.transpileModule(parts.map(n => n.getText(ast)).join('\n') + '\nglobalThis.api = { snapshot, accept };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('unmounted A keeps its main operation while B is displayed; late reads cannot resurrect it', () => {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const { snapshot, accept } = context.api;
  accept({ tabId: 'A', sequence: 5, busy: true, target: 'model' });
  accept({ tabId: 'B', sequence: 1, busy: false, target: null });
  assert.equal(snapshot('B').busy, false);
  assert.equal(snapshot('A').busy, true, 'no mount effect/reset needed for return');
  accept({ tabId: 'A', sequence: 7, busy: false, target: null });
  accept({ tabId: 'A', sequence: 5, busy: true, target: 'model' });
  assert.equal(snapshot('A').busy, false);
  assert.equal(snapshot('A').sequence, 7);
});
