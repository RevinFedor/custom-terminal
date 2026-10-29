// Real ReactDOM hooks, memo, reconciliation and synchronous handler frames.
// The DOM below only stores nodes/styles/events; it has no browser layout,
// native scroll, Virtuoso, PTY or provider. Not a <=200ms acceptance claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import * as presentation from './timelineMarkerPresentation.mjs';
import { getTerminalMcpTag, isServicePromptEntry } from '../../shared/prompt-origin.mjs';
import { createTimelineViewportSource } from './timelineViewport.mjs';

class Node {
  constructor(type, name, doc) { this.nodeType = type; this.nodeName = name; this.tagName = name;
    this.ownerDocument = doc; this.childNodes = []; this.style = {setProperty(k,v){this[k]=v;}};
    this.attributes = {}; this.namespaceURI = 'http://www.w3.org/1999/xhtml'; }
  appendChild(node) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node),1); node.parentNode = null; return node; }
  insertBefore(node, before) { node.parentNode?.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before),0,node); node.parentNode=this; }
  setAttribute(k,v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener() {} removeEventListener() {}
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  set textContent(value) { this.childNodes.forEach(n => n.parentNode = null); this.childNodes=[]; this._text=String(value); }
  get textContent() { return this._text || this.childNodes.map(n=>n.textContent).join(''); }
  getRootNode() { return this.ownerDocument; }
  contains(node) { return this === node || this.childNodes.some(n=>n.contains(node)); }
}
const doc = new Node(9,'#document'); doc.ownerDocument=doc;
doc.createElement = name => new Node(1,name.toUpperCase(),doc);
doc.createElementNS = (_ns,name) => doc.createElement(name);
doc.createTextNode = text => { const node=new Node(3,'#text',doc);node.textContent=text;return node; };
doc.documentElement=doc.createElement('html'); doc.body=doc.createElement('body');doc.documentElement.appendChild(doc.body);
doc.activeElement=doc.body;
globalThis.document=doc;
globalThis.window={ document:doc, Node, HTMLElement:Node, HTMLIFrameElement:class {},
  addEventListener(){},removeEventListener(){},location:{protocol:'http:'} };
