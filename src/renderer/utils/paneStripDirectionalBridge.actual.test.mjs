import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {transformSync} from 'esbuild';
import {moveEntriesToIndex} from './horizontalReorder.mjs';
import {paneStripGroupDragBoundary} from './paneStripSelectionModel.mjs';

// Full actual bridge + existing drop-commit source, not copied gap arithmetic.
// DOM rectangles, React, Store/writer admission and diagnostics are controlled.
// No Electron/native pointer/pixels, private SQL or performance acceptance.
const bridgeURL=process.env.NOTED_PANE_DIRECTION_BRIDGE_SOURCE
  ?pathToFileURL(process.env.NOTED_PANE_DIRECTION_BRIDGE_SOURCE):new URL('./paneTabDragBridge.ts',import.meta.url);
const directionURL=process.env.NOTED_PANE_DIRECTION_MODEL_SOURCE
  ?pathToFileURL(process.env.NOTED_PANE_DIRECTION_MODEL_SOURCE):new URL('./paneStripGroupInterfaceModel.mjs',import.meta.url);
const {directionalPaneStripGroup}=await import(directionURL);
const commitURL=new URL('./paneTabDropCommit.ts',import.meta.url);
const bridgeSource=fs.readFileSync(bridgeURL,'utf8'),commitSource=fs.readFileSync(commitURL,'utf8');
const dependencies=new Map();
for(const [source,url] of [[bridgeSource,bridgeURL],[commitSource,commitURL]])
  for(const match of source.matchAll(/\bfrom\s+['"]([^'"]+\.(?:mjs|cjs))['"]/g))
    dependencies.set(match[1],await import(new URL(match[1],url)));
const bridgeCode=transformSync(bridgeSource,{loader:'ts',format:'cjs'}).code;
const commitCode=transformSync(commitSource,{loader:'ts',format:'cjs'}).code;
const ref=tabId=>({projectId:'P',tabId}),plain=value=>JSON.parse(JSON.stringify(value));
const center=box=>({x:(box.left+box.right)/2,y:(box.top+box.bottom)/2});

function owners() {
  const writes=[],diagnostics=[],state={activeSpaceId:'W',activeProjectId:'P',
    splitPanes:[{windowId:'win',tabId:'1'}],
    moveTabsToWindowStrip(...args){writes.push(args);return true;}};
  const common={console:{log(){}},structuredClone,performance};
  const bridge={exports:{}};
  vm.runInNewContext(bridgeCode,{...common,module:bridge,exports:bridge.exports,require:name=>{
    if(name==='react')return {useSyncExternalStore(){assert.fail('no mounted React in this control');}};
    if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {uiDragDiagnostic:(...args)=>diagnostics.push(args),uiDragAdmission(){}};
    if(dependencies.has(name))return dependencies.get(name);throw Error('Uncontrolled bridge dependency '+name);
  }},{filename:bridgeURL.pathname});
  const commit={exports:{}};
  vm.runInNewContext(commitCode,{...common,module:commit,exports:commit.exports,require:name=>{
    if(name==='./paneTabDragBridge')return bridge.exports;
    if(name==='../store/useWorkspaceStore')return {useWorkspaceStore:{getState:()=>state}};
    if(dependencies.has(name))return dependencies.get(name);throw Error('Uncontrolled commit dependency '+name);
  }},{filename:commitURL.pathname});
  return {api:bridge.exports,commit:commit.exports,writes,diagnostics,state};
}

