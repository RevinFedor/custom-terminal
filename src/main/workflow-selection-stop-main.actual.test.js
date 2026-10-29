// Derived from the verified Pro Source package; these controls read CURRENT.
// Process/PTY/publication ports are controlled; SQLite databases are :memory:.
'use strict';
// Same desired assertions run against pinned PRE and authored POST. Only the
// process/OS, publication and SQL-shaped I/O ports are synthetic. Production
// runtime/group exports, Main function text and launch tracker are evaluated.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),pre=root;
const {DatabaseSync}=require('node:sqlite');
const databases=[];test.after(()=>{for(const db of databases)db.close();});
const {stableJson,executionScopeForRow}=require(path.join(pre,'src/shared/workflow-organization.cjs'));
const {createTerminalShellReadinessTracker}=require(path.join(pre,'src/main/terminal-shell-readiness.cjs'));
const fingerprint=value=>crypto.createHash('sha256').update(stableJson(value)).digest('hex'),copy=x=>JSON.parse(JSON.stringify(x));
const Runtime=require('./workflow-selection-runtime.js').WorkflowSelectionRuntime;
const Group=require('./workflow-group-actions.js').WorkflowGroupActions;
const pinnedMain=fs.readFileSync(path.join(pre,'src/main/main.js'),'utf8');
const begin=pinnedMain.indexOf('async function stopWorkflowSelectionTarget(member,observation,isCurrent) {'),end=pinnedMain.indexOf('\nworkflowSelectionRuntime =',begin);
assert(begin>=0&&end>begin);
const selectedMain=pinnedMain;
const selectedBegin=selectedMain.indexOf('async function stopWorkflowSelectionTarget(member,observation,isCurrent) {');
const selectedEnd=selectedMain.indexOf('\nworkflowSelectionRuntime =',selectedBegin);
assert(selectedBegin>=0&&selectedEnd>selectedBegin);
// Test the function from the COMPLETE delivered Main file, not a detached draft.
const main=selectedMain.slice(selectedBegin,selectedEnd);
function fixture(options={}) {
 const tabId='T',term={pid:10},tracker=createTerminalShellReadinessTracker();
 tracker.reset(tabId,term,10);tracker.markAgentLaunchWrite(tabId,term,'codex','L1');tracker.markAgentLaunchStarted(tabId,term);
 const state={commands:new Map(),steps:new Map(),writes:0,commitFailures:0,
  owner:{mainInstanceId:'M',terminalId:'TERM',sdkOwnerId:null,sdkInputRevision:null,lifecycleGeneration:'TERM:1',runSeq:1,inputRevision:5,stopRevision:0,pendingLaunch:1},
  pub:{version:1,migrationVersion:1,generation:4},membership:{tabId,workflowId:'W',revision:1},workflow:{id:'W',revision:1,layout:{windows:[]},metadata:{},deletedGeneration:null},tabRevision:2,
  row:{id:7,tab_id:tabId,project_id:null,execution_namespace:'NS',execution_subject_version:2,execution_subject_id:'SUBJ',execution_storage_revision:4,execution_archived:0,cwd:'/fixture',restore_placement_id:'P',claude_session_id:null,codex_session_id:'SID',gemini_session_id:null,tab_type:'terminal',command_type:'codex',file_path:null,parent_tab_id:null,visual_parent_tab_id:null,closed_visual_parent_tab_id:null,context_pct:0,cache_stats:null,codex_model:'model-before',codex_effort:'low'},
  launchId:'L1',acceptedSourceSessionId:'SID-PARENT',ownerToken:'CONVERSATION',
  calls:{stop:0,observe:0,preObserve:0,admitted:0,recover:0,physicalWrites:0},logs:[]};
 if(options.noProcess||options.noPending){tracker.finishAgentLaunch(tabId,term,true,tracker.launchSnapshot(tabId,term));state.owner.pendingLaunch=null;}
 if(options.sdk) {
  Object.assign(state.owner,{terminalId:null,sdkOwnerId:'SDK',sdkInputRevision:3,lifecycleGeneration:null,runSeq:0,pendingLaunch:null});
  Object.assign(state.row,{tab_type:'claude-sdk',command_type:'claude',claude_session_id:'SID',codex_session_id:null});
  state.sdkLive=true;state.launchId=null;state.acceptedSourceSessionId=null;
 }
 if(options.ordinary) {
  tracker.reset(tabId,term,10);state.owner.pendingLaunch=null;
  Object.assign(state.row,{command_type:null,codex_session_id:null});state.launchId=null;state.acceptedSourceSessionId=null;
 }
 const sql=new DatabaseSync(':memory:');databases.push(sql);
 const columns=Object.keys(state.row),q=name=>'"'+name.replaceAll('"','""')+'"';
 sql.exec('CREATE TABLE tabs('+columns.map(name=>q(name)+(name==='id'?' INTEGER PRIMARY KEY':typeof state.row[name]==='number'?' INTEGER':' TEXT')).join(',')+'); CREATE TABLE tab_history(id INTEGER PRIMARY KEY)');
 sql.prepare('INSERT INTO tabs('+columns.map(q).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(name=>state.row[name]));
 // The actual native revision trigger, on synthetic rows only. Source clocks
 // below are the full production helper, schema and triggers.
 sql.exec(`CREATE TRIGGER workflow_tabs_revision AFTER UPDATE ON tabs
   WHEN NEW.execution_subject_version=2 AND NEW.execution_storage_revision=OLD.execution_storage_revision
   BEGIN UPDATE tabs SET execution_storage_revision=OLD.execution_storage_revision+1 WHERE id=NEW.id; END;`);
 const rowState=state.row;
 state.row=new Proxy(rowState,{set(target,key,value){
   assert(columns.includes(key),'unknown fixture column '+key);
   sql.prepare('UPDATE tabs SET '+q(key)+'=? WHERE id=?').run(value,target.id);
   const next=sql.prepare('SELECT * FROM tabs WHERE id=?').get(key==='id'?value:target.id);
   Object.assign(target,next);return true;
 }});
 state.commands={get:id=>sql.prepare('SELECT command_json FROM workflow_group_actions WHERE mutation_id=?').get(id)?.command_json};
 const db={inTransaction:false,exec:statement=>sql.exec(statement),prepare:statement=>sql.prepare(statement),transaction(fn){return {immediate(){
   assert.equal(db.inTransaction,false,'nested fixture transaction');db.inTransaction=true;sql.exec('BEGIN IMMEDIATE');
   try{const result=fn();if(state.commitFailures){state.commitFailures--;throw Object.assign(Error('synthetic_commit_failure'),{code:'synthetic_commit_failure'});}sql.exec('COMMIT');return result;}
   catch(error){sql.exec('ROLLBACK');throw error;}finally{db.inTransaction=false;}
 }}}};
 const database={db,getAppState:()=>({token:state.ownerToken,reason:'send'})};
 const organization={getPublication:()=>copy(state.pub),getMembership:()=>copy(state.membership),getWorkflow:()=>copy(state.workflow),workflowRequired(){},getTab:()=>({executionResolved:true,revision:state.tabRevision,subjectVersion:2,nativeRow:copy(state.row),executionSubject:executionScopeForRow(state.row),membership:copy(state.membership)})};
 const execution=()=>options.sdk&&state.sdkLive||options.ordinary&&!state.ordinaryKnown?{known:false,inputRevision:state.owner.inputRevision,lifecycleGeneration:state.owner.lifecycleGeneration}:({known:true,provider:state.row.command_type,projectId:state.row.execution_namespace,cwd:state.row.cwd,executionScope:executionScopeForRow(state.row),sessionId:state.row.command_type==='claude'?state.row.claude_session_id:state.row.codex_session_id,instanceId:state.owner.mainInstanceId,terminalId:state.owner.terminalId,launchId:state.launchId,runSeq:state.owner.runSeq,acceptedSourceSessionId:state.acceptedSourceSessionId,inputRevision:state.owner.inputRevision,lifecycleGeneration:state.owner.lifecycleGeneration});
 const groupActions=new Group({database,organization,groups:{writable(){}},captureExecution:execution});
 let context;
 const configuration={database,organization,groupActions,captureOwner:()=>copy(state.owner),log:(phase,data)=>state.logs.push({phase,...copy(data)}),observe:async()=>{state.calls.preObserve++;options.duringInitialObserve?.(state,sql);await Promise.resolve();return {known:true,owner:{kind:options.sdk?'sdk':options.ordinary?'terminal':'ai',token:term,toolType:options.sdk?'claude':options.ordinary?null:'codex'},identity:{processStatus:'found'}};},stop:(...args)=>context.stopWorkflowSelectionTarget(...args),recoverRuntime:()=>{state.calls.recover++;throw Error('NO CLOSE');}};
 const runtime=new Runtime(configuration);
 context=vm.createContext({terminals:new Map(options.sdk?[]:[[tabId,term]]),terminalShellReadiness:tracker,captureArchivedCloseRuntimeOwner:()=>copy(state.owner),workflowSelectionRuntime:runtime,historyMutationInput:{run:(_r,fn)=>fn()},
  async stopWorkflowSessionTarget(_tab,_owner,_proof,guard,{onAdmitted}) {state.calls.stop++;options.beforeSignal?.(state,tracker,term);const verdict=guard();if(verdict.allowed!==true)return {success:false,guardRejected:true,error:verdict.reason};onAdmitted();state.calls.admitted++;if(!options.noProcess&&!options.sdk)state.calls.physicalWrites++;if(!options.sdk&&!options.ordinary&&!options.noProcess)state.owner.stopRevision++;if(options.sdk){state.sdkLive=false;state.owner.sdkOwnerId=null;state.owner.sdkInputRevision=null;}tracker.finishAgentLaunch(tabId,term,true,tracker.launchSnapshot(tabId,term));state.owner.pendingLaunch=null;state.launchId=null;state.acceptedSourceSessionId=null;options.afterHelper?.(state);if(options.throwHelper)throw Object.assign(Error('RAW_SECRET_MESSAGE_MUST_NOT_BE_LOGGED'),{code:'synthetic_stop_throw'});return options.helperFailure?{success:false,code:'synthetic_stop_failure'}:options.sdk?{success:true,hard:true}:options.noProcess?{success:true,noProcess:true,processName:'codex'}:{success:true,processName:options.ordinary?null:'codex',graceful:'ctrl-c'};},
  async observeWorkflowSelectionProcess(){state.calls.observe++;await Promise.resolve();options.duringObserve?.(state,tracker,term);if(options.throwObserve)throw Object.assign(Error('RAW_SECRET_MESSAGE_MUST_NOT_BE_LOGGED'),{code:'synthetic_observe_throw'});return options.unknownObserve?{known:false}:options.foundObserve?{known:true,identity:{processStatus:'found'}}:{known:true,identity:{processStatus:'absent'}};}
 });
 vm.runInContext(main,context);
 runtime.begin({version:1,mutationId:'STOP',action:'stop',members:[{projectId:'NS',tabId}],origin:{workflowId:'W',windowId:null}});
 const run=()=>runtime.step({mutationId:'STOP',tabId});
 return {state,runtime,run,tracker,term,sql,create:()=>new Runtime(configuration)};
}
const completed=r=>r?.completed===true;
test('exact Main success retires only its own launch, persists completed Stop once',async()=>{const f=fixture();assert.equal(completed(await f.run()),true);assert.equal(f.runtime.receipt('STOP').completed,true);assert.equal(f.state.calls.stop,1);assert.equal(f.state.calls.observe,1);assert.equal(f.state.calls.admitted,1);});
test('POSITIVE: unrelated publication advance with exact target permits successful Stop receipt',async()=>{const f=fixture({duringObserve:s=>s.pub.generation++});assert.equal(completed(await f.run()),true);assert.equal(f.runtime.receipt('STOP').completed,true);assert.equal(f.state.calls.stop,1);});
for(const [name,mutate] of Object.entries({sid:s=>s.row.codex_session_id='NEW',subject:s=>s.row.execution_subject_id='NEW',cwd:s=>s.row.cwd='/new',provider:s=>s.row.command_type='claude',ownerToken:s=>s.ownerToken='NEW',placement:s=>s.row.restore_placement_id='NEW',nativeId:s=>s.row.id++,targetTabRevision:s=>s.tabRevision++,workflowRevision:s=>s.workflow.revision++,workflowLayout:s=>s.workflow.layout.windows.push('NEW'),membership:s=>s.membership.revision++}))test('NEGATIVE: final source/target '+name+' change cannot complete',async()=>{const f=fixture({duringObserve:mutate});assert.equal(completed(await f.run()),false);assert.equal(f.runtime.receipt('STOP').completed,false);assert.equal(f.state.calls.stop,1);});
test('NEGATIVE: same-null pending launch after newer write+retirement cannot complete',async()=>{const f=fixture({duringObserve:(s,t,term)=>{t.markAgentLaunchWrite('T',term,'codex','L2');t.finishAgentLaunch('T',term,true,t.launchSnapshot('T',term));}});assert.equal(completed(await f.run()),false);assert.equal(f.runtime.receipt('STOP').completed,false);});
for(const field of ['mainInstanceId','terminalId','lifecycleGeneration','runSeq','inputRevision','stopRevision'])test('NEGATIVE: final runtime owner '+field+' change remains rejected',async()=>{const f=fixture({duringObserve:s=>s.owner[field]=typeof s.owner[field]==='number'?s.owner[field]+1:s.owner[field]+'NEW'});assert.equal(completed(await f.run()),false);assert.equal(f.runtime.receipt('STOP').completed,false);});
for(const kind of ['throwHelper','throwObserve','unknownObserve','foundObserve','helperFailure'])test('UNKNOWN: '+kind+' retains safe stage diagnostic and cannot replay Stop',async()=>{const f=fixture({[kind]:true});const r=await f.run();assert.equal(completed(r),false);const step=f.runtime.command('STOP').steps.T;assert.equal(step.error,'selection_stop_receipt_unknown');assert.equal(step.diagnostic.version,1);assert.equal(typeof step.diagnostic.stage,'string');assert.equal(JSON.stringify(step).includes('RAW_SECRET'),false);for(const runtime of [f.runtime,f.create()])assert.equal((await runtime.step({mutationId:'STOP',tabId:'T'})).pending,true);assert.equal(f.state.calls.stop,1);assert.equal(f.state.calls.recover,0);});
test('lost response ACK reads same durable success after restart without another effect',async()=>{const f=fixture();await f.run();f.state.owner.mainInstanceId='NEW-MAIN';const restarted=f.create();assert.equal(restarted.receipt('STOP').completed,true);assert.equal(restarted.ack({mutationId:'STOP',tabId:'T'}).completed,true);assert.equal((await restarted.step({mutationId:'STOP',tabId:'T'})).completed,true);assert.equal(f.state.calls.stop,1);});
test('old UNKNOWN after restart remains immutable; current absence is not historical completion',async()=>{const f=fixture({throwHelper:true});await f.run();const before=f.state.commands.get('STOP');f.state.owner.mainInstanceId='NEW';const restarted=f.create();assert.equal((await restarted.step({mutationId:'STOP',tabId:'T'})).pending,true);assert.equal(f.state.commands.get('STOP'),before);assert.equal(f.state.calls.stop,1);assert.equal(f.state.calls.recover,0);assert.throws(()=>restarted.reserve({mutationId:'CLOSE'},restarted.command('STOP').members[0]),/selection_action_target_in_progress:STOP/);});

