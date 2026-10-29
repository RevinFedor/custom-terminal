// Derived from the verified Pro Source package; these controls read CURRENT.
// Process/PTY/publication ports are controlled; SQLite databases are :memory:.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const base=path.resolve(__dirname,'../../..');
const shared=require(path.join(base,'src/shared/workflow-organization.cjs'));
const {DatabaseSync}=require('node:sqlite');
const sourceHelper=require('../workflow-selection-stop-source.js');
const fingerprint=value=>crypto.createHash('sha256').update(shared.stableJson(value)).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
function load(file,override) { return require(override||path.join(base,file)); }
const {WorkflowSelectionRuntime}=load('src/main/workflow-selection-runtime.js');
const {WorkflowGroupActions}=load('src/main/workflow-group-actions.js');
const fixtureDatabases=new Set();
test.afterEach(()=>{for(const db of fixtureDatabases){db.close();fixtureDatabases.delete(db);}});
function fixture(options={},Runtime=WorkflowSelectionRuntime) {
 const state={commands:new Map(),steps:new Map(),writes:0,commitFailures:0,postCommitFailures:0,writesBlocked:false,effects:{stop:0,observe:0,recover:0},
  row:{id:7,tab_id:'tab',project_id:null,execution_namespace:'__tab_catalog_v2__',execution_subject_version:2,execution_subject_id:'subject',execution_archived:0,execution_storage_revision:4,cwd:'/cwd',restore_placement_id:'placement',claude_session_id:null,codex_session_id:'SID',gemini_session_id:null,tab_type:'terminal',command_type:'codex',file_path:null,parent_tab_id:null,visual_parent_tab_id:null},
  owner:{mainInstanceId:'MAIN',terminalId:'PTY',sdkOwnerId:null,sdkInputRevision:null,lifecycleGeneration:'PTY:1',runSeq:2,inputRevision:3,stopRevision:5,pendingLaunch:null},
  tabRevision:1,subjectVersion:2,workflow:{id:'workflow',kind:'user',revision:1,metadata:{},layout:{},deletedGeneration:null},fieldReceipt:null,ownerToken:'TOKEN',membership:{tabId:'tab',workflowId:'workflow',revision:1},publication:{version:1,migrationVersion:1,generation:1}};
 if(options.legacy){Object.assign(state.row,{project_id:'legacy',execution_namespace:null,execution_subject_version:1,execution_subject_id:null});state.subjectVersion=1;}
 const sourceSQL=new DatabaseSync(':memory:');fixtureDatabases.add(sourceSQL);
 const clockColumns=[...sourceHelper.SOURCE_COLUMNS,'execution_storage_revision','context_pct','cache_stats','provider_state','external_run','codex_model','codex_effort'];
 sourceSQL.exec('CREATE TABLE tabs ('+clockColumns.map(key=>'"'+key+'" '+(key==='id'?'INTEGER PRIMARY KEY':['execution_subject_version','execution_archived','execution_storage_revision'].includes(key)?'INTEGER':'TEXT')).join(',')+')');
 const initialColumns=clockColumns.filter(key=>Object.hasOwn(state.row,key));
 sourceSQL.prepare('INSERT INTO tabs('+initialColumns.join(',')+') VALUES('+initialColumns.map(()=>'?').join(',')+')').run(...initialColumns.map(key=>state.row[key]));
 const syncSource=()=>{
  const old=sourceSQL.prepare('SELECT * FROM tabs WHERE tab_id=?').get(state.row.tab_id);
  if(!old)return;
  const changed=clockColumns.filter(key=>Object.hasOwn(state.row,key)&&state.row[key]!==old[key]);
  if(changed.length)sourceSQL.prepare('UPDATE tabs SET '+changed.map(key=>'"'+key+'"=?').join(',')+' WHERE tab_id=?').run(...changed.map(key=>state.row[key]),state.row.tab_id);
 };
 let db;
 const transaction=operation=>({immediate(){
  const commands=new Map(state.commands),steps=new Map(state.steps),outer=!db.inTransaction;
  if(outer){sourceSQL.exec('BEGIN IMMEDIATE');db.inTransaction=true;}
  let committed=false;
  try{const result=operation();if(state.commitFailures){state.commitFailures--;throw Object.assign(Error('synthetic_commit_failure'),{code:'synthetic_commit_failure'});}
   if(outer){sourceSQL.exec('COMMIT');db.inTransaction=false;}committed=true;
   if(state.postCommitFailures){state.postCommitFailures--;state.writesBlocked=true;throw Object.assign(Error('synthetic_post_commit_failure'),{code:'synthetic_post_commit_failure'});}return result;
  }catch(error){if(!committed){state.commands=commands;state.steps=steps;if(outer){sourceSQL.exec('ROLLBACK');db.inTransaction=false;}}throw error;}
 }});
 db={transaction,exec:sql=>sourceSQL.exec(sql),prepare(sql){
  if(sql.includes('workflow_selection_stop_source_')||sql.includes('sqlite_master')||sql==='PRAGMA table_xinfo(tabs)'){
   const statement=sourceSQL.prepare(sql);
   return{get:(...args)=>{if(sql.startsWith('SELECT * FROM workflow_selection_stop_source_clocks WHERE tab_id='))syncSource();return statement.get(...args);},all:(...args)=>statement.all(...args),run:(...args)=>statement.run(...args)};
  }
  
  if(sql==='SELECT version FROM workflow_group_action_meta WHERE singleton=1')return{get:()=>({version:1})};
  if(sql==='SELECT * FROM workflow_group_actions WHERE mutation_id=?')return{get:id=>state.commands.has(id)?{command_json:state.commands.get(id)}:null};
  if(sql==='SELECT request_hash FROM workflow_group_actions WHERE mutation_id=?')return{get:()=>null};
  if(sql==='SELECT * FROM tabs WHERE tab_id=? AND execution_archived=0')return{all:()=>state.row.execution_archived?[ ]:[copy(state.row)]};
  if(sql==='SELECT COALESCE(MAX(id),0) id FROM tab_history')return{get:()=>({id:0})};
  if(sql.includes('JOIN workflow_group_actions'))return{all:(tab,id)=>[...state.steps].filter(([k,s])=>s.tabId===tab&&s.mutationId!==id&&s.state!=='completed').map(([k,s])=>({mutation_id:s.mutationId,command_json:state.commands.get(s.mutationId)}))};
  if(sql==='INSERT INTO workflow_group_actions VALUES(?,?,?,NULL)')return{run:(id,hash,text)=>{if(state.writesBlocked)throw Object.assign(Error('writes_blocked'),{code:'writes_blocked'});state.writes++;state.commands.set(id,text);}};
  if(sql==='UPDATE workflow_group_actions SET command_json=? WHERE mutation_id=?')return{run:(text,id)=>{if(state.writesBlocked)throw Object.assign(Error('writes_blocked'),{code:'writes_blocked'});state.writes++;state.commands.set(id,text);}};
  if(sql.startsWith('INSERT INTO workflow_group_close_steps'))return{run:(mutationId,tabId,guardToken)=>{if(state.writesBlocked)throw Object.assign(Error('writes_blocked'),{code:'writes_blocked'});state.writes++;state.steps.set(mutationId+':'+tabId,{mutationId,tabId,guardToken,state:'selection-started'});}};
  if(sql.startsWith("UPDATE workflow_group_close_steps SET state='completed'"))return{run:(mutationId,tabId)=>{if(state.writesBlocked)throw Object.assign(Error('writes_blocked'),{code:'writes_blocked'});state.writes++;state.steps.set(mutationId+':'+tabId,{...state.steps.get(mutationId+':'+tabId),state:'completed'});}};
  throw Error('unexpected SQL: '+sql);
 }};
 const database={db,getAppState:()=>({token:state.ownerToken,reason:'send'})};
 const organization={getWorkflow:()=>copy(state.workflow),getTab:()=>({revision:state.tabRevision,subjectVersion:state.subjectVersion,executionResolved:true,nativeRow:copy(state.row),executionSubject:shared.executionScopeForRow(state.row),membership:copy(state.membership)}),getPublication:()=>copy(state.publication),getMembership:()=>copy(state.membership),workflowRequired:()=>{}};
 const groupActions=Object.assign(Object.create(WorkflowGroupActions.prototype),{database,db,captureExecution:()=>({known:true,provider:state.row.command_type,projectId:state.row.execution_namespace||state.row.project_id,cwd:state.row.cwd,executionScope:shared.executionScopeForRow(state.row),sessionId:state.row.codex_session_id,instanceId:state.owner.mainInstanceId,terminalId:state.owner.terminalId,launchId:'LAUNCH',runSeq:state.owner.runSeq,acceptedSourceSessionId:null,inputRevision:state.owner.inputRevision,lifecycleGeneration:state.owner.lifecycleGeneration})});
 const config={database,organization,groupActions,captureOwner:()=>copy(state.owner),observe:async()=>{state.effects.observe++;return {known:true};},stop:async member=>{state.effects.stop++;if(options.stopThrows)throw options.stopError||Error('synthetic_stop_throw');const before=copy(member.runtimeOwner);state.owner.stopRevision++;if(options.failCommitAfterStop)state.commitFailures++;if(options.failAfterCommittedStop)state.postCommitFailures++;return{version:1,completed:true,before,after:copy(state.owner),result:{success:true}};},recoverRuntime:()=>{state.effects.recover++;throw Error('must_not_close');}};
 const create=()=>new Runtime(config),runtime=create();
 runtime.begin({version:1,mutationId:'stop-id',action:'stop',members:[{projectId:state.row.execution_namespace||state.row.project_id,tabId:'tab'}],origin:{workflowId:'workflow',windowId:null}});
 return {state,runtime,create,sourceSQL,syncSource};
}
module.exports={load,fixture,WorkflowSelectionRuntime,WorkflowGroupActions,copy,base};
