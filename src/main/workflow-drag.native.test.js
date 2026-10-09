'use strict';
// Actual canonical API/SQLite + renderer plan, private DB only. Electron as Node;
// no BrowserWindow, provider, application API, PTY or production storage.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const Module=require('node:module'),{buildSync}=require('esbuild');
const Database=require('better-sqlite3'),DatabaseManager=require('./database');
const {createWorkflowOrganizationApi}=require('./workflow-organization-api');
const {dragRelation}=require('../shared/workflow-drag.cjs');
function bundled(file) {
  const filename=path.resolve(__dirname,file),mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;
  const {outputFiles}=buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',
    alias:{'@noted/structured-dnd':path.resolve(__dirname,'../../../noted-shared/packages/structured-dnd/src')}});
  mod._compile(outputFiles[0].text,filename);return mod.exports;
}
const {captureWorkflowDrag,workflowDragRequest,workflowDragSourceValid}=bundled('../renderer/utils/workflowDragModel.mjs');
const {organizationProjection,createOrganizationCommitter}=bundled('../renderer/utils/workflowOrganizationClient.mjs');
const {selectWorkflowReserve,workflowReserveOutline,projectReservePaneSource}=bundled('../renderer/utils/workflowReserve.mjs');
const {prepareDrag,projectVerticalMove,projectForestToRootEnd}=bundled('../../../noted-shared/packages/structured-dnd/src/core/index.js');
const {createWorkflowRelationReceipts}=bundled('../renderer/utils/workflowRelationReceipts.mjs');
const {createProjectTabSaveQueue}=bundled('../renderer/utils/projectTabSaveQueue.mjs');
const {createExecutionRevisionAcks}=bundled('../renderer/utils/executionRevisionAcks.mjs');
const {linkedFileOutline,captureLinkedFileDrag,linkedFileDragRequest}=bundled('../renderer/utils/tabLinkedFileTree.mjs');
const {collectTabLinkedFileTree}=bundled('../renderer/utils/tabLinkedFiles.mjs');

