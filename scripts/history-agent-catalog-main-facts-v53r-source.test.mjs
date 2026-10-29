// SOURCE-only R3 preserving repair. Actual producer/SQLite/read-plane/shared
// client/model/prepared/owner and the actual Main-facts adapter fragments.
// Synthetic canonical rows, in-process IPC and bounded queued React callbacks
// substitute for Mac/Electron. No app/provider/profile/native acceptance.
// node --max-old-space-size=64 --max-semi-space-size=2 --test --test-isolation=none scripts/history-agent-catalog-main-facts-v53r-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getHeapStatistics} from 'node:v8';
import {HistoryPrimaryRootReadModel} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {createHistoryPrimaryAgentCatalogOwner} from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import {historyPrimaryPromptAdoptionFingerprint as fingerprint} from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import {buildHistoryLivePresentation} from '../src/renderer/utils/historyLiveProjection.mjs';
import * as actual from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
const require=createRequire(import.meta.url);
const {createPrimaryAddressFixture}=require('./test-support/history-primary-address-fixture.cjs');
const {createHistoryAgentCatalogOracle}=require('./test-support/history-agent-catalog-oracle.cjs');
const predicates=createHistoryAgentCatalogOracle({});
globalThis.window={require};
globalThis.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=80*1024**2,'original runtime64/semi2');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const scope=extra=>({isTurnBusy:false,agentProcessAlive:false,currentSessionId:'s',currentProcessGeneration:'g',chipToolType:'codex',...extra});
const driver=(module,context,recipe={},owns=()=>true)=>module.createHistoryAgentCatalogCurrent({recipe,context,owns,
  isLocalPromptEntry:predicates.isLocalPromptEntry,isTaskAction:predicates.isTaskAction,
  historyAgentKey:predicates.historyAgentKey,fingerprint});
const pins=[];
for(const path of ['src/renderer/utils/historyAgentCatalogCurrent.mjs',
 'src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs','src/renderer/components/Workspace/HistoryPanel.tsx',
 'src/main/history-root-engine/main/history-primary-agent-catalog.js',
 'src/main/history-root-engine/main/history-root-read-plane.js','src/shared/history-agent-catalog-client.mjs',
 'scripts/history-agent-catalog-main-facts-v53r-source.test.mjs']){
 const data=readFileSync(new URL('../'+path,import.meta.url));pins.push({path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
console.log('[V53R_MAIN_FACTS_PINS] '+JSON.stringify({node:process.version,platform:process.platform,heapLimit:getHeapStatistics().heap_size_limit,pins}));

async function instrumentedDriver(){
 const url=new URL('../src/renderer/utils/historyAgentCatalogCurrent.mjs',import.meta.url);
 const original=readFileSync(url,'utf8'),needle='return Object.freeze({ wire, values,';
 assert.equal(original.split(needle).length,2,'one real returned driver object');
 // Test observation only: exposes COUNTS of existing native tables, not the
 // keys/records and not an alternative driver. No operation or guard changes.
 const source=original.replace("from './historyLiveProjection.mjs'",`from '${new URL('historyLiveProjection.mjs',url).href}'`)
  .replace(needle,needle+` __observe: request => execute(request), __retained: () => ({slots:values.length,operations:operations.length,
    originalMainFacts:factSnapshots.size,originalCollections:collectionSnapshots.size,
    originalCollectionKeys:[...collectionSnapshots.values()].reduce((sum,x)=>sum+x.snapshot.size,0),
    intrinsicSettings:settingSnapshots.size,historicalLookups:operations.filter(x=>x.request.kind==='map-get'||x.request.kind==='set-has').length,
    settingRuns:operations.filter(x=>x.request.kind==='setting').length,
    settingObservations:operations.filter(x=>x.request.kind==='setting').reduce((sum,x)=>sum+x.repetitions,0),
    historicalArguments:operations.filter(x=>x.request.kind==='strict-equal'&&typeof x.request.value?.value==='string'&&x.request.value.value.startsWith('historical-session-')).length}),`);
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
async function rig(t,n=1,{sameKey=false,sourceRows}={}){
 const entries=sourceRows||Array.from({length:n},(_,i)=>({uuid:'row-'+i,role:'assistant',sessionId:'s',content:'',rowStub:true,actions:[],
  actionSummary:[{toolName:'Task',family:'task',toolUseId:'historical-'+(sameKey?0:i),description:'label-'+i,subagentStatus:'completed'}]}));
 const f=await createPrimaryAddressFixture(null,{entries,sessionId:'s'}),resources=[],calls=[];
 const control={assertCurrent(){},async checkpoint(){await tick();}};
 const invoke=async(channel,payload)=>{
  calls.push({channel,kind:payload.kind,encoding:payload.encoding,operation:payload.operation});
  return channel.endsWith('fork-read-leaf')&&payload.encoding==='history-primary-agent-catalog-v1'
   ?f.plane.forkAgentCatalog(payload,{consumerKey:f.consumerKey,control}):f.invoke(channel,payload);
 };
 const model=new HistoryPrimaryRootReadModel(invoke,f.transport);model.windowDiagnostic=()=>{};
 await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],
  grouping:{enabled:false,threshold:2,responseWork:true,expandedKeys:[]},captionSelections:[],settingsPresentationKeys:[]}});
 const prepared=model.retainPreparedPresentation(),decoded=model.metadata.entries;resources.push(prepared);
 // Original model may close while the held independent source/catalog lives.
 await model.close();
 t.after(async()=>{for(const r of resources.reverse())await r.close();await model.close();assert.equal(f.plane.roots.size,0);f.close();});
 return {f,prepared,decoded,calls,keep(value){resources.push(value);return value;},
  forks(){return calls.filter(x=>x.encoding==='history-primary-agent-catalog-v1'&&x.channel.endsWith('fork-read-leaf')).length;}};
}
async function settle(owner){
 const until=Date.now()+30_000;
 while(owner.state().running||owner.state().pending){assert(Date.now()<until,'same original30s deadline');await tick();}
}
function queuedOwner(x,current,context,{onFull=()=>{},onFence=()=>{},nativeInput}={}){
 const updates=[],trace=[];let rendered=null;
 const input=nativeInput||{context},original=fingerprint(input);
 const owner=x.keep(createHistoryPrimaryAgentCatalogOwner({onChange:fn=>updates.push(fn)}));
 const candidate={ownerKey:'owner',generation:1,subject:input,prepared:x.prepared,current,
  replay(){trace.push('native');return current.isCurrent();},
  fullWitness(){trace.push('FULL');const same=fingerprint(input)===original;onFull();return same;},
  ownerFence(){trace.push('fence');onFence();return true;}};
 owner.update(candidate);
 return {owner,updates,trace,candidate,drain(){for(const update of updates.splice(0))rendered=update(rendered);return rendered;},
  rendered(){return rendered;}};
}

