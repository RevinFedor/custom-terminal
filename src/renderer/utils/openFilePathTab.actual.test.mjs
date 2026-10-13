import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {transformSync} from 'esbuild';
import {findOpenTabOwner} from './tabLinkNavigation.mjs';
import {tabNavigationLocation} from './tabNavigationLocation.mjs';
import {commitCreatedTabSnapshot} from './tabCreationCommit.mjs';
import {createProjectTabSaveQueue} from './projectTabSaveQueue.mjs';

const code=transformSync(fs.readFileSync(new URL('./openFilePathTab.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function fixture() {
  const calls=[],files=new Map(),workspace={projectId:'p',activeTabId:'agent',tabs:new Map([['agent',{id:'agent',cwd:'/agent',codexSessionId:'saved'}]])};
  const state={view:'workspace',activeSpaceId:'w',activeProjectId:'p',organizationReady:true,navigationRevision:0,windowDisplayKey:'display',
    spaces:[{id:'w'}],splitPanes:[],splitFocusedIndex:0,tabCatalog:{},tabWorkflowMembership:{},pendingTabWorkflowMembership:{},
    openProjects:new Map([['p',workspace]])};
  const queue=createProjectTabSaveQueue();let sequence=0,hold=null,persisted=0;
  state.createWorkflowTab=async request=>{
    calls.push(['create',request]);const id='file-'+(++sequence);
    const record={id,name:request.name,cwd:request.cwd,...request.tabOptions};
    const result=await commitCreatedTabSnapshot({queue,projectId:'p',isWorkspaceCurrent:()=>true,getCurrentTabs:()=>workspace.tabs,
      buildCandidateTabs:base=>new Map([...base,[id,record]]),
      persist:async()=>{await hold?.promise;persisted++;return {success:true};},
      publish:tabs=>{workspace.tabs=tabs;state.tabWorkflowMembership[id]={workflowId:request.workflowId,revision:1};}});
    return result.success?id:'';
  };
  state.openTabById=async(id,options)=>{calls.push(['open',id,options]);return true;};
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,console:{log(){},warn(){}},
    require:name=>name.includes('useWorkspaceStore')?{useWorkspaceStore:{getState:()=>state}}
      :name.includes('useUIStore')?{useUIStore:{getState:()=>({showToast:(...args)=>calls.push(['toast',...args])})}}
      :name.endsWith('tabLinkNavigation.mjs')?{findOpenTabOwner}:{tabNavigationLocation},
    window:{require:name=>{if(name==='path')return path;assert.equal(name,'electron');return {ipcRenderer:{invoke:async(channel,paths)=>{
      assert.equal(channel,'file:exists-batch');calls.push(['exists']);return Object.fromEntries(paths.map(p=>[p,files.get(p)!==false]));}}};}}});
  return {state,calls,files,workspace,open:module.exports.openFilePathTab,hold:()=>{hold=deferred();return hold;},counts:()=>({created:sequence,persisted})};
}
test('disk file becomes an independent file chip through durable creation, never a provider or AI link',async()=>{
  const f=fixture();assert.equal(await f.open('/fixture/a.md'),true);
  const tab=f.workspace.tabs.get('file-1');
  assert.equal(tab.tabType,'file');assert.equal(tab.filePath,'/fixture/a.md');assert.equal(tab.visualParentTabId,undefined);
  assert.equal(f.workspace.tabs.get('agent').codexSessionId,'saved');
  assert.equal(await f.open('/fixture/a.md'),true);assert.deepEqual(f.counts(),{created:1,persisted:1});
  assert.equal(f.calls.filter(c=>c[0]==='open').length,2);
});
test('concurrent clicks share one durable creation; only latest request may navigate',async()=>{
  const f=fixture(),hold=f.hold();const a=f.open('/fixture/a.md'),b=f.open('/fixture/a.md');hold.resolve();
  assert.deepEqual(await Promise.all([a,b]),[false,true]);assert.deepEqual(f.counts(),{created:1,persisted:1});
  assert.equal(f.calls.filter(c=>c[0]==='open').length,1);
});
test('navigation away while creating keeps the durable file in reserve without late focus',async()=>{
  const f=fixture(),hold=f.hold(),opening=f.open('/fixture/a.md');
  f.state.navigationRevision++;f.state.activeSpaceId='other';hold.resolve();
  assert.equal(await opening,false);assert.equal(f.calls.some(c=>c[0]==='open'),false);
  assert.ok(f.workspace.tabs.has('file-1'));assert.equal(f.state.tabWorkflowMembership['file-1'].workflowId,'w');
});
test('explicit file actions forward exact identity; missing file does not allocate a tab',async()=>{
  const f=fixture();f.files.set('/missing.md',false);
  assert.equal(await f.open('/missing.md'),false);assert.equal(f.counts().created,0);
  assert.equal(await f.open('/fixture/a.md','replace-shown'),true);
  assert.equal(f.calls.find(c=>c[0]==='open')[2].windowAction,'replace-shown');
  assert.equal(await f.open('/fixture/a.md','beside'),true);assert.equal(f.counts().created,1);
});
test('unambiguous existing file in another workflow is revealed, not cloned or reparented',async()=>{
  const f=fixture();const file={id:'linked',tabType:'file',filePath:'/fixture/a.md',visualParentTabId:'owner'};
  f.workspace.tabs.set('linked',file);f.state.tabWorkflowMembership.linked={workflowId:'other',revision:7};
  assert.equal(await f.open('/fixture/a.md'),true);assert.equal(f.counts().created,0);
  assert.equal(f.calls[0][1],'linked');assert.equal(file.visualParentTabId,'owner');
});
