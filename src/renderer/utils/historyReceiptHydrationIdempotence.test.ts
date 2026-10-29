import assert from 'node:assert/strict';
import test from 'node:test';
import {HistoryPromptHandoffStore,hydrateHistoryPromptHandoffFromDurableReceipt,
  getHistoryPromptHandoffsSnapshot,subscribeHistoryPromptHandoffs,consumeHistoryPromptHandoff} from './historyPromptHandoffs.ts';

const proof={auditTimestamp:'2026-10-28T14:00:00.000Z',actualHash:'exact-hash',sessionId:'S',entryUuid:'entry'};
const input={queueStatus:'sent' as const,reason:'durable-audit-confirmed',changedAt:2000,
  sendAttemptId:'A',sendOperationKey:'O',toolType:'codex' as const,proof};
function fixture(){
 const store=new HistoryPromptHandoffStore();
 store.begin({tabId:'T',handoffId:'H',toolType:'codex',text:'finite prompt',submittedAt:1000,
  sessionIdHint:'S',sendAttemptId:'A',sendOperationKey:'O'});
 return store;
}
test('identical exact receipt does not publish another handoff or invalidate readers',()=>{
 const store=fixture();let notifications=0;
 const off=store.subscribe('T',()=>notifications++);
 const first=store.settle('T','H',input);const count=notifications;
 for(let i=0;i<100;i++)assert.equal(store.settle('T','H',structuredClone(input)),first);
 assert.equal(notifications,count);off();
});
test('new optional exact proof is published once; conflicts and old attempts remain rejected',()=>{
 const store=fixture();const initial=store.settle('T','H',input);
 const enriched={...input,proof:{...proof,sourceIdentity:'source',recordByteOffset:42,actualLen:13,canonicalized:true,canonicalReason:'exact'}};
 const next=store.settle('T','H',enriched);assert.notEqual(next,initial);assert.equal(next?.auditProof?.sourceIdentity,'source');
 assert.equal(store.settle('T','H',structuredClone(enriched)),next);
 assert.equal(store.settle('T','H',{...enriched,proof:{...enriched.proof,actualHash:'foreign'}}),next);
 assert.equal(store.settle('T','H',{...enriched,sendAttemptId:'other'}),next);
});
test('actual durable hydration stops its own replay/entries/reread feedback',()=>{
 const record:any={tabId:'receipt-idempotence',handoffId:'H',operationKey:'O',attemptId:'A',provider:'codex',
  surface:'desktop-history',sessionId:'S',state:'confirmed',createdAt:1000,updatedAt:2000,
  receipt:{promptText:'finite prompt',...proof}};
 let notifications=0;const off=subscribeHistoryPromptHandoffs(record.tabId,()=>notifications++);
 try{
  const first=hydrateHistoryPromptHandoffFromDurableReceipt(record).handoff;assert(first);
  const count=notifications;
  for(let i=0;i<100;i++){
   hydrateHistoryPromptHandoffFromDurableReceipt(structuredClone(record));
   assert.equal(getHistoryPromptHandoffsSnapshot(record.tabId)[0],first);
  }
  assert.equal(notifications,count);
 }finally{off();consumeHistoryPromptHandoff(record.tabId,record.handoffId);}
});
