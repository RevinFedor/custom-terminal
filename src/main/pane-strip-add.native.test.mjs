// Run with the checkout's existing better-sqlite3-compatible Node/Electron ABI:
// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test src/main/pane-strip-add.native.test.mjs
// Native driver is mandatory. No installation, mocked SQL, user DB, application,
// provider or runtime process effects. Original five Ungroup tests stay intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeAddFixture,clone,turn,code,ids,button} from './pane-strip-add.native.fixture.mjs';
import {paneStripColorGroupsBasis} from '../shared/pane-strip-color-groups.cjs';
import {dragPlacement} from '../shared/workflow-drag.cjs';
import {captureSpaceLayout} from '../renderer/utils/workspaceSpacesModel.mjs';
import {readPaneStripActiveGroups} from '../renderer/utils/paneStripGroupsModel.mjs';

const nativeTest=(name,fn)=>test(name,{timeout:30000},fn);
const added=(before,tabIds)=>({...before,revision:before.revision+1,groups:before.groups.map(group=>group.id==='g'
  ?{...group,revision:group.revision+1,tabIds:[...group.tabIds,...tabIds]}:group)});
const prefs=f=>Object.fromEntries(['paneStripSelectedFirst','paneStripCloseOnClick','paneStripInstantHover'].map(key=>[key,f.manager.getAppState(key)]));
const focus=state=>clone({activeSpaceId:state.activeSpaceId,activeSpaceTab:state.activeSpaceTab,
  activeProjectId:state.activeProjectId,focusedProjectId:state.focusedProjectId,navigationRevision:state.navigationRevision,
  current:state.splitPanes.map(pane=>({tabId:pane.tabId,projectId:pane.projectId,selectedSlotId:pane.selectedSlotId}))});
const oneReceipt=(f,request)=>{
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_org_mutations WHERE mutation_id=?').get(request.mutationId).n,1);
  const row=f.receipt(request.mutationId),recorded=JSON.parse(row.request_json);
  assert.equal(recorded.kind,'commitWorkspace');delete recorded.kind;
  assert.deepEqual(recorded,request,'journal owns the exact admitted Add request');
};
const fieldRequest=f=>{const edits=f.fieldAttempts();assert.equal(edits.length,1);return edits[0].request;};
const acceptedB5=(f,release)=>{
  const row=f.receipt(release.request.mutationId);assert.ok(row,'actual Main journal is durable while ACK is held');
  assert.equal(JSON.parse(row.request_json).kind,'commitDrag');
  assert.equal(f.api.service.getMembership('u').workflowId,release.request.targetWorkflowId);
};
async function capturedAdd(f,lease){
  const capture=f.capture(),operation=f.add(lease);operation.catch(error=>capture.entered.reject(error));
  const request=await capture.entered.promise;await assert.rejects(operation,/fixture_request_captured_before_sql/);
  assert.equal(f.receipt(request.mutationId),undefined,'capture port prevents only this field request entering real Main');
  return request;
}
function foreignRecolor(f){
  const before=f.raw(),request=f.snapshot(),next=clone(before);next.revision++;next.groups[0].revision++;next.groups[0].color='#fedcba';
  request.spaces.find(space=>space.id==='W').stripColorGroups=next;
  request.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(before)}];
  f.api.mutate('commitWorkspace',request);return next;
}

