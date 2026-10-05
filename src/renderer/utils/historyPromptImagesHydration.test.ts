import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { beginHistoryPromptHandoff, consumeHistoryPromptHandoff, getHistoryPromptHandoffsSnapshot,
  hydrateHistoryPromptHandoffFromDurableReceipt } from './historyPromptHandoffs.ts';

const require = createRequire(import.meta.url);
const { imagePresentationFromReceipt } = require('../../main/history-authoring-projection');
const { createCodexImageRequestProjection } = require('../../main/codex-image-request-projection');
const { buildCodexImagePastePlan } = require('../../main/codex-image-transport');
const { promptAuditFingerprint } = require('../../main/prompt-audit-fingerprint');
let n = 0;
function fixture(paths = ['/var/private-image-A.jpg']) {
  const tabId = 'image-hydration-private', handoffId = 'H' + ++n, attemptId = 'A' + n;
  const operationKey = 'project:' + tabId + ':' + handoffId;
  const text = paths.map(path => '[imagePath: ' + path + ']').join('\n\n') + '\nordinary user text';
  const imageRefs = paths.map((path,id) => ({ id, path, mediaType:'image/jpeg', size:42 }));
  const plan = buildCodexImagePastePlan(text, sourcePath => ({success:true,path:sourcePath,inputPath:'/tmp/transport-'+sourcePath.split('/').at(-1)}));
  const proof = createCodexImageRequestProjection({tabId,handoffId,attemptId,operationKey,requestText:text,
    transportText:plan.text,segments:plan.segments,imageRefs});
  assert.ok(proof);
  const record:any = { tabId,handoffId,attemptId,operationKey,provider:'codex',surface:'desktop-history',sessionId:'S',
    promptHash:promptAuditFingerprint(text),promptLength:text.length,state:'audit-pending',createdAt:1,updatedAt:2,
    receipt:{operationKey,attemptId,promptText:text,transportText:plan.text,imageRequestProjection:proof,
      expectedImageRefs:imageRefs,expectedImagePaths:proof.images.map((image:any)=>image.transportPath),source:'codex-ios-terminal'} };
  record.imagePresentation = imagePresentationFromReceipt(record); assert.ok(record.imagePresentation);
  return record;
}
const own = (r:any, extra:any={}) => beginHistoryPromptHandoff({tabId:r.tabId,handoffId:r.handoffId,toolType:'codex',
  text:r.receipt.promptText,promptChips:[],imagePaths:[],sessionIdHint:r.sessionId,submittedAt:1,statusAtSend:'busy',...extra});
const current = (r:any) => getHistoryPromptHandoffsSnapshot(r.tabId).find(row=>row.handoffId===r.handoffId)!;
const cleanup = (t:any,r:any) => t.after(()=>consumeHistoryPromptHandoff(r.tabId,r.handoffId));

test('first durable attempt binds and enriches an existing empty local card in the same hydration call', t => {
  const r=fixture(); cleanup(t,r); own(r);
  const result=hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(result.hydrated,true); assert.equal(result.handoff?.sendAttemptId,r.attemptId);
  assert.equal(result.handoff?.imagePaths.length,1);
  assert.equal(current(r).imagePaths[0].path,r.receipt.expectedImageRefs[0].path);
  assert.equal(current(r).statusAtSend,'busy');
});

test('cold hydrate creates refs before returning; repeat source paths retain ordered occurrences', t => {
  const r=fixture(['/var/repeated.jpg','/var/repeated.jpg','/var/third.jpg']); cleanup(t,r);
  const a=hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(a.hydrated,true);
  assert.deepEqual(a.handoff?.imagePaths.map(x=>[x.id,x.path]),[[1,'/var/repeated.jpg'],[2,'/var/repeated.jpg'],[3,'/var/third.jpg']]);
  const b=hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.deepEqual(b.handoff?.imagePaths,a.handoff?.imagePaths);
  assert.equal(b.handoff?.queueStatus,a.handoff?.queueStatus);
  assert.equal(b.handoff?.text,r.receipt.promptText);
});

test('late image proof supplements already bound queued/sent rows without changing the delivery fact', t => {
  const r=fixture(); cleanup(t,r); own(r,{sendAttemptId:r.attemptId,sendOperationKey:r.operationKey});
  const initial=hydrateHistoryPromptHandoffFromDurableReceipt({...r,imagePresentation:null});
  assert.equal(initial.handoff?.imagePaths.length,0);
  const applied=hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(applied.handoff?.imagePaths.length,1);
  assert.equal(applied.handoff?.queueStatus,initial.handoff?.queueStatus);
  assert.equal(applied.handoff?.auditProof,initial.handoff?.auditProof);
});

test('foreign proof and changed request stay missing; existing authored refs are not overwritten', t => {
  for (const mutate of [(r:any)=>({...r.imagePresentation,attemptId:'foreign'}),
    (r:any)=>({...r.imagePresentation,operationKey:'foreign'}), (r:any)=>({...r.imagePresentation,requestHash:'foreign'})]) {
    const r=fixture();cleanup(t,r);own(r);r.imagePresentation=mutate(r);
    hydrateHistoryPromptHandoffFromDurableReceipt(r); assert.equal(current(r).imagePaths.length,0);
  }
  const r=fixture();cleanup(t,r);own(r,{sendAttemptId:r.attemptId,sendOperationKey:r.operationKey,text:'different local draft'});
  hydrateHistoryPromptHandoffFromDurableReceipt(r); assert.equal(current(r).imagePaths.length,0);
  const authored=fixture();cleanup(t,authored);own(authored,{sendAttemptId:authored.attemptId,sendOperationKey:authored.operationKey,
    imagePaths:[{id:1,path:'/var/intentional-authored.jpg'}]});
  hydrateHistoryPromptHandoffFromDurableReceipt(authored);
  assert.equal(current(authored).imagePaths[0].path,'/var/intentional-authored.jpg');
});

test('captured4944 uses actual Main proof in the local-card hydrate path, not a guessed preview path', t => {
  const file='/private/tmp/ios-dictation-scroll-20261004/audit-input-v1/receipt-4944.json';
  if(!existsSync(file))return t.skip('private captured packet unavailable; generic cases above remain required');
  const raw=JSON.parse(readFileSync(file,'utf8')).receipts[0];
  const r={...raw,receipt:raw,promptLength:raw.imageRequestProjection.requestLength,
    auditIdentity:{provider:raw.provider,attemptId:raw.attemptId,sessionId:raw.sessionId,
      promptHash:raw.actualHash,entryUuid:raw.entryUuid,sourceIdentity:raw.sourceIdentity,auditTimestamp:raw.auditTimestamp}};
  cleanup(t,r); own(r); r.imagePresentation=imagePresentationFromReceipt(r);
  assert.ok(r.imagePresentation);
  const outcome=hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(outcome.hydrated,true);
  assert.equal(outcome.handoff?.imagePaths[0]?.path,raw.expectedImageRefs[0].path);
  assert.equal(outcome.handoff?.queueStatus,'sent');
  assert.equal(outcome.handoff?.auditProof?.entryUuid,raw.entryUuid);
});
