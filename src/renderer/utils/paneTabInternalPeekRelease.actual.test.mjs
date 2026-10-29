import test from 'node:test';
import assert from 'node:assert/strict';
import {componentFixture,transportFixture,plain,all} from './paneTabInternalPeekRelease.fixture.mjs';
import {createUIActionDiagnostics} from './uiPerformanceDiagnostics.mjs';
import {capturePaneStripGroupDrag} from './paneStripGroupsModel.mjs';
import {moveEntriesToIndex} from './horizontalReorder.mjs';
import {projectPaneStripRowPlacement} from '../../shared/pane-strip-row-placement.cjs';
import {paneStripColorGroupsBasis} from '../../shared/pane-strip-color-groups.cjs';

function fixture({organizationReady=true,internalScope=true,persistentRows=false,closedProvenance=false,memberWidths={},centerMode=false,knownOwner=true}={}) {
  const paneIndex=centerMode?null:0,windowId=centerMode?null:'win',paneKey=centerMode?'center':'pane:0';
  const ui=componentFixture({anchor:1388,width:2552,memberWidths}),f=transportFixture({organizationReady});
  const groupEntries=['b','a','c'].map(tabId=>({projectId:'P',tabId}));
  const entries=persistentRows?[...groupEntries,{projectId:'P',tabId:'x'}]:groupEntries;
  const ids=entries.map(e=>e.tabId),baseRowPlacement=persistentRows?{version:1,width:1164,order:ids,rowStartIds:['x']}:null;
  ui.props.representative='a';ui.props.entries=groupEntries;ui.props.layoutKey=JSON.stringify([1164,baseRowPlacement?.rowStartIds||[]]);
  Object.assign(ui.state.splitPanes[0],{projectId:'P',tabId:'a',tabs:entries,...(baseRowPlacement?{stripRowPlacement:baseRowPlacement}:{})});
  ui.props.group.tabIds=closedProvenance?['b','closed','c','a']:['b','c','a'];
  if(closedProvenance){ui.props.group.closedExtension={retain:'raw'};ui.state.spaces[0].stripColorGroups.fieldExtension={retain:'field'};ui.state.tabCatalog={closed:{active:false},a:{active:true},b:{active:true},c:{active:true}};}
  if(centerMode){Object.assign(ui.props,{paneIndex:null,windowId:null});Object.assign(ui.state,{splitPanes:[],activeProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'a'},centerStrips:{P:entries},centerStripKey:()=> 'P'});}
  ui.render().props.onMouseEnter({buttons:0});
  ui.emit('keydown',{key:'Meta'});ui.emit('keyup',{key:'Meta'});ui.render();
  const before=ui.nodes.get('b').getBoundingClientRect();
  const point={x:before.left+before.width*.2,y:43};
  const storage=id=>({a:1001,b:1002,c:1003,x:1004}[id]);
  const subject=id=>({version:2,subjectId:'subject-'+id,tabId:id,executionNamespace:'P',legacyStorageId:storage(id)});
  Object.assign(f.state,{navigationRevision:1,organizationRevision:7,view:'workspace',
    spaces:ui.state.spaces,splitPanes:ui.state.splitPanes,splitFocusedIndex:0,
    activeSpaceId:'W',activeProjectId:'P',focusedProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'a'},centerStrips:centerMode?{P:entries}:{},centerStripKey:()=> 'P',
    pendingTabWorkflowMembership:{},globalGroups:{groups:[],tabGroups:{},membershipRevisions:{}},
    openProjects:new Map([['P',{activeTabId:'a',tabs:new Map(ids.map(id=>[id,{id,tabType:'terminal',executionSubject:subject(id),cwd:'/fixture/'+id,draft:'draft-'+id,terminalId:'terminal-'+id}]))}]]),
    tabWorkflowMembership:Object.fromEntries(ids.map(tabId=>[tabId,{tabId,workflowId:'W',revision:1}])),
    tabCatalog:Object.fromEntries(ids.map(tabId=>[tabId,{tabId,namespace:'P',active:true,storageId:storage(tabId),
      executionSubject:subject(tabId)}]))});
  if(closedProvenance)f.state.tabCatalog.closed={tabId:'closed',namespace:'P',active:false,storageId:1005};
  Object.assign(f.source,{entries:[entries[1]],rootTabId:'a',sourceSpaceId:'W',sourcePaneKey:paneKey,
    groupDrag:capturePaneStripGroupDrag({getState:()=>f.state,owner:{workflowId:'W',windowId,paneIndex},sourceIds:['a'],internalScope})});
  let layoutRevision=0,stripRectangleReads=0;
  const groupNode=ui.dom;
  let ownerQueries=0;
  const layout={
    chrome:knownOwner&&!centerMode?{isConnected:true,dataset:{terminalPaneChromeHost:'W:win'},style:{left:'0%',top:'0%',width:'50%',height:'100%'}}:null,
    stage:!centerMode?{isConnected:true,dataset:{floatingTerminalStage:'1',terminalViewportShift:'0'},style:{transform:'translateX(0px)'}}:null,
    center:knownOwner?{isConnected:true,dataset:{workspaceCenter:'1'},style:{width:'100%'}}:null,
    parent:{isConnected:true,dataset:{},style:{width:'100%'},childElementCount:2},
    sidebar:{isConnected:true,dataset:{tabSidebar:'1',workflowTabSidebar:'W'},style:{width:'288px'}},
  };
  if(layout.center)layout.center.parentElement=layout.parent;
  layout.parent.querySelector=selector=>{ownerQueries++;return selector==='[data-tab-sidebar]'?layout.sidebar:null;};
  const extraNode={dataset:{stripTabId:'x'},getBoundingClientRect:()=>({left:1388,right:1468,top:80,bottom:106,width:80,height:26}),closest:selector=>selector==='[data-pane-tab-drop-zone]'?zone:null};
  const zone={dataset:{paneKey,spaceId:'W',paneTabDropZone:'strip',stripCanonicalIds:JSON.stringify(entries.map(e=>e.tabId)),stripLayoutKey:'initial'},
    scrollLeft:0,scrollTop:0,scrollWidth:1164,isConnected:true,matches:()=>true,
    closest:selector=>selector==='[data-pane-tab-drop-zone]'?zone:selector==='[data-terminal-pane-chrome-host]'?layout.chrome:
      selector==='[data-floating-terminal-stage]'?layout.stage:selector==='[data-workspace-center]'?layout.center:null,
    getBoundingClientRect:()=>{stripRectangleReads++;return {left:1388,right:2552,top:30,bottom:56,width:1164,height:26};},
    querySelectorAll:()=>[...ui.props.entries.map(entry=>ui.nodes.get(entry.tabId)),...(persistentRows?[extraNode]:[])]};
  const attachNodes=()=>{
    groupNode.closest=selector=>selector==='[data-pane-strip-collapsed-group]'?groupNode:selector==='[data-pane-tab-drop-zone]'||selector==='[data-pane-tab-strip-scroller]'?zone:null;
    for(const node of ui.nodes.values()) node.closest=selector=>selector==='[data-pane-strip-collapsed-group]'?groupNode:
      selector==='[data-pane-tab-drop-zone]'||selector==='[data-pane-tab-strip-scroller]'?zone:null;
  };
  attachNodes();
  const owner={},field=ui.state.spaces[0].stripColorGroups;
  let receipt={element:zone,workflowId:'W',windowId,centerKey:centerMode?'P':undefined,paneKey,baseEntries:entries,canonicalEntries:entries,entries,
    stripWidth:1164,layoutKey:'initial',baseGroupState:field,groupState:field,baseRowPlacement,logicalRowPlacement:baseRowPlacement,rowPlacement:baseRowPlacement};
  f.bridge.observePaneTabStrip(owner,receipt);
  const paint=()=>{
    const target=f.bridge.getPaneTabDragSnapshot().target;
    assert.equal(target?.at,0,'actual resolver target before B');
    ui.props.dragging=true;ui.props.sourceHere=true;
    const preview=moveEntriesToIndex(entries,f.source.entries,target.at);
    ui.props.entries=preview.filter(e=>e.tabId!=='x');ui.render();attachNodes();
    const layoutKey='painted:'+ ++layoutRevision;
    zone.dataset.stripCanonicalIds=JSON.stringify(preview.map(e=>e.tabId));zone.dataset.stripLayoutKey=layoutKey;
    receipt={...receipt,entries:preview,layoutKey,rowPlacement:projectPaneStripRowPlacement({current:baseRowPlacement,baseOrder:ids,order:preview.map(e=>e.tabId),sourceIds:['a'],rowStartId:target.rowStartId,width:1164})};
    f.bridge.observePaneTabStrip(owner,receipt);
  };
  return {...f,ui,entries,point,zone,owner,field,groupNode,persistentRows,centerMode,layout,
    ownerQueries:()=>ownerQueries,
    get receipt(){return receipt;},
    rectangles(){return stripRectangleReads+ui.rectangleReads;},
    observe(patch={},nextOwner=owner){receipt={...receipt,...patch};f.bridge.observePaneTabStrip(nextOwner,receipt);},
    start(){f.pointAt(ui.nodes.get('a'));f.startAt(1428,43);f.pointAt(ui.nodes.get('b'));f.moveAt(point.x,point.y);},
    paint,
    paintAt(x,y=43){f.pointAt(ui.nodes.get('b'));f.moveAt(x,y);},
    queueAt(x,y=43){f.emit('pointermove',{clientX:x,clientY:y});},
    underlay(){f.pointAt({closest:()=>null});},
    covered(){return [...ui.nodes.values()].some(node=>{const r=node.getBoundingClientRect();return point.x>=r.left&&point.x<=r.right;});},
    dispose(){f.dispose();ui.dispose();},
  };
}