nativeTest('actual private SQL Add: singleton + three free roots commits one atomic metadata/order pair; mixed slots, runtime rows, settings and reopen survive',async t=>{
  const f=nativeAddFixture(t),before=f.pair(),execution=f.rows(),members=f.membership(),settings=prefs(f),beforeFocus=focus(f.state);
  const runtimeTabs=new Map([...f.state.openProjects].flatMap(([namespace,workspace])=>[...workspace.tabs].map(([id,tab])=>[id,{namespace,tab,input:tab.input}])));
  // Click order differs from strip order; the menu/canonical intent must append
  // b,c,x, not selection history x,c,b and not the entire selected set.
  const original=f.selection(['x','a','c','b'],'c');assert.deepEqual(clone(original.lease.entries.map(entry=>entry.tabId)),['a','b','c','x']);
  const gate=f.hold(),probe=f.atomicProbe(),operation=f.add(original.lease);
  const {request}=await gate.entered.promise;
  assert.deepEqual(request.stripColorGroupEdits[0].add,{groupId:'g',tabIds:['b','c','x']});
  assert.equal(request.stripColorGroupEdits[0].arrange,undefined);assert.equal(request.stripGroupReleases,undefined);
  assert.deepEqual(f.raw(),added(before.field,['b','c','x']));
  assert.deepEqual(ids(f.slots()),['chooser:left','a','b','c','x','t','chooser:middle','z']);
  assert.deepEqual(f.state.splitPanes[0].tabs,before.layout.splitPanes[0].tabs,'renderer does not install order before ACK');
  assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,before.field,'renderer does not install metadata before ACK');
  assert.deepEqual(probe.during.reader,before,'separate SQLite reader sees the old pair inside the transaction');
  assert.deepEqual(probe.during.writer,f.pair(),'writer sees both candidate fields before the publication marker');
  assert.deepEqual(probe.after,f.pair(),'separate reader sees both fields after commit');
  const slotById=new Map(before.layout.splitPanes[0].tabs.map(slot=>[slot.tabId||slot.slotId,slot]));
  for(const slot of f.slots())assert.deepEqual(slot,slotById.get(slot.tabId||slot.slotId),'canonical unknown slot fields survive gather');
  gate.ack.resolve();await operation;
  assert.deepEqual(f.state.splitPanes[0].tabs,f.slots(),'actual Store callback publishes accepted gather');
  assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,f.raw());
  assert.deepEqual(focus(f.state),beforeFocus,'Add does not activate, navigate or change current slot');
  assert.deepEqual(f.rows(),execution);assert.deepEqual(f.membership(),members);assert.deepEqual(prefs(f),settings);
  for(const [id,{namespace,tab,input}] of runtimeTabs){assert.equal(f.state.openProjects.get(namespace).tabs.get(id),tab);assert.equal(tab.input,input);}
  oneReceipt(f,request);const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
  assert.deepEqual(f.rows(),execution);assert.deepEqual(prefs(f),settings);oneReceipt(f,request);
});

nativeTest('actual private SQL Add: partial old group retains unselected and closed provenance, colors, collapse and extensions',async t=>{
  const f=nativeAddFixture(t,{partial:true}),before=f.pair(),rows=f.rows(),members=f.membership();
  assert.deepEqual(readPaneStripActiveGroups(f.state,'W').find(group=>group.id==='g').tabIds,['a','b']);
  assert.equal(f.state.tabCatalog.closed.active,false);assert.equal(f.state.tabCatalog.closed.subjectVersion,2);
  assert.equal(f.state.tabCatalog.c.subjectVersion,2);assert.deepEqual(before.field.groups[0].tabIds,['a','closed','b']);
  const lease=f.selection(['x','a','c'],'x').lease;await f.add(lease);
  assert.deepEqual(f.raw(),added(before.field,['c','x']));
  assert.deepEqual(f.raw().groups[0].tabIds,['a','closed','b','c','x']);
  assert.deepEqual(ids(f.slots()),['chooser:left','a','b','c','x','t','chooser:middle','z']);
  assert.equal(f.slots().some(slot=>slot.tabId==='closed'),false);assert.deepEqual(f.rows(),rows);assert.deepEqual(f.membership(),members);
  assert.deepEqual(f.raw().groups[1],before.field.groups[1]);oneReceipt(f,fieldRequest(f));await f.reopen();
  assert.deepEqual(f.raw(),added(before.field,['c','x']));assert.deepEqual(f.rows(),rows);
});

nativeTest('actual private SQL Add: archived extension-bearing raw order differs from active placed order and remains exact',async t=>{
  const f=nativeAddFixture(t,{partial:true});
  const prior=f.raw(),reordered=f.snapshot(),next={...prior,revision:prior.revision+1,groups:prior.groups.map(group=>group.id==='g'
    ?{...group,tabIds:['b','closed','a']}:group)};
  reordered.spaces.find(space=>space.id==='W').stripColorGroups=next;
  reordered.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(prior)}];f.api.mutate('commitWorkspace',reordered);
  await f.syncPublished();await f.add(f.selection(['a','c']).lease);
  assert.deepEqual(f.raw(),added(next,['c']));assert.deepEqual(f.raw().groups[0].tabIds,['b','closed','a','c']);
  assert.deepEqual(ids(f.slots()),['chooser:left','a','b','c','t','chooser:middle','z','x'],'active old block retains its durable order');
});

nativeTest('actual private SQL ordinary color edit still rejects old-group membership expansion without explicit Add intent',async t=>{
  const f=nativeAddFixture(t),before=f.pair(),request=f.snapshot();
  request.spaces.find(space=>space.id==='W').stripColorGroups=added(before.field,['b']);
  request.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(before.field)}];
  assert.throws(()=>f.api.mutate('commitWorkspace',request),error=>/workflow_strip_groups_membership_changed/.test(code(error)));
  assert.deepEqual(f.pair(),before);assert.equal(f.receipt(request.mutationId),undefined);
});

