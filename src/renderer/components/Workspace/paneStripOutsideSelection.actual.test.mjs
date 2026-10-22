import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {transformSync} from 'esbuild';
import * as model from '../../utils/paneStripSelectionModel.mjs';
import * as groups from '../../utils/paneStripGroupsModel.mjs';
import {registerPaneStripOutsideSelection} from '../../utils/paneStripOutsideSelection.mjs';
const code=transformSync(fs.readFileSync(new URL('./PaneStripSelection.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code;

// Actual selection hook and registry; controlled React/window/drag state. No
// mounted DOM or Main actions, which this presentation clear must never call.
function fixture(){
  const slots=[],effects=[],listeners=new Map(),dragListeners=new Set();let cursor=0,dirty=false,api,dragging=false;
  const entries=['a','b','c','d'].map(tabId=>({projectId:'P',tabId}));
  const state={activeSpaceId:'W',navigationRevision:1,organizationReady:true,
    splitPanes:[{windowId:'win',tabs:entries}],openProjects:new Map([['P',{tabs:new Map(entries.map(entry=>[entry.tabId,{}]))}]]),
    tabWorkflowMembership:Object.fromEntries(entries.map(entry=>[entry.tabId,{workflowId:'W'}]))};
  const window={addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
  const React={createContext:value=>({value}),useContext:()=>null,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;dirty=true;}];},
    useRef:value=>slots[cursor++]??={current:value},
    useMemo:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((x,k)=>x!==old.deps[k]))slots[i]={deps,value:fn()};return slots[i].value;},
    useEffect:(fn,deps=[])=>{const i=cursor++,old=slots[i];if(!old||deps.some((x,k)=>x!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}}};
  const store={getState:()=>state},module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,window,require:name=>{
    if(name==='react')return React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
    if(name.endsWith('paneStripSelectionModel.mjs'))return model;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('paneStripOutsideSelection.mjs'))return {registerPaneStripOutsideSelection};
    if(name.endsWith('paneTabDragBridge'))return {getPaneTabDragSnapshot:()=>({active:dragging}),subscribePaneTabDrag:fn=>{dragListeners.add(fn);return()=>dragListeners.delete(fn);}};
    if(name.endsWith('paneTabPointerBridge'))return {getPaneTabPointerSnapshot:()=>({active:false}),subscribePaneTabPointer:()=>()=>{}};
    throw Error(name);
  }});
  const rootRef={current:{contains:chip=>chip.owner==='win'}};
  const render=()=>{let count=0;do{assert.ok(++count<8);cursor=0;dirty=false;api=module.exports.usePaneStripSelectionController({
    workflowId:'W',windowId:'win',paneIndex:0,entries,rootRef});while(effects.length)effects.shift()();}while(dirty);return api;};
  const emit=(type,props={})=>{for(const fn of [...listeners.get(type)||[]])fn({button:0,target:{closest:()=>null},...props});};
  return {render,emit,selectThree(){for(const id of ['a','b','c']){render().click(id,{metaKey:true});render();}},
    drag(active){dragging=active;for(const fn of dragListeners)fn();},dispose(){for(const value of slots)value?.cleanup?.();},
    get api(){return api;},get listeners(){return listeners;}};
}
test('actual hook clears three selected chips on an ordinary outside/overlay click without changing tab activation',()=>{
  const f=fixture();try{f.selectThree();assert.equal(f.api.selected('a'),true);const lease=f.api.menu('b');assert.ok(lease.isCurrent());
    f.emit('click',{defaultPrevented:true});f.render();assert.equal(f.api.selected('a'),false);assert.equal(lease.isCurrent(),false);
    f.selectThree();assert.equal(f.api.click('d',{}),false,'ordinary caller still activates d');f.render();
    for(const id of ['a','b','c'])assert.equal(f.api.selected(id),false);assert.equal(f.api.selected('d'),true);
  }finally{f.dispose();}
});
test('actual captured menu remains current through its click; Cmd/Shift/right/middle/drag keep the set',async()=>{
  const f=fixture();try{f.selectThree();const lease=f.api.menu('b'),owner=JSON.stringify(['W','win']);
    const target={closest:selector=>selector.includes('selection-owner')?{dataset:{paneStripSelectionOwner:owner}}:null};
    f.emit('click',{target});await Promise.resolve();assert.ok(lease.isCurrent(),'asynchronous menu admission keeps its captured lease');
    for(const extra of [{metaKey:true},{shiftKey:true},{button:1},{button:2}])f.emit('click',extra);
    f.drag(true);f.drag(false);f.emit('click');f.render();assert.ok(lease.isCurrent());
    f.emit('pointerdown');f.emit('click');f.render();assert.equal(lease.isCurrent(),false);assert.equal(f.api.selected('b'),false);
  }finally{f.dispose();}
  assert.equal([...f.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
});
