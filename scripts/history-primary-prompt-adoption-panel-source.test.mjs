// SOURCE controls only. Real selected producer/client/model, native predicates,
// shared handoff store and bounded verbatim Panel callbacks. Parsed rows, Node
// SQLite, in-process IPC and a finite React/ref frame replace Electron/native.
// Run separately: node --max-old-space-size=64 --max-semi-space-size=2 --test --test-isolation=none <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { historyPrimaryPromptAdoptionFingerprint } from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import * as recovery from '../src/renderer/utils/canonicalPromptRecovery.mjs';
import * as presentation from '../src/renderer/utils/historyPromptPresentation.mjs';
import { normalizeComposerChips } from '../src/shared/composer-chips.mjs';
import { normalizePromptImageIdentity, retainPromptImageRefsForText } from '../src/shared/prompt-image-attachments.mjs';
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
assert(getHeapStatistics().heap_size_limit <= 70 * 1024 ** 2, '64MiB old/2MiB semi runtime cap required');
globalThis.window = { require };
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
const handoffs = await import('../src/renderer/utils/historyPromptHandoffs.ts');
const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
function between(a,b) {
  const start = panel.indexOf(a), end = panel.indexOf(b,start+a.length);
  assert(start >= 0 && end > start && panel.indexOf(a,start+a.length) === -1, a);
  const text = panel.slice(start,end); assert(Buffer.byteLength(text)<32*1024, 'bounded actual callback; no whole Panel AST'); return text;
}
const blocks = {
  normal: between('const normalizeHistoryPromptText =','const promptPreview ='),
  finder: between('const isLocalPromptEntry =','const mergeServerAndLocalEntries ='),
  publisher: between('  const publishHistoryRows = useCallback(','  const primaryLocalPublicationAtRender ='),
  owner: between('  const localPromptMetaOwnersRef =','  const primaryPromptAppendPendingRef ='),
  append: between('  const primaryPromptAppendPendingRef =','  const updateLocalPromptEntry ='),
  status: between('  const updateLocalPromptEntry =','  const captureLocalPromptRemoval ='),
  recovery: between('  const durablePromptOwnerRef =','  const upsertLocalRewindEntry ='),
  ack: between('  const acknowledgeMaterializedHistoryReceipt =','  useEffect(() => {\n    let stopped = false;'),
  shared: between('  const primaryPromptConsumptionEpochRef =','  // Load full history'),
  subscriber: between("  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {\n    if (change.type === 'presentation-control')",'  const appendCompactErrorEntry ='),
};
const tails = {
  normal: 'return {normalizeHistoryPromptText,normalizeHistoryPromptIdentityText};',
  finder: 'return {isLocalPromptEntry,isLocalRewindEntry,isLocalCompactErrorEntry,findServerPromptEntry,serverHasPromptEntry};',
  publisher: 'return {publishHistoryRows};',
  owner: 'return {localPromptMetaOwnersRef,getLocalPromptMetaOwner,primaryPromptPublicationFingerprint,capturePrimaryPromptAdoption,primaryPromptAdoptionLifeRef};',
  append: 'return {appendLocalPromptEntry,primaryPromptAppendPendingRef};', status: 'return {updateLocalPromptEntry};',
  recovery: 'return {hasDurablePrompt,durablePromptOwnerRef};', ack: 'return {acknowledgeMaterializedHistoryReceipt};',
  shared: 'return {consumeMaterializedPromptHandoffs,consumePrimaryMaterializedPromptHandoffs,primaryPromptConsumptionEpochRef};',
  subscriber: '',
};
const compiled = Object.fromEntries(Object.entries(blocks).map(([key,source]) => {
  const result = ts.transpileModule(source,{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}});
  assert.deepEqual(result.diagnostics,[]);
  return [key,new Function('env','with(env){\n'+result.outputText+'\n'+tails[key]+'\n}')];
}));
console.log('V49_PANEL_SOURCE '+JSON.stringify({panelSHA256:sha(panel),bytes:Buffer.byteLength(panel),
  fragments:Object.fromEntries(Object.entries(blocks).map(([k,v])=>[k,{bytes:Buffer.byteLength(v),sha256:sha(v)}])),
  node:process.version,typescript:ts.version,heapLimit:getHeapStatistics().heap_size_limit,electron:process.versions.electron||null}));
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const turn = () => new Promise(resolve=>setImmediate(resolve));
let serial=0;
const now=Date.now();
const row = (uuid,extra={}) => ({uuid,role:'user',content:'authored',timestamp:new Date(now).toISOString(),sessionId:'s',...extra});
async function setup(rows) {
  const f=await createPrimaryAddressFixture(null,{entries:rows});
  const model=new HistoryPrimaryRootReadModel(f.invoke,f.transport); model.windowDiagnostic=()=>{};
  await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],grouping:{enabled:false,responseWork:true,threshold:2,expandedKeys:[]},captionSelections:[],settingsPresentationKeys:[]}});
  return {model,f,async close(){await model.close();f.close();}};
}
function rig(x,{primary=true,initial=[],queued=false,gate=null,ack=null}={}) {
  const tabId='v49-panel-'+ ++serial,effects=[],cleanups=[],pending=new Set(),updates=[],queries=[],acks=[],logs=[];
  const actualRead=x.model.readPromptAdoption.bind(x.model);let fingerprints=0,guardChecks=0,pins=0,state=initial;
  const root=Object.create(x.model);
  // Actual model methods retain their instance; only the selected IPC boundary
  // is intercepted to inject finite pauses/failures and count caller work.
  root.getReceiptDataSubject=()=>x.model.getReceiptDataSubject();
  root.readPromptAdoption=(local,options)=>{
    queries.push({local,scope:options.scope,committed:options.committed,excluded:[...(options.excludedUuids||[])]});
    const p=(async()=>{if(gate)await gate(local,options);return actualRead(local,{...options,owns:()=>{guardChecks++;return options.owns?.()??true;}})})();
    pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;
  };
  const env={...handoffs,...presentation,...recovery,normalizeComposerChips,normalizePromptImageIdentity,
    historyPrimaryPromptAdoptionFingerprint: v=>{fingerprints++;return historyPrimaryPromptAdoptionFingerprint(v);},
    primaryPhysicalCandidate:primary,primaryRootReadEnabled:true,primaryCompositeOwnerRef:{current:''},
    primaryRootRef:{current:root},primaryReceiptCommitRef:{current:{root,dataSubject:root.getReceiptDataSubject(),ownerKey:'A',generation:1}},
    historyOwnerKey:'A',historyOwnerKeyRef:{current:'A'},historyOwnerGenerationRef:{current:1},historyTabIdRef:{current:tabId},
    promptHandoffMetaRef:{current:new Map()},presentationEntriesRef:{current:initial},suppressedPromptsRef:{current:new Map()},
    returnPromptInflight:{current:new Set()},historySnapshotOwner:{},sessionId:'s',toolType:'codex',tabId,
    LOCAL_PROMPT_PREFIX:'local-prompt-',LOCAL_REWIND_PREFIX:'local-rewind-',LOCAL_COMPACT_ERROR_PREFIX:'local-compact-error-',
    useRef:current=>({current}),useCallback:fn=>fn,useEffect:fn=>effects.push(fn),
    historyDiag:v=>logs.push(v),promptPreview:v=>String(v).slice(0,80),createPromptHandoffId:()=> 'generated',
    retainHistoryDraftImages:(text,images)=>retainPromptImageRefsForText(text,images||[]),
    persistVolatileOverlay(){},setPrimarySuppressionRevision(){},keepHistoryTailPinnedAfterMutation(){pins++;},
    setEntries(value){const apply=()=>{state=typeof value==='function'?value(state):value;};if(queued)updates.push(apply);else apply();},
    entryMatchesSuppressedPrompt:()=>false,
    removeLocalPromptEntry(){},captureLocalPromptRemoval(){return null;},setReceiptPresentationRevision(){},
    liveProjectionRef:{current:{ownerKey:'A',entries:[]}},primaryLiveCoverageOwner:{wake(){}},setLiveEntries(){},
    resolveHistoryPromptHandoffSemanticTags:record=>record.semanticTags,
    consumeLocalPromptEntry(id,reason,expected,owns=()=>true){if(!owns())return false;return handoffs.consumeHistoryPromptHandoffIfCurrent(tabId,id,expected?.owner||null);},
    ipcRenderer:{invoke:async(channel,payload)=>{assert.equal(channel,'agent:acknowledge-send-receipt-presentation');acks.push(payload);return ack?ack(payload):{success:true};}},
    useCanonicalPromptRecoveryOwner(key){const ref={current:null};cleanups.push(recovery.activateCanonicalPromptRecoveryOwner(ref,key));return ref;},
  };
  env.rawServerEntriesRef={get current(){if(primary)throw Error('PRIMARY_READ_N_RAW');return x.legacyRows||[];}};
  env.committedHistoryEntriesRef={get current(){if(primary)throw Error('PRIMARY_READ_N_COMMITTED');return {ownerKey:'A',entries:x.legacyRows||[]};}};
  for(const key of ['normal','finder'])Object.assign(env,compiled[key](env));
  env.primarySparsePublicationOwner=createHistoryPrimarySparsePublicationOwner({
    isLocal: entry=>env.isLocalPromptEntry(entry)||env.isLocalRewindEntry(entry)||env.isLocalCompactErrorEntry(entry),
  });
  env.primarySparsePublicationOwner.publishCompatibility(initial,{ownerKey:'A',generation:1});
  cleanups.push(()=>env.primarySparsePublicationOwner.clear());
  for(const key of ['publisher','owner','append','status','recovery','ack','shared'])Object.assign(env,compiled[key](env));
  for(const effect of effects){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}
  const realMetadata=Object.getOwnPropertyDescriptor(x.model,'metadata');
  Object.defineProperty(x.model,'metadata',{configurable:true,get(){throw Error('PRIMARY_READ_N_METADATA');}});
  const make=(id,extra={})=>handoffs.beginHistoryPromptHandoff({tabId,handoffId:id,toolType:'codex',sessionIdHint:'s',text:'authored',submittedAt:now,source:'finite-v49',statusAtSend:'active',...extra});
  const append=(id,extra={})=>env.appendLocalPromptEntry(extra.text||'authored','sending',{handoffId:id,statusAtSend:'active',submittedAt:now,...extra});
  return {env,root,queries,acks,logs,make,append,
    get state(){return state},get fingerprints(){return fingerprints},get guardChecks(){return guardChecks},get pins(){return pins},
    async drain(){for(let i=0;i<20000;i++){await turn();if(!pending.size){await turn();if(!pending.size)return;}}throw Error('finite query drain exceeded');},
    subscribe(){let cleanup;const original=env.useEffect;env.useEffect=fn=>{cleanup=fn();};compiled.subscriber(env);env.useEffect=original;return cleanup;},
    flush(){while(updates.length)updates.shift()();},dispose(){for(const c of cleanups.splice(0).reverse())c();},
    async close(){this.dispose();await this.drain();env.primarySparsePublicationOwner.close();if(realMetadata)Object.defineProperty(x.model,'metadata',realMetadata);else delete x.model.metadata;
      for(const h of handoffs.getHistoryPromptHandoffsSnapshot(tabId))handoffs.consumeHistoryPromptHandoffIfCurrent(tabId,h.handoffId,h);}
  };
}

