import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionRevisionAcks} from './executionRevisionAcks.mjs';
const tab=(revision=1)=>({id:'T',tabId:'T',name:'frozen',executionStorageRevision:revision,
 executionSubject:{version:2,tabId:'T',subjectId:'S',executionNamespace:'N'}});
const ack=(revision=2,patch={})=>({success:true,executionRevisions:[{tabId:'T',subjectId:'S',revision}],...patch});

test('contiguous owned ACKs advance replacement objects and frozen proof, while preserving both metadata snapshots',()=>{
 const a=createExecutionRevisionAcks(),row=tab(),replacement={...tab(),name:'pending'};
 a.ack('N',[row],ack(),()=>[replacement]);assert.equal(replacement.executionStorageRevision,2);assert.equal(replacement.name,'pending');
 const next=tab();a.prepare('N',[next]);assert.equal(next.executionStorageRevision,2);assert.equal(next.name,'frozen');
 a.ack('N',[next],ack(3));const oldest=tab();a.prepare('N',[oldest]);assert.equal(oldest.executionStorageRevision,3);
 a.ack('N',[tab()],ack(2));const repeated=tab();a.prepare('N',[repeated]);assert.equal(repeated.executionStorageRevision,3);
});
test('missing, negative, foreign and skipped-revision receipts cannot advance metadata CAS',()=>{
 for(const result of [undefined,ack(2,{success:false}),ack(7),ack(2,{projectId:'foreign'}),
  {success:true,executionRevisions:[{tabId:'T',subjectId:'other',revision:2}]}]) {
  const a=createExecutionRevisionAcks(),row=tab();a.ack('N',[row],result,()=>[row]);a.prepare('N',[row]);assert.equal(row.executionStorageRevision,1);
 }
});
test('fresh admission after a foreign revision does not bridge an old frozen snapshot across the gap',()=>{
 const a=createExecutionRevisionAcks();a.ack('N',[tab()],ack(2));
 a.ack('N',[tab(4)],ack(5));const old=tab();a.prepare('N',[old]);assert.equal(old.executionStorageRevision,1);
 const fresh=tab(4);a.prepare('N',[fresh]);assert.equal(fresh.executionStorageRevision,5);
});
test('catalog hydration respects pending saves, acknowledged revision, namespace and subject',()=>{
 const a=createExecutionRevisionAcks(),current=tab();a.ack('N',[current],ack(),()=>[current]);
 assert.equal(a.canHydrate('N',current,tab(),false),false);
 assert.equal(a.canHydrate('N',current,tab(2),true),false);
 assert.equal(a.canHydrate('N',current,tab(2),false),true);
 assert.equal(a.canHydrate('N',current,{...tab(3),executionSubject:{...tab().executionSubject,subjectId:'other'}},false),false);
 const wrongNamespace=tab();a.prepare('Q',[wrongNamespace]);assert.equal(wrongNamespace.executionStorageRevision,1);
});

test('cwd point ACK requires the exact subject, value, and contiguous known before revision',()=>{
 const a=createExecutionRevisionAcks(),current=tab();
 a.ack('N',[current],ack(),()=>[current]);
 const point={version:1,kind:'cwd',namespace:'N',tabId:'T',subjectId:'S',fromRevision:2,toRevision:3,
  executionSubject:{...current.executionSubject,cwd:'/new'}};
 assert.equal(a.matchesPoint('N',current,point,'/wrong'),false);
 assert.equal(a.point('N',current,{...point,subjectId:'other'}),false);
 assert.equal(a.point('N',current,{...point,fromRevision:4,toRevision:5}),false);
 assert.equal(a.point('N',current,point),true);assert.equal(current.executionStorageRevision,3);
 const before=tab();a.prepare('N',[before]);assert.equal(before.executionStorageRevision,3);
});

test('Main point-field proof joins only this successful snapshot to its exact final revision',()=>{
 const proof={version:1,kind:'main-owned-fields',namespace:'N',tabId:'T',subjectId:'S',fromRevision:1,toRevision:6};
 const a=createExecutionRevisionAcks(),row=tab(),replacement={...tab(),name:'new local draft'};
 a.ack('N',[row],ack(7,{executionReconciliations:[proof]}),()=>[replacement]);
 assert.equal(replacement.executionStorageRevision,7);assert.equal(replacement.name,'new local draft');
 const queued=tab();a.prepare('N',[queued]);assert.equal(queued.executionStorageRevision,7);assert.equal(queued.name,'frozen');
 assert.equal(a.canHydrate('N',replacement,tab(6),false),false);
});

test('foreign, malformed, partial and failed Main point proofs cannot approve a revision jump',()=>{
 const proof={version:1,kind:'main-owned-fields',namespace:'N',tabId:'T',subjectId:'S',fromRevision:1,toRevision:6};
 for(const delta of [{namespace:'other'},{tabId:'other'},{subjectId:'other'},{fromRevision:2},{toRevision:5},
  {toRevision:'6'},{version:2},{kind:'cwd'}]) {
  const a=createExecutionRevisionAcks(),row=tab();
  a.ack('N',[row],ack(7,{executionReconciliations:[{...proof,...delta}]}),()=>[row]);
  assert.equal(row.executionStorageRevision,1);
 }
 for(const result of [ack(7,{success:false,executionReconciliations:[proof]}),ack(7,{executionReconciliations:{}})]) {
  const a=createExecutionRevisionAcks(),row=tab();a.ack('N',[row],result,()=>[row]);assert.equal(row.executionStorageRevision,1);
 }
});