test('SDK: owned hard retirement preserves success across known:false to same durable conversation',async()=>{const f=fixture({sdk:true});assert.equal(completed(await f.run()),true);assert.equal(f.state.calls.stop,1);});
test('SDK: changed durable binding after own hard retirement cannot complete',async()=>{const f=fixture({sdk:true,duringObserve:s=>s.row.claude_session_id='NEW'});assert.equal(completed(await f.run()),false);});
test('ordinary terminal: unchanged known:false source completes only after owned helper plus absent',async()=>{const f=fixture({ordinary:true});assert.equal(completed(await f.run()),true);});
test('ordinary terminal: unowned known:false to known:true transition does not gain authority',async()=>{const f=fixture({ordinary:true,duringObserve:s=>s.ordinaryKnown=true});assert.equal(completed(await f.run()),false);});

test('noProcess success retires only writer labels with no pending launch and no new Stop revision',async()=>{const f=fixture({noProcess:true});assert.equal(completed(await f.run()),true);assert.equal(f.state.owner.stopRevision,0);assert.equal(f.state.calls.stop,1);});
test('success reaches new guarded Close reservation through actual runtime with no Close effects',async()=>{const f=fixture();assert.equal(completed(await f.run()),true);f.runtime.begin({version:1,mutationId:'CLOSE',action:'close',members:[{projectId:'NS',tabId:'T'}],origin:{workflowId:'W',windowId:null}});const prepared=await f.runtime.step({mutationId:'CLOSE',tabId:'T'});assert(prepared.closeGuard);f.runtime.startArchive(prepared.closeGuard,{projectId:'NS',tab:{tabId:'T'}});assert.equal(f.runtime.command('CLOSE').steps.T.started,true);assert.equal(f.state.calls.stop,1);assert.equal(f.state.calls.recover,0);});
test('UNKNOWN can prepare Close guard but reserve refuses archive and no Stop/recover replay',async()=>{const f=fixture({throwHelper:true});await f.run();f.runtime.begin({version:1,mutationId:'CLOSE',action:'close',members:[{projectId:'NS',tabId:'T'}],origin:{workflowId:'W',windowId:null}});const prepared=await f.runtime.step({mutationId:'CLOSE',tabId:'T'});assert(prepared.closeGuard);assert.throws(()=>f.runtime.startArchive(prepared.closeGuard,{projectId:'NS',tab:{tabId:'T'}}),/selection_action_target_in_progress:STOP/);assert.equal(f.runtime.command('CLOSE').steps.T.started,undefined);assert.equal(f.state.calls.stop,1);assert.equal(f.state.calls.recover,0);});
for(const field of ['mainInstanceId','terminalId','runSeq','inputRevision','stopRevision'])test('pre-signal '+field+' replacement rejects before admission',async()=>{const f=fixture({beforeSignal:s=>s.owner[field]=typeof s.owner[field]==='number'?s.owner[field]+1:s.owner[field]+'NEW'});assert.equal(completed(await f.run()),false);assert.equal(f.state.calls.admitted,0);});
test('pre-signal newer launch write+retirement is rejected even when pending remains null',async()=>{const f=fixture({noPending:true,beforeSignal:(s,t,term)=>{t.markAgentLaunchWrite('T',term,'codex','L2');t.finishAgentLaunch('T',term,true,t.launchSnapshot('T',term));}});assert.equal(completed(await f.run()),false);assert.equal(f.state.calls.admitted,0);});

