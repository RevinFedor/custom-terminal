import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { captureHistoryComposerDraftOwner } from './historyComposerDraftOwner.mjs';

const panel = fs.readFileSync(process.env.HISTORY_QUEUE_RECEIPT_PANEL_SOURCE
  || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = panel.indexOf('  useEffect(() => {\n    let stopped = false;', panel.indexOf('const acknowledgeMaterializedHistoryReceipt ='));
const end = panel.indexOf('\n\n  useEffect(() => subscribeHistoryPromptHandoffs', start);
assert(start > 0 && end > start, 'actual current durable receipt effect');
const compile = text => ts.transpileModule(text, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture({primary=false, existing=true, attempt='A', handoff='H'}={}) {
  const filename=fileURLToPath(new URL('./historyPromptHandoffs.ts',import.meta.url));
  const mod=new Module(filename,import.meta);mod.filename=filename;mod.paths=Module._nodeModulePaths(fileURLToPath(new URL('.',import.meta.url)));
  mod._compile(compile(fs.readFileSync(process.env.HISTORY_QUEUE_RECEIPT_HANDOFF_SOURCE||filename,'utf8')),filename);
  const h=mod.exports,calls=[],warnings=[];let cleanup;
  const record={tabId:'cold-confirmed',handoffId:'H',operationKey:'O',attemptId:'A',provider:'codex',surface:'desktop-history',
    state:'confirmed',sessionId:'S',createdAt:1000,updatedAt:2000,applicationQueue:{version:1,id:9681,state:'completed'},
    receipt:{promptText:'exact user prompt',actualHash:'exact-hash',expectedHash:'exact-hash',exactAuditConfirmed:true,
      auditTimestamp:'2026-10-28T13:37:14.788Z',entryUuid:'native-user',sourceIdentity:'native-offset',sessionId:'S'}};
  if(existing)h.beginHistoryPromptHandoff({tabId:record.tabId,handoffId:handoff,toolType:'codex',text:'exact user prompt',
    sessionIdHint:'S',sendOperationKey:handoff==='H'?'O':'other-O',sendAttemptId:attempt,applicationQueueId:9681,
    submittedAt:1000,initialStatus:'application-queued',requiresAuditIdentity:true});
  const owner={historyPromptDrafts:{[record.tabId]:'NEW draft'},historyPromptDraftImages:{},historyPromptDraftChips:{},historyPromptDraftPendingImages:{}};
  const context=vm.createContext({...h,captureHistoryComposerDraftOwner,AbortController,
    console:{warn:(...v)=>warnings.push(v)},useEffect:fn=>{cleanup=fn();},tabId:record.tabId,toolType:'codex',
    primaryPhysicalCandidate:primary,primaryRoot:null,primaryHeader:null,primaryRootRef:{current:null},primaryReceiptCommitRef:{current:null},
    historyOwnerKey:'owner',historyOwnerKeyRef:{current:'owner'},historyOwnerGenerationRef:{current:1},
    presentedOwnerKey:'cold-owner',chipsFreshOwnerKey:'',receiptPresentationRevision:0,fileRewriteEpoch:1,entries:[],
    rawServerEntriesRef:{current:[]},committedHistoryEntriesRef:{current:{ownerKey:'cold-owner',entries:[]}},
    useUIStore:{getState:()=>owner,subscribe:()=>()=>{}},setReceiptPresentationRevision(){},historyDiag(){},
    setHistoryPromptDraft(){throw Error('must not change draft');},flushHistoryComposerDrafts(){throw Error('must not save draft');},
    // These are ordinary user receipts, never Compact delivery. Bind the new
    // effect dependency but fail if it tries to enter the local-command path.
    captureLocalPromptRemoval(){throw Error('ordinary receipt must not capture Compact card removal');},
    removeLocalPromptEntry(){throw Error('must not remove card without canonical publication');},
    consumeLocalPromptEntry(){throw Error('must not consume card without canonical publication');},
    acknowledgeMaterializedHistoryReceipt(){throw Error('no canonical ACK from a delivery receipt');},
    ipcRenderer:{invoke:async(channel)=>{calls.push(channel);assert.equal(channel,'agent:list-send-receipts');return {success:true,records:[record]};}},
  });
  return {h,record,calls,warnings,owner,
    async read(){cleanup?.();vm.runInContext(compile(panel.slice(start,end)),context);for(let i=0;i<20;i++)await Promise.resolve();},
    current:()=>h.getHistoryPromptHandoffsSnapshot(record.tabId),close:()=>cleanup?.()};
}
for(const primary of [false,true])test('actual '+(primary?'primary':'legacy')+' cold History: existing confirmed card stops queued loader before canonical availability',async t=>{
 const f=fixture({primary});t.after(f.close);await f.read();
 assert.deepEqual(f.warnings,[]);assert.equal(f.current().length,1);assert.equal(f.current()[0].queueStatus,'sent');
 assert.equal(f.current()[0].auditProof.entryUuid,'native-user');
 assert.deepEqual(f.calls,['agent:list-send-receipts']);assert.equal(f.owner.historyPromptDrafts['cold-confirmed'],'NEW draft');
 f.h.settleHistoryPromptHandoff('cold-confirmed','H',{queueStatus:'application-queued',reason:'late-application-ack'});
 assert.equal(f.current()[0].queueStatus,'sent');
});

test('durable top-level confirmation supersedes nested old pending audit without a canonical read',async t=>{
 const f=fixture();t.after(f.close);
 f.record.receipt.codexAudit={success:false,status:'pending',exactAuditConfirmed:false,actualHash:'old'};
 f.record.receipt.pasteAudit={success:false,error:'old-timeout'};
 await f.read();assert.deepEqual(f.warnings,[]);
 assert.equal(f.current()[0].queueStatus,'sent');assert.equal(f.current()[0].auditProof.entryUuid,'native-user');
});

for(const change of ['text','chip','image'])test('new list cannot apply old confirmation to same-H/O/A replacement with different '+change,async t=>{
 const f=fixture();t.after(f.close);
 f.record.receipt.authoringSnapshot={editorText:'exact user prompt',chips:[],imagePaths:[]};
 let replaced=false;
 const off=f.h.subscribeHistoryPromptHandoffs('cold-confirmed',(_rows,event)=>{
  if(replaced||event.type!=='settle')return;replaced=true;
  f.h.consumeHistoryPromptHandoff('cold-confirmed','H');
  f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',
   authoringText:change==='text'?'replacement':'exact user prompt',
   authoringChips:change==='chip'?[{id:'new-chip',kind:'paste',text:'new body'}]:[],
   authoringImagePaths:change==='image'?[{id:1,path:'/new.png'}]:[],
   sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:3000,initialStatus:'application-queued'});
 });t.after(off);
 await f.read();const replacement=f.current()[0];await f.read();await f.read();
 assert.equal(replaced,true);assert.deepEqual(f.warnings,[]);
 assert.equal(f.current()[0],replacement);assert.equal(replacement.queueStatus,'application-queued');
 assert.equal(replacement.auditProof,null);assert.equal(f.calls.length,3);
});

