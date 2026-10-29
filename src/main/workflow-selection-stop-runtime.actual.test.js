// Derived from the verified Pro Source package; these controls read CURRENT.
// Process/PTY/publication ports are controlled; SQLite databases are :memory:.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {fixture,load,copy}=require('./fixtures/workflow-selection-stop.fixture.cjs');
const Runtime=require('./workflow-selection-runtime.js').WorkflowSelectionRuntime;
const make=options=>fixture(options,Runtime);
const step=r=>r.step({mutationId:'stop-id',tabId:'tab'});
const ack=r=>r.ack({mutationId:'stop-id',tabId:'tab'});
const captured=f=>{const member=f.runtime.command('stop-id').members[0];return {member,scope:f.runtime.captureStopScope(member)};};
test('exact valid Stop persists before successful response; lost ACK read never repeats Stop',async()=>{
 const f=make();const result=await step(f.runtime);assert.equal(result.completed,true);
 assert.equal(f.runtime.command('stop-id').steps.tab.receipt.version,1);assert.equal(f.state.steps.get('stop-id:tab').state,'completed');
 assert.equal(ack(f.create()).completed,true);assert.equal(f.create().receipt('stop-id').completed,true);assert.equal((await step(f.create())).completed,true);
 assert.deepEqual(f.state.effects,{stop:1,observe:1,recover:0});
});
test('same original ID retries exact completed attestation commit after rollback; no re-Stop or re-observation',async()=>{
 const f=make({failCommitAfterStop:true});await step(f.runtime).catch(()=>{});
 assert.equal(f.runtime.command('stop-id').steps.tab.state,'started');assert.equal((await step(f.runtime)).completed,true);
 assert.equal(ack(f.runtime).completed,true);assert.deepEqual(f.state.effects,{stop:1,observe:1,recover:0});
});
test('already-produced historic attestation can commit after owner/input/run/source change; fresh Close still owns new scope',async()=>{
 const f=make({failCommitAfterStop:true});await step(f.runtime).catch(()=>{});
 f.state.owner.mainInstanceId='NEW';f.state.owner.inputRevision++;f.state.owner.runSeq++;f.state.row.codex_session_id='NEW_SID';
 assert.equal(ack(f.runtime).completed,true);assert.equal(f.runtime.command('stop-id').steps.tab.receipt.before.mainInstanceId,'MAIN');
 assert.deepEqual(f.state.effects,{stop:1,observe:1,recover:0});
});
test('receipt commit retries retain only one candidate per target; repeated failure cannot run effect again',async()=>{
 const f=make({failCommitAfterStop:true});await step(f.runtime).catch(()=>{});f.state.commitFailures=2;
 assert.equal(ack(f.runtime).pending,true);assert.equal((await step(f.runtime)).pending,true);
 assert.equal(f.runtime.pendingStopReceipts.size,1);assert.equal(ack(f.runtime).completed,true);assert.equal(f.runtime.pendingStopReceipts.size,0);
 assert.equal(f.state.effects.stop,1);assert.equal(f.state.effects.observe,1);
});
test('post-commit throw is recovered by exact reads with all later writes unavailable',async()=>{
 const f=make({failAfterCommittedStop:true});await step(f.runtime).catch(()=>{});
 assert.equal(f.runtime.receipt('stop-id').completed,true);const writes=f.state.writes;
 assert.equal(f.state.writesBlocked,true);assert.equal(ack(f.runtime).completed,true);assert.equal((await step(f.runtime)).completed,true);
 assert.equal(f.state.writes,writes);assert.equal(f.state.effects.stop,1);assert.equal(f.state.effects.observe,1);
});
test('restart without committed result cannot inherit volatile receipt or turn absence/replacement into old success',async()=>{
 const f=make({failCommitAfterStop:true});await step(f.runtime).catch(()=>{});const r=f.create();f.state.owner.mainInstanceId='RESTART';
 const before=f.state.commands.get('stop-id');assert.equal((await step(r)).pending,true);assert.equal(ack(r).pending,true);
 assert.equal(r.receipt('stop-id').completed,false);assert.equal(f.state.commands.get('stop-id'),before);assert.equal(f.state.effects.stop,1);assert.equal(f.state.effects.observe,1);
});
test('thrown owner leaves original UNKNOWN with safe durable diagnostic; restart exposes it without effects',async()=>{
 const f=make({stopThrows:true});const result=await step(f.runtime);assert.equal(result.pending,true);
 assert.equal(result.diagnostic.reason,'selection_stop_owner_threw');const r=f.create();
 assert.deepEqual(r.receipt('stop-id').results[0].diagnostic,result.diagnostic);assert.deepEqual(ack(r).diagnostic,result.diagnostic);
 assert.deepEqual((await step(r)).diagnostic,result.diagnostic);assert.equal(f.state.effects.stop,1);assert.equal(f.state.effects.observe,1);
});
test('foreign mutation or changed frozen original cannot consume retained receipt',async()=>{
 const f=make({failCommitAfterStop:true});await step(f.runtime).catch(()=>{});
 assert.throws(()=>f.runtime.ack({mutationId:'foreign',tabId:'tab'}));
 const command=f.runtime.command('stop-id');command.members[0].subject.cwd='/foreign';f.state.commands.set('stop-id',JSON.stringify(command));
 assert.equal(ack(f.runtime).pending,true);assert.equal(f.runtime.receipt('stop-id').completed,false);assert.equal(f.state.effects.stop,1);
});
test('original UNKNOWN still reserves target against new Close; no generic disposition',async()=>{
 const f=make({stopThrows:true});await step(f.runtime);const member=f.runtime.command('stop-id').members[0];
 assert.throws(()=>f.runtime.reserve({mutationId:'new-close',action:'close'},member),e=>e.code==='selection_action_target_in_progress:stop-id');
 assert.deepEqual(f.state.effects,{stop:1,observe:1,recover:0});
});
test('final scoped observation accepts unrelated global publication advance with exact target unchanged',()=>{
 const f=make(),{member,scope}=captured(f);f.state.publication.generation++;
 assert.equal(f.runtime.current(member),false);assert.equal(f.runtime.currentStopScope(member,scope),true);
});
for(const [name,mutate] of Object.entries({
 nativeStorage:f=>f.state.row.id++,subject:f=>f.state.row.execution_subject_id='other',namespace:f=>f.state.row.execution_namespace='other',cwd:f=>f.state.row.cwd='/other',command:f=>f.state.row.command_type='claude',source:f=>f.state.row.codex_session_id='other',ownerToken:f=>f.state.ownerToken='other',placement:f=>f.state.row.restore_placement_id='other',tabRevision:f=>f.state.tabRevision++,workflowRevision:f=>f.state.workflow.revision++,workflowLayout:f=>f.state.workflow.layout={splitSizes:[1,2]},workflowDeleted:f=>f.state.workflow.deletedGeneration=2,membership:f=>f.state.membership.revision++,publicationRewind:f=>f.state.publication.generation=0,publicationSchema:f=>f.state.publication.version=2,input:f=>f.state.owner.inputRevision++,run:f=>f.state.owner.runSeq++,launch:f=>f.state.owner.pendingLaunch=1,stop:f=>f.state.owner.stopRevision++,main:f=>f.state.owner.mainInstanceId='other',terminal:f=>f.state.owner.terminalId='other',lifecycle:f=>f.state.owner.lifecycleGeneration='other'
}))test('final scope rejects changed '+name,()=>{const f=make(),{member,scope}=captured(f);mutate(f);assert.equal(f.runtime.currentStopScope(member,scope),false);});
test('Main runtime matching callback is explicit and synchronous; Promise/truthy claims cannot pass',()=>{
 const f=make(),{member,scope}=captured(f);
 for(const matchExecutionRuntime of [()=>Promise.resolve(true),()=>({ok:true}),()=>1,()=>{throw Error('fail');}])assert.equal(f.runtime.currentStopScope(member,scope,{matchExecutionRuntime}),false);
});
test('source clock accepts arbitrary native metadata revision advance when exact source is unchanged',()=>{
 const f=make(),{member,scope}=captured(f);f.state.row.execution_storage_revision+=5;
 assert.equal(f.runtime.currentStopScope(member,scope),true);
});
test('source clock starts at current capture; earlier SID history cannot poison later context/settings updates',()=>{
 const f=make();f.state.row.codex_session_id='OLD';f.syncSource();f.state.row.codex_session_id='SID';f.syncSource();
 const {member,scope}=captured(f);f.state.row.context_pct=50;f.state.row.codex_model='NEW';f.state.row.provider_state='settings';f.syncSource();
 assert.equal(f.runtime.currentStopScope(member,scope),true);
});
for(const key of ['codex_session_id','cwd','command_type','visual_parent_tab_id'])test('source clock rejects actual '+key+' ABA',()=>{
 const f=make(),{member,scope}=captured(f),old=f.state.row[key];f.state.row[key]='OTHER';f.syncSource();f.state.row[key]=old;f.syncSource();
 assert.equal(f.runtime.checkStopScope(member,scope).reason,'selection_stop_scope_source_clock_changed');
});
test('source observer unavailable is rejected before started marker and does not block Close reservation',async()=>{
 const f=make();f.sourceSQL.exec('DROP TRIGGER workflow_selection_stop_source_update');
 await assert.rejects(step(f.runtime),e=>e.code==='selection_stop_source_trigger_unknown');
 assert.equal(f.runtime.command('stop-id').steps.tab,undefined);assert.deepEqual(f.state.effects,{stop:0,observe:0,recover:0});
 assert.doesNotThrow(()=>f.runtime.reserve({mutationId:'new-close',action:'close'},f.runtime.command('stop-id').members[0]));
});
test('source observer failure leaves old UNKNOWN readable, without observation or replay',async()=>{
 const f=make({stopThrows:true});await step(f.runtime);const bytes=f.state.commands.get('stop-id');f.sourceSQL.exec('UPDATE workflow_selection_stop_source_meta SET version=2');
 const restarted=f.create();assert.equal(restarted.receipt('stop-id').completed,false);assert.equal(ack(restarted).pending,true);assert.equal((await step(restarted)).pending,true);
 assert.equal(f.state.commands.get('stop-id'),bytes);assert.deepEqual(f.state.effects,{stop:1,observe:1,recover:0});
});
test('completed cached receipt is pruned before a genuinely new authorized Stop, without losing its result',async()=>{
 const f=make({failAfterCommittedStop:true});await step(f.runtime).catch(()=>{});assert.equal(f.runtime.receipt('stop-id').completed,true);
 f.state.writesBlocked=false;f.runtime.begin({version:1,mutationId:'second-stop',action:'stop',members:[{projectId:'__tab_catalog_v2__',tabId:'tab'}],origin:{workflowId:'workflow',windowId:null}});
 const result=await f.runtime.step({mutationId:'second-stop',tabId:'tab'});
 // The synthetic wrapper throws after this commit too; the exact proof must
 // remain recoverable and must not conflict with the old completed cache.
 assert.equal(f.runtime.receipt('second-stop').completed,true);
 assert.equal(f.runtime.ack({mutationId:'second-stop',tabId:'tab'}).completed,true);assert.equal(f.state.effects.stop,2);assert.equal(f.state.effects.observe,2);
});

