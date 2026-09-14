'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const esbuild = require('esbuild');
const crypto = require('node:crypto');
const { SavedHistoryOperations } = require('./saved-history-operation');
const { ConversationOwners } = require('./conversation-owner');
const { SessionTranscriptService } = require('./session-transcript-service');
const { PromptQueueAssetStore } = require('./prompt-queue-assets');
const { materializeClaudeSavedHistoryImages } = require('./claude-saved-history-images');

const userText = '<saved_prompt name="Rules" context-update-id="update-C">Be exact</saved_prompt>\n'
  + '<context_file name="Spec" path="/fixture/spec.md" role="source" sha256="'+crypto.createHash('sha256').update('plan').digest('hex')+'" bytes="4">plan</context_file>\n'
  + '<pasted_content>editable paste</pasted_content>\nQuestion ';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cV+8AAAAASUVORK5CYII=';
const clone = value => JSON.parse(JSON.stringify(value));
let executorCode;
test.before(async () => {
  const output=await esbuild.build({entryPoints:[path.join(__dirname,'../renderer/utils/historyRewriteRewind.ts')],bundle:true,write:false,format:'cjs',platform:'node',
    plugins:[{name:'fixture',setup(build){
      const modules={ '../store/useUIStore':'export const useUIStore={getState:()=>fixture.ui};',
        '../store/useWorkspaceStore':'export const useWorkspaceStore={getState:()=>fixture.workspace};',
        './codexLaunch':'export const getCodexHistoryMutationSettingsProof=()=>null;export const buildCodexRunPayload=x=>x;export const buildCodexHistoryMutationResumePayload=x=>x;',
        './claudePtyActions':'export const stopClaudePtyProcess=(tabId,options)=>fixture.stop(tabId,options);' };
      build.onResolve({filter:/.*/},a=>modules[a.path]?{path:a.path,namespace:'fixture'}:null);
      build.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:modules[a.path]}));
    }}]});executorCode=output.outputFiles[0].text;
});