test('authenticated constant-C actual connected catalog retains no historical-key replay table as N grows',async t=>{
 const observed=await instrumentedDriver(),results=[];
 for(const n of [1,9]){
  const x=await rig(t,n),facts=observed.createHistoryAgentCatalogMainFactsMap(),context=scope({terminalFacts:facts});
  const current=driver(observed,context),reader=x.keep(await x.prepared.openAgentCatalog(current));
  assert.equal(reader.counts.total,n);
  const retained=current.__retained();
  assert.equal(retained.historicalLookups,0,'no historical-key Map/Set request transcript');
  // Main-only terminal fallback now enumerates the captured CURRENT Map
  // once. Fixed iterator state is allowed; the complete retained profile
  // must remain identical for N1/N9 and retain no historical arguments.
  assert.equal(retained.historicalArguments,0);
  const calls=x.calls.length;
  for(let i=0;i<4;i++){assert(current.isCurrent());assert(current.hasIntrinsicReadAuthority());}
  assert.equal(x.calls.length,calls,'proof is synchronous and does not read/retry');
  assert.equal((await reader.lookup('task:historical-'+(n-1))).kind,'found');
  results.push({historicalN:n,currentMapSize:facts.size,retained});
  // Dispose each finite fixture before constructing the next; no summed heap.
  await reader.close();await x.prepared.close();
 }
 assert.deepEqual(results[0].retained,results[1].retained);
 console.log('[V53R_R3_CONNECTED_RETENTION] '+JSON.stringify({scope:'one instrumented return object exposing counts only; actual connected machinery',results}));
});

test('unintegrated structural/custom/Proxy facts reject explicitly before catalog allocation; legacy native profile remains available',()=>{
 let getterCalls=0;class Facts extends Map{get(key){getterCalls++;return super.get(key);}}
 const custom=new Facts();
 const getter=new Map();Object.defineProperty(getter,'get',{get(){getterCalls++;return Map.prototype.get;}});
 for(const terminalFacts of [new Map(),custom,getter,new Proxy(new Map(),{}),{get(){return undefined;}}]){
  assert.throws(()=>driver(actual,scope({terminalFacts})),{code:'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE'});
 }
 assert.throws(()=>driver(actual,scope({terminalBackgroundTaskCalls:new Set()})),{code:'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE'});
 assert.equal(getterCalls,0,'profile auth is not execution or a false/empty result');
 const row={uuid:'legacy',role:'assistant',actions:[{tool:'Task',toolUseId:'old',description:'old',subagentStatus:'completed'}]};
 assert.equal(predicates.collectHistoryAgentChips([row],[],custom).length,1,'unchanged literal collector keeps native custom get');
 assert.equal(getterCalls,1);
});

test('factory owns new Main records but preserves native field aliases; structural/proxy records cannot forge provenance',()=>{
 const launch=Object.create(null),fields={provider:'codex',startedAt:7,launchSettings:launch};
 const value=actual.createHistoryAgentCatalogMainFact(fields);
 assert.notEqual(value,fields);assert.equal(Object.getPrototypeOf(value),Object.prototype);
 const aliases=[['call',value],['same',value]];
 const map=actual.createHistoryAgentCatalogMainFactsMap(aliases),set=actual.createHistoryAgentCatalogMainFactsSet(['a','a','b']);
 assert.equal(Object.getPrototypeOf(map),Map.prototype);assert.equal(Object.getPrototypeOf(set),Set.prototype);
 assert.equal(map.get('call'),value);assert.equal(map.get('same'),value);assert.equal(value.launchSettings,launch);
 assert.equal(Object.isFrozen(value),false);assert.deepEqual([...set],['a','b']);
 assert.deepEqual(Reflect.ownKeys(map),[],'private provenance adds no payload fields');
 for(const fake of [fields,new Proxy(value,{}),Object.create(value),{...value}])
  assert.throws(()=>actual.createHistoryAgentCatalogMainFactsMap([['fake',fake]]),{code:'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE'});
 const current=driver(actual,scope({terminalFacts:map,terminalBackgroundTaskCalls:set}));
 assert(current.hasIntrinsicReadAuthority(true));value.startedAt=8;
 assert.equal(current.hasIntrinsicReadAuthority(true),false,'same normalized fact remains mutable and guarded');
 value.startedAt=7;assert(current.hasIntrinsicReadAuthority(true));
 Object.setPrototypeOf(value,null);assert.equal(current.hasIntrinsicReadAuthority(true),false);assert.equal(current.isCurrent(),false);
});

