import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./WorkflowGroupMenu.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('menu.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function variable(name){let found;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name)found=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);assert.ok(found);return 'const '+found+';';}
const code=ts.transpileModule(['ok','execute','mutate'].map(variable).join('\n')+'\nmodule.exports={execute,mutate};',
 {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 const reports=[],busy=[],dismiss=[];
 const context={module:{exports:{}},lock:{current:false},screen:'main',revision:7,group:{id:'g',name:'terminal',revision:2},
  props:{workflowId:'main',workflowName:'Main'},setBusy:v=>busy.push(v),setRetry:v=>{context.retry=typeof v==='function'?v():v;},
  reportWorkflowActionError:(...args)=>reports.push(args),onDismiss:()=>dismiss.push(true),crypto:{randomUUID:()=> 'request-id'}};
 vm.runInNewContext(code,context);return {...context.module.exports,context,reports,busy,dismiss};
}
test('menu exception reports originating group/workflow in common Toast and retains exact retry after navigation',async()=>{
 const f=fixture();let reject,attempts=0;
 const action=()=>{attempts++;return new Promise((_r,no)=>{reject=no;});};
 const operation=f.execute(action,{kind:'collapse',mutationId:'frozen',collapsed:false});
 f.context.props={workflowId:'other',workflowName:'Other'};reject(Error('reply unknown'));await operation;
 assert.equal(f.reports.length,1);assert.equal(f.reports[0][1].workflowId,'main');assert.equal(f.reports[0][1].mutationId,'frozen');
 assert.equal(typeof f.context.retry,'function');
 const retry=f.context.retry();assert.equal(attempts,2);reject(Error('still unknown'));await retry;
 assert.equal(f.reports[1][1].workflowId,'main');assert.equal(f.reports[1][1].groupId,'g');
 assert.equal(f.dismiss.length,0);
 assert.doesNotMatch(source,/setError|role="alert"/,'failure is not retained in the menu');
});
test('definitive Main rejection leaves a fresh action available, without retrying the stale frozen request forever',async()=>{
 const f=fixture();await f.execute(()=>{throw Object.assign(Error('workflow_group_revision_changed'),{disposition:'not-applied'});});
 assert.equal(f.reports.length,1);assert.equal(f.context.retry,null);assert.equal(f.context.lock.current,false);
 await f.execute(()=>({success:true}));assert.equal(f.dismiss.length,1);
});
test('a negative action result is a copyable operation error; duplicate click cannot run a second mutation',async()=>{
 const f=fixture();let resolve,calls=0;
 const operation=f.execute(()=>{calls++;return new Promise(yes=>{resolve=yes;});},{kind:'close',mutationId:'close-id'});
 await f.execute(()=>{calls++;return true;});assert.equal(calls,1);
 resolve({success:false,error:'guard refused'});await operation;
 assert.equal(f.reports[0][0],'guard refused');assert.equal(f.reports[0][1].mutationId,'close-id');assert.equal(f.dismiss.length,0);
});