function assertCommand(f) {
  assert.equal(f.writes.length,0,'organization-ready path never falls back to legacy writer');
  assert.equal(f.commands.length,1,'exactly one immutable organization request');
  const request=f.commands[0].request;
  assert.equal(request.destinationKind,'window');assert.equal(request.targetWorkflowId,'W');
  assert.deepEqual(plain((f.centerMode?request.workflows[0].layout.centerStrips.P:request.workflows[0].layout.splitPanes[0].tabs).map(e=>e.tabId)),['a','b','c',...(f.persistentRows?['x']:[])]);
  assert.deepEqual(plain(request.sourceRootTabIds),['a']);
  assert.deepEqual(plain(request.stripGroupReleases[0].nextState),plain(f.field));
  assert.equal(request.tabs[0].expected.subjectId,'subject-a');
  assert.equal(request.tabs[0].expected.storageId,1001);
  assert.equal(request.tabs[0].expected.namespace,'P');
  assert.equal(request.tabs[0].expected.workflowId,'W');
  assert.equal(request.tabs[0].workflowId,'W');
  assert.equal(f.centerMode?request.workflows[0].layout.activeSpaceTab.tabId:request.workflows[0].layout.splitPanes[0].tabId,'a');
  assert.equal(f.state.openProjects.get('P').tabs.get('a').cwd,'/fixture/a');
  assert.equal(f.state.openProjects.get('P').tabs.get('a').draft,'draft-a');
  assert.equal(f.state.openProjects.get('P').tabs.get('a').terminalId,'terminal-a');
}