function fixture(t,{files=false}={}) {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  t.after(()=>{db.close();assert.equal(db.open,false);});
  const manager=new DatabaseManager({existingConnection:db});manager.initTables();
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P','/private-fixture','P');
  const insert=db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id,tab_type,parent_tab_id,visual_parent_tab_id)
    VALUES('P',?,?,'/private-fixture','codex',? ,?,?,?)`);
  for(const [id,type,parent,visual] of [['A','terminal',null,null],['Q','terminal',null,null],['B','terminal',null,null],
    ['child','terminal',null,'A'],['physical','terminal','A',null],['file','file',null,'A']])insert.run(id,id,'sid-'+id,type,parent,visual);
  db.prepare("UPDATE tabs SET file_path='/private-fixture/linked.md' WHERE tab_id='file'").run();
  if(files)for(const [id,parent] of [['file2','A'],['file3','A'],['nested','file2'],['ai-file','child']]) {
    insert.run(id,id,'sid-'+id,'file',null,parent);
    db.prepare('UPDATE tabs SET file_path=? WHERE tab_id=?').run('/private-fixture/'+id+'.md',id);
  }
  const api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  api.bootstrap({migrationId:'M',mutationId:'M:publish',workspace:{activeSpaceId:'w1',
    splitPanes:[{windowId:'w1-initial',projectId:'P',tabId:'',tabs:[]}],activeSpaceTab:null,
    spaces:[{id:'w1',projectIds:['P'],layout:{}},{id:'w2',projectIds:[],layout:{splitPanes:[{windowId:'w2-initial',projectId:'P',tabId:'',tabs:[]}]}}]}});
  let sequence=0;
  const state=()=>{
    const snapshot=api.read(),projection=organizationProjection(snapshot,{activeSpaceId:'w1'}),openProjects=new Map();
    for(const data of api.listNamespaces())openProjects.set(data.id,{...data,tabs:new Map(data.tabs.map(tab=>[tab.tabId,{...tab,id:tab.tabId}]))});
    return {...projection,openProjects};
  };
  const outline=state=>workflowReserveOutline(selectWorkflowReserve(state));
  const admission=(extra={})=>{const s=state();return captureWorkflowDrag(s,{gestureId:'gesture-'+ ++sequence,
    outline:outline(s),sourceId:'reserve-tab:B',selectedTabIds:['B','A'],...extra});};
  const plan=(a=admission())=>{
    const s=state(),tree=outline(s),prepared=prepareDrag(tree,a.sourceId,{sourceRootIds:a.sourceRootIds});
    const preview=projectVerticalMove({...prepared,boundary:1,preferredDepth:0}).tree;
    return workflowDragRequest(a,{workflowId:'w1',previewOutline:preview});
  };
  const mutate=(kind,extra)=>api.mutate(kind,{mutationId:'foreign-'+ ++sequence,expectedRevision:api.service.getPublication().revision,...extra});
  const rows=()=>db.prepare('SELECT * FROM tabs ORDER BY id').all();
  return {db,manager,api,state,outline,admission,plan,mutate,rows};
}
const rejects=(fn,pattern)=>assert.throws(fn,error=>pattern.test(error.code || error.message));

test('file menu reorders and reparents via canonical SQLite, preserving owner, mixed roots and independent AI files',t=>{
  const f=fixture(t,{files:true}),s=f.state();
  const files=collectTabLinkedFileTree(s.openProjects,'A'),outline=linkedFileOutline(files);
  assert.deepEqual(files.map(file=>file.id),['file','file2','nested','file3']);
  const a=captureLinkedFileDrag(s,'A',{sessionId:'menu-last-first',sourceId:'reserve-tab:file3',outline});
  const reordered=[outline[2],outline[0],outline[1]],before=f.rows();
  const request=linkedFileDragRequest(a,reordered);assert.ok(request);
  f.api.mutate('commitDrag',request);
  assert.deepEqual(f.rows(),before);
  assert.deepEqual(f.api.service.getWorkflow('w1').metadata.reserveRootOrder,[]);
  assert.deepEqual(f.api.service.getWorkflow('w1').metadata.reserveOrder,['file3','file','file2','nested']);
  const s2=f.state(),tree=linkedFileOutline(collectTabLinkedFileTree(s2.openProjects,'A',s2.spaces.find(s=>s.id==='w1').reserveOrder));
  const b=captureLinkedFileDrag(s2,'A',{sessionId:'menu-indent',sourceId:'reserve-tab:file',outline:tree});
  const nested=[{...tree[0],children:[tree[1]]},tree[2]];
  f.api.mutate('commitDrag',linkedFileDragRequest(b,nested));
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='file'").get().visual_parent_tab_id,'file3');
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='ai-file'").get().visual_parent_tab_id,'child');
  const s3=f.state(),c=captureLinkedFileDrag(s3,'A',{sessionId:'menu-outdent',sourceId:'reserve-tab:file',outline:nested});
  f.api.mutate('commitDrag',linkedFileDragRequest(c,reordered));
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='file'").get().visual_parent_tab_id,'A');
});

test('file menu frozen owner scope rejects a new sibling and root detach; no partial writes',t=>{
  const f=fixture(t,{files:true}),s=f.state(),outline=linkedFileOutline(collectTabLinkedFileTree(s.openProjects,'A'));
  const a=captureLinkedFileDrag(s,'A',{sessionId:'menu-scope',sourceId:'reserve-tab:file',outline});
  const request=linkedFileDragRequest(a,outline);
  const detach=structuredClone(request);detach.tabs.find(tab=>tab.tabId==='file').visualParentTabId=null;
  rejects(()=>f.api.mutate('commitDrag',detach),/file_owner_locked/);
  f.db.prepare("UPDATE tabs SET visual_parent_tab_id='A' WHERE tab_id='ai-file'").run();
  const before=f.rows();rejects(()=>f.api.mutate('commitDrag',request),/file_tree_changed/);assert.deepEqual(f.rows(),before);
});

test('file-only popup preserves global group assignments it does not display',t=>{
  const f=fixture(t,{files:true});
  const group=f.api.groups.mutate('create',{version:1,mutationId:'file-group',expectedRevision:f.api.groups.meta().revision,metadata:{name:'Separate'}}).groupId;
  f.api.groups.mutate('assign',{version:1,mutationId:'file-assign',expectedRevision:f.api.groups.meta().revision,groupId:group,tabIds:['file2'],expectedTabGroups:{file2:null}});
  const s=f.state(),outline=linkedFileOutline(collectTabLinkedFileTree(s.openProjects,'A'));
  const a=captureLinkedFileDrag(s,'A',{sessionId:'menu-groups',sourceId:'reserve-tab:file3',outline});
  f.api.mutate('commitDrag',linkedFileDragRequest(a,[outline[2],outline[0],outline[1]]));
  assert.equal(f.api.groups.read().tabGroups.file2,group);
  assert.equal(f.api.groups.read().tabGroups.A,undefined);
});

test('frozen A+child+B uses one forest, original order, and a single replayable durable command',t=>{
  const f=fixture(t),s=f.state(),a=f.admission({selectedTabIds:['B','child','A']});
  assert.deepEqual(a.rootTabIds,['A','B']);assert.ok(a.familyIds.includes('physical'));assert.ok(a.familyIds.includes('file'));
  assert.equal(a.sourceId,'reserve-tab:B');assert.equal(Object.isFrozen(a.guards.B),true);
  s.openProjects.get('P').selectedTabIds=['Q'];assert.deepEqual(a.rootTabIds,['A','B']);
  const plan=f.plan(a),before=f.rows(),result=f.api.mutate('commitDrag',plan);
  assert.deepEqual(f.rows(),before);assert.deepEqual(f.api.service.getWorkflow('w1').metadata.reserveOrder,plan.workflows[0].reserveOrder);
  assert.deepEqual(f.api.mutate('commitDrag',plan),result);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM workflow_org_mutations WHERE mutation_id=?").get(plan.mutationId).n,1);
  rejects(()=>f.api.mutate('commitDrag',{...plan,destinationKind:'changed'}),/mutation_id_conflict/);
});
test('several pane roots and physical/file family move to reserve together, without changing execution rows',t=>{
  const f=fixture(t);
  f.mutate('saveLayout',{workflowId:'w1',expectedWorkflowRevision:f.api.service.getWorkflow('w1').revision,
    layout:{splitPanes:[{windowId:'source',projectId:'P',tabId:'B',tabs:[{projectId:'P',tabId:'A'},{projectId:'P',tabId:'B'}]}]}});
  const s=f.state(),a=captureWorkflowDrag(s,{gestureId:'pane',origin:'pane',sourceId:'reserve-tab:B',
    entries:[{projectId:'P',tabId:'A'},{projectId:'P',tabId:'B'}]});
  const target={...s,activeSpaceId:'w2',splitPanes:[],centerStrips:{},activeSpaceTab:null};
  const model=selectWorkflowReserve(target),tree=workflowReserveOutline(model);
  const projected=projectReservePaneSource(model,tree,{owner:'pane',workflowDrag:a});
  assert.deepEqual(projected.sourceRootIds,['reserve-tab:A','reserve-tab:B']);
  const preview=projectForestToRootEnd(projected.outline,projected.sourceId,projected.sourceRootIds);
  const plan=workflowDragRequest(a,{workflowId:'w2',previewOutline:preview}),before=f.rows();
  f.api.mutate('commitDrag',plan);
  for(const id of a.familyIds)assert.equal(f.api.service.getMembership(id).workflowId,'w2');
  assert.deepEqual(f.api.service.getWorkflow('w1').layout.splitPanes[0].tabs,[]);
  assert.deepEqual(f.rows(),before);
});
test('a separately adopted file keeps its exact parent after extraction from a full source tree',t=>{
  const f=fixture(t),s=f.state(),a=captureWorkflowDrag(s,{gestureId:'file-adoption',origin:'pane',sourceId:'reserve-tab:file',
    entries:[{projectId:'P',tabId:'file'}]});
  const target={...s,activeSpaceId:'w2',splitPanes:[],centerStrips:{},activeSpaceTab:null};
  const model=selectWorkflowReserve(target),projected=projectReservePaneSource(model,workflowReserveOutline(model),{owner:'pane',workflowDrag:a});
  assert.equal(projected.outline.at(-1).contextParent.tabId,'A');
  const request=workflowDragRequest(a,{workflowId:'w2',previewOutline:projected.outline});
  assert.ok(request);f.api.mutate('commitDrag',request);
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='file'").get().visual_parent_tab_id,'A');
});
test('foreign member revision after pickup refuses all source writes with the original guard',t=>{
  const f=fixture(t),plan=f.plan();
  f.mutate('moveTab',{tabId:'B',workflowId:'w2',expectedMembershipRevision:f.api.service.getMembership('B').revision});
  const before=f.api.read();rejects(()=>f.api.mutate('commitDrag',plan),/membership_revision_changed/);
  assert.deepEqual(f.api.read(),before);assert.equal(f.api.getMutation(plan.mutationId),null);
});
test('new hidden descendant and changed physical owner invalidate the full frozen family',t=>{
  const f=fixture(t),plan=f.plan();
  f.db.prepare("UPDATE tabs SET visual_parent_tab_id='A' WHERE tab_id='Q'").run();
  rejects(()=>f.api.mutate('commitDrag',plan),/family_changed/);
  f.db.prepare("UPDATE tabs SET visual_parent_tab_id=NULL WHERE tab_id='Q'").run();
  f.db.prepare("UPDATE tabs SET parent_tab_id='B' WHERE tab_id='physical'").run();
  rejects(()=>f.api.mutate('commitDrag',plan),/relation_changed/);
});
test('unrelated publication/focus/resize may advance; immutable request and exact placement guards remain',t=>{
  const f=fixture(t),plan=f.plan(),origin=plan.expectedRevision;
  f.mutate('saveLayout',{workflowId:'w1',expectedWorkflowRevision:f.api.service.getWorkflow('w1').revision,
    layout:{splitSizes:[.4,.6],focusedProjectId:'P'}});
  const result=f.api.mutate('commitDrag',plan);
  assert.ok(result.baseRevision>origin);assert.equal(plan.expectedRevision,origin);
  assert.deepEqual(f.api.service.getWorkflow('w1').layout.splitSizes,[.4,.6]);
  const recorded=JSON.parse(f.db.prepare('SELECT request_json FROM workflow_org_mutations WHERE mutation_id=?').get(plan.mutationId).request_json);
  assert.equal(recorded.expectedRevision,origin);
});
test('foreign source placement in a hidden profile is not silently pruned',t=>{
  const f=fixture(t),plan=f.plan();
  f.mutate('saveLayout',{workflowId:'w1',expectedWorkflowRevision:f.api.service.getWorkflow('w1').revision,
    layout:{windowDisplayLayouts:{hidden:{splitPanes:[{windowId:'hidden',displayHidden:true,tabId:'A',projectId:'P'}]}}}});
  const before=f.api.read();rejects(()=>f.api.mutate('commitDrag',plan),/source_placement_changed/);assert.deepEqual(f.api.read(),before);
});
test('group assignments, relation and reserve order roll back together on a failed generation',t=>{
  const f=fixture(t),g=f.api.groups.mutate('create',{version:1,mutationId:'group',expectedRevision:f.api.groups.meta().revision,metadata:{name:'G'}}).groupId;
  const s=f.state(),a=f.admission({selectedTabIds:['B']});
  const tree=f.outline(s),b=tree.find(node=>node.tabId==='B'),rest=tree.filter(node=>node!==b);
  const parent=rest.find(node=>node.tabId==='Q');parent.children=[b];
  const group=rest.find(node=>node.groupId===g);
  // The empty global group is not local; use its real definition in the preview.
  const preview=[...rest.filter(node=>node!==parent && node!==group),{id:'G',groupId:g,children:[parent]}];
  const plan=workflowDragRequest(a,{workflowId:'w1',previewOutline:preview}),before=f.api.read(),rows=f.rows();
  f.api.service.fault=phase=>{if(phase==='beforePublicationMarker')throw Error('private fault');};
  assert.throws(()=>f.api.mutate('commitDrag',plan),/private fault/);
  assert.deepEqual(f.api.read(),before);assert.deepEqual(f.rows(),rows);
  f.api.service.fault=()=>{};f.api.mutate('commitDrag',plan);
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='B'").get().visual_parent_tab_id,'Q');
  assert.equal(f.api.groups.read().tabGroups.B,g);
});
test('canonical writer refuses physical execution reparenting and parent cycles',t=>{
  const f=fixture(t),plan=f.plan();
  const changed=structuredClone(plan);changed.tabs.find(tab=>tab.tabId==='physical').visualParentTabId='B';
  rejects(()=>f.api.mutate('commitDrag',changed),/physical_parent_locked/);
  const cyclic=structuredClone(plan);cyclic.tabs.find(tab=>tab.tabId==='A').visualParentTabId='child';
  rejects(()=>f.api.mutate('commitDrag',cyclic),/parent_cycle/);
});
test('file visual outdent and reattach preserve identity, path and physical ownership',t=>{
  const f=fixture(t),before=f.rows().find(row=>row.tab_id==='file');
  for(const parentId of [null,'B']){
    const s=f.state(),tree=f.outline(s),a=captureWorkflowDrag(s,{gestureId:'file-relation-'+parentId,
      outline:tree,sourceId:'reserve-tab:file',selectedTabIds:['file']});
    let file;
    const extract=nodes=>nodes.filter(node=>{if(node.tabId==='file'){file=node;return false;}return true;})
      .map(node=>({...node,children:extract(node.children || [])}));
    const preview=extract(tree);file={...file,contextParent:null};
    if(parentId)preview.find(node=>node.tabId===parentId).children.push(file);else preview.push(file);
    const plan=workflowDragRequest(a,{workflowId:'w1',previewOutline:preview});assert.ok(plan);
    const result=f.api.mutate('commitDrag',plan),after=f.rows().find(row=>row.tab_id==='file');
    assert.equal(after.visual_parent_tab_id,parentId);assert.equal(result.relationReceipts[0].afterParent,parentId);
    for(const key of ['id','file_path','cwd','parent_tab_id','codex_session_id'])assert.equal(after[key],before[key]);
  }
});
test('an empty group keeps its painted position through the canonical workflow order',t=>{
  const f=fixture(t),group=f.api.groups.mutate('create',{version:1,mutationId:'empty',expectedRevision:f.api.groups.meta().revision,
    metadata:{name:'Empty',reserveWorkflowId:'w1'}}).groupId;
  const s=f.state(),tree=f.outline(s),node=tree.find(node=>node.groupId===group);
  const a=captureWorkflowDrag(s,{gestureId:'empty-drag',outline:tree,sourceId:node.id});
  const preview=[node,...tree.filter(item=>item!==node)],plan=workflowDragRequest(a,{workflowId:'w1',previewOutline:preview});
  f.api.mutate('commitDrag',plan);
  assert.equal(f.outline(f.state())[0].groupId,group);
});

function groupedReserve(t) {
  const f=fixture(t);
  for(const [name,ids] of [['First',['A','child','physical','file']],['Second',['Q']],['Empty',[]]]){
    const group=f.api.groups.mutate('create',{version:1,mutationId:'make-'+name,expectedRevision:f.api.groups.meta().revision,
      metadata:{name,reserveWorkflowId:'w1'}}).groupId;
    if(ids.length)f.api.groups.mutate('assign',{version:1,mutationId:'assign-'+name,expectedRevision:f.api.groups.meta().revision,
      groupId:group,tabIds:ids,expectedTabGroups:Object.fromEntries(ids.map(id=>[id,null]))});
  }
  return f;
}
test('window placement keeps mixed reserve containers after their first member leaves',t=>{
  const f=groupedReserve(t),s=f.state(),tree=f.outline(s),roots=tree.map(node=>node.id);
  const a=captureWorkflowDrag(s,{gestureId:'keep-containers',outline:tree,sourceId:'reserve-tab:A',selectedTabIds:['A']});
  const plan=workflowDragRequest(a,{workflowId:'w1',target:{zone:'body',paneKey:'pane:0',paneIndex:0,at:Infinity}});
  const source=plan.workflows.find(w=>w.workflowId==='w1');
  assert.deepEqual(source.expectedReserveRootOrder,[]);assert.deepEqual(source.reserveRootOrder,roots);
  f.api.mutate('commitDrag',plan);
  assert.deepEqual(f.outline(f.state()).map(node=>node.id),roots);
  assert.deepEqual(f.api.service.getWorkflow('w1').metadata.reserveRootOrder,roots);
});
test('cross-workflow window placement preserves source hidden ranks without imposing them on destination',t=>{
  const f=groupedReserve(t),s=f.state(),roots=f.outline(s).map(n=>n.id),hidden='reserve-tab:historically-parked';
  f.mutate('commitWorkspace',{spaces:s.spaces.map(space=>({...space,reserveRootOrder:space.id==='w1'?[hidden,...roots]:['reserve-tab:destination-parked']})),
    tabWorkflowMembership:s.tabWorkflowMembership});
  const current=f.state(),a=captureWorkflowDrag(current,{gestureId:'cross-container-order',outline:f.outline(current),sourceId:'reserve-tab:A'});
  const plan=workflowDragRequest(a,{workflowId:'w2',target:{zone:'body',paneKey:'pane:0',paneIndex:0,at:Infinity}});
  const source=plan.workflows.find(w=>w.workflowId==='w1'),dest=plan.workflows.find(w=>w.workflowId==='w2');
  assert.ok(source);assert.deepEqual(source.expectedReserveRootOrder,[hidden,...roots]);
  assert.deepEqual(source.reserveRootOrder,[hidden,...roots]);assert.deepEqual(dest.reserveRootOrder,['reserve-tab:destination-parked']);
  f.api.mutate('commitDrag',plan);assert.deepEqual(f.api.service.getWorkflow('w1').metadata.reserveRootOrder,[hidden,...roots]);
});
test('foreign source root-order change after pickup still rejects the window drop',t=>{
  const f=groupedReserve(t),s=f.state(),tree=f.outline(s);
  const a=captureWorkflowDrag(s,{gestureId:'frozen-container-order',outline:tree,sourceId:'reserve-tab:A'});
  const plan=workflowDragRequest(a,{workflowId:'w2',target:{zone:'body',paneKey:'pane:0',paneIndex:0,at:Infinity}});
  f.mutate('commitWorkspace',{spaces:s.spaces.map(space=>space.id==='w1'?{...space,reserveRootOrder:tree.map(n=>n.id).reverse()}:space),
    tabWorkflowMembership:s.tabWorkflowMembership});
  const before=f.api.read();rejects(()=>f.api.mutate('commitDrag',plan),/destination_changed/);assert.deepEqual(f.api.read(),before);
});
test('same-pane reorder preserves the shown tab and an independently placed descendant',t=>{
  const f=fixture(t),entries=['A','Q','B'].map(tabId=>({projectId:'P',tabId}));
  f.mutate('saveLayout',{workflowId:'w1',expectedWorkflowRevision:f.api.service.getWorkflow('w1').revision,
    layout:{splitPanes:[{windowId:'source',projectId:'P',tabId:'Q',tabs:entries},
      {windowId:'child-window',projectId:'P',tabId:'child',tabs:[{projectId:'P',tabId:'child'}]}]}});
  const s=f.state(),a=captureWorkflowDrag(s,{gestureId:'same-pane',origin:'pane',sourceId:'reserve-tab:B',sourcePaneKey:'pane:0',
    entries:[{projectId:'P',tabId:'A'},{projectId:'P',tabId:'B'}]});
  const plan=workflowDragRequest(a,{workflowId:'w1',target:{zone:'strip',paneKey:'pane:0',paneIndex:0,at:0}});
  f.api.mutate('commitDrag',plan);
  const panes=f.api.service.getWorkflow('w1').layout.splitPanes;
  assert.deepEqual(panes[0].tabs.map(tab=>tab.tabId),['A','B','Q']);assert.equal(panes[0].tabId,'Q');
  assert.equal(panes[1].tabId,'child');
});
test('cross-workflow window placement transports roots and physical/file family while visual children remain independent',t=>{
  const f=fixture(t),s=f.state(),a=captureWorkflowDrag(s,{gestureId:'window-membership',outline:f.outline(s),
    sourceId:'reserve-tab:B',selectedTabIds:['A','B']});
  const plan=workflowDragRequest(a,{workflowId:'w2',target:{zone:'body',paneKey:'pane:0',paneIndex:0,at:Infinity}});
  f.api.mutate('commitDrag',plan);
  for(const id of ['A','B','physical','file'])assert.equal(f.api.service.getMembership(id).workflowId,'w2');
  assert.equal(f.api.service.getMembership('child').workflowId,'w1');
  assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='child'").get().visual_parent_tab_id,'A');
  assert.deepEqual(f.api.service.getWorkflow('w2').layout.splitPanes[0].tabs.map(tab=>tab.tabId),['A','B']);
});
test('changed global group composition and replaced typed rows reject the frozen command',t=>{
  const f=fixture(t),group=f.api.groups.mutate('create',{version:1,mutationId:'G',expectedRevision:f.api.groups.meta().revision,metadata:{name:'G'}}).groupId;
  f.api.groups.mutate('assign',{version:1,mutationId:'assign',expectedRevision:f.api.groups.meta().revision,groupId:group,
    tabIds:['A','child','physical','file'],expectedTabGroups:{A:null,child:null,physical:null,file:null}});
  const plan=f.plan();
  f.api.groups.mutate('assign',{version:1,mutationId:'other',expectedRevision:f.api.groups.meta().revision,groupId:group,tabIds:['Q'],expectedTabGroups:{Q:null}});
  rejects(()=>f.api.mutate('commitDrag',plan),/group_composition_changed/);
  const fresh=f.plan();
  f.db.prepare("UPDATE tabs SET id=id+1000 WHERE tab_id='B'").run();
  rejects(()=>f.api.mutate('commitDrag',fresh),/subject_changed/);
});
test('queued canonical command keeps original request across awaits and respects cancellation',async t=>{
  const f=fixture(t),plan=f.plan();let unlock;const gate=new Promise(resolve=>{unlock=resolve;});
  const seen=[],committer=createOrganizationCommitter({invoke:async(channel,payload)=>{
    if(channel==='workflow:mutation')return f.api.getMutation(payload);
    seen.push(structuredClone(payload.request));return f.api.mutate(payload.kind,payload.request);
  },getPublication:()=>f.api.service.getPublication(),applyPublication:()=>f.api.read(),onError:()=>{}});
  committer.runTask(()=>gate);const pending=committer.command('commitDrag',plan);
  f.mutate('moveTab',{tabId:'B',workflowId:'w2',expectedMembershipRevision:f.api.service.getMembership('B').revision});
  unlock();await assert.rejects(pending,/membership_revision_changed/);assert.deepEqual(seen,[plan]);
  let current=false;await assert.rejects(committer.command('commitDrag',plan,{isCurrent:()=>current}),/drag_cancelled/);
  assert.equal(seen.length,1);
});
test('relation receipt reconciles a late frozen metadata save without claiming a foreign revision gap',async t=>{
  const f=fixture(t),created=f.api.createTab({mutationId:'v2',cwd:'/fixture',workflowId:'w1',record:{name:'Native'}});
  const id=created.tabId,namespace=created.executionSubject.executionNamespace;
  const s=f.state(),tree=f.outline(s),sourceId=`reserve-tab:${id}`;
  const a=captureWorkflowDrag(s,{gestureId:'native-relation',outline:tree,sourceId});
  const moving=tree.find(node=>node.tabId===id),parent=tree.find(node=>node.tabId==='Q');
  parent.children.push(moving);const plan=workflowDragRequest(a,{workflowId:'w1',previewOutline:tree.filter(node=>node!==moving)});
  const native=f.manager.getExecutionTabV2({executionNamespace:namespace,tabId:id}),old={...native.tab,name:'Pending rename'};
  const queues=createProjectTabSaveQueue(),relations=createWorkflowRelationReceipts(),acks=createExecutionRevisionAcks();
  let result;
  const drag=queues.enqueue(namespace,()=>{result=f.api.mutate('commitDrag',plan);result.relationReceipts.forEach(receipt=>relations.record(receipt));});
  const late=queues.enqueue(namespace,()=>{
    acks.prepare(namespace,[old]);relations.prepare(namespace,[old]);
    assert.equal(old.visualParentTabId,'Q');assert.equal(old.name,'Pending rename');
    return f.manager.saveExecutionTabV2({executionNamespace:namespace,tabId:id,subjectId:native.executionSubject.subjectId,
      expectedRevision:old.executionStorageRevision,record:old});
  });
  await drag;await late;
  const after=f.manager.getExecutionTabV2({executionNamespace:namespace,tabId:id});
  assert.equal(after.tab.name,'Pending rename');assert.equal(after.tab.visualParentTabId,'Q');
  assert.deepEqual(after.executionSubject,native.executionSubject);
  const stale={...native.tab,executionStorageRevision:native.revision-1};relations.prepare(namespace,[stale]);
  assert.equal(stale.executionStorageRevision,native.revision-1);
});

test('ordinary legacy metadata save during pickup keeps the same rows and does not invalidate the drag',t=>{
  const f=fixture(t);
  // Keep a higher native PK alive so delete/reinsert cannot accidentally reuse
  // the legacy source's former physical identity.
  f.api.createTab({mutationId:'higher-native',cwd:'/fixture',workflowId:'w1',record:{name:'Neighbor'}});
  const plan=f.plan(),before=new Map(f.rows().map(row=>[row.tab_id,row.id]));
  const tabs=f.api.listNamespaces().find(namespace=>namespace.id==='P').tabs;
  tabs.find(tab=>tab.tabId==='A').name='Background title update';
  assert.equal(f.manager.saveTabs('P',tabs).success,true);
  for(const row of f.rows())assert.equal(row.id,before.get(row.tab_id),'retained PK '+row.tab_id);
  assert.equal(f.api.mutate('commitDrag',plan).success,true);
  assert.equal(f.db.prepare("SELECT name FROM tabs WHERE tab_id='A'").get().name,'Background title update');
  assert.equal(f.db.prepare("SELECT parent_tab_id FROM tabs WHERE tab_id='physical'").get().parent_tab_id,'A');
});

test('two late native saves after drag keep exact CAS advancement, parent and their newer metadata',async t=>{
  const f=fixture(t),created=f.api.createTab({mutationId:'v2-two',cwd:'/fixture',workflowId:'w1',record:{name:'Native'}});
  const id=created.tabId,namespace=created.executionSubject.executionNamespace;
  const s=f.state(),tree=f.outline(s),a=captureWorkflowDrag(s,{gestureId:'two-saves',outline:tree,sourceId:`reserve-tab:${id}`});
  const moving=tree.find(node=>node.tabId===id),parent=tree.find(node=>node.tabId==='Q');parent.children.push(moving);
  const plan=workflowDragRequest(a,{workflowId:'w1',previewOutline:tree.filter(node=>node!==moving)});
  const native=f.manager.getExecutionTabV2({executionNamespace:namespace,tabId:id});
  const snapshots=['first','second'].map(name=>({...native.tab,tabId:id,name}));
  const queue=createProjectTabSaveQueue(),rel=createWorkflowRelationReceipts(),acks=createExecutionRevisionAcks();
  rel.capture(namespace,snapshots);
  const commits=[queue.enqueue(namespace,()=>{
    const result=f.api.mutate('commitDrag',plan);
    for(const receipt of result.relationReceipts){rel.record(receipt);assert.equal(acks.relation(namespace,native.tab,receipt),true);}
  })];
  for(const snapshot of snapshots)commits.push(queue.enqueue(namespace,()=>{
    acks.prepare(namespace,[snapshot]);rel.prepare(namespace,[snapshot],acks);
    const result=f.manager.saveExecutionTabV2({executionNamespace:namespace,tabId:id,subjectId:native.executionSubject.subjectId,
      expectedRevision:snapshot.executionStorageRevision,record:snapshot});
    acks.ack(namespace,[snapshot],{success:true,executionRevisions:[{tabId:id,subjectId:native.executionSubject.subjectId,revision:result.revision}]});
  }));
  await Promise.all(commits);
  const after=f.manager.getExecutionTabV2({executionNamespace:namespace,tabId:id});
  assert.equal(after.tab.name,'second');assert.equal(after.tab.visualParentTabId,'Q');assert.deepEqual(after.executionSubject,native.executionSubject);
});
