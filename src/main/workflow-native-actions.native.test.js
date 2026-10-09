'use strict';
// Actual whole HTTP adapter + canonical owners/private SQLite. Electron Node
// mode only for the installed SQLite ABI: no BrowserWindow/app/PTY/provider.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),url=require('node:url');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3'),DatabaseManager=require('./database');
const {createWorkflowOrganizationApi}=require('./workflow-organization-api');
const {createWorkflowOrganizationHttp,WORKFLOW_HTTP_CAPABILITY}=require('./workflow-organization-http');
const {GLOBAL_EXECUTION_NAMESPACE:NS}=require('../shared/workflow-organization.cjs');
const base='/api/workflow-organization',drag=base+'/drag',groups=base+'/groups';
const evidence=(name,data)=>{if(process.env.NOTED_NATIVE_ACTIONS_EVIDENCE_DIR){fs.mkdirSync(process.env.NOTED_NATIVE_ACTIONS_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.NOTED_NATIVE_ACTIONS_EVIDENCE_DIR,name),JSON.stringify(data,null,2));}};
const ref=tabId=>({projectId:NS,tabId});
async function fixture(t,{legacy=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-native-actions-test-')),filename=path.join(root,'owned.db');
 let db,manager,api;const open=()=>{db=new Database(filename);db.pragma('foreign_keys=ON');manager=new DatabaseManager({existingConnection:db});manager.initTables();api=createWorkflowOrganizationApi({database:manager});};open();
 if(legacy){db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('legacy',root,'Legacy');db.prepare("INSERT INTO tabs(project_id,tab_id,name,cwd,command_type) VALUES('legacy','L','Legacy tab',?,'codex')").run(root);}
 api.bootstrap({migrationId:'m',mutationId:'activate',workspace:{activeSpaceId:'one',spaces:[{id:'one',name:'One',layout:{},projectIds:legacy?['legacy']:[]},{id:'two',name:'Two',layout:{},projectIds:[]}]}});
 for(const [id,wf,type,parent,physical] of [['A','one'],['B','one'],['C','one'],['file','one','file','A'],['physical','one','terminal',null,'A'],['child','one','terminal','A'],['D','two']])
  api.createTab({mutationId:'create:'+id,tabId:id,cwd:root,workflowId:wf,record:{name:id,tabType:type||'terminal',visualParentTabId:parent||null,parentTabId:physical||null,filePath:type==='file'?path.join(root,'file.md'):null}});
 fs.writeFileSync(path.join(root,'file.md'),'# private\n');
 let sequence=0;
 const mutate=(kind,body)=>api.mutate(kind,{mutationId:'setup:'+ ++sequence,expectedRevision:api.service.getPublication().revision,...body});
 const layout={splitPanes:[{windowId:'shown',...ref('A'),tabs:[ref('A'),ref('C')]},{windowId:'hidden',...ref('B'),displayHidden:true}],
  windowDisplayLayouts:{old:{splitPanes:[{windowId:'old',...ref('C')}] }},activeSpaceTab:ref('A'),splitFocusedIndex:0};
 mutate('saveLayout',{workflowId:'one',expectedWorkflowRevision:api.service.getWorkflow('one').revision,layout});
 const handler=createWorkflowOrganizationHttp({getProjectManager:()=>({db:manager,workflowOrganization:api}),
  checkAuth:req=>req.headers.authorization==='Bearer private',readBody:async req=>{let s='';for await(const x of req)s+=x;return JSON.parse(s||'{}');},
  sendJson:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
 const server=http.createServer((req,res)=>handler(req,res,url.parse(req.url,true)).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=async(route,method='GET',body,auth=true)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:{...(auth?{Authorization:'Bearer private'}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const input=async(source='C',selected=[])=>{const dto=(await call(base+'?projection=catalog-v1')).body,status=(await call(drag)).body;return {version:1,epoch:status.epoch,startedAt:status.serverTime,gestureId:'gesture-'+ ++sequence,workflowId:'one',sourceId:'reserve-tab:'+source,selectedTabIds:selected,
  expected:{organizationRevision:dto.clocks.organization.revision,groupsRevision:dto.clocks.groups.revision,tree:dto.clocks.tree.value}};};
 const capture=async(source,selected)=>{const request=await input(source,selected),r=await call(drag+'/capture','POST',request);assert.equal(r.status,200,JSON.stringify(r));return {request,...r.body};};
 const preview=async(captured,actions,workflowId='one')=>{const r=await call(drag+'/preview','POST',{version:1,captureId:captured.captureId,destination:{workflowId,actions}});assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const group=async(kind,body)=>{const snapshot=api.groups.read(),r=await call(groups+'/mutations','POST',{kind,request:{version:1,mutationId:'group:'+ ++sequence,expectedRevision:snapshot.revision,...body}});assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 return {root,call,input,capture,preview,group,mutate,get api(){return api;},get db(){return db;},reopen(){db.close();open();},rows:()=>db.prepare('SELECT * FROM tabs ORDER BY id').all()};
}
const error=(r,code)=>{assert.equal(r.status,409,JSON.stringify(r));if(code)assert.equal(r.body.error,code);};

test('separate capabilities/auth; canonical groups explicit actions, receipt/replay, stale CAS, cross-workflow and reopen',async t=>{
 const f=await fixture(t);assert.equal(WORKFLOW_HTTP_CAPABILITY.groupActions.version,1);assert.equal(WORKFLOW_HTTP_CAPABILITY.nativeDrag.inventory,'active-membership');
 for(const route of [groups,drag])assert.equal((await f.call(route,'GET',undefined,false)).status,401);
 const made=await f.group('create',{metadata:{name:'Shared',reserveWorkflowId:'one'}}),gid=made.groupId;
 await f.group('assign',{groupId:gid,tabIds:['A','D'],expectedTabGroups:{A:null,D:null}});
 for(const [kind,patch] of [['rename',{name:'Renamed'}],['status',{status:'green'}],['color',{color:'#aaff00'}],['collapse',{collapsed:true}],['collapse',{collapsed:false}]]){
  const snap=f.api.groups.read(),body={kind,request:{version:1,mutationId:'action:'+kind+':'+snap.revision,expectedRevision:snap.revision,groupId:gid,expectedGroupRevision:f.api.groups.group(gid).revision,...patch}};
  const done=await f.call(groups+'/mutations','POST',body);assert.equal(done.status,200);if(kind==='collapse' && patch.collapsed===false)evidence('group-example.json',{request:body,response:done});assert.deepEqual(await f.call(groups+'/mutations','POST',body),done);
  assert.deepEqual((await f.call(groups+'/mutations/'+encodeURIComponent(body.request.mutationId))).body,done.body);
  error(await f.call(groups+'/mutations','POST',{...body,request:{...body.request,unexpected:true}}),'workflow_group_mutation_id_conflict');
  error(await f.call(groups+'/mutations','POST',{...body,request:{...body.request,mutationId:'stale:'+body.request.mutationId}}),'workflow_group_revision_changed');
 }
 f.reopen();const read=(await f.call(groups)).body;assert.equal(read.tabGroups.A,gid);assert.equal(read.tabGroups.D,gid);assert.equal(read.groups[0].collapsed,false);
 const rows=f.rows();await f.group('delete',{groupId:gid,expectedGroupRevision:read.groups[0].revision});assert.deepEqual(f.rows(),rows);assert.deepEqual((await f.call(groups)).body.tabGroups,{});
});

test('full-active pickup includes placed/hidden/profile/file/physical; exact concurrent capture joins without latest rebase',async t=>{
 const f=await fixture(t),input=await f.input('A');let reads=0;const read=f.api.service.readState.bind(f.api.service);f.api.service.readState=()=>{reads++;return read();};
 const [a,b]=await Promise.all([f.call(drag+'/capture','POST',input),f.call(drag+'/capture','POST',input)]);assert.equal(a.status,200,JSON.stringify(a));assert.deepEqual(a,b);assert.equal(reads,1);
 assert.deepEqual(new Set(a.body.sourceFamilyIds),new Set(['A','file','physical','child']));
 assert.deepEqual(new Set(a.body.workflows.find(w=>w.id==='one').memberTabIds),new Set(['A','B','C','file','physical','child']));
 const p=await f.preview(a.body,[{kind:'reorder',parentId:null,index:1}]);assert.deepEqual(p.proposal.workflows[0].expectedReserveOrder,[]);assert.deepEqual(p.proposal.workflows[0].expectedReserveRootOrder,[]);
 assert.equal(p.proposal.tabs.find(row=>row.tabId==='physical').expected.parentTabId,'A');
 f.mutate('createWorkflow',{workflow:{id:'unrelated',name:'Unrelated'}});
 assert.deepEqual(await f.call(drag+'/capture','POST',input),a);assert.equal(reads,2,'foreign publication read plus frozen capture without another snapshot');
 error(await f.call(drag+'/capture','POST',{...input,sourceId:'reserve-tab:B'}),'workflow_drag_capture_id_conflict');
});

test('preview equals canonical commit, keeps window/profile placement and tolerates unrelated publication; exact replay after reopen',async t=>{
 const f=await fixture(t),c=await f.capture(),p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}]);
 const layout=f.api.service.getWorkflow('one').layout,rows=f.rows();f.mutate('createWorkflow',{workflow:{id:'other',name:'Other'}});
 const done=await f.call(drag+'/commit','POST',p.commit);assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.body.nativePreview.previewId,p.previewId);
 assert.deepEqual(f.api.service.getWorkflow('one').metadata.reserveRootOrder,p.tree.map(n=>n.id));assert.deepEqual(f.api.service.getWorkflow('one').layout,layout);assert.deepEqual(f.rows(),rows);
 const stored=JSON.parse(f.db.prepare('SELECT request_json FROM workflow_org_mutations WHERE mutation_id=?').get(p.commit.mutationId).request_json);delete stored.kind;delete stored.nativeCommit;assert.deepEqual(stored,p.proposal);
 assert.deepEqual((await f.call(base+'/mutations/'+encodeURIComponent(p.commit.mutationId))).body,done.body);
 evidence('drag-example.json',{captureRequest:c.request,captureResponse:Object.fromEntries(Object.entries(c).filter(([key])=>key!=='request')),preview:p,commitResponse:done,readback:await f.call(base+'?projection=catalog-v1')});
 f.reopen();assert.deepEqual(await f.call(drag+'/commit','POST',p.commit),done);
 error(await f.call(drag+'/commit','POST',{...p.commit,destination:{workflowId:'one',actions:[]}}),'workflow_mutation_id_conflict');
 error(await f.call(drag+'/capture','POST',c.request),'workflow_drag_epoch_changed');
});

test('file visual outdent/indent allowed; physical child, multi-X and ancestor cycle rejected before commit',async t=>{
 const f=await fixture(t),c=await f.capture('file'),p=await f.preview(c,[{kind:'outdent'}]);assert.equal((await f.call(drag+'/commit','POST',p.commit)).status,200);
 assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='file'").get().visual_parent_tab_id,null);
 const d=await f.capture('file'),q=await f.preview(d,[{kind:'indent'}]);assert.equal((await f.call(drag+'/commit','POST',q.commit)).status,200);
 assert.equal(f.db.prepare("SELECT visual_parent_tab_id FROM tabs WHERE tab_id='file'").get().visual_parent_tab_id,'A');
 for(const [source,selected,actions] of [['physical',[],[{kind:'outdent'}]],['C',['B','C'],[{kind:'indent'}]],['A',[],[{kind:'reorder',parentId:'reserve-tab:file',index:0}]]]){
  const x=await f.capture(source,selected);error(await f.call(drag+'/preview','POST',{version:1,captureId:x.captureId,destination:{workflowId:'one',actions}}));
 }
});

test('cross-workflow tree move retains shared global group and removes all old layout/profile family placements',async t=>{
 const f=await fixture(t),made=await f.group('create',{metadata:{name:'Shared'}}),gid=made.groupId;
 await f.group('assign',{groupId:gid,tabIds:['A','file','physical','child','D'],expectedTabGroups:{A:null,file:null,physical:null,child:null,D:null}});
 const c=await f.capture('A'),parent=c.workflows.find(w=>w.id==='two').nodes.find(n=>n.groupId===gid).id;
 const p=await f.preview(c,[{kind:'reorder',parentId:parent,index:1}],'two'),before=f.rows(),done=await f.call(drag+'/commit','POST',p.commit);
 assert.equal(done.status,200,JSON.stringify(done));assert.deepEqual(f.rows(),before);
 for(const id of ['A','file','physical','child']){assert.equal(f.api.service.getMembership(id).workflowId,'two');assert.equal(f.api.groups.read().tabGroups[id],gid);}
 const one=f.api.service.getWorkflow('one');assert.ok(!JSON.stringify(one.layout).includes('"tabId":"A"'));
 assert.equal(f.api.groups.read().groups.length,1);
});

test('scoped relation, subject, storage identity, group definition and hidden profile changes reject old preview atomically',async t=>{
 for(const change of ['relation','subject','storage','group','profile']){
  const f=await fixture(t);let gid;
  if(change==='group'){gid=(await f.group('create',{metadata:{name:'G'}})).groupId;await f.group('assign',{groupId:gid,tabIds:['B'],expectedTabGroups:{B:null}});}
  const c=await f.capture(),p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}]);
  if(change==='relation')f.db.prepare("UPDATE tabs SET visual_parent_tab_id='B' WHERE tab_id='C'").run();
  if(change==='subject')f.db.prepare("UPDATE tabs SET cwd=cwd||'/changed' WHERE tab_id='C'").run();
  if(change==='storage')f.db.prepare("UPDATE tabs SET id=id+1000 WHERE tab_id='C'").run();
  if(change==='group')await f.group('rename',{groupId:gid,expectedGroupRevision:f.api.groups.group(gid).revision,name:'Changed'});
  if(change==='profile'){const w=f.api.service.getWorkflow('one'),layout=structuredClone(w.layout);layout.windowDisplayLayouts.old.splitPanes[0].tabs=[ref('C'),ref('B')];f.mutate('saveLayout',{workflowId:'one',expectedWorkflowRevision:w.revision,layout});}
  const before=f.api.read();error(await f.call(drag+'/commit','POST',p.commit));assert.deepEqual(f.api.read(),before);assert.equal(f.api.getMutation(p.commit.mutationId),null);
 }
});

test('preview cannot be altered, release/expiry do not recapture, and stale pickup clocks refuse',async t=>{
 const f=await fixture(t),c=await f.capture(),p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}]);
 error(await f.call(drag+'/commit','POST',{...p.commit,destination:{workflowId:'one',actions:[]}}),'workflow_drag_preview_changed');
 assert.equal((await f.call(drag+'/'+encodeURIComponent(c.captureId),'DELETE')).status,200);
 assert.equal((await f.call(drag+'/capture','POST',c.request)).status,410);
 const input=await f.input();input.expected.tree='stale';error(await f.call(drag+'/capture','POST',input),'workflow_drag_pickup_changed');
 const old=await f.input();f.api.nativeDrag.now=()=>old.startedAt+300001;
 assert.equal((await f.call(drag+'/capture','POST',old)).status,410);
});

