import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transformSync} from 'esbuild';
import * as panes from '../../utils/splitPanesModel.mjs';
import * as visual from '../../utils/tabCardVisual.mjs';
import {windowSplitAvailability,canMinimizeDisplayWindow} from '../../utils/windowDisplayLayouts.mjs';
import {clampMenuToViewport} from '../../utils/menuViewportClamp.mjs';
import * as metrics from '../UI/contextMenuMetrics.mjs';

// Actual function/JSX and pure layout rules; stores/hooks/portals/DOM/lifecycle
// executors are controlled. This is not browser geometry or installed E2E.
const source=fs.readFileSync(new URL('./SplitPaneChrome.tsx',import.meta.url),'utf8');
const start=source.indexOf('export function SplitPaneAttachRow(');
const end=source.indexOf('\n/** Above every surface a pane can host',start);
assert.ok(start>=0&&end>start);
const code=transformSync(source.slice(start,end).replace(/^export /,'')+'\nglobalThis.Attach=SplitPaneAttachRow;',{loader:'tsx'}).code;
const icons=['ArrowLeftRight','BringToFront','Columns2','MessageSquareText','MoreVertical','PanelBottom','PanelLeft',
  'PanelRightClose','PanelRightOpen','PanelTop','Search','FolderInput','Minimize2','X'];
const icon=()=>React.createElement('svg');
const component=name=>props=>React.createElement('test-'+name,null,props.children);