nativeTest('actual private SQL Add: beforePublicationMarker failure rolls back metadata, gather, journal and publication together',async t=>{
  const f=nativeAddFixture(t),before=f.pair(),rows=f.rows(),members=f.membership();const probe=f.atomicProbe({reject:true});
  await assert.rejects(f.add(f.selection(['a','b']).lease),/fixture_atomic_abort/);
  const request=fieldRequest(f);assert.deepEqual(probe.during.reader,before);assert.notDeepEqual(probe.during.writer.field,before.field);
  assert.notDeepEqual(probe.during.writer.layout.splitPanes[0].tabs,before.layout.splitPanes[0].tabs);
  assert.deepEqual(probe.after,before);assert.deepEqual(f.pair(),before);assert.equal(f.receipt(request.mutationId),undefined);
  assert.equal(f.api.service.getPublication().revision,request.expectedRevision,'separate preflush is accepted, failed Add is not');
  assert.deepEqual(f.rows(),rows);assert.deepEqual(f.membership(),members);
  await f.reopen();assert.deepEqual(f.pair(),before);assert.equal(f.receipt(request.mutationId),undefined);
});

nativeTest('actual private SQL Add: lost ACK + physical reopen retries the same immutable mutation once and adopts after UI revocation',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),original=f.selection(['a','b']);f.lose();
  await assert.rejects(f.add(original.lease),/fixture_lost_ack/);const first=f.fieldAttempts()[0].request;
  assert.deepEqual(f.raw(),added(before,['b']));assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,before);
  const accepted=f.pair(),publication=f.api.service.getPublication().revision;await f.reopen();
  f.store.setState({navigationRevision:f.state.navigationRevision+1});assert.equal(original.lease.isCurrent(),false);
  await f.committer.settle();assert.equal(f.api.service.getPublication().revision,publication);
  const edits=f.fieldAttempts();assert.equal(edits.length,2);assert.deepEqual(edits[0].request,edits[1].request);
  assert.deepEqual(f.pair(),accepted);assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,accepted.field);
  assert.deepEqual(f.state.splitPanes[0].tabs,accepted.layout.splitPanes[0].tabs);oneReceipt(f,first);
});

nativeTest('actual private SQL Add: repeated live action after lost ACK recovers its own accepted gather and creates no second Add revision',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),lease=f.selection(['a','b']).lease;f.lose();
  await assert.rejects(f.add(lease),/fixture_lost_ack/);const request=f.fieldAttempts()[0].request;await f.reopen();
  const result=await f.add(lease);assert.equal(result.unchanged,true);assert.deepEqual(f.raw(),added(before,['b']));
  assert.equal(f.fieldAttempts().length,2);assert.deepEqual(f.fieldAttempts()[0].request,f.fieldAttempts()[1].request);oneReceipt(f,request);
});

nativeTest('actual private SQL Add: saved display profile is preserved byte-for-byte while only the current owner gathers',async t=>{
  const f=nativeAddFixture(t,{savedProfile:true}),before=f.pair();await f.add(f.selection(['a','b']).lease);
  assert.deepEqual(f.pair().layout.windowDisplayLayouts,before.layout.windowDisplayLayouts);
  assert.deepEqual(ids(f.slots()),['chooser:left','a','b','t','chooser:middle','c','z','x']);
  assert.deepEqual(f.raw(),added(before.field,['b']));const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
});

