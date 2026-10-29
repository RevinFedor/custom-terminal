import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {getHeapStatistics} from 'node:v8';
import {HistoryPrimaryRootReadModel} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {createHistoryAgentCatalogCurrent,createHistoryAgentCatalogMainFact,createHistoryAgentCatalogMainFactsMap} from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import {isHistoryTaskChipLive} from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import {isHistoryBackgroundTaskLive} from '../src/renderer/utils/historyProcessLiveness.mjs';
const require=createRequire(import.meta.url);
const {createPrimaryAddressFixture}=require('./test-support/history-primary-address-fixture.cjs');
const {createHistoryAgentCatalogOracle,sourcePins}=require('./test-support/history-agent-catalog-oracle.cjs');
const oracle=createHistoryAgentCatalogOracle({isHistoryTaskChipLive,isHistoryBackgroundTaskLive});
globalThis.window={require}; globalThis.localStorage={getItem(){return null},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=80*1024**2);
assert.equal(sourcePins.sourceBytes,1332531);
assert.equal(sourcePins.sourceSHA256,'9b61ffee0592c8148e285600a72aedb4205220b6cbb7b673e124709898a1f994');
const fact=x=>createHistoryAgentCatalogMainFact(x);
const map=entries=>createHistoryAgentCatalogMainFactsMap(entries.map(([k,v])=>[k,fact(v)]));
const base={provider:'codex',toolUseId:'call',label:'Agent label',agentSessionId:'full-child-session',sessionId:'s',generation:'g',startedAt:10,launchSettings:{version:1,model:'x'}};
const scope=x=>({isTurnBusy:false,agentProcessAlive:true,currentSessionId:'s',currentProcessGeneration:'g',chipToolType:'codex',...x});
const summary=r=>Object.fromEntries(['key','kind','label','startedAt','status','completedAt','durationMs'].map(k=>[k,r[k]]));
async function check(t,rows,context){
 const f=await createPrimaryAddressFixture(null,{entries:[],sessionId:'s'});
 let model,prepared,reader;
 t.after(async()=>{await reader?.close();await prepared?.close();await model?.close();assert.equal(f.plane.roots.size,0);f.close()});
 const control={assertCurrent(){},async checkpoint(){await new Promise(r=>setImmediate(r))}};
 const invoke=(channel,payload)=>channel.endsWith('fork-read-leaf')&&payload.encoding==='history-primary-agent-catalog-v1' ? f.plane.forkAgentCatalog(payload,{consumerKey:f.consumerKey,control}):f.invoke(channel,payload);
 model=new HistoryPrimaryRootReadModel(invoke,f.transport);model.windowDiagnostic=()=>{};
 await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],grouping:{enabled:false,threshold:2,responseWork:true,expandedKeys:[]},captionSelections:[],settingsPresentationKeys:[]}});
 prepared=model.retainPreparedPresentation(); await model.close();
 const current=createHistoryAgentCatalogCurrent({recipe:{insertions:rows},context,owns:()=>true,isLocalPromptEntry:oracle.isLocalPromptEntry,isTaskAction:oracle.isTaskAction,historyAgentKey:oracle.historyAgentKey,fingerprint:()=>''});
 const background=oracle.collectHistoryBackgroundChips(rows,context.isTurnBusy,context.agentProcessAlive,context.currentSessionId,context.currentProcessGeneration,context.chipToolType,context.exactActiveSubagents,context.exactActiveBackgroundTasks,context.terminalBackgroundTaskCalls);
 const agents=oracle.collectHistoryAgentChips(rows,background,context.terminalFacts);
 reader=await prepared.openAgentCatalog(current);
 const running=agents.filter(x=>x.status==='running'),completed=agents.filter(x=>x.status==='completed'),interrupted=agents.filter(x=>x.status==='interrupted');
 assert.deepEqual(reader.counts,{total:agents.length,roster:agents.length,running:running.length,completed:completed.length,interrupted:interrupted.length,background:background.length,backgroundAgents:background.filter(x=>x.kind==='subagent').length});
 for(const [section,expected] of [['background',background],['roster',[...running,...completed,...interrupted]]]){
  let got=[],offset=0;do{const page=await reader.readPage({section,offset,limit:3});got.push(...page.rows);offset=page.nextOffset;if(page.done)break;}while(true);
  assert.deepEqual(got,expected.map(summary));
 }
 for(const item of agents){const selected=await reader.lookup(item.key);assert.equal(selected.kind,'found');assert.deepEqual(selected.record,item)}
 return {background,agents,reader};
}
test('active Main-only exact parent scope and metadata survive ready catalog',async t=>{
 const active=map([['call',base],['wrong-session',{...base,toolUseId:'ws',sessionId:'other'}],['wrong-generation',{...base,toolUseId:'wg',generation:'other'}],['wrong-provider',{...base,toolUseId:'wp',provider:'claude'}],['no-child',{...base,toolUseId:'nc',agentSessionId:''}]]);
 const r=await check(t,[],scope({exactActiveSubagents:active}));assert.equal(r.agents.length,1);assert.equal(r.agents[0].entryUuid,'');assert.equal(r.agents[0].agentSessionId,'full-child-session');
});
test('dead parent excludes active Main-only agents',async t=>{const r=await check(t,[],scope({agentProcessAlive:false,exactActiveSubagents:map([['call',base]])}));assert.equal(r.agents.length,0)});
test('hydrated canonical alias suppresses duplicate Main-only face',async t=>{
 const rows=[{uuid:'row',role:'assistant',sessionId:'s',actions:[{tool:'Task',toolUseId:'call:canonical:1',description:'hydrated'}]}];
 const r=await check(t,rows,scope({exactActiveSubagents:map([['call',base]])}));assert.equal(r.background.length,1);assert.equal(r.background[0].entryUuid,'row');
});
test('terminal Main-only selected same key retains frozen duration and full metadata',async t=>{
 const terminal=map([['call',{...base,completedAt:26,status:'interrupted'}]]);
 const r=await check(t,[],scope({agentProcessAlive:false,terminalFacts:terminal}));assert.equal(r.agents[0].key,'task:call');assert.equal(r.agents[0].durationMs,16);assert.equal(r.agents[0].entryUuid,'');
});

test('terminal values protocol matches literal collector when public Map next distinguishes entry pairs',async t=>{
 const terminal=map([['call',{...base,completedAt:26,status:'completed'}]]);
 const prototype=Object.getPrototypeOf(new Map().entries()),before=Object.getOwnPropertyDescriptor(prototype,'next');
 let skippedEntryPairs=0;
 try{
  Object.defineProperty(prototype,'next',{...before,value:function(){
   const result=Reflect.apply(before.value,this,[]);
   if(!result.done&&Array.isArray(result.value)&&result.value[0]==='call'){
    skippedEntryPairs++;return Reflect.apply(before.value,this,[]);
   }
   return result;
  }});
  const result=await check(t,[],scope({agentProcessAlive:false,terminalFacts:terminal}));
  assert.equal(result.agents.length,1);
  assert.equal(result.agents[0].key,'task:call');
  assert.equal(result.agents[0].durationMs,16);
  assert.equal(skippedEntryPairs,0,'terminal compiler consumes values directly, not a derived entries traversal');
 }finally{Object.defineProperty(prototype,'next',before);}
});

