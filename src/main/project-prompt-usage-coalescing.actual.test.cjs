'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// The packaged-engine arm uses the real Electron/better-sqlite3 ABI; the Node
// arm uses builtin SQLite in private files. Neither starts an app or provider.
const FixtureSqlite=process.versions.electron?require('better-sqlite3'):require('./project-prompt-sqlite.test-support.cjs').NodeSqliteAdapter;
const {WorkflowRootRegistry}=require('./workflow-root-registry');
const {ProjectPromptCatalogService}=require('./project-prompt-catalog');
const {causal}=require('./perf-causal-context');
const support=require('./project-prompt-catalog.test-support.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('external unrelated commits retain certified SQL owners while each recipient still observes physical sources',async t=>{
 const f=fixture(t,700,{certified:true});
 f.db.exec('CREATE TABLE history_noise(value INTEGER); ALTER TABLE workflow_org_tabs ADD COLUMN record_json TEXT; ALTER TABLE workflow_org_workflows ADD COLUMN layout_json TEXT');
 const initial=await support.usage(f.service,f.root),before={...f.counts},fence=f.registry.captureCatalogFence();
 const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));
 try {
  for(let i=0;i<4;i++) {
   other.prepare('INSERT INTO history_noise VALUES(?)').run(i);
   other.prepare('UPDATE tabs SET name=?').run('Unrelated visible name'+i);
   other.prepare('UPDATE workflow_org_tabs SET record_json=?,execution_json=?').run('{"busy":true}',JSON.stringify({executionNamespace:'P',model:'model'+i}));
   other.prepare('UPDATE workflow_org_workflows SET layout_json=?').run(JSON.stringify({visit:i}));
   const now=f.registry.captureCatalogFence();assert.notEqual(now.external,fence.external);assert.equal(now.changes,fence.changes);
   assert.deepEqual(await f.service.usageForRoot(f.root),initial);
   await f.service.prepared.reconcile();
  }
  assert.equal(f.counts.headers-before.headers,0,'an external noncatalog commit must not rebuild every tab header');
  assert.ok(f.counts.sourceProbes-before.sourceProbes>=16);assert.ok(f.counts.layouts-before.layouts>=8);
  assert.ok(f.counts.leafRealpaths-before.leafRealpaths>=12);
  console.log('[CatalogExternalOwnershipWork] '+JSON.stringify({tabs:700,reads:4,headers:0,
   sourceProbes:f.counts.sourceProbes-before.sourceProbes,layouts:f.counts.layouts-before.layouts,
   leafRealpaths:f.counts.leafRealpaths-before.leafRealpaths}));
 }finally{other.close();}
});

test('external catalog commits still replace certified owners and expose forward-version errors',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);
 const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));
 try {
  const before=f.registry.captureCatalogFence();other.prepare('UPDATE projects SET name=?,icon=?').run('External project','external-icon');
  assert.notEqual(f.registry.captureCatalogFence().changes,before.changes);
  let rows=await f.service.usageForRoot(f.root);assert.deepEqual(rows[0].projects,[{id:'P',name:'External project',icon:'external-icon'}]);
  other.prepare('DELETE FROM workflow_org_memberships WHERE tab_id=?').run('t-0000');
  rows=await f.service.usageForRoot(f.root);assert.deepEqual(rows[0].tabs.map(x=>x.id),['t-0001','t-0002']);
  other.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run('{}');
  assert.deepEqual(await f.service.usageForRoot(f.root),[]);
  other.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run('{"promptDirectories":[{}]}');
  await assert.rejects(f.service.usageForRoot(f.root),{code:'workflow_directory_forward_version'});
 }finally{other.close();}
});

test('external unknown schema/epoch cannot borrow a previously certified owner projection',async t=>{
 for(const mode of ['unknown-trigger','future-row'])await t.test(mode,async t=>{
  const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);const before=f.counts.headers;
  const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));
  try {
   if(mode==='unknown-trigger')other.exec('DROP TRIGGER noted_catalog_epoch_tabs_update; CREATE TRIGGER noted_catalog_epoch_tabs_update AFTER UPDATE ON tabs BEGIN SELECT 1; END');
   else other.prepare('UPDATE noted_prompt_catalog_read_epoch SET version=99').run();
   other.prepare('UPDATE projects SET name=?').run('Uncertified external');
   const rows=await f.service.usageForRoot(f.root);assert.equal(rows[0].projects[0].name,'Uncertified external');
   assert.ok(f.counts.headers>before);assert.equal(f.service.prepared.usageInventory,null);
  }finally{other.close();}
 });
});