test('fresh receipt read can settle a restored byte-equivalent projection of the same immutable operation',async t=>{
 const f=fixture();t.after(f.close);await f.read();
 f.h.consumeHistoryPromptHandoff('cold-confirmed','H');
 f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',
  sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:3000,initialStatus:'application-queued'});
 await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current()[0].queueStatus,'sent');
 assert.equal(f.current()[0].submittedAt,3000,'not old presentation timing');
});

test('image enrichment ends the original list before adopting its synchronous same-H/O/A replacement',async t=>{
 const f=fixture();t.after(f.close);f.record.promptHash='request-hash';
 f.record.imagePresentation={version:1,operationKey:'O',attemptId:'A',requestHash:'request-hash',imagePaths:[{id:1,path:'/old.png'}]};
 let replacement;
 const off=f.h.subscribeHistoryPromptHandoffs('cold-confirmed',(_rows,event)=>{
  if(replacement||event.type!=='replay'||!_rows.some(row=>row.handoffId==='H'&&row.imagePaths.length>0))return;
  f.h.consumeHistoryPromptHandoff('cold-confirmed','H');
  replacement=f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',
   sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:3000,initialStatus:'application-queued'});
 });t.after(off);
 await f.read();assert.ok(replacement);assert.deepEqual(f.warnings,[]);
 assert.equal(f.current()[0],replacement);assert.equal(replacement.queueStatus,'application-queued');
});