test('actual private SQL Add: exact raw/owner/order/membership/activity/other-layout guards reject stale or forged requests atomically',{timeout:180000},async t=>{
  const cases=[
    ['foreign raw recolor',async(f,request)=>{foreignRecolor(f);},/strip_groups_revision_changed/],
    ['foreign active owner order',async f=>{const layout=clone(f.pair().layout),slots=layout.splitPanes[0].tabs;
      const b=slots.findIndex(slot=>slot.tabId==='b'),c=slots.findIndex(slot=>slot.tabId==='c');[slots[b],slots[c]]=[slots[c],slots[b]];
      f.mutate('saveLayout',{workflowId:'W',expectedWorkflowRevision:f.api.service.getWorkflow('W').revision,layout});},/strip_groups_order_changed/],
    ['foreign owner identity',async f=>{const layout=clone(f.pair().layout);layout.splitPanes[0].windowId='other-owner';
      f.mutate('saveLayout',{workflowId:'W',expectedWorkflowRevision:f.api.service.getWorkflow('W').revision,layout});},/strip_groups_order_changed/],
    ['foreign membership revision after OUT/IN',async f=>{for(const workflowId of ['S','W'])f.mutate('moveTab',{
      tabId:'b',workflowId,expectedMembershipRevision:f.api.service.getMembership('b').revision});},/membership/],
    ['closed added subject',async f=>{f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('b');},/membership/],
    ['forged namespace address',async(_f,request)=>{request.spaces.find(space=>space.id==='W').layout.splitPanes[0].tabs.find(slot=>slot.tabId==='b').projectId='P';},/order_changed|membership/],
    ['forged chooser ordinal',async(_f,request)=>{const slots=request.stripColorGroupEdits[0].gather.beforeSlots;
      [slots[0],slots[3]]=[slots[3],slots[0]];},/order_changed/],
    ['forged unrelated group extension',async(_f,request)=>{request.spaces.find(space=>space.id==='W').stripColorGroups.groups[1].extension={foreign:true};},/add_changed/],
    ['forged target color',async(_f,request)=>{request.spaces.find(space=>space.id==='W').stripColorGroups.groups[0].color='#123123';},/add_changed/],
    ['simultaneous unrelated workflow membership move',async(_f,request)=>{request.tabWorkflowMembership.x.workflowId='S';request.tabWorkflowMembership.x.revision++;},/membership/],
    ['same membership with forged revision',async(_f,request)=>{request.tabWorkflowMembership.x.revision++;},/membership/],
    ['Add without gather',async(_f,request)=>{delete request.stripColorGroupEdits[0].gather;},/basis_invalid/],
    ['Add together with arrange',async(_f,request)=>{request.stripColorGroupEdits[0].arrange={};},/basis_invalid/],
    ['duplicate selected free ID',async(_f,request)=>{request.stripColorGroupEdits[0].add.tabIds=['b','b'];},/add_changed|basis_invalid/],
    ['empty selected free set',async(_f,request)=>{request.stripColorGroupEdits[0].add.tabIds=[];},/add_changed|basis_invalid/],
    ['forged saved profile reorder',async(_f,request)=>{request.spaces.find(space=>space.id==='W').layout.windowDisplayLayouts.saved.splitPanes[0].tabs.reverse();},/order_changed/],
  ];
  for(const [name,change,pattern] of cases)await t.test(name,{timeout:30000},async sub=>{
    const f=nativeAddFixture(sub,{savedProfile:name.includes('profile')}),request=await capturedAdd(f,f.selection(['a','b']).lease);
    await change(f,request);
    // Validation probe: refresh only the outer publication CAS deliberately.
    // An old exact field/order/member basis must still fail independently.
    request.expectedRevision=f.api.service.getPublication().revision;
    const before=f.pair(),rows=f.rows(),members=f.membership(),revision=f.api.service.getPublication().revision;
    assert.throws(()=>f.api.mutate('commitWorkspace',request),error=>pattern.test(code(error)),name);
    assert.deepEqual(f.pair(),before);assert.deepEqual(f.rows(),rows);assert.deepEqual(f.membership(),members);
    assert.equal(f.api.service.getPublication().revision,revision);assert.equal(f.receipt(request.mutationId),undefined);
  });
});

nativeTest('actual private SQL B5: accepted free IN + held ACK preserves pre-ACK Add intent through actual Store publication',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),release=f.release({hold:true});await release.gate.entered.promise;acceptedB5(f,release);
  const intent=release.request.stripGroupReleases.find(value=>value.workflowId==='W');
  assert.ok(intent.plan.assignments.some(value=>value.tabId==='u'&&value.groupId===null),'released free assignment must be explicit null');
  assert.equal(f.state.tabWorkflowMembership.u.workflowId,'S');assert.equal(f.state.pendingTabWorkflowMembership.u.workflowId,'W');
  const original=f.selection(['u','a'],'u'),menu=f.menu(original.lease);assert.equal(original.lease.isCurrent(),false);assert.equal(original.lease.isGroupCurrent(),true);
  for(const action of ['close','stop']){const control=button(menu.render(),action);assert.equal(control.props.disabled,true);control.props.onClick();}
  assert.deepEqual(menu.runtime,[],'pending group-settings proof cannot enter canonical Full/Stop port');
  const add=button(menu.render(),'group-add');assert.ok(add);assert.equal(add.props.disabled,false);add.props.onClick();
  assert.equal(f.fieldFlights.length,1);const pending=f.fieldFlights[0];assert.equal(pending.kind,'add');assert.equal(pending.lease.isCurrent(),true);
  const captured=clone(f.state.pendingTabWorkflowMembership.u),rows=f.rows(),members=f.membership(),beforeFocus=focus(f.state);
  assert.equal(f.fieldAttempts().length,0,'Add waits in the existing organization lane');
  release.gate.ack.resolve();await release.command;await pending.promise;await turn();
  const adoption=f.publications.find(value=>value.request.mutationId===release.request.mutationId);assert.ok(adoption);
  assert.equal(adoption.state.pending.u,undefined);assert.equal(adoption.state.canonical.u.revision,captured.revision);
  assert.equal(adoption.state.envelope.workflows.W,undefined);assert.equal(adoption.state.envelope.commands[release.request.mutationId],undefined);
  assert.equal(original.lease.isCurrent(),true);assert.equal(pending.lease.isCurrent(),true);
  assert.deepEqual(f.raw(),added(before,['u']));assert.deepEqual(ids(f.slots()),['chooser:left','a','u','t','chooser:middle','b','c','z','x']);
  assert.deepEqual(f.rows(),rows);assert.deepEqual(f.membership(),members);assert.deepEqual(focus(f.state),beforeFocus);
  assert.deepEqual(menu.runtime,[]);assert.deepEqual(menu.toasts,[]);oneReceipt(f,fieldRequest(f));
  const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
});