test('IP24-01 organization-ready actual capture/compiler accepts live-zone internal release exactly once',async()=>{
  const f=fixture();try {
    f.start();f.paint();f.pointAt(f.zone);f.upAt(f.point.x,f.point.y);
    await Promise.resolve();assertCommand(f);
    f.upAt(f.point.x,f.point.y);assert.equal(f.commands.length,1);
  } finally {f.dispose();}
});

test('IP24-02 organization-ready actual component vacates painted point; exact same input still releases A before B',async()=>{
  const f=fixture();try {
    f.start();f.paint();assert.equal(f.covered(),false,'unchanged product OPEN preview vacates the point');
    assert.equal(f.source.groupDrag.isCurrent(),true);
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
  } finally {f.dispose();}
});

for(const [name,mutate] of [
  ['foreign raw color',f=>{f.state.spaces[0].stripColorGroups={...f.field,groups:[{...f.field.groups[0],color:'#123456'}]};}],
  ['foreign order',f=>{f.state.splitPanes=[{...f.state.splitPanes[0],tabs:[...f.entries].reverse()}];}],
  ['source membership',f=>{f.state.tabWorkflowMembership.a={tabId:'a',workflowId:'other',revision:2};}],
  ['navigation',f=>{f.state.navigationRevision++;}],
]) test('IP24-guard '+name+' before release never compiles a stale command',async()=>{
  const f=fixture();try {f.start();f.paint();mutate(f);f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();
    assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);
  }finally{f.dispose();}
});