for(const change of ['text','chip','image','prompt-chip'])test('legacy text receipt cannot confirm changed original '+change+' from matching display text',async t=>{
 const f=fixture();t.after(f.close);await f.read();f.h.consumeHistoryPromptHandoff('cold-confirmed','H');
 const replacement=f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',
  authoringText:change==='text'?'changed authoring':'exact user prompt',
  authoringChips:change==='chip'?[{id:'new',kind:'paste',text:'new body'}]:[],
  authoringImagePaths:change==='image'?[{id:1,path:'/new.png'}]:[],
  promptChips:change==='prompt-chip'?[{id:'prompt-new',kind:'prompt',text:'new context'}]:[],
  sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:3000,initialStatus:'application-queued'});
 await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current()[0],replacement);
 assert.equal(replacement.queueStatus,'application-queued');
});

test('legacy Run After prompt-chip snapshot still settles its exact current card',async t=>{
 const f=fixture({existing:false});t.after(f.close);const promptChips=[{id:'prompt-same',kind:'prompt',text:'same context'}];
 f.record.receipt.presentationSnapshot={text:'exact user prompt',promptChips,imagePaths:[]};
 f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',promptChips,
  sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:1000,initialStatus:'application-queued'});
 await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current()[0].queueStatus,'sent');
});

test('legacy exact bound image presentation still settles the existing original image card',async t=>{
 const f=fixture({existing:false});t.after(f.close);const images=[{id:1,path:'/original.png'}];
 f.record.promptHash='request-hash';
 f.record.imagePresentation={version:1,operationKey:'O',attemptId:'A',requestHash:'request-hash',imagePaths:images};
 f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'exact user prompt',imagePaths:images,
  sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:1000,initialStatus:'application-queued'});
 await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current()[0].queueStatus,'sent');
});

test('legacy external card with initially absent image metadata settles after its own exact image enrichment',async t=>{
 const f=fixture();t.after(f.close);f.record.promptHash='request-hash';
 f.record.imagePresentation={version:1,operationKey:'O',attemptId:'A',requestHash:'request-hash',imagePaths:[{id:1,path:'/external.png'}]};
 await f.read();assert.equal(f.current()[0].queueStatus,'application-queued');
 assert.equal(f.current()[0].authoringImagePaths.length,0);assert.equal(f.current()[0].imagePaths.length,1);
 await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current()[0].queueStatus,'sent');
});
test('cold History does not create a second SENT card from confirmed receipt alone',async t=>{
 const f=fixture({existing:false});t.after(f.close);await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current().length,0);
});
for(const fields of [{attempt:'new-A'},{handoff:'other-H'}])test('cold History preserves different current owner '+JSON.stringify(fields),async t=>{
 const f=fixture(fields);t.after(f.close);await f.read();assert.deepEqual(f.warnings,[]);assert.equal(f.current().length,1);
 assert.equal(f.current()[0].queueStatus,'application-queued');
});

test('same-H/O/A replacement during early settle cannot inherit the old receipt metadata or be returned as its successor',()=>{
 const f=fixture();f.record.receipt.enterAttemptAt=1234;let replaced=false;
 const off=f.h.subscribeHistoryPromptHandoffs('cold-confirmed',(_rows,change)=>{
  if(replaced||change.type!=='settle')return;replaced=true;
  f.h.consumeHistoryPromptHandoff('cold-confirmed','H');
  f.h.beginHistoryPromptHandoff({tabId:'cold-confirmed',handoffId:'H',toolType:'codex',text:'replacement',
   sessionIdHint:'S',sendOperationKey:'O',sendAttemptId:'A',submittedAt:3000,initialStatus:'application-queued'});
 });
 try{
  const result=f.h.settleExistingHistoryPromptHandoffFromDurableReceipt(f.record);
  assert.equal(replaced,true);assert.equal(f.current()[0].text,'replacement');
  assert.equal(f.current()[0].enterAttemptAt??null,null);
  assert.equal(f.current()[0].queueStatus,'application-queued');
  assert.notEqual(result.handoff,f.current()[0]);assert.equal(result.changed,true);
 }finally{off();}
});
