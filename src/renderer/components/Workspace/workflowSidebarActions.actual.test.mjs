import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=fs.readFileSync(new URL('./WorkflowTabSidebar.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('sidebar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function variable(name){let found;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name)found=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);assert.ok(found);return 'const '+found+';';}
const code=ts.transpileModule(variable('reportError')+'\n'+variable('create')+'\nmodule.exports={create,reportError};',
 {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const errorSource=fs.readFileSync(new URL('../../utils/workflowActionError.ts',import.meta.url),'utf8');
const errorCode=ts.transpileModule(errorSource.replace(/^import .*;\n/m,'').replace('export function','function'),
 {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){
 const calls=[],toasts=[],loading=[],current={activeSpaceId:'voice',splitPanes:[]};
 const props={sourceTabId:'source',fallbackCwd:'/voice-record',onCreateTab:async r=>{calls.push(r);}};
 const context={module:{exports:{}},Error,console:{warn(){}},creating:false,props,workflowId:'voice',
  state:{spaces:[{id:'voice',name:'Voice Record'}]},model:{catalog:new Map([['source',{tabId:'source',tab:{cwd:'/habit-tracker'}}]])},
  useWorkspaceStore:{getState:()=>current},useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})},
  setCreating:value=>loading.push(value)};
 vm.runInNewContext(errorCode+'\n'+code,context);return {...context.module.exports,props,calls,toasts,loading,current};
}
test('actual blank-space New sends the workflow directory; absent default preserves explicit source fallback',async()=>{
 const f=fixture();await f.create('codex');assert.equal(f.calls[0].cwd,'/voice-record');
 assert.equal(f.calls[0].workflowId,'voice');assert.equal(f.calls[0].action,'codex');
 f.props.fallbackCwd='';await f.create('claude');assert.equal(f.calls[1].cwd,'/habit-tracker');
 assert.deepEqual(f.toasts,[]);
});
test('late creation rejection produces one copyable toast with the originating workflow, not sidebar state',async()=>{
 const f=fixture();let reject;
 f.props.onCreateTab=()=>new Promise((_resolve,no)=>{reject=no;});
 const work=f.create('codex');assert.deepEqual(f.loading,[true]);assert.deepEqual(f.toasts,[]);
 f.current.activeSpaceId='other';reject(new Error('execution_exact_address_required'));await work;
 assert.deepEqual(f.loading,[true,false]);assert.equal(f.toasts.length,1);
 const [message,type,duration,persistent,copyText]=f.toasts[0];
 assert.match(message,/Voice Record/);assert.match(message,/execution_exact_address_required/);
 assert.equal(type,'error');assert.equal(duration,8000);assert.equal(persistent,true);
 assert.match(copyText,/Workflow ID: voice/);assert.match(copyText,/Error: execution_exact_address_required/);
 assert.doesNotMatch(source,/className="workflow-reserve-error"/,'no retained error row to leak into another workflow');
});
test('Copy includes the exact group request, revisions, outcome and original workflow after navigation',()=>{
 const f=fixture();f.current.activeSpaceId='other';
 const reason=Object.assign(new Error('workflow_group_revision_changed'),{disposition:'not-applied',workflowOperation:{
   kind:'collapse',groupId:'terminal-group',mutationId:'immutable-request',expectedRevision:12,currentRevision:13,
   expectedGroupRevision:3,currentGroupRevision:3,collapsed:false,stage:'workflow:group-mutate'}});
 f.reportError(reason,'Expand group');const toast=f.toasts[0];
 for(const part of ['Workflow ID: voice','Time UTC:','immutable-request','terminal-group','expectedRevision','currentRevision',
   'workflow:group-mutate','Outcome: not-applied'])assert.ok(toast[4].includes(part),part);
 assert.equal(toast[9],toast[4]);assert.equal(toast[7],undefined,'global upper-right toast, not a different focused tab');
 // Execute the existing Toast Copy handler; the real clipboard port is controlled.
 const toastSource=fs.readFileSync(new URL('../UI/Toast.tsx',import.meta.url),'utf8');
 const toastTree=ts.createSourceFile('toast.tsx',toastSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let click;function visit(n){if(ts.isJsxAttribute(n)&&n.name.text==='onClick'&&n.getText(toastTree).includes('clipboard.writeText(toast.copyText'))click=n.initializer.expression.getText(toastTree);ts.forEachChild(n,visit);}visit(toastTree);
 assert.ok(click);const writes=[];
 const handler=vm.runInNewContext(ts.transpileModule('('+click+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
  {toast:{copyText:toast[4]},window:{require:()=>({clipboard:{writeText:value=>writes.push(value)}})},
    setCopyConfirmed(){},copyResetTimerRef:{current:null},setTimeout:()=>1,clearTimeout(){}});
 handler({stopPropagation(){}});assert.deepEqual(writes,[toast[4]]);
});
test('other sidebar action failures use the same existing copyable toast surface',()=>{
 const f=fixture();f.reportError('refused','Не удалось открыть вкладку');
 assert.equal(f.toasts.length,1);assert.match(f.toasts[0][4],/Action: Не удалось открыть вкладку/);
});
