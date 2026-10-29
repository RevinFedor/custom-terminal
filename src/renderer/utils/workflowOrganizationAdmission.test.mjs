import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Real renderer helper, organization lane and shared Main field/order guards.
// Only transport, state publication and the event scheduler are controlled.
// No DB, Electron, application runtime or provider is started by these tests.
const root=path.resolve(process.env.AUDIT_SOURCE_ROOT || new URL('../../../',import.meta.url).pathname);
const source=relative=>pathToFileURL(path.join(root,relative)).href;
const {createOrganizationCommitter,organizationSnapshot}=await import(source('src/renderer/utils/workflowOrganizationClient.mjs'));
const {commitPaneStripGroupPresentation}=await import(source('src/renderer/utils/paneStripGroupPresentationCommit.mjs'));
const {captureSpaceLayout}=await import(source('src/renderer/utils/workspaceSpacesModel.mjs'));
const {mergePaneStripColorGroups,assertPaneStripGather,adoptPaneStripColorGroups}=await import(source('src/shared/pane-strip-color-groups.cjs'));

function fixture({scheduleNavigationAfterSnapshot=false}={}) {
  const entries=['a','b','c'].map(tabId=>({projectId:'P',tabId}));
  const groups={version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',tabIds:['a','b','c'],collapsed:true}]};
  const state={organizationReady:true,isRestoring:false,organizationRevision:1,activeSpaceId:'W',activeProjectId:'P',
    navigationRevision:0,spaces:[{id:'W',stripColorGroups:groups}],centerStrips:{},openProjects:new Map(),
    splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:entries}],tabCatalog:{},pendingTabWorkflowMembership:{},
    tabWorkflowMembership:Object.fromEntries(entries.map(entry=>[entry.tabId,{workflowId:'W',revision:1}]))};
  const lease={workflowId:'W',windowId:'win',paneIndex:0,entries,isCurrent:()=>state.navigationRevision===0};
  let revision=1,field=structuredClone(groups),layout=structuredClone(captureSpaceLayout(state)),lose=false,hidden=false;
  const events=[],writes=[],receipts=new Map();
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),onError:()=>{},
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return hidden?null:receipts.get(payload);
      const request=payload.request,edit=request.stripColorGroupEdits?.[0];
      writes.push(structuredClone(request));
      if(edit)events.push(['admitted',state.navigationRevision]);
      let result=receipts.get(request.mutationId);
      if(!result){
        assert.equal(request.expectedRevision,revision,'controlled Main global revision CAS');
        const proposed=request.spaces.find(space=>space.id==='W');
        const next=mergePaneStripColorGroups(field,proposed.stripColorGroups,edit);
        if(edit)assertPaneStripGather(layout,proposed.layout,field,next,edit);
        field=structuredClone(next);layout=structuredClone(proposed.layout);
        result={success:true,mutationId:request.mutationId,revision:++revision};receipts.set(request.mutationId,result);
      }
      if(edit&&lose){lose=false;throw Error('controlled lost ACK');}
      return result;
    },applyPublication:async()=>{
      state.spaces=adoptPaneStripColorGroups(state.spaces,[{id:'W',stripColorGroups:field,layout}]);
      state.organizationRevision=revision;
    }});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const observed={...committer,commit:(snapshot,options)=>committer.commit(()=>{
    const payload=snapshot();
    if(scheduleNavigationAfterSnapshot&&payload.stripColorGroupEdits) {
      events.push(['snapshot-validated',state.navigationRevision]);
      // A queued navigation Promise continuation is already eligible after
      // this synchronous guard. It must run AFTER admission, never in a gap
      // between that guard and request freeze/invoke.
      queueMicrotask(()=>{state.navigationRevision++;events.push(['navigation',state.navigationRevision]);});
    }
    return payload;
  },options)};
  return {state,events,writes,committer,get field(){return field;},
    lose:()=>{lose=true;hidden=true;},reveal:()=>{hidden=false;},
    run:()=>commitPaneStripGroupPresentation({getState:()=>state,committer:observed,lease,groupId:'g',ungroup:true})};
}

test('U23-SYNC-ADMISSION: validated synchronous Ungroup snapshot admits before queued navigation and adopts durable ACK afterwards',async()=>{
  const f=fixture({scheduleNavigationAfterSnapshot:true});
  await f.run();
  assert.deepEqual(f.events,[['snapshot-validated',0],['admitted',0],['navigation',1]],
    'there must be no await between a synchronous local lease/order guard and admission');
  assert.deepEqual(f.field.groups,[]);
  assert.deepEqual(f.state.spaces[0].stripColorGroups.groups,[],
    'the later navigation revokes UI scope, not an already admitted durable deletion');
});

test('U23-BEFORE-ADMISSION: navigation while the existing flush awaits rejects Ungroup without an explicit edit',async()=>{
  const f=fixture();let release;
  f.state.commitOrganization=()=>new Promise(resolve=>release=resolve);
  const pending=f.run();f.state.navigationRevision++;release();
  await assert.rejects(pending,/strip_selection_changed/);
  assert.equal(f.writes.filter(request=>request.stripColorGroupEdits).length,0);
  assert.equal(f.field.groups.length,1);
});

test('U23-ASYNC-SNAPSHOT: async canonical-read snapshot still awaits and receives a request only after fresh data returns',async()=>{
  let release,revision=1;const events=[],committer=createOrganizationCommitter({
    getPublication:()=>({revision}),onError:()=>{},
    invoke:async(channel,payload)=>{assert.equal(channel,'workflow:mutate');events.push(['invoke',payload.request.value]);
      return {success:true,mutationId:payload.request.mutationId,revision:++revision};},applyPublication:async()=>{}});
  const pending=committer.commit(async()=>{events.push(['read']);const value=await new Promise(resolve=>release=resolve);return {value};});
  await Promise.resolve();assert.deepEqual(events,[['read']]);
  release('fresh canonical');await pending;
  assert.deepEqual(events,[['read'],['invoke','fresh canonical']]);
});

test('U23-AFTER-ADMISSION: same-key UNKNOWN Ungroup recovery adopts accepted metadata after the UI lease dies',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.run(),/controlled lost ACK/);
  const first=f.writes.find(request=>request.stripColorGroupEdits);
  assert.equal(f.state.spaces[0].stripColorGroups.groups.length,1);
  f.state.navigationRevision++;f.reveal();await f.committer.settle();
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);
  assert.equal(edits.length,2);assert.deepEqual(edits[1],first);
  assert.equal(f.field.revision,2);assert.deepEqual(f.state.spaces[0].stripColorGroups.groups,[]);
});