nativeTest('actual private SQL B5: assigned IN + held ACK preserves represented Ungroup; Full/Stop retain only the original current card',async t=>{
  // at counts actual tab chips; the leading chooser does not consume ordinal0.
  const f=nativeAddFixture(t,{partial:true}),stationary=clone(f.slots()),release=f.release({hold:true,at:1});
  await release.gate.entered.promise;acceptedB5(f,release);
  assert.deepEqual(f.slots().filter(slot=>slot.tabId!=='u'),stationary,'IN preserves stationary mixed order and full tab/chooser fields');
  assert.ok(release.request.stripGroupReleases.find(value=>value.workflowId==='W').plan.assignments.some(value=>value.tabId==='u'&&value.groupId==='g'));
  const original=f.selection(['a']),menu=f.menu(original.lease);assert.equal(original.lease.isCurrent(),true);
  for(const action of ['close','stop'])assert.equal(button(menu.render(),action).props.disabled,false,
    'already canonical representative remains its own runtime target before hidden incoming member ACK');
  const ungroup=button(menu.render(),'group-ungroup');assert.ok(ungroup);assert.equal(ungroup.props.disabled,false);ungroup.props.onClick();
  const pending=f.fieldFlights[0];assert.ok(pending);assert.deepEqual(clone(pending.lease.entries.map(entry=>entry.tabId)),['a','u','b']);
  assert.deepEqual(clone(original.lease.entries.map(entry=>entry.tabId)),['a']);const layout=clone(captureSpaceLayout(f.state)),rows=f.rows(),members=f.membership();
  release.gate.ack.resolve();await release.command;await pending.promise;await turn();
  assert.equal(f.raw().groups.some(group=>group.id==='g'),false);assert.deepEqual(f.pair().layout.splitPanes,layout.splitPanes);
  assert.deepEqual(f.rows(),rows);assert.deepEqual(f.membership(),members);assert.deepEqual(menu.toasts,[]);
  for(const action of ['close','stop']){const item=button(menu.render(),action);assert.equal(item.props.disabled,false);item.props.onClick();await turn();}
  assert.deepEqual(menu.runtime.map(value=>[value.action,value.entries.map(entry=>entry.tabId)]),[['close',['a']],['stop',['a']]],
    'controlled execution port receives original card, never expanded settings membership');
  const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);assert.ok(f.receipt(release.request.mutationId));
});

nativeTest('actual private SQL B5: same-ID unknown ACK recovery precedes captured Add and creates one receipt per accepted operation',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),release=f.release({hold:true,lose:true});await release.gate.entered.promise;acceptedB5(f,release);
  const lease=f.selection(['a','u']).lease,pending=f.add(lease);release.gate.ack.resolve();
  await assert.rejects(release.command,/fixture_lost_ack/);await pending;
  const attempts=f.attempts.filter(value=>value.kind==='commitDrag');assert.equal(attempts.length,2);
  assert.deepEqual(attempts[0].request,attempts[1].request);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_org_mutations WHERE mutation_id=?').get(release.request.mutationId).n,1);
  assert.deepEqual(f.raw(),added(before,['u']));oneReceipt(f,fieldRequest(f));assert.equal(f.state.pendingTabWorkflowMembership.u,undefined);
  const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
});

