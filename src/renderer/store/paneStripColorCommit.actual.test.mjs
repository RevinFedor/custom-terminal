import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {transformSync} from 'esbuild';
import {webcrypto} from 'node:crypto';
import {readPaneStripGroupState,preparePaneStripGroupColor,applyPaneStripGatherPublication,readPaneStripActiveGroups} from '../utils/paneStripGroupsModel.mjs';
import {classifyPaneStripColorSelection,normalizeStripGroupColor} from '../utils/paneStripSelectionModel.mjs';
import {organizationSnapshot,createOrganizationCommitter} from '../utils/workflowOrganizationClient.mjs';
import {paneStripColorGroupsBasis,mergePaneStripColorGroups,adoptPaneStripColorGroups,paneStripLayoutOwner,assertPaneStripGather} from '../../shared/pane-strip-color-groups.cjs';
import {stableJson} from '../../shared/workflow-organization.cjs';
import {captureSpaceLayout} from '../utils/workspaceSpacesModel.mjs';
const source=fs.readFileSync(new URL('./useWorkspaceStore.ts',import.meta.url),'utf8');
const expression=source.match(/  commitPaneStripGroupColor: (async \(lease,color\) => \{[\s\S]*?\n  \}),\n\n  commitWorkflowDrag:/)?.[1];
assert.ok(expression,'actual owned store action exists');
const code=transformSync('module.exports='+expression,{loader:'ts',format:'cjs'}).code;
function fixture({hole=false}={}){
  const entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}];
  const state={spaces:[{id:'W',name:'Work',layout:{},unknown:'keep'}],activeSpaceId:'W',organizationReady:true,organizationRevision:1,
    pendingTabWorkflowMembership:{},tabWorkflowMembership:{a:{workflowId:'W'},b:{workflowId:'W'}},tabCatalog:{},
    splitPanes:[{windowId:'win',tabId:'a',tabs:entries}],centerStrips:{},openProjects:new Map()};
  if(hole)state.splitPanes[0].tabs=[entries[0],{projectId:'P',tabId:'x'},entries[1]];
  let mainLayout=structuredClone(captureSpaceLayout(state));
  let main,revision=1,lose=false,hideReceipt=false,wait=null;
  const writes=[],receipts=new Map();
  const organizationCommitter=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return hideReceipt?null:receipts.get(payload);
      const request=payload.request;writes.push(structuredClone(request));if(wait)await wait;
      let result=receipts.get(request.mutationId);
      if(!result){
        const space=request.spaces.find(space=>space.id==='W'),field=space.stripColorGroups,edit=request.stripColorGroupEdits?.[0];
        const next=mergePaneStripColorGroups(main,field,edit);
        if(edit)assertPaneStripGather(mainLayout,space.layout,main,next,edit);
        main=next;mainLayout=space.layout;
        result={success:true,revision:++revision,mutationId:request.mutationId};receipts.set(request.mutationId,result);
      }
      if(lose&&request.stripColorGroupEdits){lose=false;throw Error('lost ACK');}return result;
    },applyPublication:async(_result,request)=>{
      const published=[{id:'W',stripColorGroups:main,layout:mainLayout}];
      Object.assign(state,applyPaneStripGatherPublication(state,adoptPaneStripColorGroups(state.spaces,published),published,request));state.organizationRevision=revision;
    },onError:()=>{}});
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,get:()=>state,organizationCommitter,
    readPaneStripGroupState,preparePaneStripGroupColor,readPaneStripActiveGroups,classifyPaneStripColorSelection,normalizeStripGroupColor,paneStripColorGroupsBasis,paneStripLayoutOwner,captureSpaceLayout,stableJson,organizationSnapshot,crypto:webcrypto});
  state.commitOrganization=()=>organizationCommitter.commit(()=>organizationSnapshot(state));
  const lease={workflowId:'W',windowId:'win',paneIndex:0,entries,isCurrent:()=>true};
  return {state,lease,writes,commit:color=>module.exports(lease,color),get main(){return main;},
    hold:promise=>{wait=promise;},lose:()=>{lose=true;hideReceipt=true;},revealReceipt:()=>{hideReceipt=false;},
    foreign:next=>{main=next;state.organizationRevision=++revision;},adopt:()=>{state.spaces=adoptPaneStripColorGroups(state.spaces,[{id:'W',stripColorGroups:main}]);}};
}
test('actual store action sends frozen explicit field basis through existing lane and exposes color only after ACK; unrelated settings stay',async()=>{
  const f=fixture();let release;f.hold(new Promise(resolve=>release=resolve));
  const result=f.commit('#123456');await Promise.resolve();assert.equal(f.state.spaces[0].stripColorGroups,undefined);
  f.state.spaces[0]={...f.state.spaces[0],name:'New name'};release();await result;
  assert.equal(f.state.spaces[0].stripColorGroups.groups[0].color,'#123456');assert.equal(f.state.spaces[0].name,'New name');
  assert.equal(f.writes.find(request=>request.stripColorGroupEdits).stripColorGroupEdits[0].basis,paneStripColorGroupsBasis(undefined));
});
test('actual store lost ACK recovers original mutation before new intent, without duplicate group or replay of a color edit',async()=>{
  const f=fixture();f.lose();await assert.rejects(f.commit('#123456'),/lost ACK/);
  assert.equal(f.state.spaces[0].stripColorGroups,undefined);f.revealReceipt();await f.commit('#123456');
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);
  assert.equal(edits.length,2);assert.deepEqual(edits[0],edits[1]);assert.equal(f.main.groups.length,1);assert.equal(f.main.revision,1);
  assert.equal(f.writes.at(-1).stripColorGroupEdits,undefined);
});
test('latest organization revision cannot authorize stale color; known field CAS rejection releases only its rejected request',async()=>{
  const f=fixture();await f.commit('#123456');const old=f.state.spaces[0].stripColorGroups;
  const next={...old,revision:2,groups:old.groups.map(group=>({...group,color:'#abcdef',revision:2}))};f.foreign(next);
  await assert.rejects(f.commit('#ffffff'),/workflow_strip_groups_revision_changed/);assert.equal(f.main.groups[0].color,'#abcdef');
  const rejected=f.writes.at(-1).mutationId;f.adopt();await f.commit('#ffffff');
  assert.notEqual(f.writes.at(-1).mutationId,rejected);assert.equal(f.main.revision,3);assert.equal(f.main.groups[0].color,'#ffffff');
});
test('queued color refuses a departed target before publication and never follows the new window/workflow',async()=>{
  const f=fixture(),result=f.commit('#123456');f.lease.isCurrent=()=>false;
  await assert.rejects(result,/strip_selection_changed/);assert.equal(f.writes.filter(request=>request.stripColorGroupEdits).length,0);assert.equal(f.main,undefined);
});
test('CREATE accepts A-X-B as A-B-X in one metadata/layout edit, no focus/shown/namespace changes; recolor keeps order',async()=>{
  const f=fixture({hole:true});await f.commit('#123456');
  assert.deepEqual(f.state.splitPanes[0].tabs.map(entry=>entry.tabId),['a','b','x']);assert.equal(f.state.splitPanes[0].tabId,'a');
  const edit=f.writes.find(request=>request.stripColorGroupEdits);assert.ok(edit.stripColorGroupEdits[0].gather);
  assert.deepEqual(edit.spaces[0].layout.splitPanes[0].tabs.map(entry=>entry.tabId),['a','b','x']);
  const prior=f.state.splitPanes;await f.commit('#abcdef');assert.equal(f.state.splitPanes,prior);
  assert.equal(f.writes.at(-1).stripColorGroupEdits[0].gather,undefined);
});
test('actual store recolors the active remainder and recovers its lost ACK without rewriting closed member provenance',async()=>{
  const f=fixture();await f.commit('#123456');
  f.state.tabCatalog.b={active:false};f.lease.entries=f.lease.entries.slice(0,1);
  f.state.splitPanes[0].tabs=f.state.splitPanes[0].tabs.slice(0,1);
  f.lose();await assert.rejects(f.commit('#abcdef'),/lost ACK/);
  f.revealReceipt();await f.commit('#abcdef');
  assert.deepEqual(f.main.groups[0].tabIds,['a','b']);assert.equal(f.main.revision,2);
  assert.equal(f.main.groups[0].color,'#abcdef');
  const edits=f.writes.filter(request=>request.stripColorGroupEdits);
  assert.deepEqual(edits.at(-1),edits.at(-2));assert.equal(f.writes.at(-1).stripColorGroupEdits,undefined);
});