test('an external catalog commit after recipient settle cannot publish the prior retained owner',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);
 const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));let changed=false;
 causal.configure({enabled:true,sink:event=>{if(!changed&&event.phase==='settle'&&event.name==='catalog.usageForRoot'){
  changed=true;other.prepare('UPDATE projects SET name=?').run('Late external project');
 }return true;}});
 try{const rows=await f.service.usageForRoot(f.root);assert.ok(changed);assert.equal(rows[0].projects[0].name,'Late external project');}
 finally{causal.configure({enabled:false});other.close();}
});

test('watcher topology checks reuse certified owners while still probing physical directories', async t => {
 const f=fixture(t,32);f.registry.prepareCatalogReadEpoch();await support.usage(f.service,f.root);
 const p=f.service.prepared,stat=p.fs.stat;let probes=0;
 p.fs.stat=async(...args)=>{probes++;return stat(...args);};
 const before=f.counts.headers;
 for(let i=0;i<3;i++)await p.reconcile();
 assert.equal(f.counts.headers-before,0,'unchanged consumer SQL must not be rebuilt for every watcher topology event');
 assert.ok(probes>=12,'each topology check still makes fresh physical observations');
 fs.renameSync(path.join(f.a,'docs'),path.join(f.a,'docs-old'));fs.mkdirSync(path.join(f.a,'docs'));
 fs.writeFileSync(path.join(f.a,'docs','new.prompt.md'),'own fresh physical fixture');
 await p.reconcile();assert.equal(p.slots.get(f.a).state,'preparing');
 const rows=await support.usage(f.service,f.a);assert.deepEqual(rows.map(r=>path.basename(r.path)),['new.prompt.md']);
 f.db.prepare('DELETE FROM workflow_org_memberships WHERE tab_id=?').run('t-0000');
 await p.reconcile();assert.ok(!p.slots.get(f.a).tabIds.has('t-0000'));
 f.db.prepare('UPDATE noted_prompt_catalog_read_epoch SET version=99').run();const fallback=f.counts.headers;
 await p.reconcile();assert.ok(f.counts.headers>fallback,'uncertified epoch retains full fresh SQL reconciliation');
});

