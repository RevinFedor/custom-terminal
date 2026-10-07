import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./useUIStore.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('useUIStore.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function action(name,set) {
  let expression;
  const walk=node => {if(ts.isPropertyAssignment(node)&&node.name.getText(ast)===name)expression=node.initializer;ts.forEachChild(node,walk);};
  walk(ast);assert.ok(expression,name);
  const js=ts.transpileModule('('+expression.getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext(js,{set});
}
function fixture() {
  let state={historyScrollToUuid:null,historyScrollTargetTabId:null,historyScrollToolTarget:null,historyScrollRequestGeneration:0};
  const set=change => {state={...state,...change(state)};};
  return {read:() => state,scroll:action('setHistoryScrollToUuid',set),cancel:action('cancelHistoryScrollRequest',set)};
}
test('actual store atomically scopes inner-tool navigation; consumption retains ownership generation', () => {
  const f=fixture(),tool={toolUseId:'call',readSessionId:'sid',requestId:'first'};
  f.scroll('row','tab',tool);assert.equal(f.read().historyScrollRequestGeneration,1);
  assert.equal(f.read().historyScrollToolTarget,tool);assert.equal(f.read().historyScrollTargetTabId,'tab');
  f.scroll(null);assert.equal(f.read().historyScrollToolTarget,null);
  assert.equal(f.read().historyScrollRequestGeneration,1);
});
test('actual store repeated clicks have different owners, late cancellation cannot discard the new click', () => {
  const f=fixture();f.scroll('row','tab',{requestId:'first'});f.scroll('row','tab',{requestId:'second'});
  assert.equal(f.read().historyScrollRequestGeneration,2);f.cancel(1);
  assert.equal(f.read().historyScrollToolTarget.requestId,'second');
  f.cancel(2);assert.equal(f.read().historyScrollToUuid,null);assert.equal(f.read().historyScrollRequestGeneration,3);
});
test('ordinary Timeline seek drops tool scope, stays deduplicated and remains tab-specific', () => {
  const f=fixture();f.scroll('row','A',{requestId:'tool'});f.scroll('row','B');
  assert.equal(f.read().historyScrollToolTarget,null);assert.equal(f.read().historyScrollTargetTabId,'B');
  assert.equal(f.read().historyScrollRequestGeneration,2);f.scroll('row','B');
  assert.equal(f.read().historyScrollRequestGeneration,2);
});