async function harness(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-saved-adapter-'));
  const priorRoot=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=path.join(root,'claude-home');
  t.after(()=>{if(priorRoot===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=priorRoot;fs.rmSync(root,{recursive:true,force:true});});
  const sid=crypto.randomUUID(),projectDir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','-fixture');fs.mkdirSync(projectDir,{recursive:true});
  const filePath=path.join(projectDir,sid+'.jsonl'),raw=[];
  let previous=null;
  for(const [i,text] of (options.only ? [userText] : ['keep',userText,'later']).entries()) {
    const uuid='user-'+i,answer='answer-'+i;
    raw.push({uuid,type:'user',parentUuid:previous,sessionId:sid,cwd:'/fixture',timestamp:new Date(1789257600000+i*5000).toISOString(),
      message:{role:'user',content:text===userText?[{type:'text',text},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]:text}},
      {uuid:answer,type:'assistant',parentUuid:uuid,sessionId:sid,timestamp:new Date(1789257601000+i*5000).toISOString(),message:{role:'assistant',content:[{type:'text',text:'answer'}]}});
    previous=answer;
  }
  fs.writeFileSync(filePath,raw.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const calls=[],presentations=new Map(),appState=new Map(),snapshot={terminalToken:{},projectId:'P',cwd:'/fixture',sessionId:sid,toolType:'claude',
    inputRevision:1,runSeq:3,lifecycleGeneration:'G:3',launchId:options.stopped?null:'old',isRunning:!options.stopped,stopping:false};
  const db={getAppState:key=>clone(appState.get(key)||null),setAppState:(key,value)=>{appState.set(key,clone(value));},
    compareAndSetTabClaudeSessionId:(_p,_t,expected,next)=>{if(snapshot.sessionId!==expected||options.failBinding)return false;snapshot.sessionId=next;return true;},
    getSessionParent:()=>null,getParentSession:()=>null,
    saveHistoryPromptPresentation:row=>{presentations.set(row.entryUuid,clone(row));return true;},
    getHistoryPromptPresentations:(_tool,session)=>[...presentations.values()].filter(row=>row.sessionId===session),
    db:{transaction:fn=>()=>{const before=snapshot.sessionId;try{return fn();}catch(e){snapshot.sessionId=before;throw e;}},prepare:()=>({run(){},all:()=>[],get:()=>undefined})}};
  const savedLoad=Module._load;delete require.cache[require.resolve('./ipc/claude-data')];
  Module._load=function(request,parent,isMain){if(request==='electron')return {ipcMain:{handle(){}},app:{getPath:()=>root}};return savedLoad.call(this,request,parent,isMain);};
  let data;try{data=require('./ipc/claude-data');}finally{Module._load=savedLoad;}
  data.register({projectManager:{db},formatToolAction:()=>null});
  const transcript=new SessionTranscriptService({getMainWindow:()=>null,claudeData:data,codexData:null,promptPresentationStore:db});
  const assets=new PromptQueueAssetStore({rootDir:path.join(root,'assets')});
  let registry;const ui={historyPromptDrafts:{T:'foreign desktop draft'},historyPromptDraftChips:{},historyPromptDraftImages:{},setHistoryPromptDraft:()=>assert.fail('external Rewind cannot edit desktop draft')};
  const context={fixture:{ui,workspace:{setClaudeSessionId:(_tab,next)=>{calls.push(['renderer-binding',next]);}},
    stop:async(_tab,opts)=>{calls.push(['stop',opts]);registry.validateStop(opts.authority);snapshot.isRunning=false;snapshot.launchId=null;return {success:true};}},
    console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts?.detail;}},
    window:{dispatchEvent(){return false;},addEventListener(){},removeEventListener(){},require:()=>({ipcRenderer:{invoke:async(channel,args)=>{
      if(channel==='saved-history:get')return registry.read(args.tabId,args.operationId);
      if(channel==='saved-history:step'){
        if(args.phase==='rewrite'&&options.changeTarget)fs.appendFileSync(filePath,JSON.stringify({...raw[0],message:{role:'user',content:'changed'}})+'\n');
        return registry.step(args);
      }
      if(channel==='claude:run-command'){
        calls.push(['resume',args]);registry.validateResume(args.historyOperation,'claim',{sessionId:args.sessionId});
        snapshot.runSeq++;snapshot.lifecycleGeneration='G:'+snapshot.runSeq;snapshot.launchId='new-launch';snapshot.isRunning=true;
        registry.validateResume(args.historyOperation,'claimed',{sessionId:args.sessionId,launchId:'new-launch'});
        if(options.staleInputBeforeWrite)snapshot.inputRevision++;
        registry.validateResume(args.historyOperation,'write',{sessionId:args.sessionId,launchId:'new-launch'});
        calls.push(['launch-write']);return {success:!options.lateLaunchError,accepted:options.lateLaunchError?null:true,
          ...(options.lateLaunchError?{error:'publication-failed'}:{}),launchWritten:true,launchId:'new-launch',launchGeneration:'new-launch'};
      }
      throw Error('unexpected IPC '+channel);
    }}})},module:{exports:{}},exports:{},require:()=>{throw Error('unexpected require');}};
  context.exports=context.module.exports;vm.runInNewContext(executorCode,context);
  // Execute the actual App bridge consumer too, not a test-specific selection
  // of the exported executor. HTTP, bridge and provider branch are all covered.
  const appSource=fs.readFileSync(path.join(__dirname,'../renderer/App.tsx'),'utf8');
  const appTree=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let action;
  const visit=node=>{if(ts.isIfStatement(node)&&node.expression.getText(appTree)==="action === 'savedHistoryOperationScenario'")action=node.getText(appTree);ts.forEachChild(node,visit);};visit(appTree);assert.ok(action);
  Object.assign(context,{executeHistoryRewriteRewindScenario:context.module.exports.executeHistoryRewriteRewindScenario,
    executeHistoryDeleteIterationScenario:context.module.exports.executeHistoryDeleteIterationScenario,
    ensureProjectWorkspace:async()=>{},describeAgentTab:()=>({tab:{id:'T',cwd:'/fixture'},toolType:'claude',sessionId:snapshot.sessionId}),
    ipcRenderer:context.window.require().ipcRenderer,reply:(_ok,data)=>data});
  const actionCode=ts.transpileModule(action,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const bridge=vm.runInNewContext('(async(action,payload)=>{'+actionCode+'})',context);
  let finish;const done=new Promise(r=>{finish=r;});
  const owner = new ConversationOwners({db, instanceId:'fixture', capture:()=>({known:true,provider:'claude',sessionId:snapshot.sessionId,
    projectId:'P',cwd:'/fixture',instanceId:'fixture',terminalId:'pty',launchId:snapshot.launchId})});
  registry=new SavedHistoryOperations({db,transcript,runtime:{owner,capture:()=>({...snapshot}),inspectDraft:()=>({hasDraft:!!options.foreignDraft}),waitForDraft:async()=>{}},
    resolveSession:async()=>({sessionId:snapshot.sessionId,toolType:'claude',cwd:'/fixture'}),
    claude:{...data._api,materializeImages:(record,refs)=>materializeClaudeSavedHistoryImages(record,refs,assets)},
    dispatch:async(_action,args)=>{
      try{await bridge('savedHistoryOperationScenario',args);}
      catch(e){calls.push(['error',e.message]);try{await registry.step({...args,phase:'failed',data:{error:e.message}});}catch{}}finally{finish();}
    },broadcast:()=>{}});
  const timeline=await transcript.getTimeline({toolType:'claude',sessionId:sid,cwd:'/fixture',tabId:'T'});
  assert.equal(timeline.success,true,JSON.stringify(timeline));
  const target=timeline.entries.find(e=>e.content?.includes('editable paste'));
  assert.ok(target,JSON.stringify(timeline));
  const body={operationId:crypto.randomUUID(),provider:'claude',kind:options.kind||'rewind',expectedSessionId:sid,targetUuid:target.uuid,
    expectedContentRevision:options.staleRevision?'wrong-revision':timeline.revision.token};
  // Same public POST/GET receipt routes; no stand or provider invocation.
  const source=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');const start=source.indexOf("  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/history-operations", source.indexOf('// Additive saved-history scenario.'));
  const end=source.indexOf('\n  //',start+5);assert.ok(start>=0&&end>start);
  const sendJson=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const handler=vm.runInNewContext('(async(req,res,parsed)=>{let m;'+source.slice(start,end)+'})',{savedHistoryOperations:registry,decId:decodeURIComponent,sendJson,
    readBody:req=>new Promise((resolve,reject)=>{let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});})});
  const server=http.createServer((req,res)=>handler(req,res,{pathname:new URL(req.url,'http://fixture').pathname}).catch(e=>sendJson(res,500,{error:e.message})));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port+'/api/terminal-tabs/T/history-operations';
  return {filePath,sid,raw,calls,snapshot,registry,owner,body,done,
    post:async()=>{const r=await fetch(base,{method:'POST',body:JSON.stringify(body)});return {status:r.status,...await r.json()};},
    get:async()=>{const r=await fetch(base+'/'+body.operationId);return {status:r.status,...await r.json()};}};
}