test('legacy same-generation unchanged target keeps successful scope',()=>{
 const f=make({legacy:true}),{member,scope}=captured(f);assert.equal(f.runtime.currentStopScope(member,scope),true);
});
test('legacy global generation change keeps prior fence; no new anti-ABA authority is invented',()=>{
 const f=make({legacy:true}),{member,scope}=captured(f);f.state.publication.generation++;
 assert.equal(f.runtime.checkStopScope(member,scope).reason,'selection_stop_publication_changed');
});

test('typed SQLite error code survives diagnostics without raw exception message',async()=>{
 const f=make({stopThrows:true,stopError:Object.assign(Error('private path or prompt must not be stored'),{code:'SQLITE_BUSY'})});
 const result=await step(f.runtime);assert.equal(result.diagnostic.errorCode,'SQLITE_BUSY');
 assert.equal(result.diagnostic.reason,'selection_stop_owner_threw');assert.equal(f.state.commands.get('stop-id').includes('private path or prompt'),false);
});

test('initial process observation source ABA is rejected before durable started and physical Stop',async()=>{
 const f=make(),observe=f.runtime.observe;f.runtime.observe=async(...args)=>{
  const result=await observe(...args);f.state.row.codex_session_id='OTHER';f.syncSource();f.state.row.codex_session_id='SID';f.syncSource();return result;
 };
 await assert.rejects(step(f.runtime),e=>e.code==='selection_stop_scope_source_clock_changed');
 assert.equal(f.runtime.command('stop-id').steps.tab,undefined);assert.deepEqual(f.state.effects,{stop:0,observe:1,recover:0});
});
test('source observer lost during initial process lookup is a pre-effect rejection, not phantom UNKNOWN',async()=>{
 const f=make(),observe=f.runtime.observe;f.runtime.observe=async(...args)=>{
  const result=await observe(...args);f.sourceSQL.exec('DROP TRIGGER workflow_selection_stop_source_update');return result;
 };
 await assert.rejects(step(f.runtime),e=>e.code==='selection_stop_source_trigger_unknown');
 assert.equal(f.runtime.command('stop-id').steps.tab,undefined);assert.deepEqual(f.state.effects,{stop:0,observe:1,recover:0});
 assert.doesNotThrow(()=>f.runtime.reserve({mutationId:'new-close',action:'close'},f.runtime.command('stop-id').members[0]));
});