test('constant-C=1 repeated historical lookups retain only original C data observations and stop late field/method replacement',async t=>{
 const observed=await instrumentedDriver(),results=[];
 for(const n of [1,9]){
  const x=await rig(t,n,{sameKey:true}),fact=observed.createHistoryAgentCatalogMainFact({startedAt:4,completedAt:9,status:'completed'});
  const facts=observed.createHistoryAgentCatalogMainFactsMap([['historical-0',fact]]),context=scope({terminalFacts:facts});
  const current=driver(observed,context),reader=x.keep(await x.prepared.openAgentCatalog(current));
  assert.equal(reader.counts.total,1,'literal duplicate key fold retains its original insertion position');
  const retained=current.__retained();assert.equal(retained.historicalLookups,0);assert.equal(retained.originalMainFacts,1);
  results.push({historicalN:n,currentMapSize:facts.size,retained});
  let getterCalls=0;Object.defineProperty(fact,'startedAt',{configurable:true,get(){getterCalls++;return 4;}});
  assert.equal(current.isCurrent(),false);assert.equal(current.hasIntrinsicReadAuthority(true),false);
  assert.equal(getterCalls,0,'authentication rejects altered Main fields without native getter replay');
  await reader.close();await x.prepared.close();
 }
 assert.deepEqual(results[0].retained,results[1].retained,'repeated original Main record does not produce historical-sized replay data');
 console.log('[V53R_R3_REPEATED_FACT_RETENTION] '+JSON.stringify(results));
});

test('late same-object intrinsic Map mutation fails the original C snapshot inside queued publication, with no retry',async t=>{
 const x=await rig(t),facts=actual.createHistoryAgentCatalogMainFactsMap(),context=scope({terminalFacts:facts});
 const current=driver(actual,context),q=queuedOwner(x,current,context);
 q.owner.select('task:historical-0');await settle(q.owner);q.drain();
 assert.equal(q.rendered().status,'ready');assert.equal(q.rendered().selected.kind,'found');
 const old=q.rendered().selected.record;
 q.owner.requestMembership({entries:['row-0']});await settle(q.owner);
 assert(q.updates.length>0);const before=x.calls.length,allocated=x.forks();
 facts.set('historical-0',actual.createHistoryAgentCatalogMainFact({status:'interrupted',startedAt:7,completedAt:9}));
 assert.equal(current.isCurrent(),false,'original C collection snapshot catches changed membership without retaining historical keys');
 q.trace.length=0;q.drain();
 assert.equal(q.rendered().status,'error');assert.equal(q.rendered().errorStage,'presentation');
 assert.equal(q.rendered().selected.kind,'unknown');assert.equal(q.rendered().selected.record,old);
 assert(q.trace.includes('native'));assert.equal(q.trace.includes('FULL'),false,'invalid native input stops before FULL');
 assert.equal(x.calls.length,before);assert.equal(x.forks(),allocated);
 await tick();assert.equal(q.owner.state().running,null);assert.equal(q.owner.state().pending,false);
});

test('post-FULL and post-original-fence intrinsic profile mutations cannot publish; authentication never calls custom getters',async t=>{
 for(const phase of ['FULL','fence','record-FULL','record-fence']){
  const x=await rig(t),fact=actual.createHistoryAgentCatalogMainFact({startedAt:4,completedAt:9,status:'completed'}),
    facts=actual.createHistoryAgentCatalogMainFactsMap([['historical-0',fact]]),context=scope({terminalFacts:facts});
  const current=driver(actual,context);let armed=false,getters=0;
  const mutate=()=>{if(!armed)return;armed=false;
   if(phase.startsWith('record'))Object.defineProperty(fact,'startedAt',{configurable:true,get(){getters++;return 4;}});
   else Object.defineProperty(facts,'get',{configurable:true,get(){getters++;return Map.prototype.get;}});};
  const q=queuedOwner(x,current,context,phase.endsWith('FULL')?{onFull:mutate}:{onFence:mutate});
  await settle(q.owner);q.drain();assert.equal(q.rendered().status,'ready');
  q.owner.requestMembership({entries:['row-0']});await settle(q.owner);assert(q.updates.length);
  const before=x.calls.length,allocated=x.forks();armed=true;q.drain();
  assert.equal(q.rendered().status,'error');assert.equal(q.rendered().errorStage,'presentation');
  assert.equal(current.hasIntrinsicReadAuthority(true),false);assert.equal(getters,0);
  assert.equal(x.calls.length,before);assert.equal(x.forks(),allocated);
  q.owner.close();await tick();
 }
});

