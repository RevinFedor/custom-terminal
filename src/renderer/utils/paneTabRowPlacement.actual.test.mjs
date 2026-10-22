import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {buildSync,transformSync} from 'esbuild';
import * as rows from '../../shared/pane-strip-row-placement.cjs';
import * as rowLayout from '../../shared/pane-strip-row-layout.cjs';
import * as reorder from './horizontalReorder.mjs';
import * as layout from './paneStripLayout.mjs';
import * as collapsed from './paneStripCollapseModel.mjs';
import * as workflowDrag from './workflowDragModel.mjs';
import * as groupField from '../../shared/pane-strip-color-groups.cjs';
import {TAB_STRIP_ROW_GAP} from './tabCardVisual.mjs';

const ref=tabId=>({projectId:'P',tabId});
const ids=['A','B','C','D','Portfolio','Usage','Guide','Codex','History'];
const projected=['A','B','C','D','Guide','Portfolio','Usage','Codex','History'];
const placement={version:1,width:684,order:projected,rowStartIds:['Guide']};
const target={zone:'strip',paneKey:'pane:0',paneIndex:0,spaceId:'w',at:4,rowStartId:'Portfolio',stripWidth:684};
const source={owner:'pane',rootTabId:'Guide',entries:[ref('Guide')],sourcePaneKey:'pane:0',sourceSpaceId:'w',gestureId:'row-test'};
const component=()=>null;
const plain=value=>JSON.parse(JSON.stringify(value));

// Actual whole Strip module/JSX. React hooks, committed width, store and child
// components are controlled ports; no DOM/native geometry is claimed here.
function stripFixture() {
  let width=684,drag={active:false},released=null;
  const state={activeSpaceId:'w',activeProjectId:'P',spaces:[{id:'w'}],
    splitPanes:[{windowId:'W',projectId:'P',tabId:'Portfolio',tabs:ids.map(ref)}]};
  const store=selector=>selector(state);store.getState=()=>state;
  const hooks={...React,useRef:value=>({current:value}),useState:value=>[value===0?width:value,()=>{}],
    useEffect(){},useLayoutEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn};
  const doubles={react:hooks,'react-dom':{createPortal:children=>children},
    '@atlaskit/pragmatic-drag-and-drop/element/adapter':{},
    '../../store/useWorkspaceStore':{useWorkspaceStore:store},
    '../../utils/paneStripLayout.mjs':layout,'../../utils/tabCardVisual.mjs':{TAB_STRIP_ROW_GAP},
    '../../utils/horizontalReorder.mjs':reorder,
    '../../utils/paneTabDragBridge':{paneStripKey:()=> 'pane:0',usePaneTabDragSnapshot:()=>drag,
      usePaneTabDropPresentation:()=>released},
    '../../utils/paneTabDropPresentation.mjs':{panePresentationKey:()=> 'W'},
    '../../utils/workflowDragModel.mjs':workflowDrag,
    '../../../shared/pane-strip-color-groups.cjs':groupField,
    '../../utils/paneTabDropCommit':{},
    '../../hooks/useHorizontalOrderPreview':{useHorizontalOrderPreview:(base,_ref,_selector,_attribute,options)=>({displayedIds:options.projectionIds||base})},
    '../../utils/uiPerformanceDiagnostics.mjs':{uiDragDiagnostic(){}},
    '../../utils/menuViewportClamp.mjs':{},'../../utils/splitPanesModel.mjs':{splitPanesFingerprint:()=>''},
    '../UI/contextMenuMetrics.mjs':{},'./NewTabMenuRows':{__esModule:true,default:component},
    './PaneTabChip':{__esModule:true,default:component},'./PaneChooserChip':{__esModule:true,default:component},
    './PaneStripSelection':{PaneStripSelectionContext:React.createContext(null),usePaneStripSelectionController:()=>({})},
    './PaneStripGroupOutline':{__esModule:true,default:component},
    './PaneStripCollapsedGroup':{__esModule:true,default:component},
    '../../utils/paneStripCollapseModel.mjs':collapsed,
    '../../utils/paneStripSelectionModel.mjs':{paneStripOutlineGap:x=>x+1},
    '../../utils/paneStripGroupsModel.mjs':{readPaneStripOwnerEntries:()=>state.splitPanes[0].tabs,
      readyPaneStripOutlineGroups:()=>[],readPaneStripActiveGroups:()=>[]},
    '../../../shared/pane-strip-row-placement.cjs':rows,'../../../shared/pane-strip-row-layout.cjs':rowLayout,
  };
  const filename=process.env.NOTED_PANE_ROW_STRIP_SOURCE || new URL('../components/Workspace/PaneTabStrip.tsx',import.meta.url).pathname;
  const code=transformSync(fs.readFileSync(filename,'utf8'),{loader:'tsx',format:'cjs'}).code;
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>{
    assert.ok(Object.hasOwn(doubles,name),'uncontrolled module '+name);return doubles[name];
  },console,window:{},document:{body:{}}});
  const render=()=>module.exports.default({entries:state.splitPanes[0].tabs,shownTabId:'Portfolio',focused:true,
    paneIndex:0,inSplit:true,onCreateTab(){},spaceId:'w',windowId:'W'});
  const find=(tree,predicate)=>Array.isArray(tree)?tree.flatMap(node=>find(node,predicate))
    : !tree||typeof tree!=='object'?[]:[...(predicate(tree)?[tree]:[]),...find(tree.props?.children,predicate)];
  const read=()=>{const tree=render();return{
    order:find(tree,node=>'data-strip-tab-id' in (node.props||{})).map(node=>node.props['data-strip-tab-id']),
    breaks:find(tree,node=>node.type==='br').map(node=>node.props['data-pane-strip-row-start']),
    outline:find(tree,node=>node.type===component&&Object.hasOwn(node.props||{},'layoutKey'))[0]?.props.layoutKey,
  };};
  return {state,read,setDrag:value=>{drag=value;},setReleased:value=>{released=value;},setWidth:value=>{width=value;}};
}