function fixture({ids=['1','2','3'],representative='1',widths={},anchor=200,viewport=300,
  paneKey='pane:0',workflowId='W',underlay=true,groupTop=40}={}) {
  const runtime=owners(),{api}=runtime,owner={},fullIds=['x',...ids,'y'];
  const ownWidths=new Map(ids.map(id=>[id,widths[id]||80])),nodes=new Map(),boxes=new Map();
  const group={dataset:{paneStripCollapsedGroup:'g',groupOpen:'1',groupMemberIds:JSON.stringify(ids)}};
  let geometry,rectangleReads=0,scans=0,scrollWrites=0,visibleIds=[...fullIds],hidden=new Set(),leaseCurrent=true;
  const compute=(right=viewport)=>directionalPaneStripGroup({ids,representative,widths:ownWidths,
    anchorLeft:anchor,viewportLeft:0,viewportRight:right,gap:6});
  const setGeometry=value=>{
    geometry=value;group.dataset.groupDirection=value.direction;
    for(const id of ids){const left=anchor+value.offsets.get(id);boxes.set(id,{left,right:left+ownWidths.get(id),top:groupTop,bottom:groupTop+26});}
  };
  setGeometry(compute());
  boxes.set('x',underlay?{left:0,right:280,top:groupTop,bottom:groupTop+26}:{left:0,right:20,top:0,bottom:26});
  boxes.set('y',{left:800,right:850,top:groupTop+40,bottom:groupTop+66});
  const strip={dataset:{paneKey,spaceId:workflowId,paneTabDropZone:'strip',stripCanonicalIds:JSON.stringify(fullIds),stripLayoutKey:'open:0'},
    scrollTop:0,scrollWidth:1000,get scrollLeft(){return 0;},set scrollLeft(_){scrollWrites++;},
    closest:selector=>selector==='[data-pane-tab-drop-zone]'?strip:null,matches:()=>true,
    getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:140,width:1000}),
    querySelectorAll:selector=>{scans++;return visibleIds.filter(id=>!selector.includes(':not')||!hidden.has(id)).map(id=>node(id));}};
  function node(id){
    if(!nodes.has(id))nodes.set(id,{dataset:{stripTabId:id},
      closest:selector=>selector==='[data-pane-tab-drop-zone]'?strip:selector==='[data-pane-strip-collapsed-group]'&&ids.includes(id)?group:null,
      getBoundingClientRect:()=>{rectangleReads++;return boxes.get(id);}});
    return nodes.get(id);
  }
  const pointed={closest:selector=>selector==='[data-pane-tab-drop-zone]'?strip:selector==='[data-pane-strip-collapsed-group]'?group:null};
  const surface=(extra={})=>({workflowId,windowId:'win',paneKey,baseEntries:fullIds.map(ref),entries:fullIds.map(ref),
    stripWidth:1000,layoutKey:strip.dataset.stripLayoutKey,...extra});
  const begin=(roots=['2'],{grouped=true}={})=>{
    api.endPaneTabDrag();const effective=roots.length?roots:['external'];
    const source={owner:'pane',rootTabId:effective[0],entries:effective.map(ref),sourcePaneKey:paneKey,sourceSpaceId:workflowId,
      ...(grouped&&{groupDrag:{internalScope:true,boundary:paneStripGroupDragBoundary([{id:'g',revision:1,tabIds:ids}],{sourceIds:effective,order:fullIds}),
        isCurrent:()=>leaseCurrent}})};
    api.beginPaneTabDrag(source);api.observePaneTabStrip(owner,surface());return source;
  };
  return {...runtime,ids,fullIds,representative,anchor,ownWidths,boxes,nodes,group,strip,pointed,owner,compute,setGeometry,surface,begin,
    get geometry(){return geometry;},get reads(){return rectangleReads;},get scans(){return scans;},get scrollWrites(){return scrollWrites;},
    resolve:(x,y,roots=[],preferred=true)=>api.resolvePaneTabDropTarget(preferred?pointed:strip,x,roots,y),
    removeBox:id=>{visibleIds=visibleIds.filter(value=>value!==id);},hide:id=>{hidden.add(id);},
    duplicateBox:id=>{visibleIds.push(id);},invalidate:()=>{leaseCurrent=false;},
    dispose:()=>{api.forgetPaneTabStrip(owner);api.endPaneTabDrag();}};
}