// Regression for the old B5 publication boundary: same raw/order alone retired
// the newest pair on an older IN ACK while its membership phase was still pending.
nativeTest('actual private SQL B5: IN/OUT/IN queued before first ACK preserves latest pending free assignment and subsequent Add',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),initialRevision=f.state.tabWorkflowMembership.u.revision;
  const first=f.release({hold:true});await first.gate.entered.promise;acceptedB5(f,first);
  const out=f.release({workflowId:'S'}),again=f.release({workflowId:'W'});
  assert.deepEqual(dragPlacement(first.request.workflows.find(value=>value.workflowId==='W').layout),
    dragPlacement(again.request.workflows.find(value=>value.workflowId==='W').layout),'actual compiler produces the same first/final placement endpoint');
  assert.equal(f.state.pendingTabWorkflowMembership.u.revision,initialRevision+3);
  assert.ok(again.request.stripGroupReleases.find(value=>value.workflowId==='W').plan.assignments.some(value=>value.tabId==='u'&&value.groupId===null));
  assert.deepEqual(f.state.spaces.find(space=>space.id==='W').stripColorGroups,before,'ordinary OUT never consumes unrelated group members');
  const lease=f.selection(['a','u']).lease;assert.equal(lease.isCurrent(),false);assert.equal(lease.isGroupCurrent(),true);const pending=f.add(lease);
  first.gate.ack.resolve();await Promise.all([first.command,out.command,again.command]);await pending;
  const firstPublication=f.publications.find(value=>value.request.mutationId===first.request.mutationId);assert.ok(firstPublication);
  assert.equal(firstPublication.state.canonical.u.revision,initialRevision+1,'first ACK publishes only its canonical membership step');
  assert.equal(firstPublication.state.pending.u.revision,initialRevision+3,'old ACK retains the latest pending IN revision');
  assert.equal(firstPublication.state.pending.u.localReleaseMutationId,again.request.mutationId);
  assert.equal(firstPublication.state.envelope.workflows.W?.mutationId,again.request.mutationId,'latest released pair cannot be retired by matching old visible IDs');
  assert.ok(firstPublication.state.envelope.commands[again.request.mutationId]);
  assert.deepEqual(firstPublication.state.raw,before,'old ACK does not replace the latest released raw projection');
  assert.equal(f.api.service.getMembership('u').revision,initialRevision+3);assert.equal(f.state.pendingTabWorkflowMembership.u,undefined);
  assert.deepEqual(f.raw(),added(before,['u']));for(const release of [first,out,again])assert.ok(f.receipt(release.request.mutationId));
  oneReceipt(f,fieldRequest(f));const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
});

// Capture a NEW Add after the first canonical ACK. The latest pair must remain
// available in this window, until its exact membership phase is canonical.
nativeTest('actual private SQL B5 contract: Add captured after first IN ACK survives queued OUT/IN and commits once',async t=>{
  const f=nativeAddFixture(t),before=f.raw(),initialRevision=f.state.tabWorkflowMembership.u.revision;
  const first=f.release({hold:true});await first.gate.entered.promise;acceptedB5(f,first);
  const out=f.release({workflowId:'S'}),again=f.release({workflowId:'W'});
  let captured,pending;
  f.afterPublication(({request})=>{
    if(request.mutationId!==first.request.mutationId)return;
    f.afterPublication(null);
    const original=f.selection(['a','u']).lease;
    captured={state:f.record(),lease:original,groupCurrent:original.isGroupCurrent()};
    // Enqueue but never await this occupied organization lane from its own
    // publication callback. Existing OUT/last-IN operations remain ahead.
    pending=f.add(original);pending.catch(()=>{});
  });
  first.gate.ack.resolve();await Promise.all([first.command,out.command,again.command]);
  assert.ok(captured&&pending,'new settings intent is captured at the first actual Store publication');
  assert.equal(captured.state.canonical.u.revision,initialRevision+1);
  assert.equal(captured.state.pending.u.revision,initialRevision+3);
  assert.equal(captured.state.pending.u.localReleaseMutationId,again.request.mutationId);
  assert.equal(captured.groupCurrent,true);
  await pending;
  assert.equal(f.state.pendingTabWorkflowMembership.u,undefined);
  assert.equal(f.api.service.getMembership('u').revision,initialRevision+3);
  assert.deepEqual(f.raw(),added(before,['u']),'no captured definition, closed provenance, color or peer is resurrected/replaced');
  assert.deepEqual(ids(f.slots()),['chooser:left','a','u','t','chooser:middle','b','c','z','x']);
  oneReceipt(f,fieldRequest(f));
  for(const release of [first,out,again])assert.ok(f.receipt(release.request.mutationId));
  const accepted=f.pair();await f.reopen();assert.deepEqual(f.pair(),accepted);
});