test('actual no-ID Send authoring stays synchronous and never touches primary historical arrays',async()=>{
  const x=await setup([]),h=rig(x);try{
    h.make('send');assert.equal(h.append('send',{text:'author [imagePath: /finite/image.png]',imagePaths:[{id:1,path:'/finite/image.png'}],promptChips:[{id:'chip',kind:'prompt',text:'full chip'}]}),undefined);
    assert.equal(h.state.length,1);assert.equal(h.state[0].handoffId,'send');assert.equal(h.state[0].promptChips[0].text,'full chip');assert.equal(h.queries.length,0);assert.equal(h.pins,1);
    assert.throws(()=>h.env.rawServerEntriesRef.current,/PRIMARY_READ_N_RAW/);
  }finally{await h.close();await x.close();}
});
test('delayed exact append enriches all equal UUIDs missing-only without duplicate card or tail follow',async()=>{
  const x=await setup([row('canon',{role:'assistant',sourceIdentity:'old'})]);const initial=[row('canon'),row('canon',{promptChips:[{kind:'prompt',text:'existing'}]})],h=rig(x,{initial});
  try{h.make('h');h.append('h',{auditEntryUuid:'canon',promptChips:[{id:'new',kind:'prompt',text:'new chip'}]});assert.equal(h.state,initial);await h.drain();
    assert.equal(h.state.length,2);assert.equal(h.state[0].promptChips[0].text,'new chip');assert.equal(h.state[1].promptChips[0].text,'existing');assert.equal(h.pins,0);assert(h.queries[0].committed);
  }finally{await h.close();await x.close();}
});
test('actual paired append then failed status replay keeps the captured failure after unmatched proof',async()=>{
  const x=await setup([]),wait=deferred(),h=rig(x,{gate:()=>wait.promise});let off=()=>{};try{
    h.make('failed',{requiresAuditIdentity:false,initialReceipt:{queueStatus:'failed',reason:'finite-failed',requiresAuditIdentity:false,proof:{entryUuid:'absent',sessionId:'s',auditTimestamp:new Date(now).toISOString(),actualHash:'hash'}}});
    off=h.subscribe();
    assert.equal(h.state.length,0);wait.resolve();await h.drain();assert.equal(h.state.length,1);assert.equal(h.state[0].queueStatus,'failed');assert.equal(h.state[0].statusReason,'finite-failed');
    assert.deepEqual(h.queries.map(q=>q.committed===true),[true,false]);assert.equal(h.env.primaryPromptAppendPendingRef.current.size,0);
  }finally{off();wait.resolve();await h.close();await x.close();}
});
test('actual raw-status reconciliation protects durable canonical from late failed status',async()=>{
  const x=await setup([row('canon')]),h=rig(x);try{
    h.make('h');h.append('h');h.env.updateLocalPromptEntry('h','failed','late-failed',{auditEntryUuid:'canon'});await h.drain();
    assert.equal(h.state[0].queueStatus,'sending');assert.equal(h.env.suppressedPromptsRef.current.size,0);assert.equal(h.queries[0].committed,undefined);
  }finally{await h.close();await x.close();}
});
test('no-ID recovery uses full native audit-time grammar, and UNKNOWN has local read-error provenance',async()=>{
  const timestamp=new Date(now).toISOString(),x=await setup([row('canon',{content:'authored <system-reminder>omit</system-reminder>'})]),h=rig(x);
  try{assert.equal(await h.env.hasDurablePrompt('authored',now,{auditTimestamp:timestamp,auditSessionId:'s'}),true);
    assert.equal(await h.env.hasDurablePrompt('authored',now,{}),false);h.env.primaryRootRef.current=null;
    await assert.rejects(async()=>h.env.hasDurablePrompt('authored',now,{auditTimestamp:timestamp}),e=>recovery.isCanonicalPromptRecoveryReadError(e));
  }finally{await h.close();await x.close();}
});
test('old append read cannot publish into a same-H replacement or a disposed queued React commit',async()=>{
  const x=await setup([]),wait=deferred(),h=rig(x,{gate:()=>wait.promise,queued:true});try{
    h.make('h');h.append('h',{auditEntryUuid:'absent'});handoffs.consumeHistoryPromptHandoffIfCurrent(h.env.tabId,'h',handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId)[0]);
    h.make('h',{text:'replacement',submittedAt:now+1});wait.resolve();await h.drain();h.flush();assert.equal(h.state.length,0);
    h.append('h',{auditEntryUuid:'absent',text:'replacement'});await h.drain();h.dispose();assert.equal(h.env.primaryPromptAppendPendingRef.current.size,0);h.flush();assert.equal(h.state.length,0);
  }finally{wait.resolve();await h.close();await x.close();}
});
test('explicit X invalidates original pending read even though the same H object remains',async()=>{
  const x=await setup([row('canon')]),wait=deferred(),initial=[row('canon')],h=rig(x,{initial,gate:()=>wait.promise});try{
    const original=h.make('h',{sendOperationKey:'op',sendAttemptId:'at'});h.append('h',{auditEntryUuid:'canon',sendOperationKey:'op',sendAttemptId:'at',promptChips:[{id:'c',kind:'prompt',text:'should not arrive'}]});
    assert(handoffs.recordHistorySendPresentationDismissal({tabId:h.env.tabId,handoffId:'h',operationKey:'op',attemptId:'at',surface:'desktop-history',provider:'codex',deliveryControl:{version:1,cancelledAt:now,presentationDismissed:true}}));
    assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId)[0],original);wait.resolve();await h.drain();assert.equal(h.state,initial);assert.equal(h.acks.length,0);
  }finally{wait.resolve();await h.close();await x.close();}
});
test('whole shared pass reserves consumed UUID before failed ACK and retains stable tie order',async()=>{
  const x=await setup([row('same')]),h=rig(x,{ack:()=>({success:false})});try{
    h.make('first',{requiresAuditIdentity:false});h.make('second',{requiresAuditIdentity:false});h.env.consumeMaterializedPromptHandoffs(new Proxy([],{get(){throw Error('PRIMARY_CONSUME_ARRAY');}}));await h.drain();
    assert.equal(h.queries.length,2);assert.equal(h.queries[0].local.content,'authored');assert.deepEqual(h.queries[1].excluded,['same']);assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId).length,2);
  }finally{await h.close();await x.close();}
});
test('shared promotion ACK carries original audited pair and hidden data commit can retire the original owner',async()=>{
  const x=await setup([row('new',{sourceIdentity:'new-source',sourceIdentityAliases:['old','old-source']})]),h=rig(x);try{
    h.make('h',{sendOperationKey:'op',sendAttemptId:'at',initialReceipt:{queueStatus:'sent',reason:'audited',proof:{entryUuid:'old',sourceIdentity:'old-source',sessionId:'s',auditTimestamp:new Date(now).toISOString(),actualHash:'hash'}}});
    h.env.consumeMaterializedPromptHandoffs([]);await h.drain();assert.equal(h.acks.length,1);assert.equal(h.acks[0].entryUuid,'old');assert.equal(h.acks[0].sourceIdentity,'old-source');assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId).length,0);
  }finally{await h.close();await x.close();}
});
test('reentrant same-attempt replacement during promotion cannot receive ACK or be consumed',async()=>{
  const x=await setup([row('new',{sourceIdentityAliases:['old']})]),h=rig(x);let off=()=>{};try{
    h.make('h',{sendOperationKey:'op',sendAttemptId:'at',initialReceipt:{queueStatus:'sent',reason:'audited',proof:{entryUuid:'old',sessionId:'s',auditTimestamp:new Date(now).toISOString(),actualHash:'hash'}}});
    let replacement;off=handoffs.subscribeHistoryPromptHandoffs(h.env.tabId,(_snapshot,change)=>{if(change.type==='canonical-adopt'){handoffs.consumeHistoryPromptHandoffIfCurrent(h.env.tabId,'h',handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId)[0]);replacement=h.make('h',{text:'replacement',submittedAt:now+1,sendOperationKey:'op',sendAttemptId:'at'});}});
    h.env.consumeMaterializedPromptHandoffs([]);await h.drain();assert.equal(h.acks.length,0);assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(h.env.tabId)[0],replacement);
  }finally{off();await h.close();await x.close();}
});
test('actual cheap caller guard count grows with historical chunks while current-payload fingerprints stay bounded',async()=>{
  const counts=[];
  for(const n of [0,1,4,8]){const x=await setup(Array.from({length:n},(_,i)=>row('r'+i,{content:'x'.repeat(9000)+i}))),h=rig(x);try{
    h.make('h');h.append('h');h.env.updateLocalPromptEntry('h','queued','source-control',{auditEntryUuid:'absent'});await h.drain();
    counts.push({n,guards:h.guardChecks,fingerprints:h.fingerprints});
  }finally{await h.close();await x.close();}}
  console.log('V49_ACTUAL_PANEL_WORK_COUNTS '+JSON.stringify(counts));assert(counts[3].guards>counts[1].guards);assert(counts.every(v=>v.fingerprints<=counts[0].fingerprints+4));assert(counts.every(v=>v.fingerprints<80));
});
test('explicit legacy positive control still uses the native finder and missing-only decoration',async()=>{
  const x=await setup([]);x.legacyRows=[row('legacy')];const h=rig(x,{primary:false,initial:[row('legacy')]});try{
    h.make('h');h.append('h',{auditEntryUuid:'legacy',promptChips:[{id:'c',kind:'prompt',text:'legacy chip'}]});assert.equal(h.state[0].promptChips[0].text,'legacy chip');assert.equal(h.queries.length,0);
  }finally{await h.close();await x.close();}
});

