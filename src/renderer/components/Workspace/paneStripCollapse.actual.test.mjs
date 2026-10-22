import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as model from '../../utils/paneStripCollapseModel.mjs';
import * as interfaceModel from '../../utils/paneStripGroupInterfaceModel.mjs';
import * as groups from '../../utils/paneStripGroupsModel.mjs';
import {ownPaneStripGroupMetaHover} from '../../utils/paneStripGroupMetaHover.mjs';
import {paneStripColorGroupsBasis} from '../../../shared/pane-strip-color-groups.cjs';
import {horizontalDragAutoScrollDelta} from '../../utils/horizontalDragGeometry.mjs';
import * as hoverScope from '../../utils/paneStripHoverScope.mjs';
const source=fs.readFileSync(new URL('./PaneStripCollapsedGroup.tsx',import.meta.url),'utf8');
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
function fixture({anchor=200,width=600}={}){
  const slots=[],layoutEffects=[],effects=[],listeners=new Map(),nodes=new Map(),calls=[],diagnostics=[];let cursor=0,dirty=false,root,rectangleReads=0;
  const state={activeSpaceId:'W',navigationRevision:1,organizationReady:true,splitPanes:[{windowId:'win',tabId:'b',tabs:['a','b','c'].map(tabId=>({projectId:'P',tabId}))}],
    spaces:[{id:'W',stripColorGroups:{version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',tabIds:['a','b','c'],collapsed:true}]}}],
    openProjects:new Map([['P',{tabs:new Map(['a','b','c'].map(id=>[id,{}]))}]])};
  const subscribers=new Set();
  const notifyStore=()=>{for(const listener of [...subscribers])listener(state);};
  const store=fn=>fn(state);store.getState=()=>state;
  store.subscribe=listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);};
  store.setState=patch=>{Object.assign(state,patch);notifyStore();};
  state.settlePaneStripGroupPresentation=()=>null;
  const uiStore=fn=>fn({paneStripSelectedFirst:false,paneStripCloseOnClick:false});uiStore.getState=()=>({paneStripSelectedFirst:false,paneStripCloseOnClick:false});
  state.commitPaneStripGroupPresentation=async(lease,id,options)=>{calls.push(options);assert.ok(lease.isCurrent());
    const byId=new Map(state.splitPanes[0].tabs.map(entry=>[entry.tabId,entry]));state.splitPanes[0].tabs=options.order.map(id=>byId.get(id));return {revision:2};};
  const effect=(queue,fn,deps)=>{const i=cursor++,previous=slots[i];if(!previous||deps.some((value,k)=>value!==previous.deps[k])){
    slots[i]={deps,cleanup:previous?.cleanup};queue.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}};
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;dirty=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},useLayoutEffect:(fn,deps)=>effect(layoutEffects,fn,deps),useEffect:(fn,deps)=>effect(effects,fn,deps)};
  class Element{closest(){return null;}}
  const win={addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),dispatchEvent:event=>{for(const fn of [...listeners.get(event.type)||[]])fn(event);}};
  const module={exports:{}};vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,window:win,
    Element,document:{documentElement:{clientWidth:width}},console,CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},
    require:name=>{
      if(name==='react')return React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:uiStore};
      if(name.endsWith('paneStripGroupInterfaceModel.mjs'))return interfaceModel;
      if(name.endsWith('paneStripCollapseModel.mjs'))return model;
      if(name.endsWith('paneStripGroupMetaHover.mjs'))return {ownPaneStripGroupMetaHover:(owner,toggle,_target,inside)=>ownPaneStripGroupMetaHover(owner,toggle,win,inside)};
      if(name.endsWith('paneStripHoverScope.mjs'))return hoverScope;
      if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('pane-strip-color-groups.cjs'))return {paneStripColorGroupsBasis};
      if(name.endsWith('horizontalDragGeometry.mjs'))return {horizontalDragAutoScrollDelta};
      if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {currentUIActionId:()=> 'owned',uiDiagnosticAbsNow:()=>performance.now(),
        uiPerformancePhaseForAction:(id,name,fields)=>diagnostics.push({id,name,fields})};
      if(name.endsWith('PaneStripGroupOutline'))return {__esModule:true,default:'Outline'};if(name.endsWith('.css'))return {};throw Error(name);
    }});
  const props={group:state.spaces[0].stripColorGroups.groups[0],entries:state.splitPanes[0].tabs,representative:'b',workflowId:'W',windowId:'win',paneIndex:0,
    rowGap:7,presented:true,dragging:false,layoutKey:'same',onPresentation(){},renderChip:(entry,control)=>React.createElement('Card',{id:entry.tabId,control})};
  const render=()=>{let count=0;do{
    assert.ok(count++<12,'finite render settles');cursor=0;dirty=false;root=module.exports.default(props);
    const wrappers=all(root).filter(node=>node.props?.['data-strip-item']!==undefined);
    const dom={isConnected:true,contains:target=>target?.inside===true,querySelector:()=>null,querySelectorAll:()=>wrappers.map(node=>{
      const id=node.props['data-strip-tab-id'];let item=nodes.get(id);if(!item){item={dataset:{stripTabId:id}};nodes.set(id,item);}
      item.getBoundingClientRect=()=>{rectangleReads++;return {left:anchor+(node.props.style.left||0),right:anchor+(node.props.style.left||0)+80,top:30,bottom:56,width:80,height:26};};return item;
    })};root.props.ref.current=dom;dom.querySelectorAll();
    while(layoutEffects.length)layoutEffects.shift()();while(effects.length)effects.shift()();
  }while(dirty);return root;};
  const emit=(type,extra={})=>win.dispatchEvent({type,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},target:new Element(),...extra});
  return {render,props,state,calls,emit,notifyStore,nodes,diagnostics,get root(){return root;},get rectangleReads(){return rectangleReads;},dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
test('actual Meta toggles repeatedly without pointer movement or reentering the group',()=>{
  const f=fixture();
  try {
    f.render().props.onMouseEnter({buttons:0});
    for(let i=0;i<8;i++) {
      f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});
      assert.equal(f.render().props['data-group-open'],i%2===0?'1':undefined,`cycle ${i+1}`);
    }
  } finally {f.dispose();}
});
test('actual group treats its own context menu as hover during repeated Meta cycles, but releases a foreign menu',()=>{
  const f=fixture();
  const menu=owner=>{const node={dataset:{tabMenuOwnerId:owner},closest(){return this;}};
    return {closest:selector=>selector.includes('data-tab-context-menu')?node:null};};
  try {
    f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
    f.root.props.onMouseLeave({relatedTarget:menu('b')});f.emit('mousemove',{target:menu('b'),clientX:999,clientY:999});
    for(let i=0;i<8;i++){f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});assert.equal(f.render().props['data-group-open'],i%2?'1':undefined);}
    f.emit('mousemove',{target:menu('foreign'),clientX:999,clientY:999});f.render();
    f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});assert.equal(f.render().props['data-group-open'],undefined);
  }finally{f.dispose();}
});
test('actual same-row component renders each member once; OPEN keeps the representative DOM/flow position and reserves one slot',()=>{
  const f=fixture(),closed=f.render(),b=f.nodes.get('b');closed.props.onMouseEnter({buttons:0});
  f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});const opened=f.render();
  assert.equal(opened.props['data-group-open'],'1');assert.equal(f.nodes.get('b'),b);
  const cards=all(opened).filter(node=>node.type==='Card');assert.deepEqual(cards.map(node=>node.props.id),['a','b','c']);
  const wrappers=all(opened).filter(node=>node.props?.['data-strip-item']!==undefined);
  assert.equal(wrappers.filter(node=>node.props.style.position==='relative').length,1);
  assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='b').props.style.transform,'translateX(0px)');
  assert.equal(f.calls.length,0);assert.ok(f.diagnostics.some(phase=>phase.name==='strip-group:measured'&&phase.fields.rectangleCount===4));
  assert.ok(f.diagnostics.some(phase=>phase.name==='strip-group:layout'));f.dispose();
});
test('actual hovered owner consumes cached rectangles, not layout reads on each pointer move; pending Escape cancels late reveal',async()=>{
  const f=fixture();f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
  const before=f.rectangleReads;for(let i=0;i<25;i++)f.emit('mousemove',{clientX:210,clientY:40});
  assert.equal(f.rectangleReads,before);f.dispose();
  const edge=fixture({anchor:500});let release;
  edge.state.commitPaneStripGroupPresentation=()=>new Promise(resolve=>release=resolve);
  all(edge.render()).find(node=>node.type==='Card'&&node.props.id==='b').props.control.toggle();edge.render();
  edge.emit('keydown',{key:'Escape'});assert.equal(edge.render().props['data-group-preparing'],undefined);
  release({revision:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(edge.render().props['data-group-open'],undefined);edge.dispose();
});
test('actual edge OPEN waits for one existing writer ACK before revealing minimal order, without a second current card',async()=>{
  const f=fixture({anchor:500});let tree=f.render();const card=all(tree).find(node=>node.type==='Card'&&node.props.id==='b');
  card.props.control.toggle();tree=f.render();assert.equal(tree.props['data-group-preparing'],'1');assert.equal(f.calls.length,1);
  await new Promise(resolve=>setImmediate(resolve));f.props.entries=f.state.splitPanes[0].tabs;tree=f.render();
  assert.equal(tree.props['data-group-open'],'1');assert.deepEqual(f.calls[0].order,['a','c','b']);
  assert.equal(all(tree).filter(node=>node.type==='Card'&&node.props.id==='b').length,1);f.dispose();
});
test('actual open row reuses the existing outline measurement for font/card width changes; anchor remains zero without another observer',()=>{
  const f=fixture();f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
  all(f.root).find(node=>node.type==='Outline').props.onMeasured([
    {id:'a',left:0,right:120},{id:'b',left:126,right:206},{id:'c',left:212,right:292}]);
  const wrappers=all(f.render()).filter(node=>node.props?.['data-strip-item']!==undefined);
  assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='a').props.style.left,-126);
  assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='b').props.style.transform,'translateX(0px)');f.dispose();
});
test('actual over-wide group reuses event-sized drag edge scroll so current/last members remain reachable without a timer loop',()=>{
  const f=fixture({anchor:100,width:200});f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
  f.props.dragging=true;f.render();f.emit('mousemove',{clientX:199,clientY:40});
  const representative=all(f.render()).find(node=>node.props?.['data-strip-tab-id']==='b');
  assert.notEqual(representative.props.style.transform,'translateX(0px)');assert.equal(f.calls.length,0);f.dispose();
});
test('actual hover dismiss after drag outside waits for re-entry; click-open and member selection stay sticky',async()=>{
  const f=fixture();f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
  f.props.dragging=true;f.render();f.emit('mousemove',{clientX:999,clientY:999});assert.equal(f.render().props['data-group-open'],'1');
  f.props.dragging=false;f.render();f.emit('mousemove',{clientX:999,clientY:999});assert.equal(f.render().props['data-group-open'],'1');
  f.emit('mousemove',{clientX:210,clientY:40});f.emit('mousemove',{clientX:999,clientY:999});assert.equal(f.render().props['data-group-open'],undefined);
  all(f.root).find(node=>node.type==='Card'&&node.props.id==='b').props.control.toggle();f.render();
  f.emit('mousemove',{clientX:999,clientY:999});assert.equal(f.render().props['data-group-open'],'1');
  all(f.root).find(node=>node.type==='Card'&&node.props.id==='a').props.control.selected('a',async()=>true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.render().props['data-group-open'],'1');f.dispose();
});
test('actual Meta chord/blur/unmount/late ACK cannot open departed owner',async()=>{
  const f=fixture({anchor:500});f.render().props.onMouseEnter({buttons:0});
  f.emit('keydown',{key:'Meta'});f.emit('pointerdown');f.emit('keyup',{key:'Meta'});assert.equal(f.render().props['data-group-open'],undefined);
  all(f.root).find(node=>node.type==='Card'&&node.props.id==='b').props.control.toggle();f.render();
  f.props.presented=false;f.render();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.render().props['data-group-open'],undefined);
  f.dispose();assert.equal([...f.nodes.values()].length,3);
});