test('empty global group can be reordered and transferred with preview/readback equality',async t=>{
 const f=await fixture(t),g=await f.group('create',{metadata:{name:'Empty',reserveWorkflowId:'one'}});
 const input=await f.input();input.sourceId='reserve-group:'+JSON.stringify([NS,g.groupId]);
 const c=(await f.call(drag+'/capture','POST',input)).body,p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}],'two');
 const done=await f.call(drag+'/commit','POST',p.commit);assert.equal(done.status,200,JSON.stringify(done));
 const read=(await f.call(base+'?projection=catalog-v1')).body;
 assert.ok(read.workflows.find(w=>w.id==='two').rootIds.includes(input.sourceId));
 assert.ok(!read.workflows.find(w=>w.id==='one').rootIds.includes(input.sourceId));
 assert.equal(read.groups.find(x=>x.id===g.groupId).reserveWorkflowId,'two');
});

test('capture shares coherent read with catalogue; geometry-only change survives the frozen tree commit',async t=>{
 const f=await fixture(t),input=await f.input();let reads=0;const before=f.api.service.readState.bind(f.api.service);f.api.service.readState=()=>{reads++;return before();};
 const [captured,catalog]=await Promise.all([f.api.nativeDrag.capture(input),f.api.readCatalog()]);assert.equal(reads,1);assert.equal(captured.clocks.tree.value,catalog.clocks.tree.value);
 const p=await f.preview(captured,[{kind:'reorder',parentId:null,index:0}]);
 const w=f.api.service.getWorkflow('one'),layout={...w.layout,splitSizes:{cols:[.3,.7]},splitFocusedIndex:1};
 f.mutate('saveLayout',{workflowId:'one',expectedWorkflowRevision:w.revision,layout});
 const done=await f.call(drag+'/commit','POST',p.commit);assert.equal(done.status,200,JSON.stringify(done));
 assert.deepEqual(f.api.service.getWorkflow('one').layout.splitSizes,{cols:[.3,.7]});assert.equal(f.api.service.getWorkflow('one').layout.splitFocusedIndex,1);
});

