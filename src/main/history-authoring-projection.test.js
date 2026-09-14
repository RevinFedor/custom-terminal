'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const fixture = require('./fixtures/structured-authoring-37de-confirmed.json');
const { historyAuthoringProjectionFromReceipt, normalizeHistoryAuthoringProjection,
  projectHistoryAuthoringEntry, rebindHistoryAuthoringProjection } = require('./history-authoring-projection');
const { normalizePromptPresentationSnapshot, saveAuditedPromptPresentation,
  backfillConfirmedSystemPromptPresentations, backfillConfirmedCanonicalAuthoringPresentations,
  decorateHistoryPromptPresentations } = require('./history-prompt-presentations');
const { selectHistoryResponseTimingTarget, decorateHistoryResponseTimings } = require('./history-response-timings');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { createCodexImageRequestProjection } = require('./codex-image-request-projection');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const clone = value => JSON.parse(JSON.stringify(value));

function memoryStore() {
  const rows = [];
  return { rows, getHistoryPromptPresentations: (tool, sid) => rows.filter(r => r.toolType === tool && r.sessionId === sid),
    getHistoryPromptPresentationsForEntries: (_tool, uuids) => rows.filter(r => uuids.includes(r.entryUuid)),
    getHistoryPromptPresentationByAudit: (tool, sid, ts, hash) => rows.find(r => r.toolType === tool && r.sessionId === sid && r.auditTimestamp === ts && r.transportHash === hash) || null,
    saveHistoryPromptPresentation(input) {
      const found = this.getHistoryPromptPresentationByAudit(input.toolType,input.sessionId,input.auditTimestamp,input.transportHash);
      if (found) Object.assign(found, clone(input), { entryUuid: input.entryUuid || found.entryUuid });
      else rows.push(clone(input)); return true;
    }, bindHistoryPromptPresentationEntry() { throw Error('no guessing an audit address'); } };
}
const rawUser = () => clone(fixture.entries.find(e => e.role === 'user'));
function read(store, entry = rawUser()) { return decorateHistoryPromptPresentations(store, {toolType:'codex',sessionId:entry.sessionId,entries:[entry]})[0]; }

test('physical37DE receipt -> durable canonical sidecar -> canonical13 alias, without modifying raw row', () => {
  const store=memoryStore(), entry=rawUser(), before=clone(entry);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]),1);
  const result=read(store,entry);
  assert.equal(result.content,fixture.record.receipt.promptText.replace(/\[imagePath:[^\]]+\]/,'[Image #1]'));
  assert.equal(result.content.includes(fixture.record.receipt.imageRequestProjection.images[0].transportPath),false);
  assert.deepEqual(entry,before);assert.deepEqual(result.imagePaths,entry.imagePaths);
  assert.equal(store.rows[0].schemaVersion,4);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]),0);
});