test('IP24-03 repeated target slot still records the latest painted exact point',async()=>{
  const f=fixture();try {
    f.start();const revision=f.bridge.getPaneTabDragSnapshot().revision;
    f.point.x+=4;f.paintAt(f.point.x);assert.equal(f.bridge.getPaneTabDragSnapshot().revision,revision);
    f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
  } finally {f.dispose();}
});

test('IP24-04 lost capture does not end the gesture; a later painted input may release',async()=>{
  const f=fixture();try {
    f.start();f.emit('lostpointercapture',{pointerId:7});
    assert.equal(f.bridge.getPaneTabDragSnapshot().active,true);
    f.paintAt(f.point.x);f.paint();f.underlay();f.upAt(f.point.x,f.point.y);
    await Promise.resolve();assertCommand(f);
  } finally {f.dispose();}
});

async function noCommand(f){await Promise.resolve();assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);}
for(const [name,change] of [
  ['new up X',f=>f.upAt(f.point.x-1,f.point.y)],
  ['new up Y',f=>f.upAt(f.point.x,f.point.y+1)],
  ['unpainted queued same-coordinate move',f=>{f.queueAt(f.point.x);f.upAt(f.point.x,f.point.y);}],
  ['unpainted queued different-coordinate move',f=>{f.queueAt(f.point.x-2);f.upAt(f.point.x-2,f.point.y);}],
]) test('IP24-input '+name+' has no retained release authority',async()=>{
  const f=fixture();try{f.start();f.paint();f.underlay();change(f);await noCommand(f);}finally{f.dispose();}
});

test('IP24-receipt target without committed preview receipt is not a release proof',async()=>{
  const f=fixture();try{f.start();f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);}finally{f.dispose();}
});
for(const [name,change] of [
  ['wrong preview order',f=>f.observe({entries:f.entries})],
  ['wrong base order',f=>f.observe({baseEntries:[...f.entries].reverse()})],
  ['wrong canonical order',f=>f.observe({canonicalEntries:[...f.entries].reverse()})],
  ['wrong raw basis',f=>f.observe({baseGroupState:{...f.field,groups:[]}})],
  ['wrong projected group',f=>f.observe({groupState:{...f.field,groups:[]}})],
  ['different surface element',f=>f.observe({element:{...f.zone}})],
  ['unmounted surface',f=>f.bridge.forgetPaneTabStrip(f.owner)],
  ['different pane owner',f=>f.observe({windowId:'replacement-window'})],
  ['different workflow owner',f=>f.observe({workflowId:'foreign-workflow'})],
  ['unknown logical row receipt',f=>f.observe({logicalRowPlacement:{version:1,width:1164,order:['b','a','c'],rowStartIds:['c']}})],
  ['strip width',f=>f.observe({stripWidth:1165})],
  ['strip layout key without receipt',f=>{f.zone.dataset.stripLayoutKey='foreign-layout';}],
  ['group identity',f=>{f.groupNode.dataset.paneStripCollapsedGroup='foreign';}],
  ['group direction',f=>{f.groupNode.dataset.groupDirection='left';}],
  ['partial group offset receipt',f=>{f.groupNode.dataset.groupReleaseOrder=JSON.stringify(['b','a','c']);}],
  ['group layout signature',f=>{f.groupNode.dataset.groupReleaseLayout='foreign';}],
  ['group no longer OPEN',f=>{f.groupNode.dataset.groupOpen=undefined;}],
  ['group DOM disconnected',f=>{f.groupNode.isConnected=false;}],
  ['strip DOM disconnected',f=>{f.zone.isConnected=false;}],
  ['scroll left',f=>{f.zone.scrollLeft=1;}],
  ['scroll top',f=>{f.zone.scrollTop=1;}],
]) test('IP24-receipt '+name+' cannot grant the old painted point',async()=>{
  const f=fixture();try{f.start();f.paint();change(f);f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);}finally{f.dispose();}
});

