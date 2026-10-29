'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/continuation-first-input.cjs');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');

test('actual Main read-only input port proves provisional source without writer adoption/reservation/response mutation',async t=>{
 const h=fixture(t),before=h.discovery.provisionalSubmitReservation;
 const proof=await h.readAdmission();assert.equal(proof.ready,true,JSON.stringify(proof));
 assert.equal(proof.mode,'provisional-resume');assert.equal(proof.target.sessionId,'source');
 assert.equal(proof.isCurrent(),true);assert.equal(h.discovery.provisionalSubmitReservation,before);
 assert.equal(h.control.writer,null);assert.equal(h.writes.length,0);
 h.change('input');assert.equal(proof.isCurrent(),false);
});
test('actual Main/Web factories wire the input port into BOTH consumers, HEAD restart callbacks and the history owner',()=>{
 const main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),web=fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');
 const tree=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
 const fn=name=>tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(tree)||'';
 for(const name of ['getBuildContinueOperations','getOrchestrationContinuationService'])
  assert.match(fn(name),/readInputAdmission:[\s\S]{0,180}readAgentContinuationInputAdmission\(tabId, expected\)/);
 assert.match(main,/readAgentRuntimeSnapshot: readMainPublicRuntimeSnapshot,\s*(?:readAgentInputRuntimeSnapshot:[^\n]+\n\s*)?readAgentContinuationInputAdmission,/);
 assert.match(main,/readInputAdmission: \(tabId, expected\) => readAgentContinuationInputAdmission\(tabId, expected\)/);
 assert.match(fn('start'),/readAgentContinuationInputAdmission = readAgentContinuationInputAdmissionFn \|\| null/);
 assert.match(fn('stop'),/readAgentContinuationInputAdmission = null/);
 assert.match(fn('start'),/prepareSend: \(\) => prepareQueuedBuildContinueInput\(request, buildContinueId\)/);
 assert.match(fn('prepareQueuedBuildContinueInput'),/owner\.prepareInput\(operationId, request\.tabId, request\.expectedTarget\)/);
 assert.match(fn('start'),/return getOrchestrationContinuationService\(\)\.prepareRequest/);
 assert.match(fn('runPreparedAgentSendScenario'),/continuationInputFence: continuationAdmission\.fence/);
});
test('read capability retires synchronously when its exact Resume lease or source observer is revoked',async t=>{
 const h=fixture(t),proof=await h.readAdmission();assert.equal(proof.ready,true);
 h.control.lease=false;assert.equal(proof.isCurrent(),false);assert.equal(h.writes.length,0);
});
for(const kind of ['unknown','absent','lease','busy','not-ready','draft','frame','provider','foreign-source','replacement-await','input-await','stop-await']){
 test('actual provisional input authority rejects '+kind,async t=>{
  const h=fixture(t);
  if(kind==='unknown'||kind==='absent')h.control.process=kind;
  if(kind==='lease')h.control.lease=false;
  if(kind==='busy')h.control.busy=true;
  if(kind==='not-ready')h.control.ready=false;
  if(kind==='draft')h.frame(true);
  if(kind==='frame')h.control.frame=false;
  if(kind==='provider')h.control.provider='claude';
  if(kind==='foreign-source')h.intent.sourceSessionId='foreign';
  if(kind.endsWith('-await'))h.control.processRead=async()=>h.change(kind==='replacement-await'?'owner':kind==='input-await'?'input':'stop');
  const r=await h.readAdmission();assert.equal(r.ready,false,JSON.stringify(r));assert.equal(h.writes.length,0);
  assert.equal(h.discovery.provisionalSubmitReservation,null);
 });
}