test('actual Main event normalization and Panel capture authenticate the ORIGINAL state objects and preserve filters/revision/cancellation',()=>{
 const panel=readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
 const ownerAt=panel.indexOf('  const [mainBackgroundWork, setMainBackgroundWork]');
 const acceptAt=panel.indexOf('    const accept = (detail: any) => {',ownerAt);
 const acceptEnd=panel.indexOf('    const onBackgroundWork',acceptAt);
 assert(acceptAt>=0&&acceptEnd>acceptAt);const exactAccept=panel.slice(acceptAt,acceptEnd);
 let accept=exactAccept;assert(Buffer.byteLength(accept)<5000);
 for(const type of ['HistoryBackgroundAgentProof[]','HistoryBackgroundTaskProof[]','HistoryBackgroundAgentProof','HistoryBackgroundTaskProof','any','unknown'])
  accept=accept.replaceAll(': '+type,'');
 const queued=[];let state={tabId:'',revision:-1,agents:[],terminalSubagents:[],tasks:[],terminalBackgroundToolUseIds:[]};
 const frame=Function('createHistoryAgentCatalogMainFact','tabId','setMainBackgroundWork',
  'let cancelled=false;'+accept+';return {accept,cancel(){cancelled=true;}};')(
  actual.createHistoryAgentCatalogMainFact,'t',fn=>queued.push(fn));
 const launch={version:1,model:'full\0\ud800'},raw={provider:'codex',toolUseId:'call:canonical:12',sessionId:'s',generation:'g',startedAt:'4',launchSettings:launch};
 const terminal={...raw,status:'completed',completedAt:'9'};
 const wrong={...raw,toolUseId:'wrong',generation:'other'};
 const excludedWide={...terminal,toolUseId:'wide',sessionId:{native:'left unchanged until original exact filter'}};
 frame.accept({tabId:'t',revision:3,agents:[raw,wrong],terminalSubagents:[terminal,excludedWide],tasks:[],terminalBackgroundToolUseIds:[]});
 for(const fn of queued.splice(0))state=fn(state);
 assert.equal(state.agents[0].launchSettings,launch);assert.equal(state.terminalSubagents[0].launchSettings,launch);
 assert.notEqual(state.agents[0],raw,'same existing Main normalization owns its fresh record');
 assert.equal(state.terminalSubagents[1].sessionId,excludedWide.sessionId,'terminal raw session field preserved before exact filter');
 const start=panel.indexOf('  const exactActiveSubagents = useMemo(() => {'),end=panel.indexOf('  // Chips must see the SAME rows',start);
 assert(start>=0&&end>start);let body=panel.slice(start,end);assert(Buffer.byteLength(body)<5000);
 for(const type of ['HistoryBackgroundAgentProof','HistoryBackgroundTaskProof']){
  const exact='<string, '+type+'>';assert.equal(body.split(exact).length,2);body=body.replace(exact,'');
 }
 const factory=Function('useMemo','createHistoryAgentCatalogMainFactsMap','createHistoryAgentCatalogMainFactsSet',
  'mainBackgroundWork','tabId','toolType','sessionId','agentProcessGeneration','historySubagentCallIdentity',body+
  '\nreturn {exactActiveSubagents,exactActiveBackgroundTasks,terminalBackgroundTaskCalls,terminalFacts:terminalAgentFacts};');
 const capture=()=>factory(fn=>fn(),actual.createHistoryAgentCatalogMainFactsMap,actual.createHistoryAgentCatalogMainFactsSet,
  state,'t','codex','s','g',predicates.historySubagentCallIdentity);
 const facts=capture(),current=driver(actual,scope(facts));
 assert(current.hasIntrinsicReadAuthority(true));assert.equal(facts.exactActiveSubagents.size,1);assert.equal(facts.terminalFacts.size,1);
 assert.equal(facts.exactActiveSubagents.get('call'),state.agents[0]);assert.equal(facts.terminalFacts.get('call'),state.terminalSubagents[0]);
 assert.equal(facts.exactActiveBackgroundTasks,null);assert.equal(facts.terminalBackgroundTaskCalls,null);
 const newer=state;frame.accept({tabId:'t',revision:2,agents:[]});for(const fn of queued.splice(0))state=fn(state);
 assert.equal(state,newer,'original queued revision guard remains monotonic');
 frame.cancel();frame.accept({tabId:'t',revision:4,agents:[]});assert.equal(queued.length,0,'actual subscription cancellation is still honored');
 state={...state,tabId:'other'};const mismatch=capture();assert.equal(mismatch.exactActiveSubagents,null);assert.equal(mismatch.terminalFacts,undefined);
 console.log('[V53R_MAIN_FACTS_ACTUAL_ADAPTER] '+JSON.stringify({normalize:{bytes:Buffer.byteLength(exactAccept),sha256:createHash('sha256').update(exactAccept).digest('hex')},capture:{bytes:Buffer.byteLength(panel.slice(start,end)),sha256:createHash('sha256').update(panel.slice(start,end)).digest('hex')}}));
});


test('actual observable CURRENT settings preserve every getter, ordinary read, order and cancellation with trace-dependent storage',async t=>{
 const observed=await instrumentedDriver(),results=[];
 for(const n of [1,2,9]){
  const sourceRows=Array.from({length:n},(_,i)=>({uuid:'settings-history-'+i,role:'slash',sessionId:'s',sourceIdentity:'shared-setting',content:'',actions:[],
   settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}));
  const x=await rig(t,n,{sourceRows}),fact={version:1,provider:'codex',kind:'model',value:'model-a'},trace=[];
  let liveOwner=true,getters=0,cancelAt=Infinity;
  const live={uuid:'settings-current',role:'slash',sessionId:'s',sourceIdentity:'shared-setting',content:'',actions:[]};
  Object.defineProperty(live,'settingsFact',{enumerable:true,get(){trace.push('settingsFact');if(++getters===cancelAt)liveOwner=false;return fact;}});
  Object.defineProperty(live,'role',{enumerable:true,get(){trace.push('role');return 'slash';}});
  buildHistoryLivePresentation(x.decoded,[live]);const literalTrace=trace.splice(0);getters=0;
  const current=driver(observed,scope(),{live:[live]},()=>liveOwner),reader=x.keep(await x.prepared.openAgentCatalog(current));
  assert.equal(reader.counts.total,0);
  assert.deepEqual(trace,[...literalTrace,...literalTrace],'producer native pass and first final replay match literal old join call order');
  const retained=current.__retained();assert.equal(retained.intrinsicSettings,0,'getter rows are outside the certified intrinsic profile');assert.equal(retained.settingObservations,n+1);
  assert.equal(retained.historicalArguments,0);assert.equal(retained.historicalLookups,0);
  trace.length=0;getters=0;const before=x.calls.length;
  assert(current.isCurrent());assert.deepEqual(trace,literalTrace,'RLE replays the original trace, not one call per compressed descriptor');
  assert.equal(getters,n+1);assert.equal(x.calls.length,before,'proof remains synchronous with no second load/read');
  if(n===9){
   trace.length=0;getters=0;cancelAt=5;
   assert.equal(current.isCurrent(),false,'later repeated getter can revoke the ORIGINAL owner');
   assert.equal(getters,5,'check runs after every repetition and stops immediately on the fifth native getter');
   assert.equal(x.calls.length,before);
  }
  results.push({historicalN:n,currentRows:1,retained});await reader.close();await x.prepared.close();
 }
 assert.equal(results[0].retained.slots,results[2].retained.slots);
 // Interleaved ordinary property reads cannot be dropped across these
 // stateful getters. Generic replay storage follows the actual trace;
 // only positively certified settings/Main profiles promise C-sized proof.
 console.log('[V53R_CURRENT_SETTINGS_GENERIC_TRACE] '+JSON.stringify(results));
});