for(const options of [{},{stopped:true},{only:true},{kind:'delete'}])test('actual Claude saved-history HTTP/shared executor/writer '+JSON.stringify(options),async t=>{
  const h=await harness(t,options);assert.equal((await h.post()).status,202);await h.done;
  const r=await h.get();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.operation.success,true);
  assert.equal(h.registry.applicability('T',h.body.operationId,r.operation.revision).applicability.verdict,'applicable');
  h.owner.noteInput('T');
  assert.equal(h.registry.applicability('T',h.body.operationId,r.operation.revision).applicability.verdict,'superseded');
  assert.equal(r.operation.bindingCommitted,true);assert.equal(r.operation.newSessionId,undefined);
  if(options.only){assert.equal(r.operation.fileDeleted,true);assert.equal(r.operation.binding.mode,'cleared');assert.equal(r.operation.binding.sessionId,null);assert.equal(h.snapshot.sessionId,null);assert.equal(fs.existsSync(h.filePath),false);assert.equal(h.calls.some(c=>c[0]==='resume'),false);}
  else{assert.equal(r.operation.binding.mode,'retained');assert.equal(h.snapshot.sessionId,h.sid);assert.equal(h.calls.filter(c=>c[0]==='launch-write').length,1);}
  if(options.kind==='delete'){assert.equal(r.operation.draft,null);assert.match(fs.readFileSync(h.filePath,'utf8'),/later/);}
  else{const draft=r.operation.draft;assert.equal(draft.authoring.version,1);assert.equal(draft.imagePaths.length,1);assert.equal(fs.readFileSync(draft.imagePaths[0].path).toString('base64'),png);assert.ok(draft.chips.some(c=>c.contextUpdateId==='update-C'));assert.ok(draft.chips.some(c=>c.filePath==='/fixture/spec.md'));}
  assert.equal((await h.post()).operation.idempotent,true);assert.equal((await h.get()).operation.revision,r.operation.revision);
});

