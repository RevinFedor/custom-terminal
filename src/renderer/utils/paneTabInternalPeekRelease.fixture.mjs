// Full CURRENT product modules, controlled DOM/hooks/events and Store persistence port.
import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';

import * as model from './paneStripCollapseModel.mjs';
import * as interfaceModel from './paneStripGroupInterfaceModel.mjs';
import * as groups from './paneStripGroupsModel.mjs';
import {ownPaneStripGroupMetaHover} from './paneStripGroupMetaHover.mjs';
import {paneStripColorGroupsBasis} from '../../shared/pane-strip-color-groups.cjs';
import {horizontalDragAutoScrollDelta} from './horizontalDragGeometry.mjs';
import * as hoverScope from './paneStripHoverScope.mjs';

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const nodeRequire=createRequire(import.meta.url);
const directory=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(directory,'../../..');
const compiled=new Map();
// Normal checkout: existing esbuild. Source-only research host may explicitly
// name its installed Babel compiler; this never starts Playwright/a browser.
let transform;
function compileSource(source,filename) {
  if(!transform) {
    if(process.env.PANE_SOURCE_BABEL) {
      const {babelTransform}=nodeRequire(process.env.PANE_SOURCE_BABEL);
      transform=(text,name)=>babelTransform(text,name,false,[],[]).code;
    } else {
      const {transformSync}=nodeRequire('esbuild');
      transform=(text,name)=>transformSync(text,{loader:name.endsWith('.tsx')?'tsx':name.endsWith('.ts')?'ts':'js',format:'cjs',target:'es2022'}).code;
    }
  }
  return transform(source,filename);
}
export const plain=value=>JSON.parse(JSON.stringify(value));

const componentSource=fs.readFileSync(new URL('../components/Workspace/PaneStripCollapsedGroup.tsx',import.meta.url),'utf8');
export const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
export function componentFixture({anchor=200,width=600,prefs={},memberWidths={}}={}){
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
  const modes={paneStripSelectedFirst:false,paneStripCloseOnClick:false,paneStripInstantHover:false,...prefs};
  const uiStore=fn=>fn(modes);uiStore.getState=()=>modes;
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
  const module={exports:{}};vm.runInNewContext(compileSource(componentSource,'PaneStripCollapsedGroup.tsx'),{module,exports:module.exports,window:win,
    Element,document:{documentElement:{clientWidth:width}},console,CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},
    require:name=>{
      if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(name==='react')return React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:uiStore};
      if(name.endsWith('tabChrome'))return {TABBAR_PANEL_BG:'rgb(37, 37, 38)'};
      if(name.endsWith('paneStripGroupInterfaceModel.mjs'))return interfaceModel;
      if(name.endsWith('paneStripCollapseModel.mjs'))return model;
      if(name.endsWith('paneStripGroupMetaHover.mjs'))return {ownPaneStripGroupMetaHover:(owner,toggle,_target,inside)=>ownPaneStripGroupMetaHover(owner,toggle,win,inside)};
      if(name.endsWith('paneStripHoverScope.mjs'))return hoverScope;
      if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('pane-strip-color-groups.cjs'))return {paneStripColorGroupsBasis};
      if(name.endsWith('horizontalDragGeometry.mjs'))return {horizontalDragAutoScrollDelta};
      if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {captureUIHoverAction:()=>({id:'owned-hover'}),currentUIActionId:()=> 'owned',uiDiagnosticAbsNow:()=>performance.now(),
        uiPerformancePhaseForAction:(id,name,fields)=>diagnostics.push({id,name,fields}),
        uiPerformanceCommitForAction:(id,name,fields)=>diagnostics.push({id,name,fields})};
      if(name.endsWith('PaneStripGroupOutline'))return {__esModule:true,default:'Outline'};if(name.endsWith('.css'))return {};throw Error(name);
    }});
  const presentation=[];
  const props={group:state.spaces[0].stripColorGroups.groups[0],entries:state.splitPanes[0].tabs,representative:'b',workflowId:'W',windowId:'win',paneIndex:0,
    rowGap:7,presented:true,dragging:false,layoutKey:'same',onPresentation(...args){presentation.push(args);},renderChip:(entry,control)=>React.createElement('Card',{id:entry.tabId,control})};
  const dom={isConnected:true,dataset:{},contains:target=>target?.inside===true,querySelector:()=>null};
  const render=()=>{let count=0;do{
    assert.ok(count++<12,'finite render settles');cursor=0;dirty=false;root=module.exports.default(props);
    const wrappers=all(root).filter(node=>node.props?.['data-strip-item']!==undefined);
    Object.assign(dom.dataset,{paneStripCollapsedGroup:root.props['data-pane-strip-collapsed-group'],groupOpen:root.props['data-group-open'],groupMemberIds:root.props['data-group-member-ids'],groupDirection:root.props['data-group-direction']});
    dom.querySelectorAll=()=>wrappers.map(node=>{
      const id=node.props['data-strip-tab-id'];let item=nodes.get(id);if(!item){item={dataset:{stripTabId:id}};nodes.set(id,item);}
      item.getBoundingClientRect=()=>{rectangleReads++;return {left:anchor+(node.props.style.left||0),right:anchor+(node.props.style.left||0)+(memberWidths[id]||80),top:30,bottom:56,width:memberWidths[id]||80,height:26};};return item;
    });root.props.ref.current=dom;dom.querySelectorAll();
    while(layoutEffects.length)layoutEffects.shift()();while(effects.length)effects.shift()();
  }while(dirty);return root;};
  const emit=(type,extra={})=>win.dispatchEvent({type,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},target:new Element(),...extra});
  return {render,props,state,calls,presentation,dom,modes,memberWidths,emit,notifyStore,nodes,diagnostics,get root(){return root;},get rectangleReads(){return rectangleReads;},dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}