for(const [name,type,patch] of [
  ['Escape','keydown',{key:'Escape'}],['blur','blur',{}],['resize','resize',{}],
  ['pointercancel','pointercancel',{pointerId:7}],['buttons-zero','pointermove',{buttons:0}],
]) test('IP24-cancel '+name+' removes input authority before release',async()=>{
  const f=fixture();try {f.start();f.paint();f.emit(type,patch);f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
    assert.equal(f.bridge.getPaneTabDragSnapshot().active,false);
  }finally{f.dispose();}
});

test('IP24-scope ordinary grouped roots still require current live containment',async()=>{
  const f=fixture({internalScope:false});try{f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);}finally{f.dispose();}
});

test('IP24-scope outside painted move clears the old internal target',async()=>{
  const f=fixture();try{f.start();f.paint();f.underlay();f.moveAt(f.point.x-100,200);
    assert.equal(f.bridge.getPaneTabDragSnapshot().target,null);f.upAt(f.point.x,43);await noCommand(f);
  }finally{f.dispose();}
});

test('IP24-identity Store notification revokes a closed/replaced same-ID subject',async()=>{
  const f=fixture();try {f.start();f.paint();f.state.tabCatalog.a={...f.state.tabCatalog.a,storageId:'replacement',executionSubject:{subjectId:'replacement'}};
    f.notify();f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
  }finally{f.dispose();}
});

test('IP24-pair accepted compiled request uses the existing release pair helper before ACK',async()=>{
  const f=fixture();try {f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
    const request=f.commands[0].request,patch=f.pair.publishPaneStripDragRelease(f.state,request);
    assert.deepEqual(plain(patch.splitPanes[0].tabs.map(e=>e.tabId)),['a','b','c']);
    assert.equal(paneStripColorGroupsBasis(patch.spaces[0].stripColorGroups),paneStripColorGroupsBasis(f.field));
    assert.deepEqual(plain(patch.pendingTabWorkflowMembership),{});
    assert.equal(patch.paneStripReleasedPairs.commands[request.mutationId].status,'pending');
    assert.deepEqual(plain(patch.paneStripReleasedPairs.commands[request.mutationId].request),plain(request));
  }finally{f.dispose();}
});

test('IP24-row existing unrelated row break remains exact through painted release and actual compiler',async()=>{
  const f=fixture({persistentRows:true});try {
    f.start();f.paint();assert.deepEqual(f.receipt.rowPlacement.rowStartIds,['x']);
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
    const next=f.commands[0].request.workflows[0].layout.splitPanes[0].stripRowPlacement;
    assert.deepEqual(plain(next),{version:1,width:1164,order:['a','b','c','x'],rowStartIds:['x']});
    assert.deepEqual(f.state.splitPanes[0].stripRowPlacement.order,['b','a','c','x'],'no optimistic rewrite at controlled Store boundary');
  }finally{f.dispose();}
});

test('IP24-width actual existing measurement changes the layout signature without granting an old input',async()=>{
  const f=fixture();try {f.start();f.paint();const before=f.groupNode.dataset.groupReleaseLayout;
    f.ui.memberWidths.b=120;
    const outline=all(f.ui.root).find(node=>node.type==='Outline');
    outline.props.onMeasured(f.ui.props.entries.map(entry=>({id:entry.tabId,...f.ui.nodes.get(entry.tabId).getBoundingClientRect()})));
    f.ui.render();assert.notEqual(f.groupNode.dataset.groupReleaseLayout,before);
    f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
  }finally{f.dispose();}
});

