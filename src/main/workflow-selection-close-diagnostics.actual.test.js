'use strict';
// Actual current/assertCloseGuard methods; capture, checkGuard and logger are
// dependency doubles. No constructor, journal, live DB, process or Electron.
// The Main controls below execute only its extracted pre-archive guard branch.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {WorkflowSelectionRuntime}=require('./workflow-selection-runtime');
const copy=value=>JSON.parse(JSON.stringify(value));
const ERROR='selection_close_execution_changed';
const BEFORE='before_process_observation',AFTER='after_process_observation';
function fixture() {
  const state={publication:{version:1,migrationVersion:1,generation:7},membership:{workflowId:'workflow',revision:3},
    now:{placementId:'placement',execution:{tabType:'terminal',scope:{projectId:'namespace'},runtime:{token:'runtime'}},
      subject:{version:2,cwd:'/private/fixture'},runtimeOwner:{mainInstanceId:'main',inputRevision:2}}};
  const member={tabId:'tab',generation:7,membership:copy(state.membership),...copy(state.now)};
  const step={state:'prepared',started:false};
  const counts={checkGuard:0,publication:0,membership:0,capture:0,log:0},logs=[];
  const runtime=Object.assign(Object.create(WorkflowSelectionRuntime.prototype),{
    organization:{getPublication(){counts.publication++;return state.publication;},
      getMembership(tabId){counts.membership++;assert.equal(tabId,member.tabId);return state.membership;}},
    capture(tabId){counts.capture++;assert.equal(tabId,member.tabId);return state.now;},
    checkGuard(){counts.checkGuard++;return {member,step};},
    log(phase,data){counts.log++;logs.push({phase,data});},
  });
  return {state,member,step,counts,logs,runtime,guard:{mutationId:'mutation',tabId:'tab',guardToken:'guard'}};
}
const changes=[
  ['publication.version',f=>f.state.publication.version=2],
  ['publication.migrationVersion',f=>f.state.publication.migrationVersion=2],
  ['publication.generation',f=>f.state.publication.generation++],
  ['membership',f=>f.state.membership.revision++],
  ['placementId',f=>f.state.now.placementId='replacement'],
  ['execution',f=>f.state.now.execution.runtime.token='replacement'],
  ['subject',f=>f.state.now.subject.cwd='/replacement'],
  ['runtimeOwner',f=>f.state.now.runtimeOwner.inputRevision++],
];
function refuse(f,boundary) {
  assert.throws(()=>f.runtime.assertCloseGuard(f.guard,boundary),error=>
    error.code===ERROR&&error.message===ERROR&&error.statusCode===409);
  return f.logs.at(-1)?.data;
}
for(const [index,[component]] of changes.entries())test('first failed component: '+component,()=>{
  const f=fixture();
  // Every later component also differs: only the first predicate may win.
  for(const [,change] of changes.slice(index))change(f);
  const data=refuse(f,AFTER);
  assert.deepEqual(data,{version:1,boundary:AFTER,component,threw:false,error:ERROR});
  assert.equal(f.logs.length,1);assert.equal(f.logs[0].phase,'close-guard-refused');
  assert.deepEqual(f.counts,{checkGuard:1,publication:1,membership:index<3?0:1,capture:index<4?0:1,log:1});
});
test('unchanged close passes once without PASS logging; default and unknown labels are bounded',()=>{
  const f=fixture();assert.equal(f.runtime.assertCloseGuard(f.guard),undefined);
  assert.deepEqual(f.counts,{checkGuard:1,publication:1,membership:1,capture:1,log:0});
  f.state.publication.generation++;
  assert.equal(refuse(f).boundary,'unspecified');
  assert.equal(refuse(f,'/private/unknown-boundary').boundary,'unspecified');
});
test('publication and capture short circuits do not touch later fields or call capture twice',()=>{
  for(const [component,change] of changes) {
    const f=fixture();change(f);
    if(component.startsWith('publication.')) {
      f.runtime.organization.getMembership=()=>assert.fail('late membership lookup');
      f.runtime.capture=()=>assert.fail('late capture');
    } else if(component==='membership')f.runtime.capture=()=>assert.fail('late capture');
    else {
      const later=['placementId','execution','subject','runtimeOwner'];
      for(const field of later.slice(later.indexOf(component)+1))
        Object.defineProperty(f.state.now,field,{get(){assert.fail('late comparison '+field);}});
    }
    const data=refuse(f);assert.equal(data.component,component);assert.equal(data.threw,false);
    assert.equal(f.counts.capture,component.startsWith('publication.')||component==='membership'?0:1);
  }
});
for(const component of ['publication','membership','capture','placementId','execution','subject','runtimeOwner'])
test('thrown '+component+' is still false/409, with only safe error code',()=>{
  const f=fixture(),error=Object.assign(Error('private body /private/secret'),{code:'SQLITE_IOERR'});
  const throwing=()=>{throw error;};
  if(component==='publication')f.runtime.organization.getPublication=throwing;
  else if(component==='membership')f.runtime.organization.getMembership=throwing;
  else if(component==='capture')f.runtime.capture=throwing;
  else Object.defineProperty(f.state.now,component,{get:throwing});
  const data=refuse(f,BEFORE);
  assert.deepEqual(data,{version:1,boundary:BEFORE,component,threw:true,error:ERROR,errorCode:'SQLITE_IOERR'});
  assert.equal(f.runtime.current(f.member),false);assert.equal(f.logs.length,1);
});
test('fingerprint exception is attributed to the comparison that threw',()=>{
  for(const component of ['membership','execution','subject','runtimeOwner']) {
    const f=fixture(),value=component==='membership'?f.state.membership:f.state.now[component];
    Object.defineProperty(value,'unread',{enumerable:true,get(){throw Object.assign(Error('/private/body'),{code:'EIO'});}});
    const data=refuse(f);assert.equal(data.component,component);assert.equal(data.threw,true);assert.equal(data.errorCode,'EIO');
  }
});
test('archived current checks publication/membership only and preserves the same failure order',()=>{
  const f=fixture();f.runtime.capture=()=>assert.fail('archived capture');f.state.now=null;
  assert.equal(f.runtime.current(f.member,{archived:true}),true);
  assert.equal(f.counts.publication,1);assert.equal(f.counts.membership,1);assert.equal(f.counts.log,0);
  for(const [,change] of changes.slice(0,4)) {
    const other=fixture(),diagnostic={};change(other);other.runtime.capture=()=>assert.fail('archived capture');
    assert.equal(other.runtime.current(other.member,{archived:true,diagnostic}),false);
  }
});
test('explicit runtimeOwner option retains its old comparison and omitted option uses member owner',()=>{
  const f=fixture();f.state.now.runtimeOwner.inputRevision++;
  assert.equal(f.runtime.current(f.member),false);
  assert.equal(f.runtime.current(f.member,{runtimeOwner:copy(f.state.now.runtimeOwner)}),true);
  assert.equal(f.runtime.current(f.member,{runtimeOwner:null}),false);
  assert.equal(f.counts.capture,3);assert.equal(f.logs.length,0);
});
test('started/UNKNOWN non-file refusal performs no publication, membership or capture lookup',()=>{
  const f=fixture();f.step.started=true;f.step.state='started';
  f.runtime.organization.getPublication=()=>assert.fail('started publication lookup');
  f.runtime.capture=()=>assert.fail('started capture');
  for(const boundary of [BEFORE,AFTER,undefined])assert.equal(refuse(f,boundary).component,'started');
  assert.deepEqual(f.counts,{checkGuard:3,publication:0,membership:0,capture:0,log:3});
});
test('started file still checks current; file type is not a bypass',()=>{
  const f=fixture();f.step.started=true;f.member.execution.tabType=f.state.now.execution.tabType='file';
  assert.equal(f.runtime.assertCloseGuard(f.guard),undefined);
  f.state.now.placementId='other';assert.equal(refuse(f).component,'placementId');
  assert.equal(f.counts.capture,2);
});
test('original checkGuard error identity propagates before diagnostics or lookups',()=>{
  const f=fixture(),original=Object.assign(Error('original guard failure'),{code:'selection_close_guard_changed'});
  f.runtime.checkGuard=()=>{throw original;};
  assert.throws(()=>f.runtime.assertCloseGuard(f.guard,BEFORE),error=>error===original);
  assert.deepEqual(f.counts,{checkGuard:0,publication:0,membership:0,capture:0,log:0});
});
test('logger failure cannot replace refusal or cause another capture; success never calls logger',()=>{
  const f=fixture();f.runtime.log=()=>{f.counts.log++;throw Error('logger failed');};
  assert.equal(f.runtime.assertCloseGuard(f.guard),undefined);assert.equal(f.counts.log,0);
  f.state.now.runtimeOwner.inputRevision++;refuse(f,AFTER);
  assert.equal(f.counts.log,1);assert.equal(f.counts.capture,2);
});
test('collector adds no serialization or reads of later comparison values',()=>{
  const run=diagnostics=>{
    const f=fixture(),reads=[];
    for(const target of [f.state.membership,f.member.membership,f.state.now.execution,f.member.execution,
      f.state.now.subject,f.member.subject,f.state.now.runtimeOwner,f.member.runtimeOwner]) {
      const value=target===f.state.now.execution?'changed':'same';
      Object.defineProperty(target,'probe',{enumerable:true,get(){reads.push(value);return value;}});
    }
    assert.equal(f.runtime.current(f.member,diagnostics?{diagnostic:{}}:{}),false);
    return {reads,counts:f.counts};
  };
  const without=run(false),withCollector=run(true);
  assert.deepEqual(withCollector,without);assert.deepEqual(withCollector.reads,['same','same','changed','same']);
});
test('body-free bounded record omits IDs, paths, values, bodies, error messages and unsafe codes',()=>{
  const secret='/private/body\nDRAFT=secret ENV=secret '+('secret '.repeat(4096));
  for(const [component,change] of changes) {
    const f=fixture();change(f);f.guard.mutationId=f.guard.tabId=f.member.tabId=secret;
    f.member.subject.body=f.state.now.subject.body=secret;
    f.member.execution.body=f.state.now.execution.body=secret;
    const data=refuse(f,secret),wire=JSON.stringify(data);
    assert.equal(data.component,component);assert.equal(wire.includes('secret'),false);assert.equal(wire.includes('/private'),false);
    assert(Buffer.byteLength(wire)<=384);assert.deepEqual(Object.keys(data).sort(),['boundary','component','error','threw','version']);
  }
  for(const code of [undefined,secret,'/private/path','BAD CODE','x'.repeat(97),{secret}]) {
    const f=fixture();f.runtime.capture=()=>{throw Object.assign(Error(secret),{code});};
    const data=refuse(f);assert.equal(Object.hasOwn(data,'errorCode'),false);assert(Buffer.byteLength(JSON.stringify(data))<=384);
  }
  const f=fixture();f.runtime.capture=()=>{throw Object.defineProperty(Error(secret),'code',{get(){throw Error(secret);}});};
  assert.equal(refuse(f).errorCode,undefined);
});
test('maximum safe code and longest static component stay within 384 UTF-8 bytes',()=>{
  const f=fixture(),code='A'.repeat(96);
  Object.defineProperty(f.state.publication,'migrationVersion',{get(){throw Object.assign(Error('private'),{code});}});
  const data=refuse(f,AFTER);assert.equal(data.component,'publication.migrationVersion');assert.equal(data.errorCode,code);
  assert(Buffer.byteLength(JSON.stringify(data))<=384);
});
test('actual capture method keeps its original dependency call counts under diagnostics',()=>{
  const f=fixture(),calls={tab:0,row:0,signature:0,owner:0};
  f.runtime.capture=WorkflowSelectionRuntime.prototype.capture;
  const row={id:1,restore_placement_id:f.member.placementId};
  f.runtime.organization.getTab=()=>{calls.tab++;return {executionResolved:true,nativeRow:{id:1},
    membership:f.state.membership,executionSubject:f.state.now.subject};};
  f.runtime.row=()=>{calls.row++;return row;};
  f.runtime.groupActions={signature(){calls.signature++;return f.state.now.execution;}};
  f.runtime.captureOwner=()=>{calls.owner++;return f.state.now.runtimeOwner;};
  f.runtime.assertCloseGuard(f.guard,BEFORE);
  assert.deepEqual(calls,{tab:1,row:2,signature:1,owner:1});assert.equal(f.counts.publication,2);assert.equal(f.logs.length,0);
  f.state.now.runtimeOwner.inputRevision++;assert.equal(refuse(f,AFTER).component,'runtimeOwner');
  assert.deepEqual(calls,{tab:2,row:4,signature:2,owner:2});assert.equal(f.counts.publication,4);
});