test('actual cold exact-ID subscriber replay admits authoring and terminal status synchronously without an absence read',async()=>{
  const x=await setup([]),h=rig(x);let off=()=>{};try{
    h.env.primaryRootRef.current=null;h.env.primaryReceiptCommitRef.current=null;
    h.make('cold',{requiresAuditIdentity:false,initialReceipt:{queueStatus:'failed',reason:'cold-failed',proof:{entryUuid:'absent',sessionId:'s',auditTimestamp:new Date(now).toISOString(),actualHash:'hash'}}});
    off=h.subscribe();assert.equal(h.state.length,1);assert.equal(h.state[0].queueStatus,'failed');assert.equal(h.queries.length,0);
  }finally{off();await h.close();await x.close();}
});

test('final actual caller fingerprint cannot publish after reentrant disposal',async()=>{
  const x=await setup([row('canon')]),wait=deferred(),initial=[row('canon')],h=rig(x,{initial,gate:()=>wait.promise});try{
    h.make('h');h.append('h',{auditEntryUuid:'canon',promptChips:[{id:'c',kind:'prompt',text:'retain'}]});
    const actual=h.env.historyPrimaryPromptAdoptionFingerprint;let fired=false;
    h.env.historyPrimaryPromptAdoptionFingerprint=value=>{const result=actual(value);if(!fired){fired=true;h.dispose();}return result;};
    wait.resolve();await h.drain();assert(fired);assert.equal(h.state,initial);assert.equal(h.env.primaryPromptAdoptionLifeRef.current.leases.size,0);
  }finally{wait.resolve();await h.close();await x.close();}
});