test('actual captured bridge keeps anchor X/Y and durable logical order while every own-center pickup is a no-op',()=>{
  for(const options of [
    {anchor:200,viewport:300},
    {anchor:100,viewport:1000},
    {anchor:600,viewport:850,ids:['2','1','3','4'],representative:'2',widths:{'2':135,'1':70,'3':190,'4':95}},
    {anchor:400,viewport:600,ids:['1','2','3'],representative:'2',widths:{'1':70,'2':135,'3':190}},
  ]){
    const f=fixture(options);try{
      assert.deepEqual(f.geometry.order,f.ids);assert.equal(f.geometry.offsets.get(f.representative),0);
      const representative=f.boxes.get(f.representative);assert.equal(representative.left,f.anchor);assert.equal(representative.top,40);
      for(const id of f.ids){
        f.begin([id]);const point=center(f.boxes.get(id)),target=f.resolve(point.x,point.y,[id]);assert.ok(target,id);
        assert.deepEqual(moveEntriesToIndex(f.fullIds,[id],target.at,value=>value),f.fullIds,`${f.geometry.direction}/${id}`);
        assert.equal(f.writes.length,0);assert.equal(f.boxes.get(f.representative).left,f.anchor);
      }
      assert.deepEqual(f.geometry.order,f.ids,'direction is never a durable order permutation');
    }finally{f.dispose();}
  }
});

test('actual left/right first and last gaps map after all root removals through member hits and uncovered strip hits',()=>{
  for(const viewport of [300,1000])for(const roots of [[],['2'],['2','3'],['x','2'],['x','1','2','3'],['1','2','3']]){
    const f=fixture({viewport,underlay:true});try{
      f.begin(roots,{grouped:false});const first=f.boxes.get(f.ids[0]),last=f.boxes.get(f.ids.at(-1));
      const left=f.geometry.direction==='left',firstX=left?first.right-1:first.left+1,lastX=left?last.left+1:last.right-1;
      const prefix=roots.includes('x')?0:1,count=f.ids.filter(id=>!roots.includes(id)).length;
      for(const preferred of [true,false]){
        const a=f.resolve(firstX,53,roots,preferred),b=f.resolve(lastX,53,roots,preferred);
        assert.ok(a);assert.ok(b);assert.equal(a.at,prefix,`${viewport}/${roots}/first/${preferred}`);
        assert.equal(b.at,prefix+count,`${viewport}/${roots}/last/${preferred}`);
        if(left){assert.equal(a.rowStartId,null);assert.equal(b.rowStartId,null);}
      }
      assert.equal(f.reads,f.fullIds.length,'the same captured rectangles serve member and gap paths');
      assert.equal(f.scrollWrites,0);
    }finally{f.dispose();}
  }
});

test('actual left multi-root preview and existing painted commit pass only moving roots once to the existing writer',()=>{
  const f=fixture({ids:['1','2','3','4'],anchor:600,viewport:850,widths:{'1':135,'2':70,'3':190,'4':95}});try{
    const roots=['2','3'];f.begin(roots);const last=f.boxes.get('4'),target=f.resolve(last.left+1,53,roots);
    assert.equal(target.at,3);assert.equal(target.rowStartId,null);
    f.api.setPaneTabDragTarget(target);f.api.observePaneTabStrip(f.owner,f.surface());
    const result=f.commit.commitPaintedPaneTabDrop('2');assert.equal(result.claimed,true);assert.equal(result.committed,true);
    assert.equal(f.writes.length,1);assert.deepEqual(plain(f.writes[0].slice(0,4)),[0,roots.map(ref),3,'1']);
    assert.deepEqual(moveEntriesToIndex(f.fullIds,roots,target.at,value=>value),['x','1','4','2','3','y']);
    assert.equal(f.commit.commitPaintedPaneTabDrop('2').claimed,false);assert.equal(f.writes.length,1);
    assert.deepEqual(f.geometry.order,['1','2','3','4'],'mapping itself never publishes a layout or membership edit');
  }finally{f.dispose();}
});