test('IP24-diagnostic accepted dispatch and refusal each have bounded reason without pretending dispatch is ACK',async()=>{
  const accepted=fixture(),refused=fixture();try {
    accepted.start();accepted.paint();accepted.underlay();accepted.upAt(accepted.point.x,accepted.point.y);await Promise.resolve();
    const yes=accepted.diagnostics.find(p=>p.kind==='release-decision');assert.equal(yes.authority,'painted-internal-point');
    assert.equal(yes.reason,'own-preview-receipt');assert.equal(yes.dispatched,true);
    assert.ok(accepted.logs.some(line=>line.includes('[PaneTabDnd:pointer-release]')&&line.includes('committed=0')&&line.includes('dispatched=1')&&line.includes('authority=painted-internal-point')));
    refused.start();refused.paint();refused.underlay();refused.upAt(refused.point.x+1,refused.point.y);await Promise.resolve();
    const no=refused.diagnostics.find(p=>p.kind==='release-decision');assert.equal(no.reason,'internal-input-changed');
    assert.equal(no.dispatched,false);assert.ok(refused.logs.some(line=>line.includes('decision=internal-input-changed')&&line.includes('dispatched=0')));
  }finally{accepted.dispose();refused.dispose();}
});

test('IP24-legacy exact real component/owner/input receipt also repairs the synchronous legacy writer',async()=>{
  const f=fixture({organizationReady:false});try {f.start();f.paint();assert.equal(f.covered(),false);
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();
    assert.equal(f.commands.length,0);assert.equal(f.writes.length,1);
    assert.deepEqual(plain(f.writes[0].slice(0,4)),[0,[{projectId:'P',tabId:'a'}],0,'a']);
  }finally{f.dispose();}
});

test('IP24-no-reader release reuses measured metadata without any rectangle read',async()=>{
  const f=fixture();try {f.start();f.paint();f.underlay();const before=f.rectangles();
    f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);assert.equal(f.rectangles(),before);
  }finally{f.dispose();}
});

test('IP24-compiler actual unknown source activity throws before Store and still logs/refuses/cleans up',()=>{
  const f=fixture();try {
    f.state.tabCatalog.a={...f.state.tabCatalog.a,active:undefined};
    f.start();f.paint();f.pointAt(f.zone);
    assert.throws(()=>f.upAt(f.point.x,f.point.y),error=>error.code==='workflow_drag_strip_group_release_source_changed');
    assert.equal(f.commands.length,0);assert.equal(f.writes.length,0);
    assert.equal(f.bridge.getPaneTabDragSnapshot().active,false);assert.equal(f.pointer.getPaneTabPointerSnapshot().active,false);
    assert.ok(f.logs.some(line=>line.includes('decision=compile-threw')&&line.includes('dispatched=0')));
    assert.deepEqual(f.effects.slice(-3),['preview-remove','cursor-release','interaction-end']);
  }finally{f.dispose();}
});

test('IP24-error asynchronous controlled Store rejection is observed once without an ACK claim',async()=>{
  const f=fixture();try {
    let dispatched=0;f.state.commitWorkflowDrag=()=>{dispatched++;return Promise.reject(Object.assign(Error('controlled transport rejection'),{code:'controlled_transport_rejected'}));};
    f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dispatched,1);assert.ok(f.logs.some(line=>line.includes('[PaneTabDnd:durable-release]')&&line.includes('committed=0 error=controlled_transport_rejected')));
    assert.equal(f.bridge.getPaneTabDragSnapshot().active,false);assert.equal(f.state.splitPanes[0].tabs[0].tabId,'b');
  }finally{f.dispose();}
});

test('IP24-provenance internal accepted order retains inactive raw member and field/group extensions',async()=>{
  const f=fixture({closedProvenance:true});try {f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);
    await Promise.resolve();assertCommand(f);
    const raw=f.commands[0].request.stripGroupReleases[0].nextState;
    assert.deepEqual(plain(raw.groups[0].tabIds),['b','closed','c','a']);
    assert.deepEqual(plain(raw.groups[0].closedExtension),{retain:'raw'});assert.deepEqual(plain(raw.fieldExtension),{retain:'field'});
    assert.equal(f.state.openProjects.get('P').tabs.has('closed'),false);
  }finally{f.dispose();}
});

