// V53 preserving repair: actual decoded-thin oracle and cooperative producer.
// Synthetic parsed fixture + in-process IPC only; no native paint/provider data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryAgentCatalogCurrent,createHistoryAgentCatalogMainFactsMap } from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import { isHistoryTaskChipLive } from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import { isHistoryBackgroundTaskLive } from '../src/renderer/utils/historyProcessLiveness.mjs';
import { catalogScope, agentRow, taskAction, literalCatalog } from './test-support/history-agent-catalog-fixtures.mjs';
const require=createRequire(import.meta.url);
const { createPrimaryAddressFixture }=require('./test-support/history-primary-address-fixture.cjs');
const { createHistoryAgentCatalogOracle }=require('./test-support/history-agent-catalog-oracle.cjs');
const { HistoryAgentCatalog }=require('../src/main/history-root-engine/main/history-primary-agent-catalog.js');
const { HistoryPagedStore,materializeHistoryCursorSync }=require('../src/main/history-root-engine/main/history-paged-store.js');
const Database=require('./test-support/history-node-sqlite.cjs');
const oracle=createHistoryAgentCatalogOracle({isHistoryTaskChipLive,isHistoryBackgroundTaskLive});
globalThis.window={require};globalThis.localStorage={getItem(){return null},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=80*1024**2);
for(const path of ['src/main/history-root-engine/main/history-primary-agent-catalog.js','src/main/history-root-engine/main/history-agent-catalog-work.js',
 'src/main/history-root-engine/main/history-agent-catalog-scalars.js','src/renderer/utils/historyAgentCatalogCurrent.mjs',
 'scripts/history-agent-catalog-repair-v53-source.test.mjs']){
 const bytes=readFileSync(new URL('../'+path,import.meta.url));console.log('[V53_REPAIR_PIN] '+JSON.stringify({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
}
const thin=(uuid,description='agent',extra={})=>agentRow(uuid,[],{rowStub:true,actionSummary:[{toolName:'Task',family:'task',toolUseId:uuid,description,subagentStatus:'completed',...extra}]});
function current(recipe={},context={}){return createHistoryAgentCatalogCurrent({recipe:{segments:[],replacements:[],exclusions:[],insertions:[],live:[],...recipe},context:catalogScope(context),
 isLocalPromptEntry:oracle.isLocalPromptEntry,isTaskAction:oracle.isTaskAction,historyAgentKey:oracle.historyAgentKey,owns:()=>true,fingerprint:()=>''});}
async function connected(entries,fn){
 const f=await createPrimaryAddressFixture(null,{entries,sessionId:'session'});let model,held,reader;
 const control={assertCurrent(){},async checkpoint(){assert.equal(f.store.depth,0);assert.equal(f.store.stats().activeBuilders,0);await Promise.resolve();}};
 const invoke=(channel,payload)=>channel==='agent-transcript:fork-read-leaf'&&payload.encoding==='history-primary-agent-catalog-v1'
  ?f.plane.forkAgentCatalog(payload,{consumerKey:f.consumerKey,control})
  :channel==='agent-transcript:cancel-read'?Promise.resolve({success:true}):f.invoke(channel,payload);
 try{
  model=new HistoryPrimaryRootReadModel(invoke,f.transport);model.windowDiagnostic=()=>{};
  await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],grouping:{enabled:false,responseWork:false},captionSelections:[],settingsPresentationKeys:[]}});
  const decoded=model.metadata.entries,prepared=[...f.plane.roots.values()].find(state=>state.preparedPresentationRequestId);
  assert.equal(prepared.primaryPresentation.canonicalMetadataValidation.kind,'validated');assert.equal(prepared.primaryPresentation.preparedMetadataValidation.kind,'validated');
  held=model.retainPreparedPresentation();await model.close();assert.equal(held.closed,false);
  await fn({f,decoded,held,async open(recipe){reader=await held.openAgentCatalog(current(recipe));return reader;}});
 }finally{await reader?.close();await held?.close();await model?.close();assert.equal(f.store.stats().activeBuilders,0);f.close();}
}
async function compare(reader,expected){
 assert.equal(reader.counts.total,expected.length);let out=[];
 for(let offset=0;;){const page=await reader.readPage({offset,limit:2});out.push(...page.rows);if(page.done)break;offset=page.nextOffset;}
 assert.deepEqual(out.map(x=>[x.key,x.label,x.status]),expected.map(x=>[x.key,x.label,x.status]));
 for(const record of expected){const found=await reader.lookup(record.key);assert.equal(found.kind,'found');assert.deepEqual(found.record,record);}
}
test('R1 actual decoded thin null-prototype label survives independent original model.close',async()=>{
 await connected([thin('null-prototype',Object.create(null))],async({decoded,open})=>{
  assert.equal(Object.getPrototypeOf(decoded[0].actionSummary[0].description),Object.prototype);
  const expected=oracle.collectHistoryAgentChips(decoded,[]);assert.equal(expected[0].label,'[object Object]');
  await compare(await open({segments:[{start:0,end:1}]}),expected);
 });
});
test('R1 indexed arrays discard custom fields while preserving holes/undefined/aliases/cycles/full UTF16 selected fields',async()=>{
 const alias=Object.create(null);alias.exact='prompt\0\ud800\uffff';const array=new Array(4);array[0]='A';array[2]=undefined;array[3]=alias;
 array.join=null;array.toString=null;array.extra=array;const cyclic=['head'];cyclic.push(cyclic);
 const prompt={a:alias,b:alias,cycle:null};prompt.cycle=prompt;
 await connected([thin('array',array,{taskPrompt:prompt}),thin('cycle',cyclic)],async({decoded,open})=>{
  const a=decoded[0].actionSummary[0].description;assert.equal(Object.hasOwn(a,'join'),false);assert.equal(1 in a,false);assert.equal(2 in a,true);
  const p=decoded[0].actionSummary[0].taskPrompt;assert.equal(p.a,p.b);assert.equal(p.cycle,p);
  const expected=oracle.collectHistoryAgentChips(decoded,[]);assert.equal(expected[0].label,'A,,,[object Object]');
  await compare(await open({segments:[{start:0,end:2}]}),expected);
 });
});
test('R1 actual decoder property definitions, nonmonotone/repeated/hidden ordinals use same independent source',async()=>{
 const obj={};Object.defineProperty(obj,'__proto__',{value:{toString:null},enumerable:true});
 await connected([thin('first',obj),thin('hidden','never selected'),thin('third','third'),thin('last','last')],async({decoded,held,open})=>{
  assert.equal(Object.getPrototypeOf(decoded[0].actionSummary[0].description),Object.prototype);
  assert.equal(Object.hasOwn(decoded[0].actionSummary[0].description,'__proto__'),true);
  const selected=[decoded[3],decoded[0],decoded[2],decoded[3]],expected=oracle.collectHistoryAgentChips(selected,[]);
  const reader=await open({segments:[{start:3,end:4},{start:0,end:1},{start:2,end:4}]});await held.close();
  await compare(reader,expected);assert.equal((await reader.lookup('task:hidden')).kind,'missing');
 });
});
test('R1 genuine CURRENT null prototype still throws; custom array join/native selected references stay native',async()=>{
 await connected([],async({open})=>{
  const native=agentRow('native',[taskAction('native',{description:Object.create(null),result:'done'})]);
  assert.throws(()=>literalCatalog(oracle,[native]),TypeError);await assert.rejects(open({live:[native]}),TypeError);
 });
 await connected([],async({open})=>{
  const description=['A'];description.join=null;const history=new Uint16Array([0,0xd800,0xffff]),launch=new Map([['original',new Set([true])]]);
  const row=agentRow('native-array',[taskAction('native-array',{description,result:'done\0\ud800',history,launchSettings:launch})]);
  const reader=await open({live:[row]}),expected=literalCatalog(oracle,[row]).agents;await compare(reader,expected);
  const selected=await reader.lookup('task:native-array');assert.equal(selected.record.taskHistory,history);assert.equal(selected.record.launchSettings,launch);
  assert.equal(selected.record.label,'[object Array]');
 });
});