test('CURRENT object-versus-historical primitive strict equality retains no historical arguments and adds no coercion',async t=>{
 const sourceRows=Array.from({length:9},(_,i)=>({uuid:'settings-history-'+i,role:'slash',sessionId:'historical-session-'+i,
  sourceIdentity:'shared-setting',content:'',actions:[],settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}));
 const x=await rig(t,9,{sourceRows}),observed=await instrumentedDriver(),trace=[];
 const session={toString(){trace.push('session:string');return 's';},valueOf(){throw Error('STRICT_EQUAL_MUST_NOT_COERCE_OBJECT');}};
 const live={uuid:'settings-current',role:'slash',sessionId:session,sourceIdentity:'shared-setting',content:'',actions:[],
  settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}};
 buildHistoryLivePresentation(x.decoded,[live]);const literalTrace=trace.splice(0);
 const current=driver(observed,scope(),{live:[live]}),reader=x.keep(await x.prepared.openAgentCatalog(current));
 assert.equal(reader.counts.total,0);assert.equal(current.__retained().historicalArguments,0,'identity checks do not retain nine historical session strings');
 assert.deepEqual(trace,[...literalTrace,...literalTrace],'strict equality adds no toPrimitive/coercion during build or replay');
 trace.length=0;assert(current.isCurrent());assert.deepEqual(trace,literalTrace);
});


test('two alternating intrinsic CURRENT settings rows retain only C descriptor proofs as historical N grows',async t=>{
 const observed=await instrumentedDriver(),results=[];
 for(const n of [2,10]){
  const sourceRows=Array.from({length:n},(_,i)=>({uuid:'settings-history-'+i,role:'slash',sessionId:'s',sourceIdentity:'setting-'+(i%2),content:'',actions:[],
   settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}));
  const live=Array.from({length:2},(_,i)=>({uuid:'settings-current-'+i,role:'slash',sessionId:'s',sourceIdentity:'setting-'+i,content:'',actions:[],
   settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}));
  const x=await rig(t,n,{sourceRows}),originalFacts=live.map(row=>row.settingsFact);
  const shown=buildHistoryLivePresentation(x.decoded,live),literal=predicates.collectHistoryAgentChips(shown,[]);
  const current=driver(observed,scope(),{live}),reader=x.keep(await x.prepared.openAgentCatalog(current));
  const retained=current.__retained();assert.equal(reader.counts.total,literal.length);assert.equal(literal.length,0);
  assert.equal(retained.intrinsicSettings,2);assert.equal(retained.settingRuns,0);assert.equal(retained.settingObservations,0);
  assert.equal(retained.historicalArguments,0);assert.equal(retained.historicalLookups,0);
  for(let i=0;i<2;i++){assert(current.values.includes(live[i]));assert(current.values.includes(originalFacts[i]));assert.equal(live[i].settingsFact,originalFacts[i]);}
  const before=x.calls.length;assert(current.isCurrent());assert(current.hasIntrinsicReadAuthority(true));assert.equal(x.calls.length,before);
  results.push({historicalN:n,currentRows:2,retained});await reader.close();await x.prepared.close();
 }
 assert.deepEqual(results[0].retained,results[1].retained,'alternating CURRENT identities do not retain one descriptor per historical match');
 console.log('[V53R_CURRENT_SETTINGS_INTRINSIC_C2] '+JSON.stringify(results));
});

test('intrinsic settings field/descriptor/prototype mutations during FULL and each later original fence cannot publish',async t=>{
 for(const phase of ['FULL','first-fence','last-fence'])for(const change of ['value','descriptor','prototype','row-alias','kind','fact-prototype','row-uuid','row-addition','fact-addition']){
  const sourceRows=[{uuid:'settings-history',role:'slash',sessionId:'s',sourceIdentity:'setting',content:'',actions:[],
   settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}];
  const x=await rig(t,1,{sourceRows}),fact={version:1,provider:'codex',kind:'model',value:'model-a'};
  const live=[{uuid:'settings-current',role:'slash',sessionId:'s',sourceIdentity:'setting',content:'',actions:[],settingsFact:fact}];
  const context=scope(),current=driver(actual,context,{live});let armed=false,afterFull=false,fences=0,getters=0;
  const mutate=()=>{armed=false;if(change==='value')fact.value='model-b';
   else if(change==='descriptor')Object.defineProperty(fact,'value',{configurable:true,get(){getters++;return 'model-a';}});
   else if(change==='prototype')Object.setPrototypeOf(live[0],null);
   else if(change==='row-alias')live[0].settingsFact={...fact};
   else if(change==='kind')fact.kind='effort';
   else if(change==='row-uuid')live[0].uuid='a-different-current-row';
   else if(change==='row-addition')live[0].lateField='late';
   else if(change==='fact-addition')fact.lateField='late';
   else Object.setPrototypeOf(fact,null);};
  const q=queuedOwner(x,current,context,{nativeInput:{context,live},
   onFull(){if(!armed)return;afterFull=true;fences=0;if(phase==='FULL')mutate();},
   onFence(){if(armed&&afterFull&&++fences===(phase==='last-fence'?2:1))mutate();}});
  await settle(q.owner);q.drain();assert.equal(q.rendered().status,'ready');
  q.owner.requestMembership({entries:['settings-history']});await settle(q.owner);assert(q.updates.length);
  const before=x.calls.length,allocated=x.forks();armed=true;q.trace.length=0;q.drain();
  assert.equal(q.rendered().status,'error',phase+'/'+change);assert.equal(q.rendered().errorStage,'presentation');
  assert.equal(current.hasIntrinsicReadAuthority(true),false);assert.equal(getters,0,'post-proof mutation rejects without executing its replacement getter');
  assert(q.trace.indexOf('native')<q.trace.indexOf('FULL'));assert.equal(x.calls.length,before);assert.equal(x.forks(),allocated);
  assert.equal(q.owner.state().pending,false);q.owner.close();await tick();
 }
});

