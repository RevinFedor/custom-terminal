// Actual CURRENT menu module and pure group/selection models; React hooks, store and runtime delivery are controlled ports.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';import {transformSync} from 'esbuild';
import * as actions from '../../utils/paneStripSelectionActions.mjs';
import * as groups from '../../utils/paneStripGroupsModel.mjs';
import {paneStripCollapsedRuns} from '../../utils/paneStripCollapseModel.mjs';
import {paneStripLayoutOwner} from '../../../shared/pane-strip-color-groups.cjs';
import {captureSpaceLayout} from '../../utils/workspaceSpacesModel.mjs';
import * as selection from '../../utils/paneStripSelectionModel.mjs';
import * as metrics from '../UI/contextMenuMetrics.mjs';
import {resolvePtyAgentOwner} from '../../utils/ptyAgentOwner.mjs';
const event=extra=>({preventDefault(){},stopPropagation(){},button:0,detail:1,...extra});
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
const button=(tree,name)=>all(tree).find(node=>node.props?.['data-tab-context-action']===name);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function hooks(){
  const slots=[],effects=[],listeners=new Map();let cursor=0,changed=false;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useCallback:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn,deps};return slots[i].value;},
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}}};
  const window={innerWidth:1200,innerHeight:900,
    addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),clearTimeout(){},setTimeout:()=>1};
  return {React,window,listeners,render:fn=>{let result,count=0;do{assert.ok(count++<8);cursor=0;changed=false;result=fn();while(effects.length)effects.shift()();}while(changed);return result;},
    dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function menuFixture({runtimePort,colorOnly=false}={}) {
  const h=hooks(),entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}],calls=[],toasts=[],listeners=new Set();let current=true;
  const state={organizationReady:true,isRestoring:false,activeSpaceId:'W',splitPanes:[{windowId:'win',tabs:entries,tabId:'a'}],
    spaces:[{id:'W'}],centerStrips:{},tabCatalog:{},tabTitleNamingIds:new Set(),
    tabWorkflowMembership:{a:{tabId:'a',workflowId:'W',revision:1},b:{tabId:'b',workflowId:'W',revision:1}},
    openProjects:new Map([['P',{projectPath:'/P',tabs:new Map([['a',{commandType:'claude',claudeSessionId:'SIDa'}]])}],
      ['Q',{projectPath:'/Q',tabs:new Map([['b',{commandType:'claude',claudeSessionId:'SIDb'}]])}]]),
    clearTabFromSplitPane:id=>{calls.push(['remove',id]);return true;},
    commitWorkspaceWindowAction:request=>{calls.push(['beside',request]);return {ok:true};},
    setTabCompletionNotificationArmed:(...args)=>calls.push(['once',...args]),setTabCompletionNotificationPersistent:(...args)=>calls.push(['persistent',...args]),
    setTabTitleNaming:(id,on)=>{calls.push(['naming',id,on]);on?state.tabTitleNamingIds.add(id):state.tabTitleNamingIds.delete(id);},
    commitPaneStripGroupColor:async(lease,color)=>{calls.push(['color',lease.entries.map(entry=>entry.tabId),color]);return {revision:2};},
    commitPaneStripGroupPresentation:async(lease,id,options)=>{calls.push(['presentation',lease.entries.map(entry=>entry.tabId),id,options]);return {revision:2};},
    refreshOrganizationCatalog:async()=>calls.push(['refresh']),saveSession:()=>calls.push(['save'])};
  const store=selector=>selector(state);store.getState=()=>state;store.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const lease={version:1,workflowId:'W',windowId:'win',paneIndex:0,entries,isCurrent:()=>current};
  const mock={SideFlyout:()=>null,TabNotificationControls:()=>null,TabIdActions:()=>null,PaneStripGroupColorPicker:()=>null};
  const module={exports:{}};const source=fs.readFileSync(new URL('./PaneStripSelectionMenu.tsx',import.meta.url),'utf8');
  vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,crypto:webcrypto,window:h.window,document:{body:{}},
    require:name=>{
      if(name==='react')return h.React;if(name==='react-dom')return {createPortal:element=>element};
      if(name==='lucide-react')return Object.fromEntries(['ChevronRight','Copy','Palette','RotateCw','Square','PanelLeftClose','PanelLeftOpen','Ungroup','LoaderCircle'].map(name=>[name,name]));
      if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})}};
      if(name.endsWith('codexWriterIdentity'))return {requireCodexSurfaceSessionId:async()=>{throw Error('unexpected codex lookup');}};
      if(name.endsWith('ptyAgentOwner.mjs'))return {resolvePtyAgentOwner};
      if(name.endsWith('generateTabTitle'))return {refreshGeneratedTabTitle:async(id,options)=>{calls.push(['title',id,options]);return {ok:true};}};
      if(name.endsWith('paneStripCollapseModel.mjs'))return {paneStripCollapsedRuns};
      if(name.endsWith('pane-strip-color-groups.cjs'))return {paneStripLayoutOwner};
      if(name.endsWith('workspaceSpacesModel.mjs'))return {captureSpaceLayout};
      if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('paneStripSelectionActions.mjs'))return actions;if(name.endsWith('contextMenuMetrics.mjs'))return metrics;
      const key=name.split('/').at(-1);if(key==='TabIdActions')return {TabIdActions:mock.TabIdActions};
      if(mock[key])return {__esModule:true,default:mock[key]};throw Error(name);
    }});
  h.window.require=()=>({clipboard:{writeText:text=>calls.push(['copy',text])}});
  const render=()=>h.render(()=>module.exports.default({lease,onClose:()=>calls.push(['close']),runtimePort,colorOnly}));
  return {h,render,lease,state,calls,toasts,mock,invalidate:()=>{current=false;for(const listener of listeners)listener();}};
}
const grouped=f=>{
  f.state.spaces[0].stripColorGroups={version:1,revision:1,
    groups:[{id:'g',revision:1,color:'#123456',tabIds:['a','b'],collapsed:true}]};
  return f;
};
test('U23 menu: sole selected OPEN non-representative cannot dissolve or recolor the whole collapsed group',()=>{
  const f=grouped(menuFixture({colorOnly:true}));
  f.lease.entries=f.lease.entries.slice(1); // Cmd selected b; shown representative is still a.
  const tree=f.render();
  assert.equal(button(tree,'group-ungroup'),undefined);
  assert.equal(button(tree,'group-color').props.disabled,true);
  assert.equal(button(tree,'group-collapse').props.disabled,true);
  assert.deepEqual(f.calls,[]);f.h.dispose();
});
test('U23 menu: a partial single tab in a non-contiguous collapsed definition is not a represented group',()=>{
  for(const barrier of [{projectId:'X',tabId:'x'},{slotId:'chooser',extension:{keep:true}}]) {
    const f=grouped(menuFixture({colorOnly:true}));
    f.state.splitPanes[0].tabs.splice(1,0,barrier);f.lease.entries=f.lease.entries.slice(0,1);
    const tree=f.render();assert.equal(button(tree,'group-ungroup'),undefined);
    assert.equal(button(tree,'group-color').props.disabled,true);f.h.dispose();
  }
});
test('U23 menu: true collapsed representative expands only settings and preserves single Full and Stop targets',async()=>{
  for(const action of ['close','stop']) {
    const runtime=[],f=grouped(menuFixture({runtimePort:{run:async(action,lease)=>runtime.push([action,lease.entries.map(e=>e.tabId)])}}));
    f.lease.entries=f.lease.entries.slice(0,1);let tree=f.render();
    button(tree,'group-ungroup').props.onClick(event());await tick();
    assert.deepEqual(f.calls[0].slice(0,3),['presentation',['a','b'],'g']);
    assert.equal(f.calls[0][3].ungroup,true);assert.equal(f.lease.entries.length,1);
    tree=f.render();button(tree,action).props.onClick(event());await tick();
    assert.deepEqual(runtime,[[action,['a']]]);f.h.dispose();
  }
});
test('U23 menu: MRU representative and centre representative use the same collapsed-run resolver',async()=>{
  for(const kind of ['mru','centre']) {
    const f=grouped(menuFixture({colorOnly:true}));
    if(kind==='mru') {
      f.state.splitPanes[0].tabId='';f.state.splitPanes[0].history=[{tabId:'b'}];
    }else {
      f.state.centerStrips={P:f.state.splitPanes[0].tabs};f.state.splitPanes=[];
      f.state.activeProjectId='P';f.state.activeSpaceTab={projectId:'Q',tabId:'b'};
      f.lease.paneIndex=null;f.lease.windowId=null;
    }
    f.lease.entries=f.lease.entries.slice(1);button(f.render(),'group-ungroup').props.onClick(event());await tick();
    assert.deepEqual(f.calls[0].slice(0,3),['presentation',['a','b'],'g'],kind);f.h.dispose();
  }
  // Match PaneTabStrip's currentPane lookup even for an id-less legacy pane:
  // its unrelated retained history is not an authority for a different rep.
  const f=grouped(menuFixture({colorOnly:true}));
  delete f.state.splitPanes[0].windowId;f.lease.windowId=null;
  f.state.splitPanes[0].tabId='';f.state.splitPanes[0].history=[{tabId:'b'}];f.lease.entries=f.lease.entries.slice(1);
  assert.equal(button(f.render(),'group-ungroup'),undefined);f.h.dispose();
});
test('U23 menu: whole selection survives Ungroup and recreates color without closing or mutating original selection',async()=>{
  const f=grouped(menuFixture({colorOnly:true})),captured=f.lease.entries;
  f.state.commitPaneStripGroupPresentation=async(lease,id,options)=>{
    f.calls.push(['presentation',lease.entries.map(entry=>entry.tabId),id,options]);
    f.state.spaces[0].stripColorGroups={version:1,revision:2,groups:[]};return {revision:2};
  };
  button(f.render(),'group-ungroup').props.onClick(event());await tick();
  let tree=f.render();assert.equal(button(tree,'group-ungroup'),undefined);
  assert.equal(f.lease.entries,captured);assert.equal(f.calls.some(call=>call[0]==='close'||call[0]==='remove'),false);
  button(tree,'group-color').props.onMouseEnter();tree=f.render();
  all(tree).find(node=>node.type===f.mock.PaneStripGroupColorPicker).props.onCommit('#abcdef');await tick();
  assert.deepEqual(f.calls.find(call=>call[0]==='color'),['color',['a','b'],'#abcdef']);f.h.dispose();
});
test('U23 menu: ordinary partial, mixed group and unknown active provenance remain unavailable',()=>{
  for(const kind of ['ordinary-partial','mixed','unknown']) {
    const f=grouped(menuFixture({colorOnly:true}));
    const group=f.state.spaces[0].stripColorGroups.groups[0];
    if(kind==='ordinary-partial'){group.collapsed=false;f.lease.entries=f.lease.entries.slice(0,1);}
    if(kind==='mixed') {
      group.tabIds=['a'];f.state.spaces[0].stripColorGroups.groups.push({id:'other',revision:1,color:'#abcdef',tabIds:['b']});
    }
    if(kind==='unknown'){group.tabIds.push('not-in-owner');f.lease.entries=f.lease.entries.slice(0,1);}
    const tree=f.render();assert.equal(button(tree,'group-ungroup'),undefined,kind);
    assert.equal(button(tree,'group-color').props.disabled,true,kind);f.h.dispose();
  }
});
test('U23 menu: explicitly inactive raw provenance does not remove represented active-group settings',async()=>{
  const f=grouped(menuFixture({colorOnly:true}));f.state.spaces[0].stripColorGroups.groups[0].tabIds.push('closed');
  f.state.tabCatalog.closed={active:false};f.lease.entries=f.lease.entries.slice(0,1);
  button(f.render(),'group-ungroup').props.onClick(event());await tick();
  assert.deepEqual(f.calls[0].slice(0,3),['presentation',['a','b'],'g']);f.h.dispose();
});