// Read source, never load main.js/Electron. Execute exactly the branch before
// closeIntentHash: commit, archive, process lookup and durable state are doubles
// or outside this boundary. These are not live Full Close acceptance tests.
const main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const archiveStart=main.indexOf('async function archiveProjectTab(');
assert(archiveStart>=0);
const branch=main.slice(main.indexOf('  const sourceTabId',archiveStart),main.indexOf('  const closeIntentHash',archiveStart));
assert.equal((branch.match(/\.assertCloseGuard\(/g)||[]).length,2);
const archiveBranch=Function('workflowSelectionRuntime','observeWorkflowSelectionProcess',
  'return async function({projectId,tab,groupCloseGuard,closeRequest}) {\n'+branch+'\nreturn {reachedArchive:true};}');
function mainFixture() {
  const f=fixture();f.runtime.owns=()=>true;f.runtime.archiveReplay=()=>null;
  f.request={projectId:'namespace',tab:{tabId:'tab'},groupCloseGuard:f.guard};return f;
}
test('Main source labels before-observation refusal and never begins observation',async()=>{
  const f=mainFixture();f.state.publication.generation++;
  const entry=archiveBranch(f.runtime,async()=>assert.fail('observation before first PASS'));
  await assert.rejects(entry(f.request),error=>error.code===ERROR);
  assert.equal(f.logs[0].data.boundary,BEFORE);assert.equal(f.counts.capture,0);
});
for(const [component,change] of changes)test('Main source binds '+component+' refusal after observation',async()=>{
  const f=mainFixture();let observations=0;
  const entry=archiveBranch(f.runtime,async()=>{observations++;change(f);return {known:true};});
  await assert.rejects(entry(f.request),error=>error.code===ERROR&&error.statusCode===409);
  assert.equal(observations,1);assert.equal(f.logs.length,1);
  assert.equal(f.logs[0].data.boundary,AFTER);assert.equal(f.logs[0].data.component,component);
  assert.equal(f.step.started,false);assert.equal(f.step.state,'prepared');
  assert.equal(f.counts.capture,1+(changes.findIndex(([name])=>name===component)>=4?1:0));
});
test('Main source unchanged PASS and unknown/rejected observation preserve prior results without PASS logs',async()=>{
  for(const [observe,expected] of [
    [async()=>({known:true}),{reachedArchive:true}],
    [async()=>({known:false}),{success:false,error:'selection_close_process_unknown'}],
    [async()=>{throw Error('lookup failure');},{success:false,error:'selection_close_process_unknown'}],
  ]) {
    const f=mainFixture(),entry=archiveBranch(f.runtime,observe),result=await entry(f.request);
    assert.deepEqual(result,expected);
    assert.equal(f.counts.capture,2);assert.equal(f.logs.length,0);assert.equal(f.step.started,false);
  }
});
test('Main source archive replay and original UNKNOWN throw bypass all new checks and diagnostics',async()=>{
  for(const outcome of [{success:true,historyId:1},Object.assign(Error('original UNKNOWN'),{code:'selection_close_archive_unknown'})]) {
    const f=mainFixture();f.runtime.archiveReplay=()=>{if(outcome instanceof Error)throw outcome;return outcome;};
    const entry=archiveBranch(f.runtime,async()=>assert.fail('replayed observation'));
    if(outcome instanceof Error)await assert.rejects(entry(f.request),error=>error===outcome);
    else assert.equal(await entry(f.request),outcome);
    assert.deepEqual(f.counts,{checkGuard:0,publication:0,membership:0,capture:0,log:0});
  }
});
