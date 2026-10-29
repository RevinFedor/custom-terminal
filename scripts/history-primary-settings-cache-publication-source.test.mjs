// Actual model + paged producer + original caller predicates on finite rows.
// Private Node SQLite/in-process IPC substitute the native transport only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import fs from 'node:fs';
import {getHeapStatistics} from 'node:v8';
import {HistoryPrimaryRootReadModel,historyPrimaryToolClaimFingerprint} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {captureHistoryPrimaryPanelWitness,captureHistoryPrimarySettingsCachePublication,
 createHistoryPrimaryPanelInputTransaction,historyPrimaryPanelInputFingerprint} from '../src/renderer/utils/historyPrimaryPanelBindings.mjs';
import {historyPrimaryCompositionRequestClass} from '../src/renderer/utils/historyPrimaryRequestRouting.mjs';
import {buildHistoryLivePresentation} from '../src/renderer/utils/historyLiveProjection.mjs';
const require=createRequire(import.meta.url),{createPrimaryAddressFixture}=require('./test-support/history-primary-address-fixture.cjs');
globalThis.window={require};globalThis.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=96*1024**2);
const settings=(kind,value)=>({uuid:kind,role:'slash',content:'/'+kind+' '+value,sessionId:'s',sourceIdentity:'setting-'+kind,
 timestamp:'2026-10-28T00:00:00.000Z',settingsFact:{version:1,provider:'codex',kind,value}});