test('actual Strip keeps Guide at row start through preview, released owner and canonical props',()=>{
  const f=stripFixture();assert.deepEqual(f.read().breaks,[]);
  f.setDrag({active:true,source,target});
  assert.deepEqual(f.read().order,projected);assert.deepEqual(f.read().breaks,['Guide']);
  f.setDrag({active:false});f.setReleased({strips:[{key:'W',entries:projected.map(ref),rowPlacement:placement}]});
  assert.deepEqual(f.read().breaks,['Guide']);
  f.state.splitPanes[0]={...f.state.splitPanes[0],tabs:projected.map(ref),stripRowPlacement:placement};
  f.setReleased(null);assert.deepEqual(f.read().order,projected);assert.deepEqual(f.read().breaks,['Guide']);
});

test('same order can move from previous-row tail to next-row start; resized width restores natural wrap',()=>{
  const f=stripFixture();f.state.splitPanes[0].tabs=projected.map(ref);
  const before=f.read();f.setDrag({active:true,source,target});const after=f.read();
  assert.deepEqual(after.order,before.order);assert.deepEqual(after.breaks,['Guide']);assert.notEqual(after.outline,before.outline);
  f.setWidth(700);assert.deepEqual(f.read().order,projected);assert.deepEqual(f.read().breaks,[]);
});

test('released null row intent clears an older row break instead of falling back to it',()=>{
  const f=stripFixture();f.state.splitPanes[0]={...f.state.splitPanes[0],tabs:projected.map(ref),stripRowPlacement:placement};
  assert.deepEqual(f.read().breaks,['Guide']);
  f.setReleased({strips:[{key:'W',entries:projected.map(ref),rowPlacement:null}]});
  assert.deepEqual(f.read().breaks,[]);
});

test('color gather changing order invalidates old row metadata; color alone preserves it',()=>{
  const f=stripFixture();f.state.splitPanes[0]={...f.state.splitPanes[0],tabs:projected.map(ref),stripRowPlacement:placement};
  f.state.spaces[0].stripColorGroups={version:1,revision:2,groups:[]};assert.deepEqual(f.read().breaks,['Guide']);
  f.state.splitPanes[0].tabs=['Guide',...projected.filter(id=>id!=='Guide')].map(ref);assert.deepEqual(f.read().breaks,[]);
});