doc.defaultView=window;
const {createRoot}=await import('react-dom/client');
const {flushSync}=await import('react-dom');
const {compiled,preCompiled}=JSON.parse(fs.readFileSync(0,'utf8'));
const state=createStore(()=>({historyVisibleUuids:{T:['u7'],B:['u9']}}));
function useUIStore(selector){return useStore(state,selector);}
let storeConnections=0;
useUIStore.getState=state.getState;
useUIStore.subscribe=fn=>{storeConnections++;const stop=state.subscribe(fn);return()=>{storeConnections--;stop();};};
const publish=(ids,tab='T')=>state.setState(s=>({historyVisibleUuids:{...s.historyVisibleUuids,[tab]:ids}}));
const counts={parent:0,map:0,rows:[]};
const noop=()=>{};
const api=new Proxy({}, {get:()=>noop});
const emptyMap=new Map(), emptySet=new Set();
const sources=[];
const scope={...presentation,React,useUIStore,createTimelineViewportSource:options=>{
  const source=createTimelineViewportSource(options);sources.push(source);return source;
},
  probeParent:()=>counts.parent++,probeRow:index=>counts.rows.push(index),
  getOrchestrationTag:getTerminalMcpTag,isServicePromptEntry,getLoopPromptOriginTag:()=>null,
  TimelineCornerBadges:()=>null,Tooltip:p=>p.children,ChevronDown:()=>null,ChevronRight:()=>null,
  legacyVisible:new Set([8]),
  // Non-viewport owners of the actual map frame are fixed, not reimplemented.
  isExpandedLayout:false,expandedRenderBudget:Infinity,groupMap:new Map(),expandedGroups:new Set(),
  semanticGroupByUuid:emptyMap,codexCompactClusters:emptyMap,semanticGroupForcedOpenIds:emptySet,
  expandedSemanticGroups:emptySet,isAttributeEntry:()=>false,segmentRefs:{current:[]},
  hiddenCompactBoundaryIndices:emptySet,forkMarkerIndexByLastSnapIndex:emptyMap,forkMarkers:[],
  isCodex:true,lastBoundaryIndex:-1,collapsedGroupPresentation:emptyMap,activeNoteIndex:null,isNoteEditing:false,
  summaryToolType:null,semanticActionByUuid:emptyMap,historySearchMatches:()=>false,rowApi:api,
  semanticMetaPromptByUuid:emptyMap,promptSummaries:{},promptSummaryLoadingKeys:emptySet,
  isSelected:()=>false,contextSelectedEntryId:null,responseOnlyIndices:new Set([8]),unreachableIndices:new Set([8]),
  clickedState:null,hoveredIndex:null,activeTooltipIndex:null,hoveredNoteIndex:null,notes:{},
  noteEditPosition:'before',notePositions:{},rewindMarkers:emptySet,claudeMemoryBoundaryIndex:-1,
  failedStripFlash:null,activeForkMarkerIndex:null,isCmdHeld:false,treeMode:false,
  timelineFontSize:12,timelineSummaryFontSize:12,timelineLineClamp:3,intrinsicPreviewFontSize:12,
};
const {Frame,TimelineSegmentRow,TimelineBeginningViewportMarker}=vm.runInNewContext(compiled,scope);
const container=doc.createElement('div');doc.body.appendChild(container);const root=createRoot(container);
const entries=Array.from({length:3000},(_,i)=>({uuid:'u'+i,type:'user',content:'complete row '+i}));
Object.defineProperty(entries,'map',{value(fn){counts.map++;return Array.prototype.map.call(this,fn);}});
function render(props={}) {flushSync(()=>root.render(React.createElement(Frame,{entries,tabId:'T',sessionId:'S',...props})));}
function reset(){counts.parent=counts.map=0;counts.rows=[];}
function nodes(node,predicate,out=[]){if(predicate(node))out.push(node);for(const c of node.childNodes)nodes(c,predicate,out);return out;}
function entry(uuid){return nodes(container,n=>n.attributes['data-timeline-entry-uuid']===uuid)[0];}
function dot(uuid){return entry(uuid).childNodes[0];}
render();assert.equal(storeConnections,1);assert.equal(dot('u7').style.backgroundColor,'#ccc');
assert.equal(dot('u8').style.backgroundColor,'#999');assert.equal(entry('u8').attributes['data-unreachable'],undefined);
reset();flushSync(()=>publish(['u8']));
assert.equal(counts.parent,0);assert.equal(counts.map,0);assert.deepEqual(counts.rows.sort((a,b)=>a-b),[7,8]);
assert.equal(dot('u7').style.backgroundColor,'#999');assert.equal(dot('u8').style.backgroundColor,'#ccc');
console.log('POST N=3000 viewport-only: parent renders=0 maps=0 row renders=2 [7,8]');
reset();flushSync(()=>publish(['u8','u8']));assert.deepEqual(counts,{parent:0,map:0,rows:[]});
reset();flushSync(()=>publish(['u0']));
assert.equal(counts.parent,0);assert.equal(counts.map,0);
const beginning=container.firstChild.childNodes.slice(-2);
assert.equal(beginning[0].style.width,'10px');assert.equal(beginning[1].style.width,'10px');
flushSync(()=>publish([]));assert.equal(beginning[0].style.width,'12px');assert.equal(beginning[1].style.width,'12px');

// Mode transition is allowed to rerender; viewport-only updates thereafter are
// still local. Legacy terminal props and response/reachability stay effective.
render({historyTargetVisible:false});assert.equal(storeConnections,0);
assert.equal(dot('u8').style.backgroundColor,'transparent');assert.equal(entry('u8').attributes['data-unreachable'],'');
reset();flushSync(()=>publish(['u6']));assert.equal(counts.parent,0);assert.equal(counts.map,0);assert.deepEqual(counts.rows,[]);
render();assert.equal(dot('u6').style.backgroundColor,'#ccc');assert.equal(dot('u8').style.backgroundColor,'#999');
render({historyTargetVisible:false,isSdkTab:true});reset();flushSync(()=>publish(['u5']));
assert.equal(counts.parent,0);assert.equal(counts.map,0);assert.deepEqual(counts.rows.sort((a,b)=>a-b),[5,6]);
render({tabId:'B',sessionId:'other'});assert.equal(dot('u9').style.backgroundColor,'#ccc');
reset();flushSync(()=>publish(['u4'],'T'));assert.deepEqual(counts,{parent:0,map:0,rows:[]});
flushSync(()=>publish(['u10'],'B'));assert.equal(counts.parent,0);assert.deepEqual(counts.rows.sort((a,b)=>a-b),[9,10]);
render();
const sourceBeforeHide=sources.at(-1);
render({isVisible:false});assert.equal(storeConnections,0);
reset();flushSync(()=>publish(['u11']));assert.deepEqual(counts,{parent:0,map:0,rows:[]});
render();assert.equal(dot('u11').style.backgroundColor,'#ccc');
assert.equal(sources.at(-1),sourceBeforeHide,'hide/show must retain the same viewport source');
assert.deepEqual(counts.rows.sort((a,b)=>a-b),[4,11],'show updates only changed markers, not all 3000 rows');
const sourceBefore=sources.at(-1);
render({timelineOwnerKey:'same-tab-session-but-other-cwd'});
assert.notEqual(sources.at(-1),sourceBefore);assert.equal(storeConnections,1);assert.equal(dot('u11').style.backgroundColor,'#ccc');
flushSync(()=>root.unmount());assert.equal(storeConnections,0);