test('bounded captures release heavy data, free admission capacity, and reject a changed replay body',async t=>{
 const f=await fixture(t),input=await f.input();
 const captures=await Promise.all(Array.from({length:32},(_,i)=>f.api.nativeDrag.capture({...input,gestureId:'bounded-'+i})));
 assert.ok(f.api.nativeDrag.bytes>0);
 await assert.rejects(f.api.nativeDrag.capture({...input,gestureId:'full'}),e=>e.statusCode===429);
 const before=f.api.nativeDrag.bytes;f.api.nativeDrag.release(captures[0].captureId);assert.ok(f.api.nativeDrag.bytes<before);
 const next=await f.api.nativeDrag.capture({...input,gestureId:'after-release'});assert.ok(next.captureId);
 assert.equal(f.api.nativeDrag.captures.get(captures[0].captureId).context,null);assert.equal(f.api.nativeDrag.captures.get(captures[0].captureId).promise,null);
 const p=await f.preview(next,[{kind:'reorder',parentId:null,index:0}]);
 const [a,b]=await Promise.all([f.call(drag+'/commit','POST',p.commit),f.call(drag+'/commit','POST',p.commit)]);assert.equal(a.status,200,JSON.stringify(a));assert.deepEqual(a,b);
 assert.equal(f.db.prepare('SELECT count(*) n FROM workflow_org_mutations WHERE mutation_id=?').get(p.commit.mutationId).n,1);
 for(const route of [drag+'/capture',drag+'/preview',drag+'/commit',groups+'/mutations'])assert.equal((await f.call(route,'POST',{},false)).status,401);
});