function fixture({kind='empty',focused=true,area='terminal',side=false,hidden=false}={}) {
  const calls=[],slots=[];let cursor=0,tree;
  const state={activeSpaceId:'W',activeProjectId:'P',spaces:[{id:'W',name:'Here'},{id:'OTHER',name:'Other'}],
    openProjects:new Map([['P',{tabs:new Map([['AI',{id:'AI',commandType:'codex'}],['FILE',{id:'FILE',tabType:'file'}]])}]]),
    splitPanes:[],centerStrips:{},
    closeWindowPane:index=>calls.push(['close-window',index]),closeTab:(...args)=>calls.push(['close-tab',...args]),
    addEmptySplitPane:index=>calls.push(['split',index]),activateCenterTab:(...args)=>calls.push(['activate',...args]),
    openWindowTabChooser:index=>calls.push(['chooser',index])};
  const ui={sideTerminalOpenTabs:{AI:side,FILE:false},terminalPrimaryTabs:{},timelineTreeModeTabs:{},historyMcpAsUserTabs:{},
    historyPinned:false,activeArea:area,tabGeometry:{paddingX:4,paddingY:2,gap:4,borderRadius:5},tabsFontSize:13,
    setHistoryPanelOpen:(...args)=>calls.push(['history',...args]),setSideTerminalOpen:(...args)=>calls.push(['side',...args]),
    setTimelineTreeMode:(...args)=>calls.push(['timeline',...args])};
  const memo=(callback,deps)=>{const at=cursor++,prior=slots[at];
    if(!prior||deps.some((v,i)=>!Object.is(v,prior.deps[i])))slots[at]={deps,value:callback()};return slots[at].value;};
  const hooks={...React,useState:initial=>{const at=cursor++;if(!(at in slots))slots[at]=initial;
      return[slots[at],next=>{slots[at]=typeof next==='function'?next(slots[at]):next;}];},
    useRef:initial=>{const at=cursor++;return slots[at]??={current:initial};},
    useMemo:memo,useCallback:(cb,deps)=>memo(()=>cb,deps),useLayoutEffect:()=>{cursor++;},useEffect:()=>{cursor++;}};
  const workspace=selector=>selector(state);workspace.getState=()=>state;
  const uistore=selector=>selector(ui);uistore.getState=()=>ui;
  const context={...panes,...visual,...metrics,React:hooks,useEffect:hooks.useEffect,
    useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,
    useWorkspaceStore:workspace,useUIStore:uistore,resolveTabTerminalPrimary:(s,id)=>!!s.terminalPrimaryTabs[id],
    windowSplitAvailability,canMinimizeDisplayWindow,clampMenuToViewport,
    useWorkspaceWindowSwapPickerSnapshot:()=>({active:false}),
    PaneTabStrip:component('strip'),HiddenWindowPicker:component('hidden-picker'),TabMenuChoices:component('choices'),
    WorkspaceWindowSwapPicker:component('swap'),MoveToWindowMenu:component('move'),IdleSessionStopCountdown:component('idle'),
    createPortal:children=>React.createElement('test-portal',null,children),
    STRIP_MENU_ACTIVE_BACKGROUND:'green',STRIP_MENU_ACTIVE_HOVER_BACKGROUND:'green',STRIP_MENU_ACTIVE_FRAME:'frame',
    PANE_HEADER_HEIGHT_VAR:'--pane-header-h',TAB_SURFACE_HEADER_HEIGHT_VAR:'--tab-surface-header-height',
    splitPaneHeaderHeightVar:i=>'--pane-header-h-'+i,
    requestInputSearch:id=>calls.push(['search-input',id]),requestHistorySearch:id=>calls.push(['search-history',id]),
    terminalRegistry:new Map([['AI',{element:{id:'terminal'}}]]),
    requestTerminalFullView:(_element,id)=>calls.push(['full-view',id]),
    document:{body:{}},CSS:{escape:x=>x},window:{innerWidth:1280,innerHeight:800},console,
    ...Object.fromEntries(icons.map(name=>[name,icon]))};
  vm.runInNewContext(code,context);
  const props={projectId:'P',tabId:'',vacant:true,focused,paneIndex:0,spaceId:'W',presented:true,
    onCloseVacantPane:()=>state.closeWindowPane(0)};
  const setKind=next=>{
    props.vacant=next==='empty'||next==='chooser';props.tabId=next==='file'?'FILE':next==='ai'?'AI':'';
    const pane={windowId:'window-A',projectId:'P',tabId:props.tabId,
      tabs:next==='chooser'?[{slotId:'slot-A'}]:[{projectId:'P',tabId:'FILE'},{projectId:'P',tabId:'AI'}],
      ...(next==='chooser'?{selectedSlotId:'slot-A'}:{})};
    state.splitPanes=[pane,...(hidden?[{windowId:'hidden',displayHidden:true,projectId:'P',tabId:'AI'}]:[])];
    props.paneLayout=state.splitPanes;
  };
  const find=predicate=>{const walk=node=>Array.isArray(node)?node.flatMap(walk):!node||typeof node!=='object'?[]:
    [...(predicate(node)?[node]:[]),...walk(node.props?.children)];return walk(tree);};
  const by=(key,value)=>find(node=>key in (node.props||{})&&(value===undefined||node.props[key]===value));
  const render=()=>{cursor=0;tree=context.Attach(props);return tree;};
  const click=(key,value)=>{const button=by(key,value)[0];assert.ok(button,key+':'+value);
    button.props.onClick({stopPropagation(){},currentTarget:{getBoundingClientRect:()=>({left:100,right:122,bottom:35})}});render();};
  setKind(kind);render();
  const openMenu=()=>click('data-split-strip-menu-button');
  return{props,state,ui,calls,context,render,setKind,find,by,click,openMenu,
    html:()=>renderToStaticMarkup(tree),tree:()=>tree};
}

const layoutKeys=['position','float','marginLeft','marginRight','display','height','width','alignSelf','alignItems','gap','padding','flexShrink'];
function actionLayout(f) {
  const root=f.by('data-split-pane-actions')[0];
  const visit=node=>Array.isArray(node)?node.map(visit):!node||typeof node!=='object'?null:{
    type:typeof node.type==='function'?'component':node.type,
    style:Object.fromEntries(layoutKeys.filter(k=>k in (node.props?.style||{})).map(k=>[k,node.props.style[k]])),
    children:visit(node.props?.children)};
  return visit(root);
}