test('actual same-ID direction is captured with boxes; only a committed layout receipt permits recapture',()=>{
  const f=fixture({anchor:200,viewport:1000});try{
    f.begin(['1']);const before=center(f.boxes.get('1'));
    assert.equal(f.resolve(before.x,before.y,['1']).at,1);const reads=f.reads,scans=f.scans;
    f.setGeometry(f.compute(300));assert.equal(f.geometry.direction,'left');
    assert.equal(f.resolve(before.x,before.y,['1']).at,1,'live direction cannot be mixed into an older measured lease');
    assert.equal(f.reads,reads);assert.equal(f.scans,scans);
    f.strip.dataset.stripLayoutKey='open:left:1';assert.equal(f.resolve(before.x,before.y,['1']),null);
    assert.equal(f.reads,reads,'requested layout is unknown without another geometry reader');
    f.api.observePaneTabStrip(f.owner,f.surface());const after=center(f.boxes.get('1'));
    assert.equal(f.resolve(after.x,after.y,['1']).at,1);assert.equal(f.reads,reads+f.fullIds.length);
    const committedReads=f.reads;
    for(let sample=0;sample<20;sample++){f.api.observePaneTabStrip(f.owner,f.surface());assert.equal(f.resolve(after.x,after.y,['1']).at,1);}
    assert.equal(f.reads,committedReads);assert.equal(f.boxes.get('1').left,200);assert.deepEqual(f.geometry.order,['1','2','3']);
    const other={};f.api.observePaneTabStrip(other,f.surface({workflowId:'other',layoutKey:'different'}));
    assert.equal(f.resolve(after.x,after.y,['1']).at,1);assert.equal(f.reads,committedReads);f.api.forgetPaneTabStrip(other);
  }finally{f.dispose();}
});

test('actual malformed, incomplete, duplicate or nonmonotonic OPEN geometry stays unknown instead of inventing a gap',()=>{
  const faults={
    direction:f=>{f.group.dataset.groupDirection='diagonal';},
    emptyDirection:f=>{f.group.dataset.groupDirection='';},
    nullDirection:f=>{f.group.dataset.groupDirection=null;},
    missing:f=>f.removeBox('2'),
    hidden:f=>f.hide('2'),
    duplicate:f=>f.duplicateBox('2'),
    declaration:f=>{f.group.dataset.groupMemberIds=JSON.stringify(['1','3','2']);},
    overlap:f=>{f.boxes.set('2',{...f.boxes.get('2'),left:190,right:270});},
    otherRow:f=>{f.boxes.set('2',{...f.boxes.get('2'),top:80,bottom:106});},
    nonfinite:f=>{f.boxes.set('2',{...f.boxes.get('2'),left:NaN});},
    duplicateCanonical:f=>{f.strip.dataset.stripCanonicalIds=JSON.stringify(['x','1','2','2','3','y']);},
  };
  for(const [name,change] of Object.entries(faults)){
    const f=fixture();try{
      f.begin(['2']);change(f);assert.equal(f.resolve(240,53,['2']),null,name);const reads=f.reads;
      assert.equal(f.resolve(240,53,['2']),null,name);assert.equal(f.reads,reads,'unknown is not a polling read');assert.equal(f.writes.length,0);
    }finally{f.dispose();}
  }
});

test('actual left scope keeps underlay, row-start semantics and the existing member ownership fences separate',()=>{
  const f=fixture({underlay:false});try{
    f.begin(['2']);const last=f.boxes.get('3');
    assert.equal(f.resolve(last.left+1,53,['2'],false).at,3);assert.equal(f.resolve(last.left+1,53,['2'],false).rowStartId,null);
    assert.equal(f.resolve(10,13,['2'],false).at,1,'ordinary first row uses unchanged physical insertion');
    const target=f.resolve(240,53,['2']);f.api.setPaneTabDragTarget(target);
    f.api.setPaneTabDragTarget({...target,paneKey:'pane:1',paneIndex:1});assert.equal(f.api.getPaneTabDragSnapshot().target,null);
    f.api.setPaneTabDragTarget({...target,spaceId:'other'});assert.equal(f.api.getPaneTabDragSnapshot().target,null);
    f.api.setPaneTabDragTarget(target);f.invalidate();assert.equal(f.api.claimPaneTabDragDrop('2'),null);assert.equal(f.writes.length,0);
  }finally{f.dispose();}
});
