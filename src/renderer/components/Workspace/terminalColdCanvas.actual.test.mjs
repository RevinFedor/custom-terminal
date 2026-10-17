import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./Terminal.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('Terminal.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let scheduling;const declarations=new Map();
function visit(n){
  if(ts.isIfStatement(n)&&n.expression.getText(tree)==='active && isActiveProject && mayClaimFocus')scheduling=n;
  if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);
  ts.forEachChild(n,visit);
}visit(tree);
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('actual cold initialization uses the existing warm lane for a closed terminal panel, and immediate init for visible terminal',async()=>{
  assert.ok(scheduling,'actual mount scheduling boundary');
  for(const visible of [false,true]){
    let initialized=0;const queued=[];
    const ctx={active:true,isActiveProject:true,mayClaimFocus:visible,
      tabId:'child',performance:{now:()=>0},console:{warn(){}},
      isMounted:{current:true},terminalRef:{current:{}},xtermInstance:{current:null},isCreatingRef:{current:false},
      initTerminal:async()=>{initialized++},scheduleTerminalWarmInit:(_id,fn)=>queued.push(fn),
      markRendererActivity:()=>()=>{},terminalWarmQueue:new Map()};
    vm.runInNewContext(compile('(()=>{'+scheduling.getText(tree)+'})()'),ctx);
    assert.equal(initialized,visible?1:0);assert.equal(queued.length,visible?0:1);
    if(!visible){await queued[0]();assert.equal(initialized,1);}
  }
});
test('authoritative shell readiness starts pending Fork once even with no xterm instance',()=>{
  const decl=name=>{const n=declarations.get(name);assert.ok(n);return 'const '+n.getText(tree)+';';};
  const calls=[],pending={contextFork:{sourceTabId:'source',sourceSessionId:'source-sid'}};
  const ctx={tabId:'child',pendingActionExecuted:{current:false},getTabPendingAction:()=>pending,
    executePendingAction:(id,action)=>calls.push({id,action}),console:{log(){}}};
  vm.runInNewContext(compile(decl('executePendingActionAtShellPrompt')+decl('handleShellPromptReady')
    +';handleShellPromptReady(null,"other",{ready:true});handleShellPromptReady(null,"child",{ready:false});'
    +'handleShellPromptReady(null,"child",{ready:true});handleShellPromptReady(null,"child",{ready:true});'),ctx);
  assert.equal(calls.length,1);assert.equal(calls[0].id,'child');assert.equal(calls[0].action,pending);
});