nativeTest('actual private SQL B5 ordinary OUT from a colored group removes only moving root and retains old unselected/closed roots',async t=>{
  const f=nativeAddFixture(t,{partial:true}),before=f.raw(),stationary=clone(f.slots()),into=f.release({at:1});await into.command;
  assert.deepEqual(f.slots().filter(slot=>slot.tabId!=='u'),stationary,'IN keeps stationary tab/chooser fields');
  assert.ok(f.raw().groups[0].tabIds.includes('u'));const rows=f.rows(),out=f.release({workflowId:'S'});await out.command;
  assert.deepEqual(f.raw().groups[0].tabIds,before.groups[0].tabIds);assert.deepEqual(f.raw().groups[1],before.groups[1]);
  assert.deepEqual(ids(f.slots()),['chooser:left','a','b','t','chooser:middle','c','z','x']);assert.deepEqual(f.rows(),rows);
  assert.deepEqual(f.slots(),stationary,'OUT restores the exact stationary mixed slots, including extensions');
  assert.equal(f.api.service.getMembership('u').workflowId,'S');assert.equal(f.state.pendingTabWorkflowMembership.u,undefined);
});

test('actual private SQL B5: foreign state after canonical ACK cannot lend its receipt to an old Add intent',{timeout:120000},async t=>{
  const cases=['raw recolor','foreign Ungroup','order','membership','navigation','closed subject','runtime identity','unknown active'];
  for(const fault of cases)await t.test(fault,{timeout:30000},async sub=>{
    const f=nativeAddFixture(sub),release=f.release({hold:true});await release.gate.entered.promise;
    const lease=f.selection(['a','u']).lease,pending=f.add(lease);const errors=[];pending.catch(error=>errors.push(code(error)));
    let foreign;
    f.afterPublication(async({request,state,store})=>{
      if(request.mutationId!==release.request.mutationId)return;f.afterPublication(null);
      if(fault==='raw recolor'){foreignRecolor(f);await f.syncPublished();}
      if(fault==='foreign Ungroup'){
        const previous=f.raw(),removal=f.snapshot();removal.spaces.find(space=>space.id==='W').stripColorGroups={
          ...previous,revision:previous.revision+1,groups:previous.groups.filter(group=>group.id!=='g')};
        removal.stripColorGroupEdits=[{workflowId:'W',basis:paneStripColorGroupsBasis(previous)}];
        f.api.mutate('commitWorkspace',removal);await f.syncPublished(); // separate real Main writer, never recurse into the occupied renderer lane
      }
      if(fault==='order'){
        const layout=clone(f.pair().layout),slots=layout.splitPanes[0].tabs;const b=slots.findIndex(slot=>slot.tabId==='b'),c=slots.findIndex(slot=>slot.tabId==='c');
        [slots[b],slots[c]]=[slots[c],slots[b]];f.mutate('saveLayout',{workflowId:'W',expectedWorkflowRevision:f.api.service.getWorkflow('W').revision,layout});
        await f.syncPublished();store.setState(layout); // controlled UI owner mirrors the separate accepted foreign drag
      }
      if(fault==='membership'){f.mutate('moveTab',{tabId:'u',workflowId:'S',expectedMembershipRevision:f.api.service.getMembership('u').revision});await f.syncPublished();}
      if(fault==='navigation')store.setState({navigationRevision:state.navigationRevision+1});
      if(fault==='closed subject'){f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('u');await f.syncPublished();}
      if(fault==='runtime identity'){const workspace=state.openProjects.get('Q');workspace.tabs.set('u',{...workspace.tabs.get('u')});}
      if(fault==='unknown active')store.setState({tabCatalog:{...state.tabCatalog,u:{...state.tabCatalog.u,active:undefined}}});
      foreign=f.pair();
    });
    release.gate.ack.resolve();await release.command;await assert.rejects(pending,error=>/strip_|selection_/.test(code(error)));
    assert.equal(errors.length,1);assert.equal(f.fieldAttempts().length,0,'field writer never admits stale intent');assert.deepEqual(f.pair(),foreign);
    if(fault==='foreign Ungroup')assert.equal(f.raw().groups.some(group=>group.id==='g'),false,'old Add intent cannot resurrect a removed definition');
    assert.ok(f.receipt(release.request.mutationId),'durable accepted B5 remains adopted independently of failed settings intent');
  });
});