function eventHost() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, patch = {}) {
      const event = {type, button: 0, buttons: 1, isPrimary: true, pointerId: 7,
        clientX: 20, clientY: 20, metaKey: false, preventDefault() {},
        stopImmediatePropagation() {}, ...patch};
      // DOM dispatch does not invoke a listener added during this dispatch.
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    },
    count(type) { return listeners.get(type)?.size || 0; },
  };
}

export function strip(paneKey = 'pane:0', spaceId = 'w') {
  const order = ['x', 'a', 'b', 'c', 'z'];
  const element = {
    dataset: {paneKey, spaceId, paneTabDropZone: 'strip'},
    scrollLeft: 0, scrollTop: 0, scrollWidth: 500,
    closest(selector) { return selector === '[data-pane-tab-drop-zone]' ? this : null; },
    matches() { return true; },
    getBoundingClientRect: () => ({left: 0, top: 0, right: 500, bottom: 40, width: 500}),
    querySelectorAll: () => order.map((id, index) => ({dataset: {stripTabId: id},
      getBoundingClientRect: () => ({left: index * 100, right: (index + 1) * 100,
        top: 0, bottom: 40})})),
  };
  return element;
}

export function transportFixture({free = false, noLease = false, internalScope = true, sourcePaneKey = 'pane:0', organizationReady = true} = {}) {
  const window = eventHost(), frames = new Map(), subscribers = new Set();
  const writes = [], commands = [], diagnostics = [], logs = [], effects = [], pointerMoves = [], sidebarDrops = [];
  let frameId = 0, pointed = strip(sourcePaneKey), current = true, acceptSidebar = false;
  const state = {
    // Only the Store/IPC persistence boundary is controlled. Capture, group
    // lease, physical transport, claim and request compiler are actual modules.
    organizationReady, activeSpaceId: 'w', activeProjectId: 'p',
    openProjects: new Map([['p', {activeTabId: 'a', tabs: new Map([['b', {}], ['c', {}]])}]]),
    splitPanes: [{tabId: 'a'}, {tabId: 'z'}],
    centerStrips: {main: ['x', 'a', 'b', 'c', 'z'].map(tabId => ({projectId: 'p', tabId}))},
    centerStripKey: () => 'main', getFocusedProjectId: () => 'p',
    moveTabsToWindowStrip(...args) { writes.push(args); return true; },
    async commitWorkflowDrag(request,options) {
      assert.equal(options.isSourceCurrent(),true,'existing group lease is current at admission');
      assert.equal(model.workflowDragSourceValid(bridge.getPaneTabDragSnapshot().source.workflowDrag,state),true);
      commands.push({request,options});return true;
    },
  };
  const store = {getState: () => state, subscribe(listener) {
    subscribers.add(listener); return () => subscribers.delete(listener);
  }};

  const doubles = {
    '../store/useWorkspaceStore': {useWorkspaceStore: store},
    './uiPerformanceDiagnostics.mjs': {uiDragDiagnostic:(kind,fields)=>diagnostics.push({kind,...fields}), uiDragAdmission() {}, uiDragDiagnosticsEnabled: () => true},
    './interactionCursor': {acquireInteractionCursor: () => () => effects.push('cursor-release')},
    './horizontalRowDragPreview': {createHorizontalRowDragPreview: () => ({
      element: {dataset: {}, style: {}}, move() {}, remove() { effects.push('preview-remove'); },
    })},
    './historyForegroundPriority.mjs': {historyForegroundPriority: {
      beginInteraction() { effects.push('interaction-start'); }, endInteraction() { effects.push('interaction-end'); },
    }},
    react: {useSyncExternalStore() { assert.fail('no React mount in SOURCE tests'); }},
  };
  const context = vm.createContext({console: {log:(...args)=>logs.push(args.join(' ')),warn:(...args)=>logs.push(args.join(' '))}, crypto: {randomUUID}, performance, Map, Set, structuredClone,
    window, document: {elementFromPoint: () => pointed},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = {exports: {}};
    modules.set(filename, module);
    if (!compiled.has(filename)) compiled.set(filename,compileSource(fs.readFileSync(filename,'utf8'),filename));
    const require = specifier => {
      if (Object.hasOwn(doubles, specifier)) return doubles[specifier];
      if (specifier==='@noted/structured-dnd/core') return load(path.join(repository,'vendor/noted-shared/packages/structured-dnd/src/core/index.js'));
      if (!specifier.startsWith('.')) return nodeRequire(specifier);
      let resolved = path.resolve(path.dirname(filename), specifier);
      if (!path.extname(resolved)) resolved += '.ts';
      return load(resolved);
    };
    const wrapper = vm.runInContext('(function(require,module,exports){\n' + compiled.get(filename) + '\n})', context, {filename});
    wrapper(require, module, module.exports);
    return module.exports;
  }
  const bridge = load(path.join(directory, 'paneTabDragBridge.ts'));
  const pointer = load(path.join(directory, 'paneTabPointerBridge.ts'));
  const navigation = load(path.join(directory, 'tabDragNavigationBridge.ts'));
  const commit = load(path.join(directory, 'paneTabDropCommit.ts'));
  const gesture = load(path.join(directory, 'paneTabPointerGesture.ts'));
  const selectionModel = load(path.join(directory, 'paneStripSelectionModel.mjs'));
  const model = load(path.join(directory,'workflowDragModel.mjs'));
  const pair=load(path.join(directory,'paneStripReleasePair.mjs'));
  const source = {owner: 'pane', rootTabId: 'b', sourcePaneKey, sourceSpaceId: 'w',
    entries: ['b', 'c'].map(tabId => ({projectId: 'p', tabId})),
    ...(!noLease && {groupDrag: {internalScope:!free&&internalScope,boundary: free ? {kind: 'free'} : selectionModel.paneStripGroupDragBoundary(
      [{id: 'color', revision: 4, tabIds: ['a', 'b', 'c']}],
      {sourceIds: ['b', 'c'], order: ['x', 'a', 'b', 'c', 'z']}), isCurrent: () => current}}),
  };
  pointer.subscribePaneTabPointer(() => {
    if (pointer.getPaneTabPointerSnapshot().active) pointerMoves.push(pointer.getPaneTabPointerSnapshot());
  });
  pointer.subscribePaneTabPointerDrop(snapshot => { sidebarDrops.push(snapshot); return acceptSidebar; });
  const chip = {...eventHost(), closest: () => null};
  const unbind = gesture.bindPaneTabPointerDrag(chip, () => source);
  const flush = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
  };
  return {source, state, writes, commands, diagnostics, logs, effects, bridge, pointer, navigation, commit, model, pair, pointerMoves, sidebarDrops,
    notify(){for(const listener of [...subscribers])listener(state);},
    emit(type,patch){window.dispatch(type,patch);},
    get pendingFrames() { return frames.size; },
    get activeSubscriptions() { return subscribers.size; },
    get moveListeners() { return window.count('pointermove'); },
    invalidate(notify = false) { current = false; if (notify) [...subscribers].forEach(listener => listener(state)); },
    adopt() { acceptSidebar = true; },
    pointAt(element) { pointed = element; },
    hover(kind) { pointed = {closest: selector => selector === (kind === 'workflow'
      ? '[data-space-chip]' : '[data-structured-project-drop-target]')
      ? {dataset: {spaceChip: 'other-w', projectId: 'other-p'}} : null}; },
    startAt(x,y) { chip.dispatch('pointerdown',{target:chip,clientX:x,clientY:y});window.dispatch('pointermove',{clientX:x-10,clientY:y});flush(); },
    moveAt(x,y) { window.dispatch('pointermove',{clientX:x,clientY:y});flush(); },
    upAt(x,y) { window.dispatch('pointerup',{clientX:x,clientY:y}); },
    start() { chip.dispatch('pointerdown', {target: chip}); window.dispatch('pointermove', {clientX: 30}); flush(); },
    move(x = 30) { window.dispatch('pointermove', {clientX: x}); flush(); },
    meta() { window.dispatch('keydown', {key: 'Meta'}); flush(); },
    up(x = 30) { window.dispatch('pointerup', {clientX: x}); },
    dispose() { gesture.cancelPaneTabPointerDrag('test-cleanup'); unbind(); },
  };
}
