'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Sqlite=require('better-sqlite3'),DatabaseManager=require('./database');
const main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const begin=main.indexOf("    if (req.method === 'GET' && req.url?.startsWith('/terminal/tabs')) {");
const end=main.indexOf("    } else if (req.method === 'GET' && req.url?.startsWith('/terminal/tab-plan'))",begin);
assert.ok(begin>0&&end>begin);
const branch=main.slice(begin,end)+'    }';
function fixture(t){
 const db=new Sqlite(':memory:'),manager=new DatabaseManager({existingConnection:db});manager.initTables();manager.ensureWorkflowExecutionStorage();t.after(()=>db.close());
 const batch=[],terminals=new Map(),terminalCommandState=new Map(),bridgeKnownSessions=new Map(),terminalProjects=new Map(),terminalInitialCommand=new Map(),runtime=new Map();
 const handler=new Function('projectManager','getCodexRuntimeProjectionBatch','terminals','terminalCommandState','bridgeKnownSessions','terminalProjects','terminalInitialCommand','console','return (req,res)=>{'+branch+'}')( {db:manager},(rows,scope)=>{batch.push({rows,scope});return Object.fromEntries(rows.map(r=>[r.tabId,runtime.get(r.tabId)||{sessionId:null,writerConfirmed:false,writerUsableForMutation:false,writerStatus:'absent',liveLifecycle:false,sessionStatus:'inactive'}]));},terminals,terminalCommandState,bridgeKnownSessions,terminalProjects,terminalInitialCommand,{log(){},error(){}});
 const ask=(query='')=>new Promise(resolve=>{let status=200;handler({method:'GET',url:'/terminal/tabs'+(query?'?'+query:'')},{writeHead(value){status=value},end(value){resolve({status,body:JSON.parse(value)})}})});
 const standalone=(id,scope='scope-v2',color='codex',position=0)=>manager.createExecutionTabV2({tabId:id,subjectId:'subject-'+id,executionNamespace:scope,cwd:'/fixture/'+id,record:{name:id,color,position,commandType:'codex',codexSessionId:'saved-'+id}});
 const legacy=(id='legacy',cwd='/legacy')=>{db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(id,cwd,id);db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,color,command_type,codex_session_id) VALUES(?,?,?,?,?,?,?)').run(id,'tab-'+id,'Legacy '+id,cwd,'codex','codex','saved-'+id)};
 return{db,manager,ask,standalone,legacy,batch,terminals,terminalCommandState,bridgeKnownSessions,terminalProjects,terminalInitialCommand,runtime};
}

test('standalone namespace with zero Projects exposes stored tab without inventing a live writer',async t=>{
 const f=fixture(t);f.standalone('b','scope-v2','codex',2);f.standalone('a','scope-v2','codex',1);
 const out=await f.ask('parentProjectId=scope-v2&cwd=/fixture');assert.equal(out.status,200);assert.deepEqual(out.body.tabs.map(x=>x.tabId),['a','b']);
 assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n,0);assert.equal(f.batch.length,1);assert.equal(f.batch[0].scope,'scope-v2');
 const a=out.body.tabs[0];assert.equal(a.sessionId,null);assert.equal(a.codexSavedSessionId,'saved-a');assert.equal(a.codexWriterConfirmed,false);assert.equal(a.codexWriterUsableForMutation,false);assert.equal(a.isAlive,false);assert.equal(a.isRunning,false);
});

test('exact namespace wins over same-cwd legacy Project and does not include another namespace',async t=>{
 const f=fixture(t);f.standalone('right');f.standalone('foreign','other');f.legacy('legacy','/shared');
 const out=await f.ask('parentProjectId=scope-v2&cwd=/shared');assert.deepEqual(out.body.tabs.map(x=>x.tabId),['right']);assert.equal(f.batch[0].scope,'scope-v2');
});

test('known empty namespace never falls through to the legacy cwd',async t=>{
 const f=fixture(t);f.standalone('archived');f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('archived');f.legacy('legacy','/shared');
 const out=await f.ask('parentProjectId=scope-v2&cwd=/shared');assert.deepEqual(out.body.tabs,[]);
});

test('namespace list preserves color/active filtering and one passive runtime batch',async t=>{
 const f=fixture(t);f.standalone('red','scope-v2','red');f.standalone('shown');f.standalone('archived');f.db.prepare('UPDATE tabs SET execution_archived=1 WHERE tab_id=?').run('archived');
 const out=await f.ask('parentProjectId=scope-v2&color=codex');assert.deepEqual(out.body.tabs.map(x=>x.tabId),['shown']);assert.deepEqual(f.batch,[{rows:[{tabId:'shown',savedSessionId:'saved-shown'}],scope:'scope-v2'}]);
});

test('legacy ID, cwd fallback, absent query and unknown scope retain existing responses',async t=>{
 const f=fixture(t);f.legacy();f.legacy('other','/other');
 assert.deepEqual((await f.ask('parentProjectId=legacy&cwd=/other')).body.tabs.map(x=>x.tabId),['tab-legacy']);
 assert.deepEqual((await f.ask('cwd=/legacy')).body.tabs.map(x=>x.tabId),['tab-legacy']);
 assert.deepEqual((await f.ask('parentProjectId=unknown&cwd=/legacy')).body.tabs.map(x=>x.tabId),['tab-legacy'],'established unknown-ID legacy cwd fallback');
 assert.deepEqual((await f.ask('parentProjectId=unknown&cwd=/missing')).body.tabs,[]);assert.equal((await f.ask()).status,400);
});

test('passive runtime unknown is not promoted from saved SID or surviving PTY',async t=>{
 const f=fixture(t);f.standalone('a');f.terminals.set('a',{pid:1234});f.terminalProjects.set('a','/live/cwd');
 f.runtime.set('a',{sessionId:null,writerConfirmed:false,writerUsableForMutation:false,writerStatus:'unknown',liveLifecycle:null,sessionStatus:'unknown'});
 const a=(await f.ask('parentProjectId=scope-v2')).body.tabs[0];assert.ok(a);assert.equal(a.isAlive,true);assert.equal(a.pid,1234);assert.equal(a.isRunning,false);assert.equal(a.processLookupUnknown,true);assert.equal(a.sessionId,null);assert.equal(a.codexSavedSessionId,'saved-a');assert.equal(a.cwd,'/live/cwd');
});