test('original C collection contents/order are checked after FULL and after the last cheap fence',async t=>{
 for(const phase of ['FULL','last-fence'])for(const change of ['empty-map-add','map-delete','map-order','empty-set-add']){
  const x=await rig(t),a=actual.createHistoryAgentCatalogMainFact({startedAt:4,status:'completed'}),b=actual.createHistoryAgentCatalogMainFact({startedAt:5,status:'completed'});
  const map=actual.createHistoryAgentCatalogMainFactsMap(change.startsWith('map-')?[['historical-0',a],['other',b]]:[]);
  const set=actual.createHistoryAgentCatalogMainFactsSet(),context=scope({terminalFacts:map,terminalBackgroundTaskCalls:set});
  const current=driver(actual,context);let armed=false,afterFull=false,fences=0;
  const mutate=()=>{armed=false;if(change==='empty-map-add')map.set('late',a);else if(change==='map-delete')map.delete('historical-0');
   else if(change==='map-order'){map.delete('historical-0');map.set('historical-0',a);}else set.add('late');};
  const q=queuedOwner(x,current,context,{onFull(){if(!armed)return;afterFull=true;fences=0;if(phase==='FULL')mutate();},
   onFence(){if(armed&&afterFull&&++fences===2)mutate();}});
  await settle(q.owner);q.drain();assert.equal(q.rendered().status,'ready');
  q.owner.requestMembership({entries:['row-0']});await settle(q.owner);const before=x.calls.length,allocated=x.forks();
  armed=true;q.drain();assert.equal(q.rendered().status,'error',phase+'/'+change);assert.equal(q.rendered().errorStage,'presentation');
  assert.equal(current.hasIntrinsicReadAuthority(true),false);assert.equal(x.calls.length,before);assert.equal(x.forks(),allocated);
  q.owner.close();await tick();
 }
});

test('delete/read/restore of an original Main fact is cancelled at its actual intrinsic lookup without retaining the request key',async t=>{
 const x=await rig(t),fact=actual.createHistoryAgentCatalogMainFact({startedAt:4,completedAt:9,status:'completed'});
 const map=actual.createHistoryAgentCatalogMainFactsMap([['historical-0',fact]]),context=scope({terminalFacts:map});
 const current=driver(actual,context);let observed=0,continued=0;
 const wrapped={...current,drive(stage,options){
  const intercepted=Object.create(stage,{readValue:{value:async(...args)=>{const request=await stage.readValue(...args);
   if(request.kind==='map-get'&&request.slot===current.wire.context.terminalFactsSlot){observed++;map.delete('historical-0');}
   return request;}},advance:{value:async(...args)=>{if(observed){continued++;map.set('historical-0',fact);}return stage.advance(...args);}}});
  return current.drive(intercepted,options);
 }};
 try{await assert.rejects(x.prepared.openAgentCatalog(wrapped),{code:'HISTORY_READ_CANCELLED'});}
 finally{map.set('historical-0',fact);}
 assert.equal(observed,1);assert.equal(continued,0,'a missing intrinsic value cannot continue before the original C lookup result is compared');
 assert.equal(current.isCurrent(),false,'cancelled native driver cannot become valid after A→B→A restoration');
});

test('native Proxy/getter/inherited settings and missing Node authority retain the original complete replay trace',async t=>{
 const observed=await instrumentedDriver();
 for(const profile of ['row-proxy','fact-proxy','inherited','missing-authority']){
  const sourceRows=Array.from({length:3},(_,i)=>({uuid:'settings-history-'+i,role:'slash',sessionId:'s',sourceIdentity:'setting',content:'',actions:[],
   settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}}));
  const x=await rig(t,3,{sourceRows}),trace=[],fact={version:1,provider:'codex',kind:'model',value:'model-a'};
  let live={uuid:'settings-current',role:'slash',sessionId:'s',sourceIdentity:'setting',content:'',actions:[],settingsFact:fact};
  const track=(target,fields)=>new Proxy(target,{get(object,key,receiver){if(fields.includes(key))trace.push(String(key));return Reflect.get(object,key,receiver);}});
  if(profile==='row-proxy')live=track(live,['settingsFact','role']);
  if(profile==='fact-proxy')live.settingsFact=track(fact,['version','provider','kind','value']);
  if(profile==='inherited'){delete live.settingsFact;Object.setPrototypeOf(live,{get settingsFact(){trace.push('inherited:settingsFact');return fact;}});}
  buildHistoryLivePresentation(x.decoded,[live]);const literalTrace=trace.splice(0);
  const saved=globalThis.window;if(profile==='missing-authority')globalThis.window={require(name){if(name==='node:util')throw Error('NO_NATIVE_PROXY_AUTHORITY');return require(name);}};
  let current;try{current=driver(observed,scope(),{live:[live]});}finally{globalThis.window=saved;}
  assert.equal(trace.length,0,'capability classification invokes no CURRENT getter or Proxy get trap');
  const reader=x.keep(await x.prepared.openAgentCatalog(current));assert.equal(reader.counts.total,0);
  const retained=current.__retained();assert.equal(retained.intrinsicSettings,0);assert.equal(retained.settingObservations,4);
  assert.deepEqual(trace,[...literalTrace,...literalTrace],profile+' build plus original first replay');
  trace.length=0;const before=x.calls.length;assert(current.isCurrent());assert.deepEqual(trace,literalTrace,profile+' complete original replay');assert.equal(x.calls.length,before);
  await reader.close();await x.prepared.close();
 }
});


