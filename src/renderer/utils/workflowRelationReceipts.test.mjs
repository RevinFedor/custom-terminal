import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowRelationReceipts} from './workflowRelationReceipts.mjs';
import {createExecutionRevisionAcks} from './executionRevisionAcks.mjs';

const subject={version:2,executionNamespace:'P',subjectId:'S',tabId:'A',cwd:'/fixture'};
const row=()=>({tabId:'A',name:'before',visualParentTabId:null,executionSubject:subject,executionStorageRevision:1});
const receipt={version:1,kind:'visual-parent',mutationId:'move',namespace:'P',tabId:'A',subjectId:'S',
  executionSubject:subject,storageId:1,fromRevision:1,toRevision:2,beforeParent:null,afterParent:'Q'};

test('two older queued metadata snapshots follow our relation and subsequent save ACK without losing their own names',()=>{
  const rel=createWorkflowRelationReceipts(),acks=createExecutionRevisionAcks(),live=row();
  const first={...row(),name:'first rename'},second={...row(),name:'second rename'};
  rel.capture('P',[first,second]);rel.record(receipt);assert.equal(acks.relation('P',live,receipt),true);
  acks.prepare('P',[first]);rel.prepare('P',[first],acks);
  assert.equal(first.visualParentTabId,'Q');assert.equal(first.executionStorageRevision,2);
  acks.ack('P',[first],{success:true,executionRevisions:[{tabId:'A',subjectId:'S',revision:3}]});
  acks.prepare('P',[second]);rel.prepare('P',[second],acks);
  assert.equal(second.executionStorageRevision,3);assert.equal(second.visualParentTabId,'Q');
  assert.equal(second.name,'second rename');
});

test('legacy receipt fixes only old queued echoes; a future explicit unparent is preserved',()=>{
  const rel=createWorkflowRelationReceipts();
  const old={tabId:'A',visualParentTabId:null,name:'queued rename'};
  rel.capture('P',[old]);rel.record({...receipt,subjectId:null,executionSubject:{version:1,projectId:'P',cwd:'/fixture',tabId:'A'},fromRevision:null,toRevision:null});
  rel.prepare('P',[old]);assert.equal(old.visualParentTabId,'Q');assert.equal(old.name,'queued rename');
  const later={tabId:'A',visualParentTabId:null,name:'deliberately unparented'};
  rel.capture('P',[later]);rel.prepare('P',[later]);assert.equal(later.visualParentTabId,null);
});

test('a foreign revision gap or subject cannot be bridged by our relation receipt',()=>{
  const rel=createWorkflowRelationReceipts(),acks=createExecutionRevisionAcks(),old=row();
  rel.capture('P',[old]);const later={...receipt,fromRevision:3,toRevision:4};rel.record(later);
  assert.equal(acks.relation('P',old,later),false);acks.prepare('P',[old]);rel.prepare('P',[old],acks);
  assert.equal(old.executionStorageRevision,1);assert.equal(old.visualParentTabId,null);
  assert.equal(acks.relation('P',old,{...receipt,executionSubject:{...subject,subjectId:'foreign'}}),false);
});