test('a newer same-H delayed canonical append owns the token through both queued React updaters',async()=>{
  const x=await setup([row('canon')]),initial=[row('canon')],h=rig(x,{initial,queued:true});try{
    h.make('h');h.append('h',{auditEntryUuid:'absent',text:'older local'});await h.drain();
    assert.equal(h.state,initial);assert.equal(h.env.primaryPromptAppendPendingRef.current.size,1);
    h.append('h',{auditEntryUuid:'canon',promptChips:[{id:'new',kind:'prompt',text:'latest enrichment'}]});await h.drain();
    h.flush();assert.equal(h.state.length,1);assert.equal(h.state[0].uuid,'canon');assert.equal(h.state[0].promptChips[0].text,'latest enrichment');
    assert.equal(h.env.primaryPromptAppendPendingRef.current.size,0);assert.equal(h.env.primaryPromptAdoptionLifeRef.current.leases.size,0);
  }finally{await h.close();await x.close();}
});


test('actual status final witness includes the original metadata getter after identity enrichment cloned it',async()=>{
  const x=await setup([]),wait=deferred(),h=rig(x,{gate:()=>wait.promise});try{
    h.make('h');h.append('h');let text='authored';
    const original=h.env.promptHandoffMetaRef.current.get('h');Object.defineProperty(original,'text',{configurable:true,enumerable:true,get:()=>text});
    h.env.updateLocalPromptEntry('h','failed','must retain',{auditEntryUuid:'absent'});
    assert.notEqual(h.env.promptHandoffMetaRef.current.get('h'),original);text='new closed-over author';
    wait.resolve();await h.drain();assert.equal(h.state[0].queueStatus,'sending');assert.equal(h.env.suppressedPromptsRef.current.size,0);
    assert.equal(h.env.primaryPromptAdoptionLifeRef.current.leases.size,0);
  }finally{wait.resolve();await h.close();await x.close();}
});