test('native Task A → historical H → native Task B cannot mutate Main state then restore it around elided intrinsic reads',async t=>{
 for(const change of ['field','membership']){
  const history={uuid:'historical',role:'assistant',sessionId:'s',content:'',rowStub:true,actions:[],
   actionSummary:[{toolName:'Task',family:'task',toolUseId:'historical',description:'H',subagentStatus:'completed'}]};
  const x=await rig(t,1,{sourceRows:[history]}),fact=actual.createHistoryAgentCatalogMainFact({startedAt:4,completedAt:9,status:'completed'});
  const facts=actual.createHistoryAgentCatalogMainFactsMap([['historical',fact]]),context=scope({terminalFacts:facts});
  let armed=false;const trace=[];
  const a={uuid:'a',role:'assistant',sessionId:'s',content:'',actions:[{tool:'Task',toolUseId:'a',subagentStatus:'completed',
   get description(){if(armed){trace.push('mutate');if(change==='field')fact.startedAt=5;else facts.delete('historical');}return 'A';}}]};
  const b={uuid:'b',role:'assistant',sessionId:'s',content:'',actions:[{tool:'Task',toolUseId:'b',subagentStatus:'completed',
   get description(){if(armed){trace.push('restore');fact.startedAt=4;facts.set('historical',fact);}return 'B';}}]};
  const recipe={segments:[{row:a},{start:0,end:1},{row:b}]},current=driver(actual,context,recipe);
  const q=queuedOwner(x,current,context,{nativeInput:{context,recipe}});q.owner.select('task:historical');
  await settle(q.owner);q.drain();assert.equal(q.rendered().status,'ready');assert.equal(q.rendered().selected.record.startedAt,4);
  const old=q.rendered().selected.record;q.owner.requestMembership({entries:['historical']});await settle(q.owner);
  const before=x.calls.length,allocated=x.forks();armed=true;trace.length=0;q.drain();
  assert.equal(q.rendered().status,'error');assert.equal(q.rendered().selected.kind,'unknown');assert.equal(q.rendered().selected.record,old);
  assert.deepEqual(trace,['mutate'],'combined intrinsic proof rejects before a later native getter can hide the intervening change');
  assert.equal(x.calls.length,before);assert.equal(x.forks(),allocated);assert.equal(q.owner.state().pending,false);
  fact.startedAt=4;facts.set('historical',fact);trace.length=0;
  const expected=predicates.collectHistoryAgentChips([a,x.decoded[0],b],[],facts).find(value=>value.key==='task:historical');
  assert.equal(expected.startedAt,change==='field'?5:0);assert.deepEqual(trace,['mutate','restore']);assert.equal(fact.startedAt,4);assert.equal(facts.get('historical'),fact);
  armed=false;q.owner.close();await tick();
 }
});


test('private intrinsic C proofs use captured native iteration without invoking replaced public iterator getters',()=>{
 const fact=actual.createHistoryAgentCatalogMainFact({startedAt:4,status:'completed'}),facts=actual.createHistoryAgentCatalogMainFactsMap([['a',fact]]);
 const set=actual.createHistoryAgentCatalogMainFactsSet(['a']);
 const row={role:'slash',settingsFact:{version:1,provider:'codex',kind:'model',value:'model-a'}};
 const current=driver(actual,scope({terminalFacts:facts,terminalBackgroundTaskCalls:set}),{live:[row]});
 const mapIterator=Object.getPrototypeOf(new Map().entries()),setIterator=Object.getPrototypeOf(new Set().values());
 const originalMap=Object.getOwnPropertyDescriptor(mapIterator,'next'),originalSet=Object.getOwnPropertyDescriptor(setIterator,'next');
 let getters=0;
 try{
  Object.defineProperty(mapIterator,'next',{configurable:true,get(){getters++;throw Error('PUBLIC_MAP_ITERATOR_GETTER');}});
  Object.defineProperty(setIterator,'next',{configurable:true,get(){getters++;throw Error('PUBLIC_SET_ITERATOR_GETTER');}});
  assert(current.hasIntrinsicReadAuthority(true));assert(current.isCurrent());assert.equal(getters,0);
 }finally{Object.defineProperty(mapIterator,'next',originalMap);Object.defineProperty(setIterator,'next',originalSet);}
});
test('ordinary CURRENT own-data observations across mutating getters cannot disappear from queued replay',async t=>{
 const x=await rig(t,0,{sourceRows:[]}),context=scope();
 let armed=false;const trace=[];
 const action={tool:'Task',toolUseId:'x',description:'X',subagentStatus:'completed',startedAt:4,completedAt:9};
 const first={tool:'Task',toolUseId:'a',subagentStatus:'completed',startedAt:1,
  get description(){if(armed){trace.push('mutate');action.startedAt=5;}return 'A';}};
 const last={tool:'Task',toolUseId:'b',subagentStatus:'completed',startedAt:1,
  get description(){if(armed){trace.push('restore');action.startedAt=4;}return 'B';}};
 const row=(uuid,value)=>({uuid,role:'assistant',sessionId:'s',content:'',actions:[value]});
 const repeated=row('x',action),rows=[repeated,row('a',first),repeated,row('b',last)];
 const recipe={segments:rows.map(value=>({row:value}))},nativeInput={context,recipe};
 const current=driver(actual,context,recipe),q=queuedOwner(x,current,context,{nativeInput});
 q.owner.select('task:x');await settle(q.owner);q.drain();
 assert.equal(q.rendered().status,'ready');assert.equal(q.rendered().selected.record.startedAt,4);
 const before=q.rendered(),original=before.selected.record;
 q.owner.requestMembership({entries:['x']});await settle(q.owner);
 const calls=x.calls.length,forks=x.forks();
 armed=true;trace.length=0;q.drain();
 assert.equal(q.rendered().status,'error','a changed intermediate CURRENT observation cannot publish READY');
 assert.equal(q.rendered().selected.kind,'unknown');
 assert.equal(q.rendered().selected.record,original,'original same-owner detail remains mounted during UNKNOWN');
 assert.deepEqual(trace,['mutate'],'stop on the changed second own-data read before a later getter can restore it');
 assert.equal(q.owner.isCurrent(before),false);assert.equal(q.owner.state().pending,false);
 assert.equal(x.calls.length,calls,'synchronous proof adds no read/retry');
 assert.equal(x.forks(),forks,'no second catalog allocation');
 // A separate literal fold proves the previously omitted observation matters.
 action.startedAt=4;trace.length=0;
 const expected=predicates.collectHistoryAgentChips(rows,[]).find(value=>value.key==='task:x');
 assert.equal(expected.startedAt,5);assert.deepEqual(trace,['mutate','restore']);assert.equal(action.startedAt,4);
 armed=false;q.owner.close();await tick();
});