test('actual empty/file/AI/chooser header has no vacancy label or X; action layout is stable through focus/side-terminal changes',()=>{
  for(const hidden of [false,true]) {
    const f=fixture({hidden});let baseline;
    for(const kind of ['empty','file','ai','chooser','ai','empty'])for(const side of [false,true])for(const area of ['terminal','sidebar'])for(const focused of [false,true]){
      f.setKind(kind);f.ui.sideTerminalOpenTabs.AI=side;f.ui.activeArea=area;f.props.focused=focused;f.render();
      const html=f.html();assert.ok(!html.includes('Нет вкладки'));assert.equal(f.by('data-vacant-pane-close').length,0);
      assert.equal(f.by('data-split-strip-menu-button').length,1);assert.equal(f.by('data-split-pane-terminal-slot').length,1);
      baseline??=actionLayout(f);assert.deepEqual(actionLayout(f),baseline);
      const focus=f.by('data-split-pane-focus-actions')[0];assert.equal(focus.props.inert,!focused||area==='sidebar');
      const frame=f.by('data-split-attach-row')[0].props.style;assert.ok(frame.minHeight>0);assert.equal(frame.height,undefined);
    }
  }
});

test('empty/chooser Close window invokes only the supplied vacant-window executor once',()=>{
  for(const kind of ['empty','chooser']){
    const f=fixture({kind});f.openMenu();assert.equal(f.by('data-split-strip-menu-item','close-window').length,1);
    f.click('data-split-strip-menu-item','close-window');assert.deepEqual(f.calls,[['close-window',0]]);
    assert.equal(f.by('data-split-strip-menu').length,0);
  }
  for(const kind of ['file','ai']){const f=fixture({kind});f.openMenu();assert.equal(f.by('data-split-strip-menu-item','close-window').length,0);}
});

test('old menu cannot close another workflow/window, a replacement index or a now-filled pane',()=>{
  for(const change of ['workflow','replacement','filled']){
    const f=fixture();f.openMenu();const action=f.by('data-split-strip-menu-item','close-window')[0];
    if(change==='workflow')f.state.activeSpaceId='OTHER';
    else if(change==='replacement')f.state.splitPanes=[{...f.state.splitPanes[0],windowId:'window-B'}];
    else f.state.splitPanes[0].tabId='AI';
    action.props.onClick({stopPropagation(){}});assert.deepEqual(f.calls,[],change);
  }
});

test('legacy id-less vacancy closes only while the exact pane object remains current',()=>{
  for(const replace of [false,true]){
    const f=fixture();delete f.state.splitPanes[0].windowId;f.render();f.openMenu();
    const action=f.by('data-split-strip-menu-item','close-window')[0];
    if(replace)f.state.splitPanes=[{...f.state.splitPanes[0]}];
    action.props.onClick({stopPropagation(){}});assert.deepEqual(f.calls,replace?[]:[['close-window',0]]);
  }
});

test('terminal slot reserves width but cannot activate an absent control; valid AI keeps its existing executor',()=>{
  for(const kind of ['empty','file','ai'])for(const side of [false,true]){
    const f=fixture({kind,side}),button=f.by('data-split-pane-terminal-slot')[0];
    const available=kind==='ai'&&side;
    assert.equal(button.props.disabled,!available);assert.equal(button.props.style.width,22);
    f.click('data-split-pane-terminal-slot');
    assert.deepEqual(f.calls,available?[['activate','P','AI'],['full-view','AI']]:[]);
  }
});

test('Search input and Timeline keep the exact AI target; parked chips/chooser are passed to the unchanged measured strip',()=>{
  const f=fixture({kind:'ai'});f.openMenu();f.click('data-split-strip-menu-item','search-input');
  assert.deepEqual(f.calls,[['search-input','AI']]);
  f.openMenu();f.click('data-split-strip-menu-item','timeline');
  assert.deepEqual(f.calls.at(-1),['timeline','AI',true]);
  for(const kind of ['empty','chooser','file','ai']){
    f.setKind(kind);f.render();const strip=f.find(node=>node.type===f.context.PaneTabStrip)[0];
    assert.equal(strip.props.shownTabId,f.props.vacant?'':f.props.tabId);assert.equal(strip.props.windowId,'window-A');
    if(kind==='chooser')assert.equal(strip.props.selectedSlotId,'slot-A');else assert.equal(strip.props.entries.length,2);
    strip.props.onCreateTab();assert.deepEqual(f.calls.at(-1),['chooser',0]);
  }
});
