'use strict';
// Actual renderer compiler -> canonical Main -> private SQLite. No Electron app,
// renderer store, pointer input, provider, or production storage is started.
// Node 22 uses the existing builtin-SQLite adapter; Electron 28 Node-mode uses
// the installed better-sqlite3 ABI. Both execute the same Main transactions.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const mainRoot=process.env.NOTED_ROW_MAIN_ROOT || __dirname;
const pins=new Map(),mixed=new Set(),originalCompile=Module.prototype._compile;
function pin(filename,source) {
  if(!filename.startsWith(repo+'/src/')&&!filename.startsWith(repo+'/vendor/'))return;
  const digest=sha(source);if(pins.has(filename)&&pins.get(filename)!==digest)mixed.add(filename);pins.set(filename,digest);
}
Module.prototype._compile=function(source,filename){pin(filename,source);return originalCompile.call(this,source,filename);};
const electron=!!process.versions.electron;
assert.ok(electron ? process.versions.electron.startsWith('28.') : Number(process.versions.node.split('.')[0])>=22,
  'Run with Node 22+ builtin SQLite or Electron 28 ELECTRON_RUN_AS_NODE=1; never system Node 18');
const Database=electron?require('better-sqlite3'):require('./project-prompt-sqlite.test-support.cjs').NodeSqliteAdapter;
const DatabaseManager=require(path.join(mainRoot,'database'));
const {createWorkflowOrganizationApi}=require(path.join(mainRoot,'workflow-organization-api'));
const {stableJson}=require(path.join(mainRoot,'../shared/workflow-organization.cjs'));
const {paneStripColorGroupsBasis}=require(path.join(mainRoot,'../shared/pane-strip-color-groups.cjs'));
const {buildSync}=require('esbuild');
function bundled(relative) {
  const filename=path.resolve(__dirname,relative),outfile=path.join(__dirname,'__row-placement-fixture.cjs');
  const {outputFiles}=buildSync({entryPoints:[filename],outfile,bundle:true,platform:'node',format:'cjs',write:false,
    sourcemap:'external',logLevel:'silent',alias:{'@noted/structured-dnd':path.join(repo,'vendor/noted-shared/packages/structured-dnd/src')}});
  const map=JSON.parse(outputFiles.find(file=>file.path.endsWith('.map')).text);
  map.sources.forEach((file,index)=>pin(path.resolve(path.dirname(outfile),file),map.sourcesContent[index]));
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=module.paths;
  mod._compile(outputFiles.find(file=>file.path===outfile).text,filename+':bundle');
  // The bundle is not a disk source pin.
  pins.delete(filename+':bundle');
  return mod.exports;
}
const drag=bundled('../renderer/utils/workflowDragModel.mjs');
const {organizationProjection}=bundled('../renderer/utils/workflowOrganizationClient.mjs');
const clone=value=>JSON.parse(JSON.stringify(value)),outcomes=[];
const initialOrder=['Home','Portfolio','Guide','Notes'],placedOrder=['Home','Guide','Portfolio','Notes'];
const descriptor=(order,rowStartIds,width=420)=>({version:1,width,order:[...order],rowStartIds:[...rowStartIds]});
function fixture(t,{center=false,order=initialOrder,row=null}={}) {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  t.after(()=>{db.close();assert.equal(db.open,false);});
  const manager=new DatabaseManager({existingConnection:db});manager.initTables();
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P','/private-row-fixture','Private row fixture');
  for(const id of initialOrder)db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type,codex_session_id)
    VALUES('P',?,?,'/private-row-fixture','terminal','codex',?)`).run(id,id,'synthetic-'+id);
  const slots=order.map(tabId=>({projectId:'P',tabId})),shown={projectId:'P',tabId:'Home'};
  const layout={splitPanes:center?[]:[{windowId:'source',...shown,tabs:slots,width:420,height:300,
      ...(row?{stripRowPlacement:row}:{})}],centerStrips:center?{P:slots}:{},
    ...(center&&row?{centerStripRowPlacements:{P:row}}:{}),activeSpaceTab:shown,
    activeProjectId:'P',focusedProjectId:'P',splitFocusedIndex:0,splitSizes:[100],windowDisplayLayouts:{}};
  const api=createWorkflowOrganizationApi({database:manager,validateDirectory:()=>true});
  api.bootstrap({migrationId:'row:migration',mutationId:'row:publish',workspace:{activeSpaceId:'W',...layout,
    spaces:[{id:'W',name:'Rows',projectIds:['P'],layout}]}});
  let sequence=0;
  const workflow=()=>api.service.getWorkflow('W');
  const read=()=>{
    const persisted=JSON.parse(db.prepare("SELECT layout_json FROM workflow_org_workflows WHERE workflow_id='W'").get().layout_json);
    assert.deepEqual(clone(workflow().layout),persisted,'canonical API agrees with raw SQLite read');return persisted;
  };
  const flat=(layout=read())=>(center?layout.centerStrips.P:layout.splitPanes[0].tabs).map(slot=>slot.tabId);
  const placement=(layout=read())=>center?layout.centerStripRowPlacements?.P:layout.splitPanes[0].stripRowPlacement;
  const state=()=>{
    const projection=organizationProjection(api.read(),{activeSpaceId:'W'}),openProjects=new Map();
    for(const p of api.listNamespaces())openProjects.set(p.id,{...p,tabs:new Map(p.tabs.map(tab=>[tab.tabId,{...tab,id:tab.tabId}]))});
    return {...projection,openProjects};
  };
  // Full private database state, including generations, receipts, groups,
  // journal, memberships and execution rows, rather than just API projection.
  const sql=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>
    [name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>stableJson(row)).sort()]));
  const changes=()=>Number(db.prepare('SELECT total_changes() AS n').get().n);
  const execution=()=>clone(db.prepare('SELECT * FROM tabs ORDER BY id').all());
  const members=()=>clone(db.prepare('SELECT * FROM workflow_org_memberships ORDER BY tab_id').all());
  const baseline={execution:execution(),members:members()};
  const identity=()=>{assert.deepEqual(execution(),baseline.execution);assert.deepEqual(members(),baseline.members);};
  const save=next=>api.mutate('saveLayout',{mutationId:'row:save:'+ ++sequence,workflowId:'W',
    expectedRevision:api.service.getPublication().revision,expectedWorkflowRevision:workflow().revision,layout:next});
  const capture=({at=1,rowStartId='Portfolio',width=420,paneIndex=center?null:0}={})=>{
    const admission=drag.captureWorkflowDrag(state(),{gestureId:'row:drag:'+ ++sequence,origin:'pane',
      sourceId:'reserve-tab:Guide',sourcePaneKey:center?'center':'pane:0',entries:[{projectId:'P',tabId:'Guide'}]});
    assert.ok(admission);assert.equal(drag.workflowDragSourceValid(admission,state()),true);
    const request=drag.workflowDragRequest(admission,{workflowId:'W',target:{zone:'strip',
      paneKey:paneIndex===null?'center':'pane:'+paneIndex,paneIndex,at,rowStartId,stripWidth:width}});
    assert.ok(request);return {admission,request};
  };
  const accept=request=>{
    const frozen=stableJson(request),receipt=api.mutate('commitDrag',request);
    assert.equal(receipt.success,true);assert.deepEqual(api.getMutation(request.mutationId),receipt);
    assert.equal(stableJson(request),frozen,'compiler request remains immutable');return receipt;
  };
  const reject=(request,code)=>{
    const before=sql(),count=changes();
    assert.throws(()=>api.mutate('commitDrag',request),error=>error.code===code);
    assert.deepEqual(sql(),before,'rejection changes no SQL table, receipt, journal, generation or revision');
    assert.equal(changes(),count,'rejection performs no SQL writes');assert.equal(api.getMutation(request.mutationId),null);
  };
  const setRow=value=>{const next=read();if(center)next.centerStripRowPlacements={...next.centerStripRowPlacements,P:value};
    else next.splitPanes[0].stripRowPlacement=value;return save(next);};
  return {db,api,state,workflow,read,flat,placement,sql,changes,execution,identity,save,capture,accept,reject,setRow};
}
function record(name,fn) {
  test(name,t=>{const outcome={name,status:'FAIL'};outcomes.push(outcome);
    try{fn(t,outcome);outcome.status='PASS';}catch(error){outcome.error={code:error.code,message:error.message};throw error;}});
}
for(const center of [false,true]) {
  const surface=center?'legacy center':'window';
  record(surface+': Guide before Portfolio retains Guide row start through Main commit/read', (t,result)=>{
    const f=fixture(t,{center,row:descriptor(initialOrder,['Portfolio'])}),{request}=f.capture();
    const expected=descriptor(placedOrder,['Guide']);
    assert.deepEqual(f.placement(request.workflows.find(w=>w.workflowId==='W').layout),expected,'actual compiler projects row start');
    const revision=f.workflow().revision;result.receipt=f.accept(request);
    assert.deepEqual(f.flat(),placedOrder);assert.deepEqual(f.placement(),expected);assert.equal(f.workflow().revision,revision+1);f.identity();
    result.persisted=f.placement();
  });
  record(surface+': same flat order with different row intent persists a real workflow revision', (t,result)=>{
    const f=fixture(t,{center,order:placedOrder}),{request}=f.capture();
    assert.deepEqual(f.flat(request.workflows.find(w=>w.workflowId==='W').layout),f.flat());
    const revision=f.workflow().revision;result.receipt=f.accept(request);
    assert.deepEqual(f.flat(),placedOrder);assert.deepEqual(f.placement(),descriptor(placedOrder,['Guide']));
    assert.equal(f.workflow().revision,revision+1,'row-only intent must not be swallowed as an order no-op');f.identity();
  });
  record(surface+': newer same-order row metadata blocks stale drag without SQL writes', (t,result)=>{
    const f=fixture(t,{center,order:placedOrder}),{admission,request}=f.capture();
    const newer=descriptor(placedOrder,['Notes'],438);f.setRow(newer);
    assert.deepEqual(f.flat(),placedOrder);assert.equal(drag.workflowDragSourceValid(admission,f.state()),false);
    f.reject(request,'workflow_drag_destination_changed');assert.deepEqual(f.placement(),newer);f.identity();
    result.refusal='workflow_drag_destination_changed';result.sqlHash=sha(stableJson(f.sql()));
  });
  record(surface+': exact old receipt replay preserves newer valid row metadata without SQL writes', (t,result)=>{
    const f=fixture(t,{center}),{request}=f.capture(),original=f.accept(request);
    const newer=descriptor(placedOrder,['Notes'],438);f.setRow(newer);
    const before=f.sql(),count=f.changes(),frozen=stableJson(request);
    const replay=f.api.mutate('commitDrag',request);assert.deepEqual(replay,original);
    assert.deepEqual(f.sql(),before);assert.equal(f.changes(),count);assert.equal(stableJson(request),frozen);
    assert.deepEqual(f.placement(),newer);assert.deepEqual(f.flat(),placedOrder);f.identity();
    result.originalReceipt=original;result.replayReceipt=replay;result.persisted=f.placement();
  });
  record(surface+': unrelated concurrent resize and focus survive row commit', (t,result)=>{
    const f=fixture(t,{center}),{admission,request}=f.capture(),next=f.read();
    next.splitSizes=[73];next.splitFocusedIndex=7;next.focusedProjectId='focus-only';
    if(!center){next.splitPanes[0].width=615;next.splitPanes[0].height=777;next.splitPanes[0].tabId='Notes';}
    f.save(next);assert.equal(drag.workflowDragSourceValid(admission,f.state()),true);
    result.receipt=f.accept(request);const current=f.read();
    assert.deepEqual(current.splitSizes,[73]);assert.equal(current.splitFocusedIndex,7);assert.equal(current.focusedProjectId,'focus-only');
    if(!center){assert.equal(current.splitPanes[0].width,615);assert.equal(current.splitPanes[0].height,777);assert.equal(current.splitPanes[0].tabId,'Notes');}
    assert.deepEqual(f.flat(),placedOrder);assert.deepEqual(f.placement(),descriptor(placedOrder,['Guide']));f.identity();
  });
}
record('closed execution source refuses a frozen row command without SQL writes', (t,result)=>{
  const f=fixture(t),{request}=f.capture();
  assert.equal(f.db.prepare("UPDATE tabs SET execution_archived=1 WHERE tab_id='Guide'").run().changes,1);
  // Synthetic current closed flag only: not desktop Full Close/lifecycle acceptance.
  f.reject(request,'workflow_drag_source_missing');assert.deepEqual(f.flat(),initialOrder);
  result.refusal='workflow_drag_source_missing';
});
record('current strip color-group boundary still rejects moving Guide outside its group', (t,result)=>{
  const f=fixture(t),w=f.workflow();
  f.api.mutate('commitWorkspace',{mutationId:'row:group',expectedRevision:f.api.service.getPublication().revision,
    spaces:[{...w.metadata,id:w.id,kind:w.kind,layout:w.layout,
      stripColorGroups:{version:1,revision:1,groups:[{id:'GuidePortfolio',revision:1,color:'#123456',tabIds:['Portfolio','Guide']}]}}],
    tabWorkflowMembership:Object.fromEntries(f.api.service.listGlobalTabs().map(tab=>[tab.tabId,
      {...tab.membership,expectedMembershipRevision:tab.membership.revision}])),
    stripColorGroupEdits:[{workflowId:'W',basis:paneStripColorGroupsBasis(w.metadata.stripColorGroups)}]});
  const {request}=f.capture({at:3,rowStartId:null});
  f.reject(request,'workflow_drag_strip_group_changed');assert.deepEqual(f.flat(),initialOrder);f.identity();
  result.refusal='workflow_drag_strip_group_changed';
});
after(()=>{
  Module.prototype._compile=originalCompile;
  const sources=[...pins].sort(([a],[b])=>a.localeCompare(b)).map(([filename,sha256])=>({path:filename,sha256,
    unchangedAtEnd:fs.existsSync(filename)&&sha(fs.readFileSync(filename))===sha256}));
  const drift=sources.filter(source=>!source.unchangedAtEnd).map(source=>source.path);
  const result={status:drift.length||mixed.size?'SOURCE_DRIFT':outcomes.every(row=>row.status==='PASS')?'PASS':'FAIL',
    runtime:{node:process.versions.node,electron:process.versions.electron||null,execPath:process.execPath,
      sqlite:electron?'better-sqlite3':'NodeSqliteAdapter/node:sqlite'},
    counts:{tests:outcomes.length,passed:outcomes.filter(row=>row.status==='PASS').length,failed:outcomes.filter(row=>row.status==='FAIL').length},
    results:outcomes,sourceDrift:drift,mixedSourceVersions:[...mixed],sources,
    testSHA256:sha(fs.readFileSync(__filename)),boundaries:['private in-memory SQLite; actual Main API/schema/transactions',
      'actual workflowDragModel compiler bundled in memory using existing fixture alias',
      'synthetic records and directory validation; closed control is synthetic SQL archive flag',
      'no UI/app/build/native gestures/provider/Browser; no parent implementation edits']};
  if(process.env.NOTED_ROW_PLACEMENT_EVIDENCE) {
    const directory=process.env.NOTED_ROW_PLACEMENT_EVIDENCE;
    assert.equal(fs.realpathSync(directory),'/private/tmp/noted-terminal-incident-20261019-1108.2vBlv9/source4196/row-placement-repair-20261020/main-controls');
    const label=electron?'electron28':'node22';
    fs.writeFileSync(path.join(directory,label+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  }
  assert.deepEqual(drift,[],'source edited during run; results cannot be attributed to one current source');
  assert.deepEqual([...mixed],[],'two compiler/Main versions loaded during run');
});