test('adjacent generic settings RLE replays every recorded invocation and revocation',async()=>{
 const observed=await instrumentedDriver(),trace=[],fact={version:1,provider:'codex',kind:'model',value:'model-a'};
 let calls=0,liveOwner=true,cancelAt=Infinity;
 const row={uuid:'generic-rle',get role(){trace.push('role');return 'slash';},
  get settingsFact(){trace.push('settingsFact');if(++calls===cancelAt)liveOwner=false;return fact;}};
 const current=driver(observed,scope(),{live:[row]},()=>liveOwner);
 const rowSlot=current.values.indexOf(row);assert(rowSlot>=0);
 for(let i=0;i<7;i++)current.__observe({kind:'setting',rowSlot});
 const originalTrace=trace.splice(0),retained=current.__retained();
 assert.equal(calls,7);assert.equal(retained.intrinsicSettings,0);
 assert.equal(retained.settingRuns,1);assert.equal(retained.settingObservations,7);
 calls=0;assert(current.isCurrent());assert.deepEqual(trace.splice(0),originalTrace);assert.equal(calls,7);
 calls=0;cancelAt=5;assert.equal(current.isCurrent(),false);assert.equal(calls,5);
});

test('Main event candidates keep old identity filtering before strict intrinsic collection authorization',()=>{
 const foreignIdentity={toString(){throw Error('OWNER_FILTER_MUST_NOT_COERCE');}};
 const candidate=actual.createHistoryAgentCatalogMainFact({provider:'codex',toolUseId:'foreign',
  sessionId:foreignIdentity,generation:'g',startedAt:1,completedAt:2,status:'completed'});
 assert.equal(candidate.sessionId,foreignIdentity,'normalization keeps its original value for the existing exact filter');
 assert.equal(candidate.sessionId==='s',false);
 assert.throws(()=>actual.createHistoryAgentCatalogMainFactsMap([['foreign',candidate]]),
  {code:'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE'},'unfiltered structural identity cannot authorize intrinsic Main reads');
 const good=actual.createHistoryAgentCatalogMainFact({provider:'codex',toolUseId:'own',
  sessionId:'s',generation:'g',startedAt:1,status:'running'});
 const facts=actual.createHistoryAgentCatalogMainFactsMap([['own',good]]);
 assert.equal(facts.get('own'),good);
});

test('Main-only terminal enumeration cannot retain authority after values method replacement',()=>{
 const fact=actual.createHistoryAgentCatalogMainFact({toolUseId:'a',provider:'codex',startedAt:1,
  completedAt:2,status:'completed',agentSessionId:'own',sessionId:'s',generation:'g'});
 const facts=actual.createHistoryAgentCatalogMainFactsMap([['a',fact]]);
 const current=driver(actual,scope({terminalFacts:facts}));
 assert(current.hasIntrinsicReadAuthority(true));
 const original=facts.values;
 try{
  Object.defineProperty(facts,'values',{configurable:true,value(){throw Error('CUSTOM_VALUES_MUST_NOT_RUN');}});
  assert.equal(current.hasIntrinsicReadAuthority(true),false);
  assert.equal(current.isCurrent(),false);
 }finally{delete facts.values;}
 assert.equal(facts.values,original);
});

test('native for-of continuation captures next once per iterator in build and replay',async()=>{
 const observed=await instrumentedDriver();let getters=0;
 const iterable={ [Symbol.iterator](){let ordinal=0;return {
  get next(){getters++;return function(){return ordinal++===0?{done:false,value:7}:{done:true};};}
 };}};
 const current=driver(observed,scope(),{live:[iterable]});
 const sourceSlot=current.values.indexOf(iterable);assert(sourceSlot>=0);
 const encoded=current.__observe({kind:'iterator',slot:sourceSlot});
 const iterator=current.values[encoded.slot];assert.equal(getters,1);
 Object.defineProperty(iterator,'next',{configurable:true,value(){throw Error('LATE_NEXT_MUST_NOT_REPLACE_CAPTURED_METHOD');}});
 const first=current.__observe({kind:'next',slot:encoded.slot});
 const last=current.__observe({kind:'next',slot:encoded.slot});
 assert.equal(current.values[first.slot].value,7);assert.equal(current.values[last.slot].done,true);
 assert.equal(getters,1);
 assert(current.isCurrent());assert.equal(getters,2,'one next getter per new iterator, not one per step');
});