test('existing startup helper migrates confirmed authored data before any History read or TTL pruning', () => {
  const store=memoryStore();
  backfillConfirmedSystemPromptPresentations(store,[fixture.record]);
  const persisted=clone(store.rows);
  assert.equal(persisted.length,1);
  const reopened=memoryStore();reopened.rows.push(...persisted);
  assert.match(read(reopened).content,/Rewind\.\[Image #1\]/);
  // No receipt lookup exists on the reopened reader at all.
  assert.equal(read(reopened).uuid,rawUser().uuid);
});

test('ordinary late audit and forged client projection cannot erase or replace an exact stored projection', () => {
  const store=memoryStore();backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]);
  const record=fixture.record;
  const fake=historyAuthoringProjectionFromReceipt(record);fake.parts[0].text='foreign';
  const normalized=normalizePromptPresentationSnapshot({...record.receipt.presentationSnapshot,authoringProjection:fake});
  assert.equal(normalized.authoringProjection,undefined);
  assert.equal(saveAuditedPromptPresentation(store,{toolType:'codex',sessionId:record.sessionId,
    auditTimestamp:record.auditIdentity.auditTimestamp,actualHash:record.receipt.actualHash,
    actualText:record.receipt.transportText,snapshot:{...record.receipt.presentationSnapshot,authoringProjection:fake}}),true);
  assert.equal(store.rows[0].schemaVersion,4);assert.match(read(store).content,/Rewind\.\[Image #1\]/);
});

for (const [label, mutate] of [
  ['unconfirmed',r=>{r.state='audit-pending';}], ['other attempt',r=>{r.attemptId='foreign';}],
  ['other operation',r=>{r.operationKey='foreign';}], ['other tab',r=>{r.tabId='foreign';}],
  ['other provider',r=>{r.provider='claude';}], ['other session',r=>{r.sessionId='foreign';}],
  ['other audit scope',r=>{r.auditIdentity.attemptId='foreign';}],
  ['wrong actual hash',r=>{r.receipt.actualHash='foreign';}],
  ['wrong source hash',r=>{r.receipt.imageRequestProjection.authoringTransport.sourceHash='0'.repeat(64);}],
  ['no typed spans',r=>{delete r.receipt.imageRequestProjection.authoringTransport;}],
  ['partial span',r=>{r.receipt.imageRequestProjection.authoringTransport.imageRanges[0].end--;}],
  ['changed outside span',r=>{r.receipt.transportText+='!';}],
  ['wrong image ref',r=>{r.receipt.expectedImageRefs[0].path='/other/same-name.png';}],
]) test('confirmed mapping rejects '+label,()=>{
  const r=clone(fixture.record);mutate(r);const store=memoryStore();
  assert.equal(historyAuthoringProjectionFromReceipt(r),null);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[r]),0);assert.equal(store.rows.length,0);
});

test('row identity, timestamp, whole-text hash and image slot must match before semantic projection',()=>{
  const store=memoryStore();backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]);
  for(const mutate of [e=>{e.sessionId='foreign';},e=>{e.timestamp='2026-09-14T00:00:00Z';},
    e=>{e.uuid='other';e.sourceIdentity='foreign';e.sourceIdentityAliases=[];},
    e=>{e.content+='!';},e=>{e.imagePaths[0].path='/foreign/image.png';}]){
    const entry=rawUser();mutate(entry);
    const row=store.rows[0],proof=row.chips.find(i=>i.kind==='authoring-projection');
    assert.equal(projectHistoryAuthoringEntry(proof,row,entry,entry.imagePaths),null,String(mutate));
  }
});

test('corrupt durable projection and contradictory claims stay closed; image IDs cannot be reordered',()=>{
  const original=historyAuthoringProjectionFromReceipt(fixture.record);
  for(const mutate of [p=>{p.parts[0].text+='!';},p=>{p.parts[1].id=2;},
    p=>{p.parts[1].transportPath='/tmp/foreign.png';},p=>{p.binding.sessionId='foreign';},
    p=>{p.requestSha256='0'.repeat(64);},p=>{p.binding.transportHash='wrong';}]){
    const bad=clone(original);mutate(bad);assert.equal(normalizeHistoryAuthoringProjection(bad),null);
  }
  const store=memoryStore(),other=clone(fixture.record);
  for(const holder of [other,other.receipt,other.receipt.imageRequestProjection,other.auditIdentity])holder.attemptId='other-confirmed-attempt';
  assert.ok(historyAuthoringProjectionFromReceipt(other));
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record,other]),0);
  assert.equal(store.rows.length,0);
  backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]);
  const row=store.rows[0];row.chips.find(c=>c.kind==='authoring-projection').parts[0].text='corrupt';
  assert.equal(read(store).content,rawUser().content);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[fixture.record]),0,'do not overwrite an ambiguous existing claim');
});