test('B22-C01 actual OPEN held IN then OUT keeps one fixed representative, uses existing width receipt and never writes membership or arrange',()=>{
  const f=fixture();
  try {
    const raw=f.state.spaces[0].stripColorGroups,basis=paneStripColorGroupsBasis(raw),before=f.props.entries;
    f.state.splitPanes[0].tabs=[...before,{projectId:'P',tabId:'x'}];
    f.state.openProjects.get('P').tabs.set('x',{});
    f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
    const anchor=f.nodes.get('b');f.props.dragging=true;f.render();
    f.props.group={...raw.groups[0],revision:2,tabIds:['a','x','b','c']};
    f.props.entries=['a','x','b','c'].map(tabId=>({projectId:'P',tabId}));f.props.membershipPreview=true;
    assert.equal(f.render().props['data-group-open'],'1','prospective revision does not dismiss the existing OPEN owner');
    let wrappers=all(f.root).filter(node=>node.props?.['data-strip-item']!==undefined);
    assert.equal(wrappers.filter(node=>node.props.style.position==='relative').length,1);
    assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='b').props.style.transform,'translateX(0px)');
    const outline=all(f.root).find(node=>node.type==='Outline');
    outline.props.onMeasured([{id:'a',left:0,right:80},{id:'x',left:86,right:206},
      {id:'b',left:212,right:292},{id:'c',left:298,right:378}]);
    f.render();wrappers=all(f.root).filter(node=>node.props?.['data-strip-item']!==undefined);
    assert.deepEqual(wrappers.map(node=>node.props['data-strip-tab-id']),['a','x','b','c']);
    assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='x').props.style.left,-126);
    assert.equal(wrappers.find(node=>node.props['data-strip-tab-id']==='b').props.style.transform,'translateX(0px)');
    assert.equal(f.nodes.get('b'),anchor);assert.equal(paneStripColorGroupsBasis(f.state.spaces[0].stripColorGroups),basis);
    f.props.group=raw.groups[0];f.props.entries=before;f.props.membershipPreview=false;
    assert.equal(f.render().props['data-group-open'],'1');assert.equal(f.nodes.get('b'),anchor);
    assert.deepEqual(all(f.root).filter(node=>node.type==='Card').map(node=>node.props.id),['a','b','c']);
    assert.equal(f.calls.length,0,'held IN/OUT cannot use the ordinary arrange writer');
    assert.equal(paneStripColorGroupsBasis(f.state.spaces[0].stripColorGroups),basis);
  } finally {f.dispose();}
});

test('B22-C02 prospective membership never masks a same-revision foreign raw-field change or a released canonical membership change',()=>{
  for(const change of ['foreign-color','released-membership']) {
    const f=fixture();
    try {
      const raw=f.state.spaces[0].stripColorGroups;
      f.state.splitPanes[0].tabs=[...f.state.splitPanes[0].tabs,{projectId:'P',tabId:'x'}];f.state.openProjects.get('P').tabs.set('x',{});
      f.render().props.onMouseEnter({buttons:0});f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();
      f.props.dragging=true;f.render();
      f.props.group={...raw.groups[0],revision:2,tabIds:['a','x','b','c']};
      f.props.entries=['a','x','b','c'].map(tabId=>({projectId:'P',tabId}));f.props.membershipPreview=true;
      assert.equal(f.render().props['data-group-open'],'1');
      f.state.spaces[0].stripColorGroups=change==='foreign-color'
        ?{...raw,groups:[{...raw.groups[0],color:'#123456'}]}
        :{...raw,revision:2,groups:[f.props.group]};
      f.notifyStore();assert.equal(f.render().props['data-group-open'],undefined,change);
      assert.equal(f.calls.length,0,'scope revocation cannot restore captured member IDs');
    } finally {f.dispose();}
  }
});