test('actual private SQL B5: missing, malformed or foreign released-pair proof cannot grant Add or runtime authority',{timeout:120000},async t=>{
  const faults=['bare pending','unknown envelope','unknown status','missing null assignment','foreign owner','missing command','foreign revision'];
  for(const fault of faults)await t.test(fault,{timeout:30000},async sub=>{
    const f=nativeAddFixture(sub),release=f.release({hold:true});await release.gate.entered.promise;
    const original=clone(f.state.paneStripReleasedPairs),pending=clone(f.state.pendingTabWorkflowMembership),pair=f.state.paneStripReleasedPairs.workflows.W;
    if(fault==='bare pending')f.state.paneStripReleasedPairs=undefined;
    if(fault==='unknown envelope')f.state.paneStripReleasedPairs={...f.state.paneStripReleasedPairs,version:42};
    if(fault==='unknown status')pair.status='future-status';
    if(fault==='missing null assignment'){
      pair.intent.plan.assignments=pair.intent.plan.assignments.filter(value=>value.tabId!=='u');
      const command=f.state.paneStripReleasedPairs.commands[release.request.mutationId];
      command.request.stripGroupReleases.find(value=>value.workflowId==='W').plan.assignments=[];
    }
    if(fault==='foreign owner')pair.layout.splitPanes[0].windowId='foreign';
    if(fault==='missing command')delete f.state.paneStripReleasedPairs.commands[release.request.mutationId];
    if(fault==='foreign revision')f.state.pendingTabWorkflowMembership.u.revision++;
    const lease=f.selection(['a','u']).lease;assert.equal(lease.isCurrent(),false);assert.equal(lease.isGroupCurrent(),false);
    const menu=f.menu(lease);for(const action of ['close','stop'])button(menu.render(),action).props.onClick();
    await assert.rejects(f.add(lease),error=>/strip_selection_changed|strip_group_selection_changed/.test(code(error)));
    assert.deepEqual(menu.runtime,[]);assert.equal(f.fieldAttempts().length,0);
    // Restore only our injected renderer fault, then let the real durable B5
    // ACK retire normally. This cleanup does not fabricate a Main receipt.
    f.store.setState({paneStripReleasedPairs:original,pendingTabWorkflowMembership:pending});release.gate.ack.resolve();await release.command;
    assert.ok(f.receipt(release.request.mutationId));assert.equal(f.state.pendingTabWorkflowMembership.u,undefined);
  });
});

nativeTest('actual private SQL Add: newer UI navigation before synchronous field admission rejects without any Add receipt',async t=>{
  const f=nativeAddFixture(t),before=f.pair(),lease=f.selection(['a','b']).lease;
  f.store.setState({navigationRevision:f.state.navigationRevision+1});await assert.rejects(f.add(lease),/strip_selection_changed/);
  assert.deepEqual(f.pair(),before);assert.equal(f.fieldAttempts().length,0);
});

nativeTest('actual private SQL Add: unknown activity is retained as raw provenance and cannot be used as an eligible new root',async t=>{
  const f=nativeAddFixture(t),before=f.pair(),lease=f.selection(['a','b']).lease;
  f.store.setState({tabCatalog:{...f.state.tabCatalog,b:{...f.state.tabCatalog.b,active:undefined}}});
  await assert.rejects(f.add(lease),/strip_group_selection_changed/);assert.deepEqual(f.pair(),before);assert.equal(f.fieldAttempts().length,0);
});

nativeTest('actual private SQL runtime owner: post-Add Full/Stop admit only original selected roots; pre-Add generation cannot be rebased',async t=>{
  const f=nativeAddFixture(t,{partial:true}),original=f.selection(['a','c']).lease,{owner,calls}=f.runtime(),rows=f.rows();
  const request=action=>({version:1,mutationId:randomUUID(),action,origin:{workflowId:'W',windowId:'win'},
    members:original.entries.map(({projectId,tabId})=>({projectId,tabId}))});
  const old=request('stop');owner.begin(old);const before=owner.command(old.mutationId);
  assert.deepEqual(before.members.map(member=>member.tabId),['a','c']);assert.equal(owner.current(before.members[0]),true);
  await f.add(original);assert.deepEqual(f.raw().groups[0].tabIds,['a','closed','b','c']);
  assert.equal(owner.current(before.members[0]),false,'existing Main3314 generation fence remains strict after metadata commit');
  await assert.rejects(owner.step({mutationId:old.mutationId,tabId:'a'}),/selection_action_owner_changed/);
  assert.deepEqual(calls,[],'stale pre-Add authority never reaches even the controlled Stop executor');
  for(const action of ['stop','close']){
    const admitted=request(action);owner.begin(admitted);const command=owner.command(admitted.mutationId);
    assert.deepEqual(command.members.map(member=>member.tabId),['a','c'],'group settings do not expand runtime targets to hidden b or closed provenance');
    assert.equal(command.members.every(member=>owner.current(member)),true);
    assert.equal(command.members.every(member=>member.generation===f.api.service.getPublication().generation),true);
    for(const tabId of ['a','c']){
      const result=await owner.step({mutationId:admitted.mutationId,tabId});assert.equal(result.success,true);
      if(action==='close')assert.equal(result.closeGuard.tabId,tabId,'Full prepares only exact requested roots; fixture never archives or kills');
      else assert.equal(result.completed,true);
    }
  }
  assert.deepEqual(calls,[{tabId:'a',namespace:'P'},{tabId:'c',namespace:'P'}]);
  assert.deepEqual(f.rows(),rows,'controlled runtime ports never alter execution rows, sessions or cwd');
});