test('an identical path and a literal imagePath marker OUTSIDE typed image parts remain byte-exact text',()=>{
  const sourcePath='/source/image.png',alias='/tmp/noted-terminal-codex-image-input/fixture.png';
  const literal=`Typed path ${alias}; literal [imagePath: ${sourcePath}]; actual image:`;
  const marker=`[imagePath: ${sourcePath}]`,request=literal+marker+' end.';
  const typed={sourceHash:crypto.createHash('sha256').update(request).digest('hex'),imageRanges:[{start:literal.length,end:literal.length+marker.length,path:sourcePath}]};
  const plan=buildCodexImagePastePlan(request,p=>({success:true,path:p,inputPath:alias,mediaType:'image/png',size:1}),{authoringTransport:typed});
  const r=clone(fixture.record),scope={tabId:r.tabId,handoffId:r.handoffId,operationKey:r.operationKey,attemptId:r.attemptId};
  const proof=createCodexImageRequestProjection({...scope,requestText:request,transportText:plan.text,segments:plan.segments,imageRefs:plan.staged,authoringTransport:typed});
  Object.assign(r,{promptHash:proof.requestHash,promptLength:proof.requestLength});
  Object.assign(r.auditIdentity,{promptHash:proof.transportHash});
  Object.assign(r.receipt,{promptText:request,transportText:plan.text,actualHash:proof.transportHash,imageRequestProjection:proof,
    expectedImagePaths:[alias],expectedImageRefs:plan.staged,presentationSnapshot:{imagePaths:[{id:1,path:sourcePath,mediaType:'image/png',size:1}]}});
  const store=memoryStore();assert.equal(backfillConfirmedCanonicalAuthoringPresentations(store,[r]),1);
  const entry=rawUser();Object.assign(entry,{content:plan.text,imagePaths:[{id:1,path:sourcePath}]});
  delete entry.promptPresentationTransportHash;
  const projected=read(store,entry);
  assert.equal(projected.content,literal+'[Image #1] end.');
  assert.equal(projected.content.includes(alias),true);
  const recovered=decorateHistoryPromptPresentations(store,{toolType:'codex',sessionId:r.sessionId,entries:[entry],
    recoverManagedImageRef:()=>{throw Error('typed text must not use path recovery');}})[0];
  assert.equal(recovered.content,projected.content);assert.equal(recovered.imagePaths.length,1);
});

test('physical commentary16 is not a second final; final26 gets the stored duration unchanged',()=>{
  const entries=clone(fixture.entries),timing={...fixture.timing,durationMs:9874};
  assert.equal(selectHistoryResponseTimingTarget(entries,timing)?.uuid,entries.at(-1).uuid);
  let bound=null;
  const db={getPendingHistoryResponseTimings:()=>[timing],bindHistoryResponseTimingEntry:value=>{bound=value;return true;},
    getHistoryResponseTimingsForEntries:()=>bound?[{...timing,entryUuid:bound.entryUuid}]:[]};
  const result=decorateHistoryResponseTimings(db,{toolType:'codex',sessionId:timing.sessionId,tabId:fixture.record.tabId,entries});
  assert.equal(bound.entryUuid,'codex-assistant-'+timing.sessionId+'-26');
  assert.equal(result.at(-1).responseTiming.durationMs,9874);
  assert.equal(result.find(e=>e.textPhase==='commentary').responseTiming,undefined);
});

test('two real finals, foreign session, final outside interval and commentary-only remain unbound',()=>{
  const last=clone(fixture.entries.at(-1));
  for(const entries of [
    [...fixture.entries,{...last,uuid:'second-real-final'}],
    [{...last,sessionId:'foreign'}], [{...last,timestamp:new Date(fixture.timing.startTs-1).toISOString()}],
    [{...last,timestamp:new Date(fixture.timing.endTs+2001).toISOString()}],
    fixture.entries.filter(e=>e.textPhase!=='final_answer'),
  ]) assert.equal(selectHistoryResponseTimingTarget(entries,fixture.timing),null);
});