test('native storage revision alone is not a source change and does not block exact Stop',async()=>{const f=fixture({duringObserve:s=>s.row.execution_storage_revision++});assert.equal(completed(await f.run()),true);});
test('pre-signal SID A to B to A real source trigger rejects before admission or synthetic write',async()=>{const f=fixture({beforeSignal:s=>{const original=s.row.codex_session_id;s.row.codex_session_id='B';s.row.codex_session_id=original;}});assert.equal(completed(await f.run()),false);assert.equal(f.state.calls.admitted,0);assert.equal(f.state.calls.physicalWrites,0);assert.equal(f.runtime.command('STOP').steps.T.diagnostic.reason,'selection_stop_scope_source_clock_changed');});
test('final SID A to B to A real source trigger prevents completion after original one effect',async()=>{const f=fixture({duringObserve:s=>{const original=s.row.codex_session_id;s.row.codex_session_id='B';s.row.codex_session_id=original;}});assert.equal(completed(await f.run()),false);assert.equal(f.state.calls.admitted,1);assert.equal(f.state.calls.physicalWrites,1);});
test('ordinary stats and future model preference writes preserve exact current Stop',async()=>{const f=fixture({duringObserve:s=>{s.row.context_pct=25;s.row.codex_model='future-model';s.row.codex_effort='high';}});assert.equal(completed(await f.run()),true);assert.equal(f.state.calls.physicalWrites,1);});

test('initial observation SID A to B to A rejects before reservation/started and all effects',async()=>{const f=fixture({duringInitialObserve:s=>{const original=s.row.codex_session_id;s.row.codex_session_id='B';s.row.codex_session_id=original;}});const result=await f.run().catch(error=>({error:error.code||error.message}));assert.equal(completed(result),false);assert.notEqual(f.runtime.command('STOP').steps.T?.started,true);assert.equal(f.state.calls.stop,0);assert.equal(f.state.calls.admitted,0);assert.equal(f.state.calls.physicalWrites,0);});
test('initial observation source trigger removal rejects before reservation/started and all effects',async()=>{const f=fixture({duringInitialObserve:(_s,sql)=>sql.exec('DROP TRIGGER IF EXISTS workflow_selection_stop_source_update')});const result=await f.run().catch(error=>({error:error.code||error.message}));assert.equal(completed(result),false);assert.notEqual(f.runtime.command('STOP').steps.T?.started,true);assert.equal(f.state.calls.stop,0);assert.equal(f.state.calls.admitted,0);assert.equal(f.state.calls.physicalWrites,0);});