const {outputFiles}=buildSync({stdin:{contents:`export * from './src/renderer/utils/paneTabDragBridge.ts';
  export * from './src/renderer/utils/workflowDragModel.mjs';`,resolveDir:new URL('../../../',import.meta.url).pathname},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react'],
  alias:{'@noted/structured-dnd':new URL('../../../vendor/noted-shared/packages/structured-dnd/src',import.meta.url).pathname}});
const module={exports:{}};
vm.runInNewContext(outputFiles[0].text,{module,exports:module.exports,console:{log(){}},structuredClone,Map,Set,
  require:name=>{assert.equal(name,'react');return{useSyncExternalStore(){}};}});
const api=module.exports;

function leaseFixture() {
  const before={splitPanes:[{windowId:'W',...ref('Portfolio'),tabs:projected.map(ref)}],centerStrips:{},
    splitFocusedIndex:0,activeSpaceTab:ref('Portfolio'),activeProjectId:'P',focusedProjectId:'P'};
  const state={...before,view:'workspace',activeSpaceId:'w',navigationRevision:0,organizationRevision:1,
    spaces:[{id:'w',kind:'user',layout:before}],globalGroups:{groups:[],tabGroups:{},membershipRevisions:{}},
    openProjects:new Map([['P',{tabs:new Map(projected.map(id=>[id,{id,tabType:'terminal'}]))}]]),
    tabWorkflowMembership:Object.fromEntries(projected.map(tabId=>[tabId,{workflowId:'w',revision:1}])),
    tabCatalog:Object.fromEntries(projected.map((id,index)=>[id,{active:true,storageId:index+1}]))};
  const admission=api.captureWorkflowDrag(state,{gestureId:source.gestureId,origin:'pane',sourceId:'reserve-tab:Guide',
    entries:source.entries,sourcePaneKey:'pane:0'});assert.ok(admission);
  const request=api.workflowDragRequest(admission,{workflowId:'w',target});assert.ok(request);
  const subscribers=new Set(),store={getState:()=>state,subscribe:listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);}};
  const owner={},entries=projected.map(ref);
  const surface=(baseRowPlacement=null)=>({workflowId:'w',windowId:'W',paneKey:'pane:0',baseEntries:entries,
    entries,baseRowPlacement,rowPlacement:placement,stripWidth:684});
  api.beginPaneTabDrag(source);api.setPaneTabDragTarget(target);api.observePaneTabStrip(owner,surface());
  const lease=api.beginPaneTabDropPresentation(request,store,()=>true);assert.ok(lease);
  return{state,owner,surface,lease,request,close:()=>{api.forgetPaneTabStrip(owner);api.endPaneTabDrag();}};
}

test('same-order row-only write holds release until actual canonical React row props catch up',()=>{
  const f=leaseFixture();
  assert.deepEqual(plain(api.getPaneTabDropPresentationSnapshot().strips[0].rowPlacement),placement);
  api.endPaneTabDrag();assert.ok(api.getPaneTabDropPresentationSnapshot());
  Object.assign(f.state,f.request.workflows[0].layout);f.lease.applying();f.lease.settle(true);
  api.observePaneTabStrip(f.owner,f.surface(null));assert.ok(api.getPaneTabDropPresentationSnapshot(),'order alone cannot retire row presentation');
  api.observePaneTabStrip(f.owner,f.surface(placement));assert.equal(api.getPaneTabDropPresentationSnapshot(),null);f.close();
});

test('rejected row-only write releases its presentation without claiming canonical placement',()=>{
  const f=leaseFixture();f.lease.settle(false);assert.equal(api.getPaneTabDropPresentationSnapshot(),null);
  assert.equal(f.state.splitPanes[0].stripRowPlacement,undefined);f.close();
});

test('resizing the target retires the width-bound released row presentation',()=>{
  const f=leaseFixture();Object.assign(f.state,f.request.workflows[0].layout);f.lease.applying();f.lease.settle(true);
  api.observePaneTabStrip(f.owner,{...f.surface(null),rowPlacement:null,stripWidth:700});
  assert.equal(api.getPaneTabDropPresentationSnapshot(),null);f.close();
});