test('no-ID recovery rejects a changed closed-over original identity after its synthetic local snapshot was read',async()=>{
  const x=await setup([row('canon')]),wait=deferred(),h=rig(x,{gate:()=>wait.promise});try{
    let auditTimestamp=new Date(now).toISOString();const identity={get auditTimestamp(){return auditTimestamp;},auditSessionId:'s'};
    const result=h.env.hasDurablePrompt('authored',now,identity);auditTimestamp=new Date(now+1000).toISOString();wait.resolve();
    await assert.rejects(result,e=>recovery.isCanonicalPromptRecoveryReadError(e));
  }finally{wait.resolve();await h.close();await x.close();}
});

test('queued actual status publication revalidates the original native numeric coercion proof',async()=>{
  const x=await setup([row('canon')]),h=rig(x,{queued:true});try{
    h.make('h');h.append('h');h.flush();let submittedAt=now;
    const nativeClock={valueOf(){return submittedAt;}};
    h.env.promptHandoffMetaRef.current.get('h').submittedAt=nativeClock;
    h.env.updateLocalPromptEntry('h','queued','awaited');await h.drain();
    submittedAt=now+100000;h.flush();assert.equal(h.state[0].queueStatus,'sending');
    assert.equal(h.env.primaryPromptAdoptionLifeRef.current.leases.size,0);
  }finally{await h.close();await x.close();}
});


