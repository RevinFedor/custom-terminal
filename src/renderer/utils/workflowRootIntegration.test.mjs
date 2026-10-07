import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createOrganizationCommitter,organizationSnapshot,organizationProjection,archiveRestoreLeaseAddress,
  createArchiveTitleRefresher,getHistoryTitleTarget,isExactGroupCloseGuard,waitForOrganizationReady} from './workflowOrganizationClient.mjs';
import {organizationPlacementIntent} from './workflowPlacementMembership.mjs';
import {resolveTabLinkNavigation,findOpenTabOwner} from './tabLinkNavigation.mjs';
globalThis.crypto ||= webcrypto;
test('legacy archive source and reserved target differ; recovery binds both identities',()=>{
  const lease={entry:{id:7,tab_id:'source',execution_subject_version:1,restoreTargetTabId:'reserved'},
    replacement:{namespace:'legacy',historyId:7,sourceTabId:'source',tabId:'reserved'}};
  assert.equal(archiveRestoreLeaseAddress(lease,'legacy','source').targetTabId,'reserved');
  assert.throws(()=>archiveRestoreLeaseAddress(lease,'legacy','reserved'),/archive_restore_source_changed/);
  for(const patch of [{namespace:'foreign'},{historyId:8},{sourceTabId:'reserved'},{tabId:'source'}])
    assert.throws(()=>archiveRestoreLeaseAddress({...lease,replacement:{...lease.replacement,...patch}},'legacy','source'),/replacement_changed/);
});
test('native archive retains same opaque identity; pre-opaque legacy rows still use reserved target',()=>{
  assert.equal(archiveRestoreLeaseAddress({entry:{id:7,tab_id:'same',execution_subject_version:2,restoreTargetTabId:'same'}},'native','same').targetTabId,'same');
  assert.throws(()=>archiveRestoreLeaseAddress({entry:{id:7,tab_id:'source',execution_subject_version:2,restoreTargetTabId:'different'}},'native'),/subject_changed/);
  assert.equal(archiveRestoreLeaseAddress({entry:{id:7,tab_id:null,restoreTargetTabId:'reserved'},
    replacement:{namespace:'legacy',historyId:7,sourceTabId:null,tabId:'reserved'}},'legacy').sourceTabId,null);
  assert.throws(()=>archiveRestoreLeaseAddress({entry:{id:7,tab_id:'old'}},'legacy'),/target_missing/);
});
test('title refresh generates once and retries exact rename-history payload after lost ACK',async()=>{
  const input={version:1,namespace:'old',historyId:7,requestId:'refresh',expectedRevision:'frozen-hash',
    record:{id:7,namespace:'old',command_type:'codex',codex_session_id:'source-sid',cwd:'/source',unknown:{kept:true}}};
  const writes=[],reads=[];let lost=true;
  const refresh=createArchiveTitleRefresher({generateTitle:async options=>{reads.push(options);return {ok:true,title:'Generated title'};},
    renameHistory:async request=>{writes.push(structuredClone(request));if(lost)throw Error('lost ACK');return {success:true};}});
  await assert.rejects(refresh(input),/lost ACK/);lost=false;await refresh(structuredClone(input));
  assert.equal(reads.length,1);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].expectedRevision,'frozen-hash');
  assert.equal(writes[0].name,'Generated title');assert.deepEqual(writes[0].record,input.record);
  await assert.rejects(refresh({...input,record:{...input.record,cwd:'/changed'}}),/request_id_conflict/);
});
test('title refresh preserves existing provider selection and does not rename after generation refusal',async()=>{
  assert.deepEqual(getHistoryTitleTarget({command_type:'claude',claude_session_id:'claude',codex_session_id:'codex'}),{toolType:'claude',sessionId:'claude'});
  assert.equal(getHistoryTitleTarget({command_type:'gemini',gemini_session_id:'gemini'}),null);
  let writes=0;
  const refresh=createArchiveTitleRefresher({generateTitle:async()=>({ok:false,reason:'no-user-prompt'}),renameHistory:()=>{writes++;}});
  const result=await refresh({requestId:'refused',record:{command_type:'codex',codex_session_id:'sid'}});
  assert.equal(result.success,false);assert.equal(result.disposition,'not-applied');assert.equal(writes,0);
});
test('group guard must address exact tab and original mutation; missing token is not authority',()=>{
  const guard={mutationId:'action',tabId:'owner',guardToken:'token'};
  assert.equal(isExactGroupCloseGuard(guard,'owner','action'),true);
  assert.equal(isExactGroupCloseGuard(guard,'foreign','action'),false);
  assert.equal(isExactGroupCloseGuard(guard,'owner','foreign'),false);
  assert.equal(isExactGroupCloseGuard({...guard,guardToken:''},'owner','action'),false);
});
test('Inbox bridge waits for owned startup publication and unsubscribes on success/failure',async()=>{
  for(const failure of [false,true]){
    let state={organizationReady:false,organizationError:null};const listeners=new Set();
    const store={getState:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
    const waiting=waitForOrganizationReady(store);assert.equal(listeners.size,1);
    state=failure?{organizationReady:false,organizationError:'migration failed'}:{organizationReady:true,organizationError:null};
    for(const fn of [...listeners])fn(state);
    failure?await assert.rejects(waiting,/migration failed/):await waiting;
    assert.equal(listeners.size,0);
  }
});
test('fresh publication exposes only system Inbox workflow; virtual namespaces are not UI projects',()=>{
  const p=organizationProjection({publication:{version:1,migrationVersion:1,revision:1,generation:1},tabs:[],
    workflows:[{id:'__noted_workflow_inbox__',kind:'inbox',revision:1,metadata:{name:'Inbox'},layout:{}}],
    namespaces:[{id:'__tab_catalog_v2__',path:null,recommendedCwd:'/home'},{id:'__noted_inbox__',path:null,recommendedCwd:'/home'}]},state());
  assert.deepEqual(p.spaces.map(space=>space.id),['__noted_workflow_inbox__']);assert.deepEqual(p.spaces[0].projectIds,[]);
});
test('canonical execution namespace wins over stale duplicate bucket/order and hints',()=>{
  const actual={id:'same'},stale={id:'same'};
  const s={tabCatalog:{same:{namespace:'exact'}},openProjects:new Map([['stale',{tabs:new Map([['same',stale]])}],['exact',{tabs:new Map([['same',actual]])}]])};
  assert.equal(findOpenTabOwner(s,'same').tab,actual);
  s.openProjects.delete('exact');assert.equal(findOpenTabOwner(s,'same'),null);
});
const pane = (id,tabId,hidden=false) => ({windowId:id,projectId:'old',tabId,tabs:[{projectId:'old',tabId}],displayHidden:hidden});
const state = () => ({organizationReady:true,isRestoring:false,activeSpaceId:'a',splitPanes:[pane('a1','A'),pane('a2','B')],
  splitFocusedIndex:1,spaces:[{id:'a',layout:{}},{id:'b',layout:{splitPanes:[pane('b1','C')],splitFocusedIndex:0}}],
  tabWorkflowMembership:{A:{workflowId:'a',revision:1},B:{workflowId:'a',revision:1},C:{workflowId:'b',revision:1},R:{workflowId:'b',revision:1}},
  pendingTabWorkflowMembership:{},openProjects:new Map([['old',{tabs:new Map()}]])});
test('profile-only and dormant links retain their exact window; reserve uses remembered workflow',()=>{
  const s=state();s.spaces[1].layout.windowDisplayLayouts={wide:{splitPanes:[pane('profile','P')]}};
  assert.equal(resolveTabLinkNavigation(s,'C').kind,'reveal');
  assert.equal(resolveTabLinkNavigation(s,'P').pane.windowId,'profile');
  assert.deepEqual(resolveTabLinkNavigation(s,'R'),{kind:'append',spaceId:'b',paneIndex:0});
  s.pendingTabWorkflowMembership.R={workflowId:'a'};
  assert.deepEqual(resolveTabLinkNavigation(s,'R'),{kind:'append',spaceId:'a',paneIndex:1});
});
test('placement intent includes profiles, detach keeps membership, move leaves automation canonical',()=>{
  const s=state();const next={...s,spaces:[s.spaces[0],{id:'b',layout:{splitPanes:[pane('b1','C'),pane('moved','A')]}}],
    splitPanes:[pane('a2','B')]};
  assert.equal(organizationPlacementIntent(s,next).pendingTabWorkflowMembership.A.workflowId,'b');
  assert.equal(s.tabWorkflowMembership.A.workflowId,'a');
  assert.equal(organizationPlacementIntent(s,{...s,splitPanes:[]}).pendingTabWorkflowMembership.A,undefined);
});
test('complete snapshots require every catalog member, including inactive records',()=>{
  const s=state();s.tabCatalog={...s.tabWorkflowMembership,closed:{active:false}};
  assert.throws(()=>organizationSnapshot(s),/incomplete_membership/);
  s.tabWorkflowMembership.closed={workflowId:'a',revision:5};
  assert.equal(organizationSnapshot(s).tabWorkflowMembership.closed.expectedMembershipRevision,5);
});
test('physical/file placement family is independent of bucket/row order; visual AI child stays independent',()=>{
  const s=state();s.openProjects=new Map([['files',{tabs:new Map([['file',{id:'file',tabType:'file',visualParentTabId:'child'}]])}],
    ['agents',{tabs:new Map([['visual',{id:'visual',visualParentTabId:'A'}],['child',{id:'child',parentTabId:'A'}]])}]]);
  for(const id of ['file','child','visual'])s.tabWorkflowMembership[id]={workflowId:'a',revision:1};
  const next={...s,splitPanes:[pane('a2','B')],spaces:[s.spaces[0],{id:'b',layout:{splitPanes:[pane('b1','C'),pane('moved','A')]}}]};
  const pending=organizationPlacementIntent(s,next).pendingTabWorkflowMembership;
  assert.equal(pending.child.workflowId,'b');assert.equal(pending.file.workflowId,'b');assert.equal(pending.visual,undefined);
});
test('publication preserves v1/v2 exact execution namespaces and identifies cold/archived records',()=>{
  const p=organizationProjection({publication:{version:1,migrationVersion:1,revision:3,generation:3},workflows:[],
    tabs:[{tabId:'v1',legacyRow:{},executionSubject:{projectId:'old'},membership:{workflowId:'x'}},
      {tabId:'v2',nativeRow:{execution_archived:1},executionSubject:{executionNamespace:'new'},membership:{workflowId:'x'}}]},state());
  assert.equal(p.tabCatalog.v1.active,true);assert.equal(p.tabCatalog.v1.namespace,'old');
  assert.equal(p.tabCatalog.v2.active,false);assert.equal(p.tabCatalog.v2.namespace,'new');
});
test('lost ACK blocks later intents until same immutable mutation recovers; serial CAS advances',async()=>{
  let rev=1,missing=true;const calls=[],errors=[];
  const c=createOrganizationCommitter({getPublication:()=>({revision:rev}),onError:e=>errors.push(e.message),
    applyPublication:r=>{rev=r.revision;},invoke:async(channel,payload)=>{
      calls.push({channel,payload:structuredClone(payload)});
      if(channel==='workflow:mutation') return null;
      if(missing)throw Error('transport lost');return {revision:++rev};
    }});
  await assert.rejects(c.commit({marker:'first'}),/transport/);
  missing=false;await c.commit({marker:'second'});await c.flush();
  const writes=calls.filter(c=>c.channel==='workflow:mutate').map(c=>c.payload.request);
  assert.deepEqual(writes[0],writes[1]);assert.notEqual(writes[1].mutationId,writes[2].mutationId);
  assert.equal(writes[2].expectedRevision,2);assert.equal(c.pending(),0);assert.equal(errors.length,1);
});
test('publication read failure retries apply without resending acknowledged mutation',async()=>{
  let fail=true,rev=0,writes=0;
  const c=createOrganizationCommitter({getPublication:()=>({revision:rev}),onError:()=>{},
    invoke:async()=>({revision:++writes}),applyPublication:r=>{if(fail)throw Error('read lost');rev=r.revision;}});
  await assert.rejects(c.commit({}),/read lost/);fail=false;await c.commit({});assert.equal(writes,2);assert.equal(rev,2);
});
test('negative/malformed/foreign mutation receipts never publish and retain immutable recovery intent',async()=>{
  const invalid=[{success:false,revision:2},{ok:false,revision:2},{revision:'2'},
    {revision:2,generation:NaN},{revision:2,mutationId:'foreign'}, {revision:0}];
  for(const response of invalid){
    let recovering=false,revision=1;const writes=[],applied=[];
    const c=createOrganizationCommitter({getPublication:()=>({revision}),onError:()=>{},
      applyPublication:result=>{applied.push(result);revision=result.revision;},
      invoke:async(channel,payload)=>{
        if(channel==='workflow:mutation')return response;
        writes.push(structuredClone(payload.request));
        return recovering?{revision:++revision,mutationId:payload.request.mutationId}:response;
      }});
    await assert.rejects(c.commit({marker:'original'}),/workflow_commit_unconfirmed/);
    assert.deepEqual(applied,[]);
    recovering=true;await c.commit({marker:'next'});
    assert.deepEqual(writes[0],writes[1]);assert.notEqual(writes[1].mutationId,writes[2].mutationId);
  }
});
test('negative invoke ACK can recover only through a positive receipt for its exact mutation',async()=>{
  let applied=0,queried;
  const c=createOrganizationCommitter({getPublication:()=>({revision:1}),onError:()=>{},
    applyPublication:()=>{applied++;},invoke:async(channel,payload)=>{
      if(channel==='workflow:mutate')return {success:false,revision:2};
      queried=payload;return {success:true,revision:2,mutationId:payload};
    }});
  const ack=await c.commit({marker:'original'});
  assert.equal(ack.mutationId,queried);assert.equal(applied,1);
});