test('Main compiler ships as a self-contained CJS artifact without renderer or sibling source paths',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-drag-packaged-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'dist/workflow-native-drag.cjs');fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../dist/workflow-native-drag.cjs'),file);
 const shipped=require(file);assert.equal(shipped.version,1);assert.equal(typeof shipped.captureNativeDrag,'function');assert.equal(typeof shipped.previewNativeDrag,'function');
 const f=await fixture(t),c=await f.capture(),entry=f.api.nativeDrag.captures.get(c.captureId);
 const plan=shipped.previewNativeDrag(entry.context,{workflowId:'one',actions:[{kind:'reorder',parentId:null,index:0}]});assert.equal(plan.request.tabs.length,6);
});

test('native full tree mixes v1 aliases and v2 execution subjects without readdressing either family',async t=>{
 const f=await fixture(t,{legacy:true}),c=await f.capture('L',['L','C']),p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}]);
 const legacy=p.proposal.tabs.find(x=>x.tabId==='L');assert.equal(legacy.expected.namespace,'legacy');assert.equal(p.proposal.nativeScope.subjects.L.version,1);
 assert.equal(p.proposal.nativeScope.subjects.C.version,2);assert.equal(p.proposal.nativeScope.subjects.C.executionNamespace,NS);
 const before=f.rows(),response=await f.call(drag+'/commit','POST',p.commit);assert.equal(response.status,200,JSON.stringify({response,scope:p.proposal.nativeScope.subjects.L,row:before.find(x=>x.tab_id==='L')}));assert.deepEqual(f.rows(),before);
 const dto=(await f.call(base+'?projection=catalog-v1')).body;assert.equal(dto.executionRefs.L.namespace,'legacy');assert.ok(dto.executionRefs.L.aliases.some(x=>x.namespace==='legacy' && x.tabId==='L'));
});