// The actual parent map with only the former parent selector restored. No
// legacy effect is added: one full map already demonstrates the regression.
const {Frame:PreFrame}=vm.runInNewContext(preCompiled,{...scope});
const preRoot=createRoot(container);
flushSync(()=>preRoot.render(React.createElement(PreFrame,{entries,tabId:'T',sessionId:'S'})));
reset();flushSync(()=>publish(['u12']));
assert.equal(counts.parent,1);assert.equal(counts.map,1);
console.log('PRE selector control N=3000 viewport-only: parent renders=1 maps=1 (3000 memo-row comparisons)');
flushSync(()=>preRoot.unmount());

// Actual row's own expansion controls preserve group any-member scope, then
// narrow back to the header's own UUID when expanded.
const small=doc.createElement('div');doc.body.appendChild(small);const smallRoot=createRoot(small);
const groupEntries=[{uuid:'a',type:'user'},{uuid:'b',type:'user'},{uuid:'c',type:'user'}];
const groupStore=createStore(()=>({ids:['b']}));let groupConnections=0;
const viewportSource=createTimelineViewportSource({entries:groupEntries,read:()=>groupStore.getState().ids,
  subscribe:fn=>{groupConnections++;const stop=groupStore.subscribe(fn);return()=>{groupConnections--;stop();};}});
const controls=[];
const groupApi=new Proxy({expandGroup:id=>{controls.push('expand:'+id);renderGroup(true);},
  collapseGroup:id=>{controls.push('collapse:'+id);renderGroup(false);}}, {get:(target,key)=>target[key] || noop});
const props={viewportSource,entry:groupEntries[0],index:0,api:groupApi,groupInfo:{isGroupHeader:true,isGroupChild:true,groupId:'g',groupSize:3,groupKind:'orchestration'},
  isGroupExpanded:false,isExpandedLayout:false,isInViewport:false};
const renderGroup=expanded=>flushSync(()=>smallRoot.render(React.createElement(TimelineSegmentRow,{...props,isGroupExpanded:expanded})));
renderGroup(false);reset();flushSync(()=>groupStore.setState({ids:['c']}));assert.deepEqual(counts.rows,[],'any member stays active');
function clickToggle(){
  const button=nodes(small,n=>n.attributes['data-timeline-group-toggle']==='g')[0];
  const key=Object.keys(button).find(k=>k.startsWith('__reactProps$'));
  let stopped=false;button[key].onClick({stopPropagation(){stopped=true;}});assert.equal(stopped,true);
}
clickToggle();assert.deepEqual(controls,['expand:g']);reset();flushSync(()=>groupStore.setState({ids:['a']}));assert.deepEqual(counts.rows,[0]);
clickToggle();assert.deepEqual(controls,['expand:g','collapse:g']);reset();flushSync(()=>groupStore.setState({ids:['b']}));assert.deepEqual(counts.rows,[]);
flushSync(()=>smallRoot.unmount());assert.equal(groupConnections,0);

const textRoot=createRoot(small),fullEntry={uuid:'full',type:'user',content:'Ω😀\ud800'.repeat(3000)+' END'};
const textStore=createStore(()=>({ids:[]}));
const textSource=createTimelineViewportSource({entries:[fullEntry],read:()=>textStore.getState().ids,subscribe:textStore.subscribe});
const clicks=[];
const textApi=new Proxy({handleEntryClick:entry=>clicks.push(entry)}, {get:(target,key)=>target[key]||noop});
flushSync(()=>textRoot.render(React.createElement(TimelineSegmentRow,{entry:fullEntry,index:0,api:textApi,viewportSource:textSource,
  isExpandedLayout:true,timelineLineClamp:3,intrinsicPreviewFontSize:12,isInViewport:false})));
const beforeText=small.textContent;
flushSync(()=>textStore.setState({ids:['full']}));assert.equal(small.textContent,beforeText,'viewport changes no labels/text');
const textRow=nodes(small,n=>n.attributes['data-timeline-entry-uuid']==='full')[0];
const textProps=Object.keys(textRow).find(k=>k.startsWith('__reactProps$'));
textRow[textProps].onClick({});assert.equal(clicks[0],fullEntry);assert.equal(clicks[0].content,fullEntry.content);
flushSync(()=>textRoot.unmount());
console.log('PASS fresh snapshots/reset/reentry/source-owner, SDK/legacy reachability, beginning fork+plan, collapsed/expanded group, cleanup');