function direct(rows,recipe={},context={}){
 const driver=current({segments:undefined,...recipe},context),store=new HistoryPagedStore({Database,diskBytes:28*1024**2,pageBytes:1024,residentPages:3,indexBytes:2048,sqlCacheKiB:8});
 const source=store.captureLegacy(rows),catalog=new HistoryAgentCatalog(store,source.cursor(),driver.wire,{},'work-control');
 return {store,source,catalog,driver,close(){catalog.close();source.release();assert.equal(store.stats().activeBuilders,0);assert.equal(store.stats().leases,0);store.close();}};
}
async function cancelAt(rows,recipe,stage,kind,context={}){
 const d=direct(rows,recipe,context);let active=true,checks=0,previous=0,target;
 const observed={summaries:0,agents:0,aliasPushes:0,anchors:0,textChars:0};
 const record=d.catalog.record,wrapper=d.catalog.wrapper,push=d.catalog.push,write=d.catalog.draftWrite;
 d.catalog.record=function(fields){if(fields.tool==='Task')observed.summaries++;if(Object.hasOwn(fields,'index')&&Object.hasOwn(fields,'offset'))observed.anchors++;return record.call(this,fields);};
 d.catalog.wrapper=function(fields){if(fields.kind==='subagent')observed.agents++;return wrapper.call(this,fields);};
 d.catalog.push=function(array,value){if(typeof value==='string'&&value.startsWith('alias-'))observed.aliasPushes++;return push.call(this,array,value);};
 d.catalog.draftWrite=function(draft,part){assert(part.length<=128);observed.textChars+=part.length;return write.call(this,draft,part);};
 const control={assertCurrent(){assert.equal(active,true,'ORIGINAL_CONSUMER_CANCELLED');},async checkpoint(){
  checks++;assert.equal(d.store.depth,0);assert.equal(d.store.stats().activeBuilders,0);
  assert(d.catalog.metrics.workUnits-previous<=64);previous=d.catalog.metrics.workUnits;
  if(d.catalog.metrics.stage===stage&&(!kind||d.catalog.metrics.lastWorkKind===kind)){
   target={...d.catalog.metrics,observed:{...observed}};active=false;
  }
 }};
 try{
  await assert.rejects(async()=>{
   await d.catalog.resume(undefined,control);
   const getHeader=()=>({phase:d.catalog.phase,sequence:d.catalog.sequence,nativeRequest:d.catalog.pending});
   const transport={header:getHeader(),async advance(value){await d.catalog.resume(value,control);d.catalog.sequence++;this.header=getHeader();},async readValue(){return d.catalog.pending;}};
   await d.driver.drive(transport);
  },/ORIGINAL_CONSUMER_CANCELLED/);
  assert(target,'requested inner work reached checkpoint');assert(target.maxWorkBetweenYields<=64);assert(checks>0);
  console.log('[V53_FIRST_CANCEL] '+JSON.stringify({stage,kind,checks,target}));return target;
 }finally{d.close();}
}
test('R2 constructor defers whole recipe import; first recipe-import yield cancels before all segments',async()=>{
 const entries=[thin('one')],segments=Array.from({length:129},()=>({start:0,end:1}));
 const d=direct(entries,{segments});try{assert.equal(d.catalog.metrics.workUnits,0);assert.equal(d.catalog.arena.state().current,null);}finally{d.close();}
 const target=await cancelAt(entries,{segments},'recipe-import');assert.equal(target.sourceRows,0);
});
test('R2 one65-action row yields inside inner action scan/fold before65 records; no SQL/builder survives cancellation',async()=>{
 const row=thin('wide');row.actionSummary=Array.from({length:65},(_,i)=>({toolName:'Task',toolUseId:'wide-'+i,description:'wide'+i,subagentStatus:'completed'}));
 const target=await cancelAt([row],{},'fold');assert(target.historicalActions<65);assert(target.observed.summaries<65);assert(target.observed.agents<65);
});
test('R2 wide object graph normalization and one129-alias join yield under original consumer',async()=>{
 const row=thin('aliases');row.sourceIdentityAliases=Array.from({length:129},(_,i)=>'alias-'+i);
 const graph=Object.fromEntries(Array.from({length:129},(_,i)=>['field'+i,{value:i}]));row.actionSummary[0].taskPrompt=graph;
 await cancelAt([row],{},'thin-normalization');
 const alias=await cancelAt([row],{live:[agentRow('new',[],{sourceIdentity:'unmatched'})]},'join-aliases','alias-dedup');assert(alias.observed.aliasPushes>0);assert(alias.observed.aliasPushes<129);
});
test('R2 inner physical join/anchors and long keys/text suffix/scalar scan are cooperative',async()=>{
 const rows=Array.from({length:17},(_,i)=>({...thin('p'+i),sourceIdentity:'source'+i,recordByteOffset:17-i}));
 const anchors=await cancelAt(rows,{live:[agentRow('new',[],{sourceIdentity:'unmatched',recordByteOffset:8.5})]},'join-anchors');assert(anchors.observed.anchors<17);
 const long=thin('key'+'x'.repeat(9000),'label');await cancelAt([long],{},'fold','text-concat-window');
 const suffix=thin('suffix','label'+' '.repeat(9000));await cancelAt([suffix],{},'fold','label-trim');
 const canonical=thin('id:canonical:'+'1'.repeat(9000));await cancelAt([canonical],{},'fold','canonical-suffix',{terminalFacts:createHistoryAgentCatalogMainFactsMap()});
 const numeric=thin('numeric','plain',{startedAt:'0'.repeat(9000)+'4'});await cancelAt([numeric],{},'fold','scalar-step');
 const date=thin('date');date.timestamp='2026-10-27 ('+'x'.repeat(9000)+')';await cancelAt([date],{},'fold','scalar-step');
});
test('R2 actual IPC scalar continuation import cancels before full text; held sibling/source remains open',async()=>{
 const f=await createPrimaryAddressFixture(null,{entries:[],sessionId:'session'});let model,held,reader,alive=true,checkpoint,appendRequests=0;
 const full='D'.repeat(32768),row=agentRow('native-scalar',[taskAction('native-scalar',{description:full,result:'done'})]);
 const invoke=async(channel,payload)=>{
  if(channel==='agent-transcript:cancel-read')return {success:true};
  if(channel==='agent-transcript:fork-read-leaf'&&payload.encoding==='history-primary-agent-catalog-v1')return f.plane.forkAgentCatalog(payload,{consumerKey:f.consumerKey,control:{assertCurrent(){},async checkpoint(){assert.equal(f.store.depth,0);assert.equal(f.store.stats().activeBuilders,0);}}});
  if(channel==='agent-transcript:read-page'&&payload.kind==='primary-agent-catalog-step'){
   if(payload.operation==='append-value')appendRequests++;
   const c=f.plane.state(payload,f.consumerKey).agentCatalog;
   return f.plane.readPage(payload,{consumerKey:f.consumerKey,control:{assertCurrent(){if(!alive)throw Object.assign(new Error('ORIGINAL_SCALAR_CANCELLED'),{code:'ORIGINAL_SCALAR_CANCELLED'});},async checkpoint(){
    assert.equal(f.store.depth,0);assert.equal(f.store.stats().activeBuilders,0);
    if(payload.operation==='append-value'||payload.operation==='advance-value'){checkpoint={operation:payload.operation,scalarLength:c.scalarLength||0,metrics:{...c.metrics}};alive=false;}
   }}});
  }
  return f.invoke(channel,payload);
 };
 try{
  model=new HistoryPrimaryRootReadModel(invoke,f.transport);model.windowDiagnostic=()=>{};
  await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],grouping:{enabled:false,responseWork:false},captionSelections:[],settingsPresentationKeys:[]}});
  held=model.retainPreparedPresentation();await model.close();
  await assert.rejects(async()=>{reader=await held.openAgentCatalog(current({live:[row]}));},/ORIGINAL_SCALAR_CANCELLED/);
  assert(checkpoint);assert(checkpoint.scalarLength<full.length);assert(appendRequests>0);assert.equal(held.closed,false);
  assert.equal(row.actions[0].description,full);console.log('[V53_SCALAR_CANCEL] '+JSON.stringify({appendRequests,checkpoint}));
 }finally{await reader?.close();await held?.close();await model?.close();f.close();}
});
test('R1 unsupported historical Map/Set follows actual decoder error grammar; CURRENT values remain native',async()=>{
 for(const selected of [new Map([['key','value']]),new Set(['value'])]){
  const rows=[thin('mapset','agent',{launchSettings:selected})],f=await createPrimaryAddressFixture(null,{entries:rows,sessionId:'session'});
  const model=new HistoryPrimaryRootReadModel(f.invoke,f.transport);model.windowDiagnostic=()=>{};
  try{await assert.rejects(model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],grouping:{enabled:false,responseWork:false},captionSelections:[],settingsPresentationKeys:[]}}),/HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED/);}
  finally{await model.close();f.close();}
  const d=direct(rows);try{await assert.rejects(d.catalog.resume(),/HISTORY_PRIMARY_METADATA_CONTAINER_WIRE_REQUIRED/);}finally{d.close();}
 }
});
