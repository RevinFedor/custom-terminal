import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
const code=transformSync(fs.readFileSync(new URL('./linkedFileActions.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
function fixture() {
  const tab={id:'file',tabType:'file',filePath:'/private/synthetic.md',visualParentTabId:'owner'},calls=[];
  const state={openProjects:new Map([['p',{tabs:new Map([['file',tab]])}]]),tabCatalog:{file:{storageId:7}},
    closeTab:async(...args)=>{calls.push(['close',...args]);state.openProjects.get('p').tabs.delete('file');return true;}};
  let resolve; const pending=new Promise(r=>resolve=r),module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,require:()=>({useWorkspaceStore:{getState:()=>state}}),
    window:{require:()=>({ipcRenderer:{invoke:(...args)=>{calls.push(args);return pending;}}})},Set,Object,JSON});
  vm.runInContext(code,context);
  return {...module.exports,state,tab,calls,resolve};
}
test('Trash failure keeps the link; success closes exactly captured identity after ACK',async()=>{
  for(const success of [false,true]) {
    const f=fixture(),target=f.captureLinkedFileAction('p','file'),promise=f.deleteLinkedFile(target);
    assert.equal(f.calls.length,1);assert.equal(f.state.openProjects.get('p').tabs.has('file'),true);
    f.resolve(success);const result=await promise;
    assert.equal(result.ok,success);assert.equal(f.calls.filter(c=>c[0]==='close').length,Number(success));
  }
});
test('stale menu never deletes; late reparent never inherits old delete ACK',async()=>{
  for(const before of [true,false]) {
    const f=fixture(),target=f.captureLinkedFileAction('p','file');
    if(before)f.tab.visualParentTabId='other';
    const promise=f.deleteLinkedFile(target);
    if(!before)f.tab.visualParentTabId='other';
    f.resolve(true);assert.equal((await promise).ok,false);
    assert.equal(f.calls.filter(c=>c[0]==='file:delete').length,Number(!before));
    assert.equal(f.calls.filter(c=>c[0]==='close').length,0);
  }
});
test('repeated Delete while pending has one disk operation and one unlink',async()=>{
  const f=fixture(),target=f.captureLinkedFileAction('p','file'),first=f.deleteLinkedFile(target);
  assert.equal((await f.deleteLinkedFile(target)).ok,false);f.resolve(true);assert.equal((await first).ok,true);
  assert.equal(f.calls.length,2);
});
test('Unlink preserves disk and rejects a reparented stale menu',async()=>{
  const f=fixture(),target=f.captureLinkedFileAction('p','file');f.tab.visualParentTabId='other';
  assert.equal((await f.unlinkLinkedFile(target)).ok,false);assert.equal(f.calls.length,0);
  const current=f.captureLinkedFileAction('p','file');assert.equal((await f.unlinkLinkedFile(current)).ok,true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'close');
});