test('IP24-mixed mixed card widths use their unchanged actual preview and preserve representative anchor',async()=>{
  const f=fixture({memberWidths:{a:80,b:123,c:97}});try {const anchor=f.ui.nodes.get('a').getBoundingClientRect();
    f.start();f.paint();assert.equal(f.covered(),false);
    assert.equal(f.ui.nodes.get('a').getBoundingClientRect().left,anchor.left);
    assert.equal(f.ui.nodes.get('a').getBoundingClientRect().top,anchor.top);
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
  }finally{f.dispose();}
});

test('IP24-recorder actual bounded diagnostics retains the precise release refusal reason',async()=>{
  const f=fixture();try {
    f.start();f.paint();f.underlay();f.upAt(f.point.x+1,f.point.y);await Promise.resolve();
    const release=f.diagnostics.find(p=>p.kind==='release-decision'),lines=[];
    const recorder=createUIActionDiagnostics({now:()=>1000,emit:line=>lines.push(line)});
    recorder.drag.configure({mode:'frames'});
    recorder.drag.event('pending',{pointerId:7,eventAbs:1000,gestureId:release.gestureId});
    recorder.drag.event('threshold',{gestureId:release.gestureId});
    recorder.drag.event('release-decision',release);
    recorder.drag.event('physical-end',{gestureId:release.gestureId,reason:'release'});
    const line=lines.find(value=>value.startsWith('[Perf:DragWindow] '));assert.ok(line);
    const report=JSON.parse(line.slice('[Perf:DragWindow] '.length));
    assert.equal(report.phases.find(p=>p.name==='release-decision').reason,'internal-input-changed');
    assert.ok(report.phases.length<=32);assert.ok(line.length<66000);
  }finally{f.dispose();}
});

for(const [name,change] of [
  ['row gap',f=>{f.ui.props.rowGap++;}],
  ['representative',f=>{f.ui.props.representative='b';}],
]) test('IP24-component '+name+' revokes the existing measured release signature',async()=>{
  const f=fixture();try {f.start();f.paint();const before=f.groupNode.dataset.groupReleaseLayout;
    change(f);f.ui.render();assert.notEqual(f.groupNode.dataset.groupReleaseLayout,before);
    f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
  }finally{f.dispose();}
});

for(const [name,change] of [
  ['chrome left',f=>{f.layout.chrome.style.left='1%';}],
  ['chrome top',f=>{f.layout.chrome.style.top='1%';}],
  ['chrome owner ID',f=>{f.layout.chrome.dataset.terminalPaneChromeHost='W:other';}],
  ['stage viewport shift',f=>{f.layout.stage.dataset.terminalViewportShift='1';}],
  ['stage transform',f=>{f.layout.stage.style.transform='translateX(1px)';}],
  ['FullView chrome reparent',f=>{f.layout.chrome={...f.layout.chrome};}],
  ['center reparent',f=>{f.layout.center.parentElement={...f.layout.parent};}],
  ['center parent child count',f=>{f.layout.parent.childElementCount++;}],
]) test('IP24-owner '+name+' invalidates captured authored layout before Store publication',async()=>{
  const f=fixture();try{f.start();f.paint();change(f);f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
    assert.equal(f.diagnostics.find(p=>p.kind==='release-decision').reason,'internal-owner-geometry-changed');
  }finally{f.dispose();}
});

test('IP24-owner missing layout owners never grants fallback',async()=>{
  const f=fixture({knownOwner:false});try{f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);}finally{f.dispose();}
});

test('IP24-center existing center owner without floating chrome preserves the internal release',async()=>{
  const f=fixture({centerMode:true});try{f.start();f.paint();f.underlay();const queries=f.ownerQueries();
    f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);assert.equal(f.ownerQueries(),queries,'release performs no parent/sidebar query');
  }finally{f.dispose();}
});

test('IP24-center imperative sidebar width change invalidates old painted point before Store update',async()=>{
  const f=fixture({centerMode:true});try{f.start();f.paint();f.layout.sidebar.style.width='300px';
    f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
    assert.equal(f.diagnostics.find(p=>p.kind==='release-decision').reason,'internal-owner-geometry-changed');
  }finally{f.dispose();}
});