for(const options of [{foreignDraft:true},{staleRevision:true},{staleInputBeforeWrite:true},{failBinding:true}])test('Claude adapter fail-closed '+JSON.stringify(options),async t=>{
  const h=await harness(t,options);await h.post();await h.done;const r=await h.get();assert.equal(r.status,409,JSON.stringify(r));
  assert.equal(h.calls.some(c=>c[0]==='launch-write'),false);
  if(options.foreignDraft||options.staleRevision)assert.equal(r.operation.historyMutated,false);
  else assert.equal(r.operation.historyMutated,true);
});

test('Claude late launch failure preserves the one written launch, binding and portable draft; never replays',async t=>{
  const h=await harness(t,{lateLaunchError:true});await h.post();await h.done;
  const r=await h.get();assert.equal(r.status,409);assert.equal(r.operation.resume.launchWritten,true);
  assert.equal(r.operation.bindingCommitted,true);assert.equal(r.operation.draft.authoring.version,1);
  assert.equal(h.calls.filter(c=>c[0]==='launch-write').length,1);
  assert.equal((await h.post()).operation.idempotent,true);assert.equal(h.calls.filter(c=>c[0]==='launch-write').length,1);
});

test('Claude binding and receipt are atomic in real SQLite, including removed-session rollback',async t=>{
  const Sqlite=require('better-sqlite3'),Database=require('./database');
  let sql;try{sql=new Sqlite(':memory:');}catch(e){if(e.code==='ERR_DLOPEN_FAILED'){t.skip('Electron ABI');return;}throw e;}
  t.after(()=>sql.close());sql.exec("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE tabs(project_id TEXT,tab_id TEXT,claude_session_id TEXT);INSERT INTO tabs VALUES('P','T','S')");
  const db=Object.create(Database.prototype);db.db=sql;
  const snapshot={terminalToken:{},projectId:'P',cwd:'/fixture',sessionId:'S',inputRevision:1,runSeq:1,lifecycleGeneration:'G',launchId:null,isRunning:false};
  const owner = new ConversationOwners({db,capture:()=>({known:true,provider:'claude',projectId:'P',cwd:'/fixture',launchId:null,
    sessionId:sql.prepare('SELECT claude_session_id AS sid FROM tabs').get().sid})});
  const registry=new SavedHistoryOperations({db,runtime:{owner,capture:()=>({...snapshot,sessionId:sql.prepare('SELECT claude_session_id AS sid FROM tabs').get().sid})}});
  const key=registry.key('T','O'),lease={key,record:{tabId:'T',operationId:'O',toolType:'claude',expectedSessionId:'S',phase:'adopting',state:'running',revision:1,fileDeleted:true,
    request:{tabId:'T',toolType:'claude',expectedSessionId:'S'}},scope:snapshot,mutation:{committed:true,fileDeleted:true},mutationSessionId:'S'};
  db.setAppState(key,lease.record);registry.leases.set(key,lease);
  sql.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'receipt rejected'); END");
  await assert.rejects(registry.step({tabId:'T',operationId:'O',phase:'adopted'}),/receipt rejected/);
  assert.equal(sql.prepare('SELECT claude_session_id AS sid FROM tabs').get().sid,'S');assert.equal(db.getAppState(key).phase,'adopting');
  assert.equal(owner.stored('T'), null, 'failed receipt also rolls back the applicability checkpoint');
  sql.exec('DROP TRIGGER reject_receipt');await registry.step({tabId:'T',operationId:'O',phase:'adopted'});
  assert.equal(sql.prepare('SELECT claude_session_id AS sid FROM tabs').get().sid,null);
  assert.equal(db.getAppState(key).binding.mode,'cleared');
  assert.equal(registry.applicability('T','O',2).applicability.verdict,'applicable');
  assert.equal(owner.current('T').currentBinding.state,'none');
});