const rows=[settings('model','full Ω\ud800'),settings('effort','high'),{uuid:'user',role:'user',sessionId:'s',content:'FULL\0\ud800😀',timestamp:'2026-10-28T00:00:01.000Z'}];
async function rig(t){
 const fixture=await createPrimaryAddressFixture(null,{entries:rows}),root=new HistoryPrimaryRootReadModel(fixture.invoke,fixture.transport);
 const applied={localEntries:[],liveEntries:[],liveToolResults:null,rewindPreview:null,
  settingsPresentationKeys:[],grouping:{enabled:false,threshold:2,responseWork:true,expandedKeys:[]},captionSelections:[]};
 const ownerKey='UI-owned',ownerGeneration=1,suppressions=new Map(),captions=new Map();
 await root.open({...fixture.payload,primaryPresentation:applied},{presentationScope:{ownerKey,generation:ownerGeneration,visit:1,presented:true}});
 t.after(async()=>{await root.close();fixture.close();});
 const entries=[...root.view.serverMetadata.entries],cache=new Map();
 const output=buildHistoryLivePresentation(entries,[],{settingsPresentationKeys:cache});
 assert.equal(output,entries);assert.equal(cache.size,2);
 const receipt=captureHistoryPrimarySettingsCachePublication(root,entries,output,{cacheWasEmpty:true,ownerKey,ownerGeneration});
 assert(receipt);
 const presentation={...applied,settingsPresentationKeys:[...cache],grouping:{...applied.grouping},captionSelections:[]};
 const state={root,header:root.header,ownerKey,ownerGeneration,entries,live:{ownerKey,entries:applied.liveEntries},
  results:{ownerKey,results:new Map()},rewind:null,presentation,suppressions,captions};
 state.witness=captureHistoryPrimaryPanelWitness({root,header:root.header,ownerKey,entries,rewind:null,presentation:applied,
  fingerprint:historyPrimaryPanelInputFingerprint(applied,suppressions,captions,historyPrimaryToolClaimFingerprint)});
 const transaction=createHistoryPrimaryPanelInputTransaction(()=>state,historyPrimaryToolClaimFingerprint);
 return {fixture,root,applied,presentation,state,transaction,receipt,entries,output,cache,ownerKey,ownerGeneration};
}
test('original initial default-cache publication supersedes the exact actual Surface despite unchanged rows',async t=>{
 const x=await rig(t);assert.equal(x.transaction.current(),false);
 assert.equal(historyPrimaryCompositionRequestClass(x.applied,x.presentation,x.state.suppressions,x.root.header,0),'semantic');
 const surface=x.root.attachSurface({ownerKey:x.ownerKey,generation:x.ownerGeneration,visit:1,presented:true});
 const outcome=await surface.bootstrapWindow(x.root.renderSnapshot(),0,x.transaction.current);
 assert.equal(outcome.status,'superseded');assert.equal(outcome.reason,'surface-composition-moved');
 assert.equal(outcome.requiredClass,'semantic');
});
test('same-data receipt restores actual Surface bootstrap without reopening Root or replacing its data subject',async t=>{
 const x=await rig(t),header=x.root.header,subject=x.root.getReceiptDataSubject();
 const next=x.transaction.rebaseSettingsCache(x.receipt,x.applied,x.presentation);
 assert(next);assert.equal(next.fingerprint,x.state.witness.fingerprint);
 x.state.witness=next;x.transaction.invalidate();assert.equal(x.transaction.current(),true);
 const applied=x.presentation;
 assert.equal(historyPrimaryCompositionRequestClass(applied,x.presentation,x.state.suppressions,header,0),'view');
 const surface=x.root.attachSurface({ownerKey:x.ownerKey,generation:x.ownerGeneration,visit:1,presented:true});
 assert.equal((await surface.bootstrapWindow(x.root.renderSnapshot(),0,x.transaction.current)).status,'data-ready');
 assert.equal(x.fixture.calls.filter(c=>c.channel==='agent-transcript:get-history').length,1);
 assert.equal(x.root.header,header);assert.equal(x.root.getReceiptDataSubject(),subject);
 assert.equal(x.root.window.get(0).entry.content,rows[0].content);
 assert.equal(x.transaction.rebaseSettingsCache(x.receipt,x.applied,x.presentation),null,'one consumption only');
 const future={...x.presentation,liveEntries:[{...rows[0],uuid:'next-model',sourceIdentity:'next-setting',sourceIdentityAliases:[rows[0].sourceIdentity]}]};
 assert.equal(historyPrimaryCompositionRequestClass(applied,future,x.state.suppressions,header,0),'semantic');
 const projected=buildHistoryLivePresentation([],future.liveEntries,{settingsPresentationKeys:x.cache});
 assert.equal(projected[0].settingsPresentationKey,'source:setting-model','future alias keeps earlier exact key');
});
test('changed alias key or grouping is never accepted as a cache-only publication',async t=>{
 for(const kind of ['alias','grouping']){
  await t.test(kind,async t=>{
   const x=await rig(t);
   if(kind==='alias')x.presentation.settingsPresentationKeys[0]=[x.presentation.settingsPresentationKeys[0][0],'source:different'];
   else x.presentation.grouping.enabled=true;
   assert.equal(x.transaction.rebaseSettingsCache(x.receipt,x.applied,x.presentation),null);
   assert.equal(x.transaction.current(),false);
  });
 }
});
test('CURRENT values, suppression and owner replacement retain ordinary invalidation',async t=>{
 for(const kind of ['local','live','suppression','generation']){
  await t.test(kind,async t=>{
   const x=await rig(t);
   if(kind==='local')x.presentation.localEntries=[new Proxy({}, {get(){throw Error('must not read CURRENT payload');}})];
   if(kind==='live')x.presentation.liveEntries=[new Proxy({}, {get(){throw Error('must not read CURRENT payload');}})];
   if(kind==='suppression')x.state.suppressions.set('own',{});
   if(kind==='generation')x.state.ownerGeneration++;
   assert.equal(x.transaction.rebaseSettingsCache(x.receipt,x.applied,x.presentation),null);
  });
 }
});
test('copied CURRENT row and changed merge output cannot mint a historical cache receipt',async t=>{
 const x=await rig(t),scope={cacheWasEmpty:true,ownerKey:x.ownerKey,ownerGeneration:x.ownerGeneration};
 assert.equal(captureHistoryPrimarySettingsCachePublication(x.root,[{...x.entries[0]},...x.entries.slice(1)],
  [{...x.entries[0]},...x.entries.slice(1)],scope),null);
 const copied=[{...x.entries[0]},...x.entries.slice(1)];
 assert.equal(captureHistoryPrimarySettingsCachePublication(x.root,copied,copied,scope),null);
 assert.equal(captureHistoryPrimarySettingsCachePublication(x.root,x.entries,[...x.entries],scope),null);
 assert.equal(captureHistoryPrimarySettingsCachePublication(x.root,x.entries,x.entries,{...scope,cacheWasEmpty:false}),null);
});
test('reentry after original full fingerprint revokes acceptance without changing the prior witness',async t=>{
 const x=await rig(t),before=x.state.witness;let calls=0;
 const transaction=createHistoryPrimaryPanelInputTransaction(()=>x.state,value=>{
  calls++;const result=historyPrimaryToolClaimFingerprint(value);x.state.ownerGeneration++;return result;
 });
 assert.equal(transaction.rebaseSettingsCache(x.receipt,x.applied,x.presentation),null);
 assert.equal(calls,1);assert.equal(x.state.witness,before);
});

