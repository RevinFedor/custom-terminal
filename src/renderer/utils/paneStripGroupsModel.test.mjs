import test from 'node:test';import assert from 'node:assert/strict';
import {readPaneStripGroupState,readPaneStripOwnerEntries,readPaneStripActiveGroups,capturePaneStripGroupDrag,editPaneStripGroupColor,
  preparePaneStripGroupColor,applyPaneStripGatherPublication,readyPaneStripOutlineGroups} from './paneStripGroupsModel.mjs';
import {organizationSnapshot,organizationProjection,createOrganizationCommitter} from './workflowOrganizationClient.mjs';
import {mergeLayout} from '../../shared/workflow-organization.cjs';
const fixture=()=>{
  const entries=['a','b','c'].map((tabId,index)=>({projectId:index===1?'Q':'P',tabId}));
  const state={spaces:[{id:'W',name:'Work',layout:{},stripColorGroups:{version:1,revision:3,groups:[{id:'g',color:'#112233',tabIds:['a','b'],revision:2}]}},
    {id:'other',layout:{},extension:'preserve'}],activeSpaceId:'W',navigationRevision:3,organizationReady:true,organizationRevision:10,organizationGeneration:1,
    organizationWorkflowOrder:['W','other'],splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:entries}],
    splitFocusedIndex:0,centerStrips:{},windowDisplayKey:'display',windowDisplayLayouts:{},splitSizes:null,
    activeProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'a'},focusedProjectId:'P',
    tabWorkflowMembership:Object.fromEntries(entries.map(entry=>[entry.tabId,{workflowId:'W',revision:2}])),pendingTabWorkflowMembership:{},tabCatalog:{},
    globalGroups:{revision:99,groups:[{id:'hierarchy'}]},
    openProjects:new Map([['P',{tabs:new Map([['a',{cwd:'/a'}],['c',{}]])}],['Q',{tabs:new Map([['b',{}]])}]])};
  const lease={workflowId:'W',windowId:'win',paneIndex:0,entries:entries.slice(0,2),isCurrent:()=>true};
  return {state,lease,entries};
};
test('color is losslessly carried by existing workflow metadata/organization snapshot, never global/sidebar or execution fields',()=>{
  const {state,lease}=fixture(),before=state.spaces[1],global=state.globalGroups;
  const spaces=editPaneStripGroupColor(state,lease,'#abcdef');assert.equal(spaces[1],before);
  assert.equal(spaces[0].stripColorGroups.revision,4);assert.equal(spaces[0].stripColorGroups.groups[0].revision,3);
  assert.deepEqual(spaces[0].stripColorGroups.groups[0].tabIds,['a','b']);assert.equal(state.globalGroups,global);
  state.spaces=spaces;const snapshot=organizationSnapshot(state);
  assert.deepEqual(snapshot.spaces[0].stripColorGroups,spaces[0].stripColorGroups);
  const fields={...snapshot.spaces[0]};delete fields.layout;
  const metadata=mergeLayout({unknown:{retain:true}},fields);
  const projection=organizationProjection({publication:{version:1,migrationVersion:1,revision:11,generation:2},
    workflows:[{id:'W',kind:'user',revision:11,metadata,layout:snapshot.spaces[0].layout}],tabs:[]},state);
  assert.deepEqual(projection.spaces[0].stripColorGroups,spaces[0].stripColorGroups);
  assert.equal(projection.spaces[0].unknown.retain,true);
});
test('CREATE gathers selected slots around chooser/foreign entries while preserving shown/geometry/unknown fields; recolor does not gather',()=>{
  const {state,lease,entries}=fixture();delete state.spaces[0].stripColorGroups;
  const chooser={slotId:'chooser',cwd:'/chosen',future:'keep'},foreign={projectId:'P',tabId:'x'};
  state.splitPanes[0]={...state.splitPanes[0],tabId:'x',column:2,future:'keep',tabs:[entries[0],chooser,foreign,entries[1]]};
  const candidate=preparePaneStripGroupColor(state,lease,'#abcdef','g');
  const pane=candidate.state.splitPanes[0];assert.deepEqual(pane.tabs.map(slot=>slot.tabId||slot.slotId),['a','b','chooser','x']);
  assert.equal(pane.tabs[2],chooser);assert.equal(pane.tabId,'x');assert.equal(pane.column,2);assert.equal(pane.future,'keep');
  assert.deepEqual(state.splitPanes[0].tabs.map(slot=>slot.tabId||slot.slotId),['a','chooser','x','b']);
  const recolor=preparePaneStripGroupColor(candidate.state,lease,'#123456');assert.equal(recolor.gather,undefined);assert.equal(recolor.state.splitPanes,candidate.state.splitPanes);
});
test('ACK order adoption follows exact window while inactive, never changes focus or replaces a newer local order',()=>{
  const {state,lease,entries}=fixture();delete state.spaces[0].stripColorGroups;
  state.splitPanes[0].tabs=[entries[0],{projectId:'P',tabId:'x'},entries[1]];
  const prepared=preparePaneStripGroupColor(state,lease,'#abcdef','g');
  const proposed=organizationSnapshot(prepared.state),request={...proposed,stripColorGroupEdits:[{workflowId:'W',gather:prepared.gather}]};
  const published=proposed.spaces;
  const original=state.splitPanes;
  const applied=applyPaneStripGatherPublication(state,state.spaces,published,request);
  assert.deepEqual(applied.splitPanes[0].tabs.map(slot=>slot.tabId),['a','b','x']);assert.equal(applied.activeSpaceId,undefined);assert.equal(applied.splitFocusedIndex,undefined);
  state.spaces[0].layout=organizationSnapshot(state).spaces[0].layout;state.activeSpaceId='other';state.splitPanes=[{windowId:'foreign',tabs:[]}];
  const inactive=applyPaneStripGatherPublication(state,state.spaces,published,request);
  assert.equal(inactive.splitPanes,undefined);assert.deepEqual(inactive.spaces[0].layout.splitPanes[0].tabs.map(slot=>slot.tabId),['a','b','x']);
  state.activeSpaceId='W';state.splitPanes=[{...original[0],tabs:[entries[1],entries[0],{projectId:'P',tabId:'x'}]}];
  const newer=applyPaneStripGatherPublication(state,state.spaces,published,request);assert.equal(newer.splitPanes,undefined);
});
test('new outline waits for accepted gather props; existing group remains visible during a drag preview',()=>{
  const groups=[{id:'g',tabIds:['a','b']}],known=new Set(),before=['a','x','b'].map(tabId=>({tabId,projectId:'P'})),after=[before[0],before[2],before[1]];
  assert.deepEqual(readyPaneStripOutlineGroups(groups,before,after,known),[]);
  assert.deepEqual(readyPaneStripOutlineGroups(groups,after,after,known),groups);
  assert.deepEqual(readyPaneStripOutlineGroups(groups,before,after,known),groups);
});
test('mixed/subset/future/stale/not-ready edits reject before writing, exact recolor no-op preserves revision',()=>{
  const {state,lease}=fixture();assert.equal(editPaneStripGroupColor(state,lease,'#112233'),null);
  for(const ids of [['a'],['a','c']])assert.throws(()=>editPaneStripGroupColor(state,{...lease,entries:ids.map(tabId=>({tabId}))},'#abcdef'));
  assert.throws(()=>editPaneStripGroupColor(state,{...lease,isCurrent:()=>false},'#abcdef'));
  assert.throws(()=>editPaneStripGroupColor({...state,organizationReady:false},lease,'#abcdef'));
  state.spaces[0].stripColorGroups.version=2;assert.throws(()=>readPaneStripGroupState(state,'W'),/forward_version/);
  state.spaces[0].stripColorGroups=null;assert.throws(()=>readPaneStripGroupState(state,'W'),/forward_version/);
});
test('DnD capture fences group revision, order, exact membership, navigation away-return and window identity; unrelated runtime publication is harmless',()=>{
  for(const change of ['color','order','membership','navigation','window','runtime']) {
    const {state,lease}=fixture(),capture=capturePaneStripGroupDrag({getState:()=>state,owner:lease,sourceIds:['b'],internalScope:true});
    assert.equal(capture.boundary.end,1);assert.ok(capture.isCurrent());
    if(change==='color')state.spaces[0].stripColorGroups.revision++;
    if(change==='order')state.splitPanes[0].tabs.reverse();
    if(change==='membership')state.tabWorkflowMembership.b.revision++;
    if(change==='navigation')state.navigationRevision+=2;
    if(change==='window')state.splitPanes[0].windowId='new';
    if(change==='runtime')state.openProjects.get('Q').tabs.get('b').busy=true;
    assert.equal(capture.isCurrent(),change==='runtime',change);
  }
});
test('legacy center and stable window-ID relocation use actual captured owner, not focused namespace',()=>{
  const {state,lease,entries}=fixture();state.splitPanes.unshift({windowId:'other',tabs:[]});
  assert.deepEqual(readPaneStripOwnerEntries(state,lease),entries);
  state.splitPanes=[];state.centerStrips.P=entries;state.activeProjectId='P';
  assert.deepEqual(readPaneStripOwnerEntries(state,{...lease,paneIndex:null,windowId:null}),entries);
  state.activeSpaceId='other';assert.equal(readPaneStripOwnerEntries(state,lease),null);
});
test('existing organization lane recovers the SAME immutable color request after unknown ACK without inventing a new group/writer',async()=>{
  const {state,lease}=fixture();state.spaces=editPaneStripGroupColor(state,lease,'#abcdef');
  const writes=[];let fail=true,receipt=null;
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return receipt;
      writes.push(structuredClone(payload.request));if(fail)throw Error('lost');
      return {success:true,revision:11,mutationId:payload.request.mutationId};
    },applyPublication:async()=>{state.organizationRevision=11;},onError:()=>{}});
  await assert.rejects(committer.commit(()=>organizationSnapshot(state)),/lost/);
  fail=false;receipt={success:true,revision:11,mutationId:writes[0].mutationId};
  await committer.commit(()=>organizationSnapshot(state));
  assert.equal(writes.length,3);assert.deepEqual(writes[0],writes[1]);
  assert.notEqual(writes[1].mutationId,writes[2].mutationId);
  assert.deepEqual(writes[0].spaces[0].stripColorGroups,writes[2].spaces[0].stripColorGroups);
});
test('positively closed members no longer poison active color/drag, but raw members and unknown coverage remain exact',()=>{
  const {state,lease}=fixture(),raw=state.spaces[0].stripColorGroups;
  state.splitPanes[0].tabs=state.splitPanes[0].tabs.filter(entry=>entry.tabId!=='b');
  state.tabCatalog.b={active:false};lease.entries=lease.entries.slice(0,1);
  assert.deepEqual(readPaneStripActiveGroups(state,'W')[0].tabIds,['a']);
  const next=preparePaneStripGroupColor(state,lease,'#abcdef');
  assert.deepEqual(next.state.spaces[0].stripColorGroups.groups[0].tabIds,['a','b']);assert.equal(next.gather,undefined);
  assert.equal(raw.groups[0].color,'#112233');assert.deepEqual(raw.groups[0].tabIds,['a','b']);
  const drag=capturePaneStripGroupDrag({getState:()=>state,owner:lease,sourceIds:['a']});
  assert.equal(drag.boundary.kind,'group');assert.equal(drag.boundary.start,0);assert.equal(drag.boundary.end,0);assert.ok(drag.isCurrent());
  delete state.tabCatalog.b;
  assert.deepEqual(readPaneStripActiveGroups(state,'W')[0].tabIds,['a','b']);
  assert.throws(()=>preparePaneStripGroupColor(state,lease,'#abcdef'));
  assert.equal(capturePaneStripGroupDrag({getState:()=>state,owner:lease,sourceIds:['a']}).boundary.kind,'blocked');
});
