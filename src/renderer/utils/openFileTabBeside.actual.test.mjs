import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as linked from './tabLinkedFiles.mjs';
import * as navigation from './tabLinkNavigation.mjs';
import * as panes from './splitPanesModel.mjs';

const compile=name=>transformSync(fs.readFileSync(new URL(name,import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
const helper=compile('./openFileTabBeside.ts'),actions=compile('./linkedFileActions.ts');
function fixture({placed=false,capacity=true}={}) {
  const calls=[];
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const file={id:'file',tabType:'file',filePath:'/synthetic/doc.md',visualParentTabId:'owner'};
  const state={view:'workspace',activeSpaceId:'w',spaces:[{id:'w',layout:{}}],splitPanes:[{windowId:'owner-window',projectId:'p',tabId:'owner'},
      ...(placed?[{windowId:'file-window',projectId:'p',tabId:'file'}]:[])],splitFocusedIndex:0,
    openProjects:new Map([['p',{tabs:new Map([['owner',{id:'owner',tabType:'terminal'}],['file',file]])}]]),
    tabCatalog:{file:{active:true}},tabWorkflowMembership:{file:{workflowId:'w'},owner:{workflowId:'w'}},
    commitWorkspaceWindowAction:request=>{calls.push(['place',request]);return capacity?{ok:true,spaceId:'w',paneIndex:1}:{ok:false,reason:'window_capacity_reached'};},
    openTabById:async(id,options)=>{calls.push(['reveal',id,options]);return true;},
    showHiddenWindowAlongside:(...args)=>{calls.push(['alongside',...args]);return true;},
    commitOrganization:()=>{calls.push(['persist']);return pending;},
    closeTab:()=>assert.fail('opening a file must never unlink')
  };
  const ui={showToast:(...args)=>calls.push(['toast',...args]),setActiveArea:value=>calls.push(['area',value])};
  const ws={getState:()=>state},us={getState:()=>ui};
  const execute=(code,modules)=>{
    const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,console:{log(){},warn(){}},
      require:name=>{assert.ok(name in modules,name);return modules[name];}});return module.exports;
  };
  const exactActions=execute(actions,{'../store/useWorkspaceStore':{useWorkspaceStore:ws}});
  const mod=execute(helper,{'../store/useWorkspaceStore':{useWorkspaceStore:ws},'../store/useUIStore':{useUIStore:us},
    './linkedFileActions':exactActions,'./tabLinkedFiles.mjs':linked,'./tabLinkNavigation.mjs':navigation,'./splitPanesModel.mjs':panes,
    './tabLinkedFilePreview':{dismissTabLinkedFile:id=>calls.push(['dismiss',id])}});
  const expected=linked.collectTabLinkedFileTree(state.openProjects,'owner')[0];
  return {state,calls,finish,file,expected,open:arg=>mod.openFileTabBeside('p','file',arg)};
}
test('popup middle opens right of exact owner; persistence never unlinks bytes or relation',async()=>{
  const f=fixture(),run=f.open(f.expected);
  assert.equal(f.calls[0][0],'place');assert.equal(f.calls[0][1].target.mode,'new-window');
  assert.equal(f.calls[0][1].target.side,'right');assert.equal(f.calls[0][1].target.anchorTabId,'owner');
  f.finish();assert.equal(await run,true);assert.equal(f.file.visualParentTabId,'owner');assert.equal(f.file.filePath,'/synthetic/doc.md');
});
test('sidebar file middle opens beside focused window through same ingress',async()=>{
  const f=fixture(),run=f.open();assert.equal(f.calls[0][1].target.anchor,'focused');
  f.finish();assert.equal(await run,true);
});
test('already placed file reveals existing window without creating or closing another',async()=>{
  const f=fixture({placed:true});assert.equal(await f.open(f.expected),true);
  assert.equal(f.calls.filter(c=>c[0]==='reveal').length,1);assert.equal(f.calls.filter(c=>c[0]==='place').length,0);
  assert.ok(f.state.openProjects.get('p').tabs.has('file'));
});
test('changed path or parent cannot use stale popup action',async()=>{
  const f=fixture();f.file.filePath='/renamed.md';assert.equal(await f.open(f.expected),false);
  assert.deepEqual(f.calls.map(c=>c[0]),['toast']);
});
test('full layout refuses placement while preserving existing reader/link',async()=>{
  const f=fixture({capacity:false});assert.equal(await f.open(f.expected),false);
  assert.ok(!f.calls.some(c=>['dismiss','persist','reveal'].includes(c[0])));assert.equal(f.file.visualParentTabId,'owner');
});
test('late persistence ACK cannot steal focus after user leaves',async()=>{
  const f=fixture(),run=f.open(f.expected),calls=f.calls.length;f.state.view='dashboard';f.finish();
  assert.equal(await run,true);assert.equal(f.state.view,'dashboard');assert.equal(f.calls.length,calls);
});
test('reopen fills the vacant side window instead of accumulating empty columns',async()=>{
  const f=fixture();f.state.splitPanes.push({windowId:'side',projectId:'',tabId:'',tabs:[]});
  const run=f.open(f.expected);assert.equal(f.calls[0][1].target.mode,'same-window');
  assert.equal(f.calls[0][1].target.windowIndex,1);f.finish();assert.equal(await run,true);
});
test('hidden vacant window returns alongside captured owner, without swapping it away',async()=>{
  const f=fixture();f.state.splitPanes.push({windowId:'side',projectId:'',tabId:'',tabs:[],displayHidden:true});
  const run=f.open(f.expected);assert.equal(f.calls[0][1].target.mode,'same-window');
  assert.equal(f.calls[0][1].reveal,false);assert.deepEqual(f.calls.find(c=>c[0]==='alongside'),['alongside','w','owner-window','side','right']);
  f.finish();assert.equal(await run,true);
});