test('IP24-B5 exact earlier released logical order may catch up in retained canonical props during the new gesture',async()=>{
  const f=fixture();try {
    const oldEntries=['c','b','a'].map(tabId=>({projectId:'P',tabId}));
    const before={...f.state,splitPanes:[{...f.state.splitPanes[0],tabs:oldEntries}]};
    const admission=f.model.captureWorkflowDrag(before,{gestureId:'earlier-release',origin:'pane',sourceId:'reserve-tab:c',entries:[oldEntries[0]],sourcePaneKey:'pane:0',sourceWorkflowId:'W'});
    const request=f.model.workflowDragRequest(admission,{workflowId:'W',target:{zone:'strip',paneKey:'pane:0',paneIndex:0,spaceId:'W',at:2,stripWidth:1164}});
    Object.assign(f.state,f.pair.publishPaneStripDragRelease(before,request));
    assert.deepEqual(plain(f.state.splitPanes[0].tabs.map(e=>e.tabId)),['b','a','c']);
    f.observe({canonicalEntries:oldEntries});f.start();f.paint();
    assert.equal(f.source.groupDrag.isCurrent(),true);
    f.observe({canonicalEntries:f.entries});
    assert.equal(f.source.groupDrag.isCurrent(),true,'exact own catch-up cannot revoke a fresh logical pickup');
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
  }finally{f.dispose();}
});

test('IP24-B5 retained canonical row metadata catches up to the exact already released logical descriptor',async()=>{
  const f=fixture({persistentRows:true});try {
    const oldEntries=['a','b','c','x'].map(tabId=>({projectId:'P',tabId}));
    const oldRows={version:1,width:1164,order:['a','b','c','x'],rowStartIds:['x']};
    const before={...f.state,splitPanes:[{...f.state.splitPanes[0],tabs:oldEntries,stripRowPlacement:oldRows}]};
    const admission=f.model.captureWorkflowDrag(before,{gestureId:'earlier-row-release',origin:'pane',sourceId:'reserve-tab:b',entries:[oldEntries[1]],sourcePaneKey:'pane:0',sourceWorkflowId:'W'});
    const request=f.model.workflowDragRequest(admission,{workflowId:'W',target:{zone:'strip',paneKey:'pane:0',paneIndex:0,spaceId:'W',at:0,stripWidth:1164}});
    Object.assign(f.state,f.pair.publishPaneStripDragRelease(before,request));
    const logicalRows=f.state.splitPanes[0].stripRowPlacement;
    assert.deepEqual(plain(logicalRows),{version:1,width:1164,order:['b','a','c','x'],rowStartIds:['x']});
    f.observe({canonicalEntries:oldEntries,baseRowPlacement:null,logicalRowPlacement:logicalRows});
    f.start();f.paint();f.observe({canonicalEntries:f.entries,baseRowPlacement:logicalRows});
    assert.equal(f.source.groupDrag.isCurrent(),true);
    f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
    assert.deepEqual(plain(f.commands[0].request.workflows[0].layout.splitPanes[0].stripRowPlacement),
      {version:1,width:1164,order:['a','b','c','x'],rowStartIds:['x']});
  }finally{f.dispose();}
});

test('IP24-FullView already lifted chrome without stage/center remains a valid exact owner',async()=>{
  const f=fixture();try {f.layout.stage=null;f.layout.center=null;
    f.start();f.paint();f.underlay();f.upAt(f.point.x,f.point.y);await Promise.resolve();assertCommand(f);
  }finally{f.dispose();}
});

test('IP24-FullView lifted chrome style change without a Store update revokes the old point',async()=>{
  const f=fixture();try {f.layout.stage=null;f.layout.center=null;
    f.start();f.paint();f.layout.chrome.style.left='12px';f.underlay();f.upAt(f.point.x,f.point.y);await noCommand(f);
    assert.equal(f.diagnostics.find(p=>p.kind==='release-decision').reason,'internal-owner-geometry-changed');
  }finally{f.dispose();}
});

export {fixture,assertCommand};
