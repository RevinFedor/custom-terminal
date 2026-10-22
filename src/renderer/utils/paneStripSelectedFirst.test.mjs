import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// The optional source root makes OLD RED exercise the complete old modules,
// not a reimplemented predecessor. IPC/publication timing is controlled here;
// SQLite, React, DOM, activation, native input and pixels are not participants.
const source=name=>process.env.NOTED_STRIP_SOURCE_ROOT
  ?pathToFileURL(path.resolve(process.env.NOTED_STRIP_SOURCE_ROOT,'src/renderer/utils',name))
  :new URL(name,import.meta.url);
const {commitPaneStripGroupPresentation}=await import(source('paneStripGroupPresentationCommit.mjs'));
const {createOrganizationCommitter,organizationSnapshot}=await import(source('workflowOrganizationClient.mjs'));
const {applyPaneStripGatherPublication}=await import(source('paneStripGroupsModel.mjs'));
const {captureSpaceLayout}=await import(source('workspaceSpacesModel.mjs'));
const {adoptPaneStripColorGroups,assertPaneStripGather,mergePaneStripColorGroups}=await import(new URL('../../shared/pane-strip-color-groups.cjs',source('paneStripGroupsModel.mjs')));
const clone=structuredClone;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function fixture({inactive=false,center=false}={}) {
  const ids=['x','a','b','c','d','y'],tab=tabId=>({projectId:'P',tabId,extension:{keep:tabId}});
  const slots=[tab('x'),{slotId:'chooser',cwd:'/chosen',extension:{keep:'chooser'}},...['a','b','c','d','y'].map(tab)];
  const raw={version:1,revision:7,extension:{raw:true},groups:[{id:'g',revision:3,color:'#abcdef',collapsed:true,
    tabIds:['a','b','c','d',...(inactive?['closed']:[])],extension:{provenance:true}}]};
  const pane={windowId:'win',projectId:'P',tabId:'a',tabs:slots,extension:{window:true}};
  const state={organizationReady:true,isRestoring:false,organizationRevision:10,navigationRevision:4,
    activeSpaceId:'W',activeProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'a'},
    spaces:[{id:'W',stripColorGroups:clone(raw),extension:{workflow:true}},{id:'other',layout:{},extension:{other:true}}],
    splitPanes:center?[]:[pane],centerStrips:center?{P:slots}:{},openProjects:new Map(),
    tabWorkflowMembership:Object.fromEntries([...ids,...(inactive?['closed']:[])].map(id=>[id,{workflowId:'W',revision:2}])),
    pendingTabWorkflowMembership:{},tabCatalog:Object.fromEntries(ids.map(id=>[id,{active:true}]))};
  if(inactive)state.tabCatalog.closed={active:false};
  let mainRaw=clone(raw),mainLayout=clone(captureSpaceLayout(state)),revision=10,alive=true;
  let lose=false,hide=false,afterAccept=null;
  const writes=[],accepted=[],receipts=new Map();
  const currentSlots=()=>center?state.centerStrips.P:state.splitPanes[0].tabs;
  const setSlots=slots=>{if(center)state.centerStrips.P=slots;else state.splitPanes[0].tabs=slots;};
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return hide?null:receipts.get(payload);
      const request=clone(payload.request);writes.push(request);let result=receipts.get(request.mutationId);
      if(!result) {
        assert.equal(request.expectedRevision,revision,'actual serial owner expected revision');
        const proposed=request.spaces.find(space=>space.id==='W'),edit=request.stripColorGroupEdits?.find(edit=>edit.workflowId==='W');
        const next=mergePaneStripColorGroups(mainRaw,proposed.stripColorGroups,edit);
        const arranged=edit?assertPaneStripGather(mainLayout,proposed.layout,mainRaw,next,edit):null;
        if(arranged?.pane)proposed.layout.splitPanes[arranged.paneIndex].tabs=arranged.slots;
        else if(arranged)proposed.layout.centerStrips[arranged.centerKey]=arranged.slots;
        mainRaw=clone(next);mainLayout=clone(proposed.layout);
        result={success:true,revision:++revision,mutationId:request.mutationId};receipts.set(request.mutationId,result);accepted.push(request);
      }
      if(afterAccept)await afterAccept(request);
      if(lose&&request.stripColorGroupEdits?.some(edit=>edit.arrange)){lose=false;throw Error('lost ACK');}
      return result;
    },applyPublication:async(_result,request)=>{
      const published=[{id:'W',stripColorGroups:clone(mainRaw),layout:clone(mainLayout)}];
      Object.assign(state,applyPaneStripGatherPublication(state,adoptPaneStripColorGroups(state.spaces,published),published,request),
        {organizationRevision:revision});
    },onError:()=>{}});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  const lease={version:1,workflowId:'W',windowId:center?null:'win',paneIndex:center?null:0,
    entries:currentSlots().filter(slot=>raw.groups[0].tabIds.includes(slot.tabId)),isCurrent:()=>alive};
  const run=options=>commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId:'g',...options});
  return {state,lease,committer,writes,accepted,run,currentSlots,setSlots,
    get raw(){return mainRaw;},get layout(){return mainLayout;},get revision(){return revision;},
    order:()=>currentSlots().map(slot=>slot.tabId||slot.slotId),
    select:id=>{if(center)state.activeSpaceTab={projectId:'P',tabId:id};else state.splitPanes[0].tabId=id;return run({selectedTabId:id});},
    lose:()=>{lose=true;hide=true;},recover:()=>{hide=false;},revoke:()=>{alive=false;},
    afterAccept:callback=>{afterAccept=callback;},
    holdFlush:()=>{const entered=deferred(),gate=deferred();state.commitOrganization=()=>{entered.resolve();return gate.promise;};return {entered:entered.promise,release:gate.resolve};},
  };
}
const members=f=>f.order().filter(id=>['a','b','c','d'].includes(id));
const arrange=f=>f.accepted.filter(request=>request.stripColorGroupEdits?.some(edit=>edit.arrange));