test('physical preparation never repeats an unchanged certified SQL ownership assembly', async t => {
 const f=fixture(t,32); f.registry.prepareCatalogReadEpoch(); await support.usage(f.service,f.root);
 const p=f.service.prepared,open=p.fs.opendir;let enter,release,held=false;
 const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});t.after(()=>release());
 p.fs.opendir=async dir=>{if(!held&&dir===path.join(f.a,'docs')){held=true;enter();await gate;}return open(dir);};
 f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Fresh SQL owners','P');
 p.markDirty(p.slots.get(f.a),'own-held-source');
 const first=assert.rejects(f.service.usageForRoot(f.root),e=>['prompt_catalog_preparing','prompt_catalog_changed'].includes(e.code));
 await entered;await first;const before=f.counts.headers;
 for(let i=0;i<3;i++)await assert.rejects(f.service.usageForRoot(f.root),e=>['prompt_catalog_preparing','prompt_catalog_changed'].includes(e.code));
 assert.equal(f.counts.headers-before,0,'a preparing source must not force the same SQL owners through every tab again');
 assert.equal(p.slots.get(f.a).state,'preparing','retained SQL owners never grant physical readiness');
 release();const rows=await support.usage(f.service,f.root);
 assert.equal(rows.length,3);for(const row of rows){assert.equal(row.tabs.length,32);assert.equal(row.projects[0].name,'Fresh SQL owners');}
});
function fixture(t,n=32,{certified=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'catalog-usage-flight-'))),a=path.join(root,'a'),b=path.join(root,'b');
 for(const dir of [a,b]){fs.mkdirSync(path.join(dir,'docs','nested'),{recursive:true});fs.writeFileSync(path.join(dir,'docs','one.prompt.md'),'own synthetic fixture');}
 fs.writeFileSync(path.join(a,'docs','nested','two.prompt.md'),'own synthetic fixture');
 const db=new FixtureSqlite(path.join(root,'private.sqlite'));
 db.exec(`CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,project_id TEXT,execution_namespace TEXT,name TEXT);
  CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT);
  CREATE TABLE workflow_org_memberships(tab_id TEXT PRIMARY KEY,workflow_id TEXT);
  CREATE TABLE workflow_org_workflows(workflow_id TEXT PRIMARY KEY,metadata_json TEXT,deleted_generation INTEGER);
  CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,icon TEXT,updated_at INTEGER);
  INSERT INTO projects VALUES('P','Project',NULL,NULL,1);`);
 const database={db,getProjectById:id=>database.db.prepare('SELECT * FROM projects WHERE id=?').get(id)};
 const registry=new WorkflowRootRegistry(database);
 db.prepare('INSERT INTO workflow_org_workflows VALUES(?,?,NULL)').run('W',JSON.stringify({defaultCwd:a,promptDirectories:[b]}));
 db.transaction(()=>{for(let i=0;i<n;i++){const id='t-'+String(i).padStart(4,'0');
  db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run(id,'P','P',id);
  db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?)').run(id,JSON.stringify({executionNamespace:'P'}));
  db.prepare('INSERT INTO workflow_org_memberships VALUES(?,?)').run(id,'W');
  db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1)').run('tab:'+id);
 }})();
 if(certified)assert.equal(registry.prepareCatalogReadEpoch(),true);
 const counts={headers:0,body:0,scans:0,prepares:0,gets:0,sourceProbes:0,leafRealpaths:0,layouts:0},original=registry.readTabHeader.bind(registry);
 const prepare=db.prepare.bind(db);db.prepare=sql=>{counts.prepares++;const statement=prepare(sql),get=statement.get.bind(statement);statement.get=(...args)=>{counts.gets++;return get(...args);};return statement;};
 registry.readTabHeader=(...args)=>{counts.headers++;return original(...args);};
 const asyncFs={...fs.promises,opendir:(...args)=>{counts.scans++;return fs.promises.opendir(...args);},
  stat:(...args)=>{counts.sourceProbes++;return fs.promises.stat(...args);},
  realpath:(file,...args)=>{if(file.endsWith('.prompt.md'))counts.leafRealpaths++;return fs.promises.realpath(file,...args);}};
 const layouts=new Map(),layoutStore={get:root=>{counts.layouts++;return layouts.get(root)||{layout:{}};}};
 const service=new ProjectPromptCatalogService({db:database,rootRegistry:registry,asyncFs,layoutStore,watch:false});
 t.after(()=>{service.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
 return{root,a,b,db,database,registry,service,counts,n,layouts};
}
test('certified later reads retain one SQL ownership inventory while every recipient observes current sources and leaves',async t=>{
 const f=fixture(t,32,{certified:true});await support.usage(f.service,f.root);
 const before={...f.counts};
 const values=[];for(const root of [f.a,f.b,f.root,f.a])values.push(await f.service.usageForRoot(root));
 assert.deepEqual(values.map(rows=>rows.length),[2,1,3,2]);
 assert.equal(f.counts.headers-before.headers,0,'certified independent reads must not repeat all-tab header assembly');
 assert.equal(f.counts.scans,before.scans);
 assert.ok(f.counts.sourceProbes-before.sourceProbes>=16,'each recipient still probes every configured root/docs');
 assert.ok(f.counts.layouts-before.layouts>=8,'each recipient still reads exact source layouts');
 assert.ok(f.counts.leafRealpaths-before.leafRealpaths>=12,'physical leaves are request-local observations');
 values[0][0].tabs[0].name='foreign';values[0][0].projects[0].name='foreign';
 assert.notEqual(values[3][0].tabs[0].name,'foreign');assert.equal(values[3][0].projects[0].name,'Project');
 console.log('[CatalogRetainedUsageWork] '+JSON.stringify({independentReads:4,tabs:f.n,
  headers:f.counts.headers-before.headers,sourceProbes:f.counts.sourceProbes-before.sourceProbes,
  layouts:f.counts.layouts-before.layouts,leafRealpaths:f.counts.leafRealpaths-before.leafRealpaths}));
});
test('concurrent retained roots share one complete authoritative inventory instead of one all-tabs pass per root',async t=>{
 const f=fixture(t);await support.tab(f.service,'t-0000');f.counts.headers=0;const scans=f.counts.scans;
 const roots=[f.a,f.b,path.join(f.a,'docs','nested'),f.root,f.a,f.b];
 const values=await Promise.all(roots.map(root=>f.service.usageForRoot(root)));
 assert.deepEqual(values.map(v=>v.length),[2,1,1,3,2,1]);
 for(const rows of values)for(const row of rows){assert.equal(row.tabs.length,f.n);assert.deepEqual(row.projects,[{id:'P',name:'Project',icon:null}]);}
 assert.ok(f.counts.headers<=f.n*2+2,'six simultaneous roots must not rebuild/revalidate all scope headers six times: '+f.counts.headers);
 assert.equal(f.counts.scans,scans,'no repeated physical metadata scan');
 values[0][0].tabs.push({id:'foreign'});values[0][0].projects[0].name='foreign';
 assert.equal(values[4][0].tabs.length,f.n);assert.equal(values[4][0].projects[0].name,'Project');
 console.log('[CatalogUsageWork] '+JSON.stringify({requests:roots.length,tabs:f.n,headers:f.counts.headers,scans:f.counts.scans-scans}));
});
test('statement reuse keeps every fresh fence read while avoiding four new SQL statements per header',t=>{
 const f=fixture(t,1),reader=f.registry.createSourcesReader();f.counts.prepares=0;f.counts.gets=0;
 for(let i=0;i<64;i++)assert.equal(reader.header('t-0000').workflowSources.length,2);
 assert.ok(f.counts.prepares<=12,'prepared fence ports must be reused, not authoritative row values: '+f.counts.prepares);
 assert.ok(f.counts.gets>=64*8,'all current SQL/version reads still execute');
 f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=? WHERE workflow_id=?').run(JSON.stringify({defaultCwd:f.b}),'W');
 assert.deepEqual(reader.header('t-0000').workflowSources.map(row=>row.path),[f.b]);
 f.db.exec('ALTER TABLE workflow_org_workflows ADD COLUMN replacement INTEGER');
 assert.equal(reader.header('t-0000').workflowSources[0].path,f.b);
});
test('a later independent read observes exact binding, project name and explicit-empty changes',async t=>{
 const f=fixture(t,3);await support.usage(f.service,f.root);
 f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Renamed','P');
 f.db.prepare('DELETE FROM workflow_org_memberships WHERE tab_id=?').run('t-0000');
 const value=await f.service.usageForRoot(f.a);
 assert.equal(value[0].tabs.length,2);assert.equal(value[0].projects[0].name,'Renamed');
 assert.ok(!value[0].tabs.some(row=>row.id==='t-0000'));
});
test('a joined result cannot outlive source invalidation, close or same-path replacement',async t=>{
 const f=fixture(t,3);await support.tab(f.service,'t-0000');
 let once=false;f.service.prepared.controlOptions={maxSteps:1,schedule:async()=>{await tick();if(!once){once=true;f.db.prepare('DELETE FROM workflow_org_memberships').run();}}};
 const values=await Promise.all([f.service.usageForRoot(f.a),f.service.usageForRoot(f.root)]);
 assert.deepEqual(values,[[],[]]);assert.ok(once);
 f.service.close();await assert.rejects(f.service.prepared.usage(f.root),{code:'prompt_catalog_unavailable'});
});
test('late source-only invalidation after recipient diagnostics cannot publish a stale shared inventory',async t=>{
 const f=fixture(t,3);await support.tab(f.service,'t-0000');let changed=false;
 causal.configure({enabled:true,sink:event=>{
  if(!changed&&event.phase==='settle'&&event.name==='catalog.usageForRoot'){
   changed=true;fs.unlinkSync(path.join(f.a,'docs','one.prompt.md'));
   fs.writeFileSync(path.join(f.a,'docs','replacement.prompt.md'),'new own fixture');
   f.service.invalidateTabs(null,'filesystem');
  }return true;
 }});
 try{const rows=await support.usage(f.service,f.a);
  assert.ok(changed);assert.ok(rows.some(row=>row.path.endsWith('/replacement.prompt.md')));
  assert.ok(!rows.some(row=>row.path.endsWith('/one.prompt.md')));
 }finally{causal.configure({enabled:false});}
});
for(const certified of [false,true])test('a DB change while inventory is pending cannot multiply all-tabs readers for later recipients; certified='+certified,async t=>{
 const f=fixture(t,8,{certified});await support.tab(f.service,'t-0000');
 const prep=f.service.prepared,originalScopes=prep.scopes.bind(prep),originalSnapshot=prep.usageSnapshot.bind(prep);
 let enter,release,second,first=true,active=0,peak=0,invocations=0;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;}),joined=new Promise(resolve=>{second=resolve;});
 t.after(()=>release());
 prep.scopes=async(...args)=>{active++;peak=Math.max(peak,active);try{if(first){first=false;enter();await held;}return await originalScopes(...args);}finally{active--;}};
 prep.usageSnapshot=(...args)=>{const result=originalSnapshot(...args);if(++invocations===2)second();return result;};
 const a=f.service.usageForRoot(f.a);await entered;
 f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Newest','P');
 const b=f.service.usageForRoot(f.b);await joined;
 release();const values=await Promise.all([a,b]);
 assert.equal(peak,1,'a pending read already owns revalidation; changed hints must not admit another global reader');
 for(const rows of values)assert.equal(rows[0].projects[0].name,'Newest');
});
test('recipient leaf canonical proof is fresh after the shared inventory settles, not authority from another read',async t=>{
 const f=fixture(t,2);await support.tab(f.service,'t-0000');
 const leaf=path.join(f.a,'docs','one.prompt.md'),original=f.service.prepared.fs.realpath;
 let inventorySettled=false;
 f.service.prepared.fs.realpath=async p=>p===leaf&&!inventorySettled?path.join(f.b,'outside.prompt.md'):original(p);
 causal.configure({enabled:true,sink:event=>{if(event.phase==='settle'&&event.name==='catalog.usageInventory')inventorySettled=true;return true;}});
 try{const rows=await f.service.usageForRoot(f.a);assert.ok(inventorySettled);
  assert.ok(rows.some(row=>row.path===leaf),'a final recipient must observe the current leaf/alias resolution');
 }finally{causal.configure({enabled:false});}
});
test('usage does not materialize per-tab authoring prompt DTOs that its response never exposes',async t=>{
 const f=fixture(t);await support.tab(f.service,'t-0000');
 let materialized=0;const original=f.service.prepared.catalog.bind(f.service.prepared);
 f.service.prepared.catalog=async(...args)=>{const value=await original(...args);materialized+=value.prompts.length;return value;};
 const rows=await f.service.usageForRoot(f.root);
 assert.equal(rows.length,3);for(const row of rows)assert.equal(row.tabs.length,f.n);
 assert.equal(materialized,0,'usage needs shared paths/owners, not cloned content/id/file_paths records for every tab');
});
for(const certified of [false,true])test('overlapping configured roots retain global scope order and exact combined ownership; certified='+certified,async t=>{
 const f=fixture(t,3,{certified}),nested=path.join(f.a,'docs','nested');
 fs.mkdirSync(path.join(nested,'docs'),{recursive:true});const shared=path.join(nested,'docs','shared.prompt.md');fs.writeFileSync(shared,'own fixture');
 f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=? WHERE workflow_id=?').run(JSON.stringify({defaultCwd:f.a}),'W');
 f.db.prepare('INSERT INTO workflow_org_workflows VALUES(?,?,NULL)').run('nested',JSON.stringify({defaultCwd:nested}));
 f.db.prepare('UPDATE workflow_org_memberships SET workflow_id=? WHERE tab_id=?').run('nested','t-0001');
 f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Same','P');
 for(const [index,id]of [[1,'Q'],[2,'R']]){
  f.db.prepare('INSERT INTO projects VALUES(?,?,NULL,NULL,1)').run(id,'Same');
  f.db.prepare('UPDATE tabs SET project_id=?,execution_namespace=? WHERE tab_id=?').run(id,id,'t-000'+index);
  f.db.prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?').run(JSON.stringify({executionNamespace:id}),'t-000'+index);
 }
 const rows=await support.usage(f.service,f.a),row=rows.find(x=>x.path===shared);
 assert.deepEqual(row.tabs.map(x=>x.id),['t-0000','t-0001','t-0002']);
 assert.deepEqual(row.projects,[{id:'P',name:'Same',icon:null},{id:'Q',name:'Same',icon:null},{id:'R',name:'Same',icon:null}]);
 if(certified){const headers=f.counts.headers;assert.deepEqual(await f.service.usageForRoot(f.a),rows);assert.equal(f.counts.headers,headers);}
});
test('continuous unrelated History writes do not make a stable catalog unreadable',async t=>{
 const f=fixture(t,8);await support.tab(f.service,'t-0000');
 f.db.exec('CREATE TABLE history_noise(value INTEGER)');f.registry.prepareCatalogReadEpoch?.();let writes=0;
 f.service.prepared.controlOptions={maxSteps:8,schedule:async()=>{await tick();f.db.prepare('INSERT INTO history_noise VALUES(?)').run(++writes);}};
 const rows=await f.service.usageForRoot(f.a);
 assert.equal(rows.length,2);assert.equal(rows[0].tabs.length,8);assert.ok(writes>5);
});
test('real source changes still re-pass authority while unrelated History writes continue',async t=>{
 const f=fixture(t,8);await support.tab(f.service,'t-0000');
 f.db.exec('CREATE TABLE history_noise(value INTEGER)');f.registry.prepareCatalogReadEpoch?.();let writes=0,changed=false;
 f.service.prepared.controlOptions={maxSteps:8,schedule:async()=>{await tick();f.db.prepare('INSERT INTO history_noise VALUES(?)').run(++writes);
  if(!changed){changed=true;f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=? WHERE workflow_id=?').run(JSON.stringify({promptDirectories:[]}),'W');}
 }};
 assert.deepEqual(await f.service.usageForRoot(f.a),[]);assert.ok(changed);assert.ok(writes>2);
});
test('700-tab retained inventory survives unrelated History/name/model/layout writes without all-tab work',async t=>{
 const f=fixture(t,700,{certified:true});
 f.db.exec('CREATE TABLE history_noise(value INTEGER); ALTER TABLE workflow_org_tabs ADD COLUMN record_json TEXT; ALTER TABLE workflow_org_workflows ADD COLUMN layout_json TEXT');
 await support.usage(f.service,f.root);const before={...f.counts};
 f.db.prepare('INSERT INTO history_noise VALUES(1)').run();
 f.db.prepare('UPDATE tabs SET name=?').run('Presentation name');
 f.db.prepare('UPDATE workflow_org_tabs SET record_json=?,execution_json=?').run('{"busy":true}','{"executionNamespace":"P","model":"different"}');
 f.db.prepare('UPDATE workflow_org_workflows SET layout_json=?').run('{"windows":[]}');
 for(const root of [f.a,f.b,f.root]){const rows=await f.service.usageForRoot(root);assert.equal(rows[0].tabs.length,700);assert.equal(rows[0].tabs[0].name,'t-0000');}
 assert.equal(f.counts.headers-before.headers,0);assert.equal(f.counts.scans-before.scans,0);
 console.log('[CatalogRetained700Work] '+JSON.stringify({tabs:700,independentReads:3,headers:0,
  sourceProbes:f.counts.sourceProbes-before.sourceProbes,leafRealpaths:f.counts.leafRealpaths-before.leafRealpaths}));
});
test('every SQL ownership input invalidates certified metadata including direct writes without notify',async t=>{
 const cases=[
  ['namespace',f=>{f.db.prepare('INSERT INTO projects VALUES(?,?,NULL,NULL,1)').run('Q','Other');},
   f=>f.db.prepare('UPDATE tabs SET execution_namespace=? WHERE tab_id=?').run('Q','t-0000'),
   rows=>assert.deepEqual(rows[0].projects.map(p=>p.id),['Q','P'])],
  ['execution-json',f=>{f.db.prepare('UPDATE tabs SET execution_namespace=NULL,project_id=NULL').run();f.db.prepare('INSERT INTO projects VALUES(?,?,NULL,NULL,1)').run('Q','Other');},
   f=>f.db.prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?').run('{"projectId":"Q"}','t-0000'),
   rows=>assert.deepEqual(rows[0].projects.map(p=>p.id),['Q','P'])],
  ['project-name',()=>{},f=>f.db.prepare('UPDATE projects SET name=?,icon=? WHERE id=?').run('Renamed','own-icon','P'),
   rows=>assert.deepEqual(rows[0].projects,[{id:'P',name:'Renamed',icon:'own-icon'}])],
  ['workflow-directories',()=>{},f=>f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run(JSON.stringify({defaultCwd:f.b})),
   rows=>assert.equal(rows.length,1)],
  ['explicit-empty',()=>{},f=>f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run('{"promptDirectories":[]}'),
   rows=>assert.deepEqual(rows,[])],
  ['membership-delete',()=>{},f=>f.db.prepare('DELETE FROM workflow_org_memberships WHERE tab_id=?').run('t-0000'),
   rows=>assert.deepEqual(rows[0].tabs.map(x=>x.id),['t-0001'])],
  ['deleted-workflow',()=>{},f=>f.db.prepare('UPDATE workflow_org_workflows SET deleted_generation=2').run(),
   rows=>assert.deepEqual(rows,[])],
  ['scope-delete',()=>{},f=>f.db.prepare('DELETE FROM workflow_root_scope_meta WHERE scope=?').run('tab:t-0000'),
   rows=>assert.deepEqual(rows[0].tabs.map(x=>x.id),['t-0001'])],
  ['binding',f=>{f.db.prepare('DELETE FROM workflow_org_memberships').run();f.db.prepare('INSERT INTO workflow_roots VALUES(?,?,?,1,0)').run('R',f.a,'{"enabled":true}');},
   f=>f.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:t-0000','R','{}'),
   rows=>assert.deepEqual(rows[0].tabs.map(x=>x.id),['t-0000'])],
  ['root-path',f=>{f.db.prepare('DELETE FROM workflow_org_memberships').run();f.db.prepare('INSERT INTO workflow_roots VALUES(?,?,?,1,0)').run('R',f.a,'{"enabled":true}');f.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:t-0000','R','{}');},
   f=>f.db.prepare('UPDATE workflow_roots SET path=? WHERE id=?').run(f.b,'R'),
   rows=>assert.equal(rows.length,1)],
 ];
 for(const [name,setup,mutate,check]of cases)await t.test(name,async t=>{
  const f=fixture(t,2,{certified:true});setup(f);await support.usage(f.service,f.root);const headers=f.counts.headers;
  mutate(f);const rows=await support.usage(f.service,f.root);check(rows);
  assert.ok(f.counts.headers>headers||name==='scope-delete','source mutation rebuilds the all-scope projection');
  const after=f.counts.headers;await f.service.usageForRoot(f.root);assert.equal(f.counts.headers,after,'new healthy epoch can retain only its own inventory');
 });
});
test('uncertified/missing/future/unknown-trigger fences and fake authority labels never retain',async t=>{
 for(const mode of ['unprepared','missing','future','unknown-trigger','fake-label','spoofed-registry-label'])await t.test(mode,async t=>{
  const f=fixture(t,3,{certified:mode!=='unprepared'});await support.usage(f.service,f.root);
  if(mode==='missing')f.db.prepare('DELETE FROM noted_prompt_catalog_read_epoch').run();
  if(mode==='future')f.db.prepare('UPDATE noted_prompt_catalog_read_epoch SET version=99').run();
  if(mode==='unknown-trigger')f.db.exec('DROP TRIGGER noted_catalog_epoch_tabs_update; CREATE TRIGGER noted_catalog_epoch_tabs_update AFTER UPDATE ON tabs BEGIN SELECT 1; END');
  if(mode==='fake-label')f.service.prepared.authorityFence=()=>({...f.registry.captureCatalogFence(),authoritySource:'catalog-read-epoch-v1'});
  if(mode==='spoofed-registry-label'){
   f.db.prepare('DELETE FROM noted_prompt_catalog_read_epoch').run();const original=f.registry.captureCatalogFence.bind(f.registry);
   f.registry.captureCatalogFence=()=>({...original(),authoritySource:'catalog-read-epoch-v1'});
  }
  for(let i=0;i<2;i++){const before=f.counts.headers;await f.service.usageForRoot(f.a);assert.ok(f.counts.headers>before);assert.equal(f.service.prepared.usageInventory,null);}
 });
});
test('schema/connection drift rebuilds; transaction reads cannot borrow certified metadata',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);
 let before=f.counts.headers;f.db.exec('CREATE TABLE unrelated_ddl(value INTEGER)');await f.service.usageForRoot(f.root);assert.ok(f.counts.headers>before);
 before=f.counts.headers;await f.service.usageForRoot(f.root);assert.equal(f.counts.headers,before);
 let pending;f.db.transaction(()=>{pending=f.service.usageForRoot(f.root);})();
 await assert.rejects(pending,{code:'prompt_catalog_changed'});
 const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));try{
  f.database.db=other;before=f.counts.headers;
  await f.service.usageForRoot(f.root);assert.ok(f.counts.headers>before);assert.equal(f.service.prepared.usageInventory,null);
  assert.equal(f.registry.prepareCatalogReadEpoch(),true);await f.service.usageForRoot(f.root);
  before=f.counts.headers;await f.service.usageForRoot(f.root);assert.equal(f.counts.headers,before);
 }finally{f.database.db=f.db;other.close();}
});
test('same certified SQL epoch observes source/layout/leaf changes without delivered watcher notifications',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);const headers=f.counts.headers;
 const replacement=path.join(f.a,'docs','replacement.prompt.md');
 fs.unlinkSync(path.join(f.a,'docs','one.prompt.md'));fs.writeFileSync(replacement,'own replacement');
 let rows=await support.usage(f.service,f.a);
 assert.ok(rows.some(x=>x.path===replacement));assert.ok(!rows.some(x=>x.path.endsWith('/one.prompt.md')));
 const slot=f.service.prepared.slots.get(f.a),stamp=slot.snapshot.layoutStamp,scans=f.counts.scans;
 f.layouts.set(f.a,{revision:2,layout:{orderByParent:{[path.join(f.a,'docs')]:[replacement]}}});
 rows=await support.usage(f.service,f.a);assert.notEqual(slot.snapshot.layoutStamp,stamp);assert.ok(f.counts.scans>scans);
 const leaf=path.join(f.a,'docs','nested','two.prompt.md');
 fs.unlinkSync(leaf);fs.symlinkSync(path.join(f.b,'docs','one.prompt.md'),leaf);
 assert.ok(!(await f.service.usageForRoot(f.a)).some(x=>x.path===leaf));
 assert.ok((await f.service.usageForRoot(f.b)).some(x=>x.path===leaf),'new physical leaf target is observed per recipient');
 assert.equal(f.counts.headers,headers,'FS invalidation does not need to reassemble unchanged SQL owners');
});
test('configured alias retarget without notification observes new physical source and keeps spelling',async t=>{
 const f=fixture(t,2,{certified:true}),alias=path.join(f.root,'configured-alias');fs.symlinkSync(f.a,alias,'dir');
 f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run(JSON.stringify({defaultCwd:alias}));
 const original=await support.usage(f.service,alias);assert.equal(original.length,2);const headers=f.counts.headers;
 fs.unlinkSync(alias);fs.symlinkSync(f.b,alias,'dir');
 const rows=await support.usage(f.service,alias);assert.equal(rows.length,1);assert.equal(rows[0].path,path.join(alias,'docs','one.prompt.md'));
 assert.equal(f.counts.headers,headers);
});
test('a later recipient observes unnotified FS change after shared inventory diagnostic settle',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);let changed=false;
 const replacement=path.join(f.a,'docs','new.prompt.md');
 causal.configure({enabled:true,sink:event=>{if(!changed&&event.phase==='settle'&&event.name==='catalog.usageInventory'){
  changed=true;fs.unlinkSync(path.join(f.a,'docs','one.prompt.md'));fs.writeFileSync(replacement,'own fixture');
 }return true;}});
 try{const rows=await support.usage(f.service,f.a);assert.ok(changed);assert.ok(rows.some(x=>x.path===replacement));assert.ok(!rows.some(x=>x.path.endsWith('/one.prompt.md')));}
 finally{causal.configure({enabled:false});}
});
test('certified late diagnostic SQL mutation still re-passes exact authority',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);let changed=false;
 causal.configure({enabled:true,sink:event=>{if(!changed&&event.phase==='settle'&&event.name==='catalog.usageForRoot'){
  changed=true;f.db.prepare('UPDATE projects SET name=?').run('After diagnostic');
 }return true;}});
 try{const rows=await f.service.usageForRoot(f.a);assert.ok(changed);assert.equal(rows[0].projects[0].name,'After diagnostic');}
 finally{causal.configure({enabled:false});}
});
test('late diagnostic connection replacement cannot publish the previous certified projection',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);
 const other=new FixtureSqlite(path.join(f.root,'private.sqlite'));let changed=false;
 causal.configure({enabled:true,sink:event=>{if(!changed&&event.phase==='settle'&&event.name==='catalog.usageForRoot'){
  changed=true;other.prepare('UPDATE projects SET name=?').run('Other connection');f.database.db=other;
 }return true;}});
 try{const rows=await f.service.usageForRoot(f.a);assert.ok(changed);assert.equal(rows[0].projects[0].name,'Other connection');assert.equal(f.service.prepared.usageInventory,null);}
 finally{causal.configure({enabled:false});f.database.db=f.db;other.close();}
});
test('future binding interpretation is not hidden behind a previously retained complete inventory',async t=>{
 const f=fixture(t,3,{certified:true});f.db.prepare('DELETE FROM workflow_org_memberships').run();
 f.db.prepare('INSERT INTO workflow_roots VALUES(?,?,?,1,0)').run('R',f.a,'{"enabled":true}');
 f.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:t-0000','R','{}');
 await support.usage(f.service,f.root);
 f.db.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:t-0000');
 await assert.rejects(f.service.usageForRoot('/unrelated/disjoint'),{code:'root_binding_forward_version'});
 assert.equal(f.service.prepared.usageInventory,null);
});
test('close after diagnostic settle cannot publish retained owners; explicit reuse gets a new lifetime',async t=>{
 const f=fixture(t,3,{certified:true});await support.usage(f.service,f.root);const old=f.service.prepared;let closed=false;
 causal.configure({enabled:true,sink:event=>{if(!closed&&event.phase==='settle'&&event.name==='catalog.usageForRoot'){closed=true;f.service.close();}return true;}});
 try{await assert.rejects(f.service.usageForRoot(f.a),{code:'prompt_catalog_changed'});assert.equal(old.usageInventory,null);}
 finally{causal.configure({enabled:false});}
 const rows=await support.usage(f.service,f.a);assert.equal(rows[0].tabs.length,3);assert.notEqual(f.service.prepared,old);
});
test('retained metadata does not bypass current watch coverage or policy availability',async t=>{
 const f=fixture(t,2,{certified:true});await support.usage(f.service,f.root);
 f.service.watchEnabled=true;
 await assert.rejects(f.service.usageForRoot(f.a),{code:'prompt_catalog_watch_unavailable'});
 f.service.watchEnabled=false;
 const policy=require('../shared/prompt-source-policy.cjs'),old=policy.PROMPT_SOURCE_POLICY_VERSION;
 policy.PROMPT_SOURCE_POLICY_VERSION=2;
 try{await assert.rejects(support.usage(f.service,f.a),{code:'prompt_catalog_failed'});}
 finally{policy.PROMPT_SOURCE_POLICY_VERSION=old;}
});
test('legacy private SQLite catalogs keep fresh independent scopes with no retained inventory',async t=>{
 const f=fixture(t,2,{certified:true});
 f.db.exec('CREATE TABLE project_prompt_sources(project_id TEXT,root_path TEXT)');
 f.db.prepare('INSERT INTO project_prompt_sources VALUES(?,?)').run('P',f.a);
 f.database.getProjectPromptSources=id=>f.database.db.prepare('SELECT root_path AS rootPath FROM project_prompt_sources WHERE project_id=?').all(id);
 const legacy=new ProjectPromptCatalogService({db:f.database,asyncFs:fs.promises,watch:false});t.after(()=>legacy.close());
 await support.usage(legacy,f.root);let scopes=0;const original=legacy.prepared.scopes.bind(legacy.prepared);
 legacy.prepared.scopes=async(...args)=>{scopes++;return original(...args);};
 assert.equal((await legacy.usageForRoot(f.a)).length,2);
 f.db.prepare('UPDATE projects SET name=? WHERE id=?').run('Current legacy','P');
 assert.equal((await legacy.usageForRoot(f.a))[0].projects[0].name,'Current legacy');
 assert.equal(scopes,2);assert.equal(legacy.prepared.usageInventory,null);
});
