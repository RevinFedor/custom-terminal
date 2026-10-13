import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as panes from '../utils/splitPanesModel.mjs';
import * as chooser from '../utils/windowTabChooser.mjs';
import {findOpenTabOwner} from '../utils/tabLinkNavigation.mjs';

const tree=ts.createSourceFile('store.ts',fs.readFileSync(new URL('./useWorkspaceStore.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
function method(name){let value;function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(tree)===name)value=n.initializer.getText(tree);ts.forEachChild(n,visit);}visit(tree);assert.ok(value);return ts.transpileModule('module.exports='+value,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;}
const methods=['openWindowTabChooser','createTabForWindowChooser','createSDKTab'];
const compiled=Object.fromEntries(methods.map(name=>[name,method(name)]));
const namespace='__tab_catalog_v2__';
function fixture({legacy=false,center=false}={}){
 const old={id:'old',cwd:'/habit-tracker'};
 const state={organizationReady:!legacy,activeSpaceId:'voice',spaces:[{id:'voice',defaultCwd:'/voice-record',layout:{}},{id:'other',layout:{}}],
  activeProjectId:'habit',activeSpaceTab:null,splitFocusedIndex:0,splitPanes:center?[]:[{windowId:'empty',projectId:'habit',tabId:''}],
  centerStrips:{},tabCatalog:{},tabWorkflowMembership:{old:{workflowId:'other'}},pendingTabWorkflowMembership:{},
  openProjects:new Map([['habit',{projectId:'habit',projectPath:'/habit-tracker',activeTabId:'old',tabs:new Map([['old',old]])}],
   [namespace,{projectId:namespace,projectPath:'',tabs:new Map()}]]),
  centerStripKey:()=> 'habit',getFocusedProjectId:()=> 'habit',saveSession(){},activateCenterTab(){}};
 const ui={activeArea:'workspace',setActiveArea(){},showToast(...args){calls.push(['toast',...args]);}};
 const calls=[],context={get:()=>state,set:p=>Object.assign(state,p),console:{log(){},warn(){},error(){}},
  ...panes,...chooser,findOpenTabOwner,GLOBAL_EXECUTION_NAMESPACE:namespace,resolveWorkspaceCwd:value=>value||'/home',
  useUIStore:{getState:()=>ui},chooserLaunchesInFlight:new Map(),notifyWindowChooserLaunch(){},EMPTY_TAB_NAME:'',
  readSessionIdFromClipboard:()=>null,getNextAvailableName:()=> 'claude',process:{env:{HOME:'/home'}}};
 for(const name of methods){context.module={exports:{}};vm.runInNewContext(compiled[name],context);state[name]=context.module.exports;}
 state.createTabAfterCurrent=async(project,name,cwd,options)=>{
  calls.push(['create',project,cwd,options.workflowId]);
  if(state.beforePublish)await state.beforePublish();
  if(!options.canPublish())return '';
  Object.assign(state,options.onPublish('created'));return 'created';
 };
 return{state,calls};
}
for(const center of [false,true])test('new '+(center?'center':'empty window')+' chooser uses workflow cwd, not last legacy project',()=>{
 const f=fixture({center}),id=f.state.openWindowTabChooser(center?null:0);
 const slot=panes.paneChooserSlots(f.state.splitPanes[0]).find(x=>x.slotId===id);
 assert.equal(slot.projectId,namespace);assert.equal(slot.cwd,'/voice-record');
 assert.deepEqual(panes.paneTabs(f.state.splitPanes[0]),[],'do not import the previous workflow tab');
});
test('legacy project chooser keeps its root while workflow explicit directory stays immutable',async()=>{
 const legacy=fixture({legacy:true}),old=legacy.state.openWindowTabChooser(0);
 assert.equal(panes.paneChooserSlots(legacy.state.splitPanes[0])[0].cwd,'/habit-tracker');
 const f=fixture(),id=f.state.openWindowTabChooser(0);
 f.state.splitPanes=panes.setChooserSlotDirectory(f.state.splitPanes,0,id,'/explicit/worktree').panes;
 f.state.spaces[0].defaultCwd='/new-default';
 assert.equal(await f.state.createTabForWindowChooser(id,'codex'),'created');
 assert.deepEqual(f.calls.find(x=>x[0]==='create'),['create',namespace,'/explicit/worktree','voice']);
});
test('dormant chooser creates in its captured workflow, not whichever workflow is now active',async()=>{
 const f=fixture(),id=f.state.openWindowTabChooser(0);
 f.state.spaces[0].layout={splitPanes:f.state.splitPanes};f.state.activeSpaceId='other';
 f.state.splitPanes=[{windowId:'other-empty',projectId:'habit',tabId:''}];
 assert.equal(await f.state.createTabForWindowChooser(id,'codex'),'created');
 assert.deepEqual(f.calls.find(x=>x[0]==='create'),['create',namespace,'/voice-record','voice']);
 assert.equal(f.state.activeSpaceId,'other');assert.equal(f.state.splitPanes[0].tabId,'');
 assert.equal(f.state.spaces[0].layout.splitPanes[0].tabId,'created');
});
for(const action of ['terminal','codex','claude','sdk'])test(action+': switch during factory await preserves workflow/cwd and does not steal focus',async()=>{
 const f=fixture(),id=f.state.openWindowTabChooser(0);
 f.state.beforePublish=async()=>{
  f.state.spaces[0].layout={splitPanes:f.state.splitPanes};f.state.activeSpaceId='other';
  f.state.splitPanes=[{windowId:'other-empty',projectId:'habit',tabId:''}];
 };
 assert.equal(await f.state.createTabForWindowChooser(id,action),'created');
 assert.deepEqual(f.calls.find(x=>x[0]==='create'),['create',namespace,'/voice-record','voice']);
 assert.equal(f.state.activeSpaceId,'other');assert.equal(f.state.splitPanes[0].tabId,'');
 assert.equal(f.state.spaces[0].layout.splitPanes[0].tabId,'created');
});
test('closed chooser during factory await cannot publish into the replacement empty window',async()=>{
 const f=fixture(),id=f.state.openWindowTabChooser(0);
 f.state.beforePublish=async()=>{f.state.splitPanes=[{windowId:'replacement',projectId:'',tabId:''}];};
 assert.equal(await f.state.createTabForWindowChooser(id,'codex'),null);
 assert.equal(f.state.splitPanes[0].tabId,'');assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});