test('selected-first: 2 from 1,2,3,4 then 3 move only selected; durable metadata and every other slot keep order',async()=>{
  const f=fixture(),raw=clone(f.raw),outside=f.currentSlots().filter(slot=>!['a','b','c','d'].includes(slot.tabId));
  await f.select('b');assert.deepEqual(members(f),['b','a','c','d']);
  await f.select('c');assert.deepEqual(members(f),['c','b','a','d']);
  assert.deepEqual(f.order(),['x','chooser','c','b','a','d','y']);assert.deepEqual(f.raw,raw);
  assert.deepEqual(f.currentSlots().filter(slot=>!['a','b','c','d'].includes(slot.tabId)),outside);
  assert.equal(f.state.splitPanes[0].tabId,'c');assert.equal(arrange(f).length,2);
  for(const request of arrange(f))assert.equal(request.stripColorGroupEdits[0].arrange.representative,request.spaces[0].layout.splitPanes[0].tabId);
});
test('selected-first: ordinary noncollapsed groups refuse order intent before any lane write',async()=>{
  const f=fixture();f.state.spaces[0].stripColorGroups.groups[0].collapsed=false;
  await assert.rejects(f.select('b'),/strip_group_selection_changed/);assert.equal(f.writes.length,0);
});
test('selected-first: inactive raw provenance stays; unknown coverage remains active and missing unknown placement refuses',async()=>{
  const f=fixture({inactive:true}),raw=clone(f.raw);delete f.state.tabCatalog.c;
  await f.select('b');assert.deepEqual(members(f),['b','a','c','d']);assert.deepEqual(f.raw,raw);
  f.setSlots(f.currentSlots().filter(slot=>slot.tabId!=='c'));
  const count=f.writes.length;await assert.rejects(f.select('d'),/strip_group_selection_changed/);assert.equal(f.writes.length,count);
});
test('selected-first: center owner uses the same arrange proof and retains chooser extensions',async()=>{
  const f=fixture({center:true});await f.select('d');assert.deepEqual(members(f),['d','a','b','c']);
  assert.equal(f.layout.centerStrips.P[1].extension.keep,'chooser');assert.equal(f.state.activeSpaceTab.tabId,'d');
});
test('selected-first: default explicit OPEN-fit still moves representative to either end without selected-first sorting',async()=>{
  const f=fixture(),raw=clone(f.raw);await f.run({order:['a','c','d','b'],representative:'b'});
  assert.deepEqual(members(f),['a','c','d','b']);assert.deepEqual(f.raw,raw);
});
test('selected-first: selected already first recovers unknown BEFORE no-op; newest select1 survives select2 lost ACK',async()=>{
  const f=fixture(),raw=clone(f.raw);f.lose();await assert.rejects(f.select('b'),/lost ACK/);
  assert.deepEqual(members(f),['a','b','c','d']);f.recover();await f.select('a');
  assert.deepEqual(members(f),['a','b','c','d']);assert.deepEqual(f.raw,raw);
  const attempts=f.writes.filter(request=>request.stripColorGroupEdits?.some(edit=>edit.arrange));
  assert.deepEqual(attempts[0],attempts[1]);assert.notEqual(attempts[1].mutationId,attempts[2].mutationId);
  assert.equal(arrange(f).length,2,'one original accepted arrange and one newer explicit selection');
});
test('selected-first: recovery preserves accepted rest order for a different newest selected member',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.select('b'),/lost ACK/);f.recover();await f.select('d');
  assert.deepEqual(members(f),['d','b','a','c']);assert.equal(arrange(f).length,2);
});
test('selected-first: newest select1 survives select2 admitted with a delayed successful ACK',async()=>{
  const f=fixture(),entered=deferred(),gate=deferred();let held=false;
  f.afterAccept(request=>{if(!held&&request.stripColorGroupEdits?.some(edit=>edit.arrange)) {
    held=true;entered.resolve();return gate.promise;
  }});
  const first=f.select('b');
  await Promise.race([entered.promise,first.then(()=>{throw Error('selection settled before its delayed ACK');})]);
  const latest=f.select('a');gate.resolve();await Promise.all([first,latest]);
  assert.deepEqual(members(f),['a','b','c','d']);assert.equal(arrange(f).length,2);
});
test('selected-first: unrelated newer local order during recovery is not overwritten or mistaken for accepted arrange',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.select('b'),/lost ACK/);f.recover();
  f.afterAccept(request=>{if(request.stripColorGroupEdits?.some(edit=>edit.arrange)) {
    const slots=f.currentSlots(),byId=new Map(slots.map(slot=>[slot.tabId||slot.slotId,slot]));
    f.setSlots(['x','chooser','c','a','b','d','y'].map(id=>byId.get(id)));
  }});
  await assert.rejects(f.select('a'),/order_changed/);assert.deepEqual(members(f),['c','a','b','d']);assert.equal(arrange(f).length,1);
});
for(const change of ['recolor','unjoin','closed-member','membership','newer-order','revoked-ui']) {
  test(`selected-first: ${change} while normal flush awaits refuses the captured intent`,async()=>{
    const f=fixture(),gate=f.holdFlush(),result=f.select('b');
    await Promise.race([gate.entered,result.then(()=>{throw Error('selection settled without entering its normal flush');})]);
    if(change==='recolor')f.state.spaces[0].stripColorGroups.groups[0].color='#123456';
    if(change==='unjoin')f.state.spaces[0].stripColorGroups.groups[0].tabIds=['a','c','d'];
    if(change==='closed-member')f.state.tabCatalog.b.active=false;
    if(change==='membership')f.state.tabWorkflowMembership.b={workflowId:'other',revision:3};
    if(change==='newer-order'){const slots=f.currentSlots().slice();[slots[3],slots[4]]=[slots[4],slots[3]];f.setSlots(slots);}
    if(change==='revoked-ui')f.revoke();
    gate.release();await assert.rejects(result,/strip_(group|groups|selection)/);assert.equal(arrange(f).length,0);
  });
}
test('selected-first: accepted mutation is adopted after renderer lease revocation; lease does not revoke durable receipt',async()=>{
  const f=fixture();f.afterAccept(request=>{if(request.stripColorGroupEdits?.some(edit=>edit.arrange))f.revoke();});
  await f.select('b');assert.deepEqual(members(f),['b','a','c','d']);assert.equal(arrange(f).length,1);assert.equal(f.lease.isCurrent(),false);
});
test('selected-first: missing member, mixed explicit order or collapsed update never creates a hidden new writer',async()=>{
  for(const options of [{selectedTabId:'missing'},{selectedTabId:'b',order:['b','a','c','d']},{selectedTabId:'b',collapsed:true}]) {
    const f=fixture();await assert.rejects(f.run(options),/strip_group_selection_changed/);assert.equal(f.writes.length,0);
  }
});
test('existing runTask passes no recovery witness without a recovered immutable operation',async()=>{
  const f=fixture();assert.equal(await f.committer.runTask(context=>context),null);
});
test('existing organization settle: idle returns null, unknown order replays original key and adopts without a new write',async()=>{
  const f=fixture();assert.equal(f.committer.settle(),null);
  f.lose();await assert.rejects(f.select('b'),/lost ACK/);f.recover();
  const wait=f.committer.settle();assert.ok(wait?.then);await wait;await f.committer.flush();
  assert.deepEqual(members(f),['b','a','c','d']);assert.equal(arrange(f).length,1);
  const attempts=f.writes.filter(request=>request.stripColorGroupEdits?.some(edit=>edit.arrange));
  assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);assert.equal(f.committer.settle(),null);
});
test('existing organization settle: UI revoke while recovery waits does not prevent durable accepted adoption',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.select('b'),/lost ACK/);f.recover();
  const gate=deferred(),entered=deferred();f.afterAccept(request=>{if(request.stripColorGroupEdits?.some(edit=>edit.arrange)){entered.resolve();return gate.promise;}});
  const waiting=f.committer.settle();await entered.promise;f.revoke();gate.resolve();await waiting;
  assert.deepEqual(members(f),['b','a','c','d']);assert.equal(f.lease.isCurrent(),false);assert.equal(arrange(f).length,1);
});
test('selected-first: activation readiness fences newer DnD order captured before the first await',async()=>{
  const f=fixture(),ready=deferred(),result=f.run({selectedTabId:'b',selectionReady:ready.promise});
  const slots=f.currentSlots().slice();[slots[2],slots[4]]=[slots[4],slots[2]];f.setSlots(slots);ready.resolve(true);
  await assert.rejects(result,/order_changed/);assert.equal(arrange(f).length,0);
});
test('selected-first: false or rejected activation readiness cannot admit a new order',async()=>{
  for(const rejects of [false,true]) {
    const f=fixture(),ready=deferred(),result=f.run({selectedTabId:'b',selectionReady:ready.promise});
    if(rejects)ready.reject(Error('activation failed'));else ready.resolve(false);
    await assert.rejects(result,/strip_selection_changed/);assert.equal(f.writes.length,0);
  }
});
test('selected-first: synchronous capture recovers old unknown independently of activation, then applies newest member once ready',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.select('b'),/lost ACK/);f.recover();
  const ready=deferred(),result=f.run({selectedTabId:'d',selectionReady:ready.promise});
  await f.committer.flush();assert.deepEqual(members(f),['b','a','c','d']);assert.equal(arrange(f).length,1);
  ready.resolve(true);await result;assert.deepEqual(members(f),['d','b','a','c']);assert.equal(arrange(f).length,2);
});
test('selected-first: proved already-first no-op writes nothing after the existing lane is settled',async()=>{
  const f=fixture(),result=await f.run({selectedTabId:'a',selectionReady:Promise.resolve(true)});
  assert.equal(result.unchanged,true);assert.equal(f.writes.length,0);
});
