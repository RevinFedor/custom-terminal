import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const source=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('HistoryPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),declarations={};
const visit=node=>{if(ts.isVariableDeclaration(node)&&['openHistoryAgent','toggleHistoryDetail'].includes(node.name.getText(ast)))
  declarations[node.name.getText(ast)]='globalThis.'+node.name.getText(ast)+'='+node.initializer.getText(ast)+';';ts.forEachChild(node,visit)};
visit(ast);
test('same saved child row is an open/close toggle, with functional updates',()=>{
  let selected=null,roster=true;
  const scope={useCallback:fn=>fn,setExpandedBackgroundChipKey:value=>{selected=typeof value==='function'?value(selected):value},setAgentRosterOpen:value=>{roster=value}};
  vm.runInNewContext(transformSync(Object.values(declarations).join('\n'),{loader:'tsx'}).code,scope);
  scope.toggleHistoryDetail('task:exact-a');assert.equal(selected,'task:exact-a');assert.equal(roster,false);
  scope.toggleHistoryDetail('task:exact-a');assert.equal(selected,null);
  scope.toggleHistoryDetail('task:exact-a');scope.toggleHistoryDetail('task:exact-b');assert.equal(selected,'task:exact-b');
  scope.openHistoryAgent('task:exact-b');assert.equal(selected,'task:exact-b','external open never becomes accidental close');
});
test('actual row removes only its status border and calls the existing toggle controller',()=>{
  // Full declaration is needed because comments live inside its body.
  let declaration='';const scan=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='SubAgentBlock')declaration=node.getText(ast);ts.forEachChild(node,scan)};scan(ast);
  assert.match(declaration,/onClick=\{\(\) => inspector.toggleAgent\(agentKey\)\}/);
  assert.doesNotMatch(declaration,/borderLeft/);
  assert.match(declaration,/aria-expanded=\{selected\}/);
  assert.match(source,/toggleAgent: toggleHistoryDetail/);
  assert.match(source,/openAgent: openHistoryAgent/);
});