test('status suppression keeps the original full caller witness after onProof native replay',async()=>{
  const start=panel.indexOf('const entryMatchesSuppressedPrompt ='),end=panel.indexOf('const isLocalPromptEntry =',start);
  assert(start>=0&&end>start);const actual=panel.slice(start,end);assert(Buffer.byteLength(actual)<4096);
  const result=ts.transpileModule(actual,{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}});
  assert.deepEqual(result.diagnostics,[]);
  const install=new Function('env','with(env){'+result.outputText+';return {entryMatchesSuppressedPrompt,filterSuppressedPromptEntries};}');
  for(const mutationAt of [null,4]){
    const x=await setup([row('old-canonical',{timestamp:new Date(now-600000).toISOString()})]),h=rig(x);
    let queryReturned=false,coercions=0,mutated=false;
    try{
      Object.assign(h.env,install({...h.env,...presentation}));
      h.make('h',{requiresAuditIdentity:false});h.append('h');
      const meta=h.env.promptHandoffMetaRef.current.get('h'),owner=h.env.getLocalPromptMetaOwner(meta),originalRow=h.state[0];
      meta.submittedAt={valueOf(){if(queryReturned&&++coercions===mutationAt){mutated=true;meta.text='different current author';}return now;}};
      const read=h.root.readPromptAdoption.bind(h.root);h.root.readPromptAdoption=(...args)=>read(...args).then(value=>{queryReturned=true;return value;});
      h.env.updateLocalPromptEntry('h','failed','finite-original-status');await h.drain();
      assert.equal(h.env.promptHandoffMetaRef.current.get('h'),meta);
      assert.equal(h.env.getLocalPromptMetaOwner(meta),owner);
      if(mutationAt===null){
        assert.equal(mutated,false);assert.equal(h.state[0].queueStatus,'failed');
        assert.equal(h.env.suppressedPromptsRef.current.size,1);
        assert.equal(h.env.filterSuppressedPromptEntries([row('later-canonical')],h.env.suppressedPromptsRef.current.values()).hidden,1);
      }else{
        assert.equal(mutated,true,'positive control: native query proof mutated the same metadata');
        assert.equal(h.state[0],originalRow);assert.equal(h.state[0].queueStatus,'sending');
        assert.equal(h.env.suppressedPromptsRef.current.size,0);
        assert.equal(h.env.filterSuppressedPromptEntries([row('later-canonical')],h.env.suppressedPromptsRef.current.values()).hidden,0);
      }
      assert.equal(h.env.primaryPromptAdoptionLifeRef.current.leases.size,0);
    }finally{await h.close();await x.close();}
  }
});