test('actual Panel merge and input-transaction bodies publish the default cache without a semantic refresh',async t=>{
 const source=fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
 const select=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>0&&b>a);return source.slice(a,b);};
 const body=select('  const settingsPresentationKeysRef = useRef(', '  // Rewind owns the final presentation boundary.')
  +select('  const primaryLiveToolResults = ', '  const displayUnitsPrevRef = useRef<');
 assert(body.length<12000);
 const compiled=new Function('env','with(env){'+stripTypeScriptTypes(body,{mode:'strip'})
  +'\nreturn {primaryPresentation,primaryInputsCurrent,primaryInputTransaction,settingsPresentationKeysRef};}');
 const ownerKey='UI-owned',ownerGeneration=1,empty=[],results=new Map(),suppressions=new Map(),captions=new Map(),hooks=[];
 let cursor=0;
 const env={historyOwnerKey:ownerKey,historyOwnerKeyRef:{current:ownerKey},historyOwnerGenerationRef:{current:ownerGeneration},
  renderEntries:[],visibleLiveEntries:empty,ownerLiveEntries:empty,primaryRootRef:{current:null},
  liveToolResultsRef:{current:{ownerKey,results}},liveToolResults:results,primaryPhysicalCandidate:true,
  primaryLocalRowsRef:{current:[]},rewindPreview:null,historyGroupActionsEnabled:false,expandedGroupKeys:new Set(),
  groupCaptionSelectionsRef:{current:captions},primaryCaptionRevision:0,primarySuppressionRevision:0,
  primarySurfaceWitnessRef:{current:null},presentationEntriesRef:{current:[]},liveProjectionRef:{current:{ownerKey,entries:empty}},
  primaryPresentationRef:{current:null},suppressedPromptsRef:{current:suppressions},tabId:'t',
  useUIStore:{getState:()=>({historyRewindPreviews:{t:null}})},primaryCompositionAppliedRef:{current:null},
  historyDiag(){},buildHistoryLivePresentation,captureHistoryPrimarySettingsCachePublication,
  createHistoryPrimaryPanelInputTransaction,historyPrimaryToolClaimFingerprint,
  useRef(value){const i=cursor++;return hooks[i]||(hooks[i]={current:value});},
  useMemo(fn,deps){const i=cursor++,old=hooks[i];if(old&&deps.length===old.deps.length&&deps.every((v,n)=>Object.is(v,old.deps[n])))return old.value;
   const value=fn();hooks[i]={value,deps};return value;}};
 const render=()=>{cursor=0;return compiled(env);},first=render();
 assert.equal(first.primaryPresentation.settingsPresentationKeys.length,0);
 const fixture=await createPrimaryAddressFixture(null,{entries:rows}),root=new HistoryPrimaryRootReadModel(fixture.invoke,fixture.transport);
 t.after(async()=>{await root.close();fixture.close();});
 await root.open({...fixture.payload,primaryPresentation:first.primaryPresentation},
  {presentationScope:{ownerKey,generation:ownerGeneration,visit:1,presented:true}});
 env.primaryRootRef.current=root;const entries=[...root.view.serverMetadata.entries];env.renderEntries=entries;env.presentationEntriesRef.current=entries;
 env.primaryCompositionAppliedRef.current=first.primaryPresentation;
 env.primarySurfaceWitnessRef.current=captureHistoryPrimaryPanelWitness({root,header:root.header,ownerKey,entries,rewind:null,
  presentation:first.primaryPresentation,fingerprint:historyPrimaryPanelInputFingerprint(first.primaryPresentation,suppressions,captions,historyPrimaryToolClaimFingerprint)});
 const shown=render();assert.equal(shown.primaryPresentation.settingsPresentationKeys.length,2);
 assert.equal(env.primaryCompositionAppliedRef.current,shown.primaryPresentation,'actual composition effect guard now skips refresh');
 assert.equal(shown.primaryInputsCurrent(),true);
 const surface=root.attachSurface({ownerKey,generation:ownerGeneration,visit:1,presented:true});
 assert.equal((await surface.bootstrapWindow(root.renderSnapshot(),0,shown.primaryInputsCurrent)).status,'data-ready');
 assert.equal(fixture.calls.filter(c=>c.channel==='agent-transcript:get-history').length,1);
 assert.equal(render().primaryPresentation,shown.primaryPresentation,'unchanged next parent render stays on the same publication');
});

