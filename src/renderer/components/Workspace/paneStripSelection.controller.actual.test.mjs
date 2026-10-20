import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {transformSync} from 'esbuild';
import * as model from '../../utils/paneStripSelectionModel.mjs';
import {readPaneStripOwnerEntries,capturePaneStripGroupDrag} from '../../utils/paneStripGroupsModel.mjs';
const source=fs.readFileSync(new URL('./PaneStripSelection.tsx',import.meta.url),'utf8');
const code=transformSync(source,{loader:'tsx',format:'cjs'}).code;
function fixture(){
  const entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'},{projectId:'P',tabId:'c'}];
  const state={activeSpaceId:'W',activeProjectId:'P',organizationReady:true,centerStrips:{},
    spaces:[{id:'W'}],navigationRevision:1,
    splitPanes:[{windowId:'window-A',tabId:'a',tabs:entries}],
    openProjects:new Map([['P',{tabs:new Map([['a',{}],['c',{}]])}],['Q',{tabs:new Map([['b',{}]])}]]),
    tabWorkflowMembership:Object.fromEntries(entries.map(e=>[e.tabId,{workflowId:'W'}]))};
  const slots=[],effects=[];let cursor=0,changed=false,result;
  const hooks={createContext:()=>({}),useContext:()=>null,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>{
      const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useMemo:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:cb(),deps};return slots[i].value;},
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}},
  };
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>{
    if(name==='react')return hooks;
    if(name.endsWith('paneStripSelectionModel.mjs'))return model;
    if(name.endsWith('paneStripGroupsModel.mjs'))return {readPaneStripOwnerEntries,capturePaneStripGroupDrag};
    if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:{getState:()=>state}};
    throw Error(name);
  }});
  const props={workflowId:'W',windowId:'window-A',paneIndex:0,entries,presented:true};
  const render=()=>{let passes=0;do{assert.ok(passes++<10);cursor=0;changed=false;result=module.exports.usePaneStripSelectionController(props);while(effects.length)effects.shift()();}while(changed);return result;};
  const dispose=()=>slots.forEach(slot=>slot?.cleanup?.());
  render();return {state,props,render,dispose,get:()=>result};
}
test('actual controller keeps selection local; exact menu/drag order crosses execution namespaces without activating or writing store',()=>{
  const f=fixture(),before=JSON.stringify([...f.state.openProjects].map(([id,w])=>[id,[...w.tabs]]));
  assert.equal(f.get().click('a',{}),false);f.render();
  assert.equal(f.get().click('c',{shiftKey:true}),true);f.render();
  const lease=f.get().menu('b');assert.ok(lease?.isCurrent());
  assert.deepEqual(JSON.parse(JSON.stringify(lease.entries)),f.props.entries);
  assert.equal(f.get().dragEntries('b').length,3);
  assert.equal(JSON.stringify([...f.state.openProjects].map(([id,w])=>[id,[...w.tabs]])),before);
  assert.equal(f.get().click('c',{}),false);f.render();assert.equal(lease.isCurrent(),false);
  assert.equal(f.get().menu('a'),null);f.dispose();
});
test('actual controller retains free membership scope and blocks unknown schema without a pointer-handler exception',()=>{
  const f=fixture(),free=f.get().captureGroupDrag('a');assert.equal(free.boundary.kind,'free');assert.ok(free.isCurrent());
  f.state.activeSpaceId='OTHER';f.state.navigationRevision++;assert.ok(free.isCurrent(),'free navigation remains allowed');f.state.activeSpaceId='W';
  f.state.spaces[0].stripColorGroups={version:1,revision:1,groups:[{id:'g',revision:1,color:'#123456',tabIds:['a','b']}]};
  assert.equal(free.isCurrent(),false,'late CREATE revokes previously free source');
  const capture=f.get().captureGroupDrag('a');assert.equal(capture.boundary.kind,'group');assert.equal(capture.boundary.end,1);assert.ok(capture.isCurrent());
  f.state.spaces[0].stripColorGroups.version=2;
  assert.equal(f.get().captureGroupDrag('a').boundary.kind,'blocked');assert.equal(capture.isCurrent(),false);f.dispose();
});
test('renderer departure/return, owner replacement and pruning revoke old menu without retargeting it',()=>{
  for(const kind of ['away','owner','prune','membership','unmount']){
    const f=fixture();f.get().click('a',{});f.render();const lease=f.get().menu('a');assert.ok(lease.isCurrent());
    if(kind==='away'){f.props.presented=false;f.render();f.props.presented=true;f.render();}
    if(kind==='owner'){f.props.windowId='window-B';f.render();}
    if(kind==='prune'){f.props.entries=f.props.entries.slice(1);f.state.splitPanes[0].tabs=f.props.entries;f.render();}
    if(kind==='membership')f.state.tabWorkflowMembership.a={workflowId:'OTHER'};
    if(kind==='unmount')f.dispose();
    assert.equal(lease.isCurrent(),false,kind);
  }
});
test('window ID preserves selection when its pane index changes; another window does not inherit it',()=>{
  const f=fixture();f.get().click('a',{});f.render();
  f.state.splitPanes.unshift({windowId:'other',tabs:[]});f.props.paneIndex=1;f.render();
  assert.ok(f.get().selected('a'));assert.ok(f.get().menu('a').isCurrent());
  f.props.windowId='other';f.props.paneIndex=0;f.render();assert.equal(f.get().selected('a'),false);
});