test('new member or empty group in the painted workflow invalidates its full tree; unrelated group remains admissible',async t=>{
 for(const mode of ['member','empty-group','unrelated-group']){
  const f=await fixture(t),c=await f.capture(),p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}]);
  if(mode==='member')f.api.createTab({mutationId:'late-member',tabId:'late',workflowId:'one',cwd:f.root,record:{name:'Late'}});
  else await f.group('create',{metadata:{name:'Late group',reserveWorkflowId:mode==='empty-group'?'one':'two'}});
  const result=await f.call(drag+'/commit','POST',p.commit);
  if(mode==='unrelated-group')assert.equal(result.status,200,JSON.stringify(result));else error(result,'workflow_drag_inventory_changed');
 }
});

test('empty-group transfer does not rewrite a future group definition',async t=>{
 const f=await fixture(t),g=await f.group('create',{metadata:{name:'Empty',reserveWorkflowId:'one'}});
 const input=await f.input();input.sourceId='reserve-group:'+JSON.stringify([NS,g.groupId]);
 const c=(await f.call(drag+'/capture','POST',input)).body,p=await f.preview(c,[{kind:'reorder',parentId:null,index:0}],'two');
 const metadata=JSON.parse(f.db.prepare('SELECT metadata_json FROM workflow_global_groups WHERE group_id=?').get(g.groupId).metadata_json);
 f.db.prepare('UPDATE workflow_global_groups SET metadata_json=? WHERE group_id=?').run(JSON.stringify({...metadata,version:2,future:{keep:true}}),g.groupId);
 const before=f.api.read();error(await f.call(drag+'/commit','POST',p.commit),'workflow_group_metadata_version_unsupported');assert.deepEqual(f.api.read(),before);
});
