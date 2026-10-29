import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {getHeapStatistics} from 'node:v8';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createHistoryAgentCatalogCurrent,createHistoryAgentCatalogMainFact,createHistoryAgentCatalogMainFactsMap,createHistoryAgentCatalogMainFactsSet} from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import {buildHistoryLivePresentation} from '../src/renderer/utils/historyLiveProjection.mjs';
import {isHistoryTaskChipLive} from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import {isHistoryBackgroundTaskLive} from '../src/renderer/utils/historyProcessLiveness.mjs';
import {farHistoryFixture,fullNativeFixture,nativeGrammarFixture,agentRow,taskAction,catalogScope,literalCatalog} from './test-support/history-agent-catalog-fixtures.mjs';
const require=createRequire(import.meta.url);
const {HistoryPagedStore,materializeHistoryCursorSync}=require('../src/main/history-root-engine/main/history-paged-store.js');
const {HistoryAgentCatalog}=require('../src/main/history-root-engine/main/history-primary-agent-catalog.js');
const Database=require('./test-support/history-node-sqlite.cjs');
const {createHistoryAgentCatalogOracle}=require('./test-support/history-agent-catalog-oracle.cjs');
const oracle=createHistoryAgentCatalogOracle({isHistoryTaskChipLive,isHistoryBackgroundTaskLive});
assert(getHeapStatistics().heap_size_limit<=80*1024**2,'runtime old64/semi2 cap');
for(const path of ['src/main/history-root-engine/main/history-primary-agent-catalog.js','src/renderer/utils/historyAgentCatalogCurrent.mjs',
 'scripts/history-agent-catalog-producer-v53-source.test.mjs']){
 const bytes=readFileSync(new URL('../'+path,import.meta.url));
 console.log('[V53_PRODUCER_SOURCE_PIN] '+JSON.stringify({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
}
const isLocal=e=>e.role==='queued'&&e.uuid.startsWith('local-prompt-');
const isTask=a=>typeof a==='object'&&a!==null&&'tool'in a&&a.tool==='Task';
async function run(sourceRows,recipe={},context=catalogScope(),terminalFacts) {
 const native=createHistoryAgentCatalogCurrent({recipe:{replacements:[],exclusions:[],insertions:[],live:[],...recipe},context:{...context,terminalFacts},
  isLocalPromptEntry:isLocal,isTaskAction:isTask,historyAgentKey:oracle.historyAgentKey,fingerprint:()=>'',owns:()=>true});
 const store=new HistoryPagedStore({Database,diskBytes:28*1024**2,pageBytes:1024,residentPages:3,indexBytes:2048,sqlCacheKiB:8});let source,catalog;
 try {
  source=store.captureLegacy(sourceRows);
  catalog=new HistoryAgentCatalog(store,source.cursor(),native.wire,{},'test');
  await catalog.resume();let sequence=0;
  const getHeader=()=>({phase:catalog.phase,sequence,nativeRequest:catalog.pending});
  const stage={header:getHeader(),async advance(value){await catalog.resume(value);sequence++;this.header=getHeader();},async readValue(){return catalog.pending;}};
  await native.drive(stage);
  const unwrap=items=>items.map(wrapper=>{for(const [field,slot]of Object.entries(wrapper.fieldRefs))wrapper.record[field]=native.values[slot];return wrapper.record;});
  const root=catalog.cursor();
  return {agents:unwrap(materializeHistoryCursorSync(root.field('sections').field('all'))),
   background:unwrap(materializeHistoryCursorSync(root.field('sections').field('background'))),
   counts:materializeHistoryCursorSync(root.field('counts')),metrics:catalog.metrics,stats:catalog.arena.stats(),native};
 }finally{catalog?.close();source?.release();store.close();}
}
function effective(rows,recipe){
 const replacements=new Map((recipe.replacements||[]).map(x=>[x.ordinal,x.row]));const exclusions=new Set(recipe.exclusions||[]);
 let entries=recipe.segments?recipe.segments.flatMap(segment=>'row'in segment?[segment.row]:rows.slice(segment.start,segment.end))
  :rows.map((e,i)=>({row:replacements.get(i)||e,index:i})).filter(x=>!exclusions.has(x.index)).map(x=>x.row);
 if(recipe.insertions?.length)entries=buildHistoryLivePresentation(entries,recipe.insertions);
 if(recipe.live?.length)entries=buildHistoryLivePresentation(entries,recipe.live);
 return entries;
}
async function equivalent(rows,recipe,context,terminals){
 const result=await run(rows,recipe,context,terminals);const expected=literalCatalog(oracle,effective(rows,recipe),context,terminals);
 assert.deepEqual(result.agents,expected.agents);assert.deepEqual(result.background,expected.background);return result;
}
test('actual paged producer keeps all far completed/interrupted rows and exact sections',async()=>{
 // The preserved101-row run passed under the product store's20GiB default,
 // then honestly failed when this fixture was tightened to28MiB (SQLite
 // reserves half for its journal). Keep that quota;73 is beyond the UI's
 // bounded64-row page and still exercises every historical fold/section.
 const result=await equivalent(farHistoryFixture(73),{},catalogScope());
 assert.equal(result.counts.total,73);assert.equal(result.counts.completed,37);assert.equal(result.counts.interrupted,36);
 assert.equal(result.stats.ownership.nativeMapEntries,0);assert.equal(result.stats.ownership.nativeRows,0);assert.equal(result.metrics.nativeRequests,0);
 console.log('[V53_PRODUCER_COST] '+JSON.stringify({metrics:result.metrics,arena:result.stats,heapUsed:process.memoryUsage().heapUsed,
  heapLimit:getHeapStatistics().heap_size_limit,nativeLatency:false,globalMemoryMeasured:false}));
});
test('literal historical duplicate fallback chains and stable ties',async()=>{
 const rows=[agentRow('a',[taskAction('x',{startedAt:10,result:'first',history:[1],taskPrompt:'old'})]),
 agentRow('b',[taskAction('y',{startedAt:20,subagentStatus:'completed'})]),
 agentRow('c',[taskAction('x',{startedAt:20,result:undefined,history:[],taskPrompt:''})])];
 await equivalent(rows,{},catalogScope());
});
test('CURRENT inherited Task, sparse/undefined actions, BigInt Number coercion and typed history stay native',async()=>{
 const f=nativeGrammarFixture();const result=await equivalent([], {live:f.entries},catalogScope());
 assert.equal(result.agents[0].taskHistory,f.history);
});
test('CURRENT full UTF16/NUL fields and original selected object identity',async()=>{
 const f=fullNativeFixture();const result=await equivalent([], {live:f.entries},catalogScope());
 assert.equal(result.agents[0].taskHistory,f.history);assert.equal(result.agents[0].launchSettings,f.launchSettings);
 assert.equal(result.agents[0].taskPrompt,f.full);
});
test('native live duplicates only first record consumes liveByKey; old fallback and count remain exact',async()=>{
 const rows=[agentRow('a',[taskAction('x',{startedAt:10})]),agentRow('b',[taskAction('x',{startedAt:20})])];
 const context=catalogScope({isTurnBusy:true,agentProcessAlive:true,exactActiveSubagents:createHistoryAgentCatalogMainFactsMap([['x',createHistoryAgentCatalogMainFact({provider:'codex',startedAt:50,agentId:'current'})]])});
 await equivalent([], {live:rows},context);
});
test('two causal joins normalize historical inversion; unmatched early return does not touch native physical getters',async()=>{
 const rows=[agentRow('r1',[],{sourceIdentity:'s1',recordByteOffset:30,actionSummary:[{toolName:'Task',toolUseId:'dup',description:'first'}]}),
 agentRow('r2',[],{sourceIdentity:'s2',recordByteOffset:10,actionSummary:[{toolName:'Task',toolUseId:'dup',description:'second'}]})];
 const live=agentRow('r3',[taskAction('current')],{sourceIdentity:'s3',recordByteOffset:20});
 await equivalent(rows,{live:[live]},catalogScope());
 const matched={role:'assistant',uuid:'r1',sourceIdentity:'s1'};Object.defineProperty(matched,'recordByteOffset',{get(){throw Error('unused physical');}});
 await equivalent(rows,{live:[matched]},catalogScope());
});
test('exact Main orphan background tasks and terminal tombstones preserve branches',async()=>{
 const context=catalogScope({agentProcessAlive:true,chipToolType:'claude',exactActiveBackgroundTasks:createHistoryAgentCatalogMainFactsMap([
  ['keep',createHistoryAgentCatalogMainFact({kind:'bash',toolUseId:'keep',label:'one',startedAt:7,command:'cmd'})],
  ['terminal',createHistoryAgentCatalogMainFact({kind:'monitor',toolUseId:'terminal',startedAt:10})]]),terminalBackgroundTaskCalls:createHistoryAgentCatalogMainFactsSet(['terminal'])});
 await equivalent([],{},context);
});
test('terminal facts short-circuit unused native startedAt coercion and preserve BigInt subtraction failure',async()=>{
 const action=taskAction('key',{subagentStatus:'completed'});Object.defineProperty(action,'startedAt',{get(){throw Error('must be skipped');}});
 await equivalent([], {live:[agentRow('one',[action])]},catalogScope(),createHistoryAgentCatalogMainFactsMap([['key',createHistoryAgentCatalogMainFact({startedAt:7,completedAt:9,status:'completed'})]]));
 await assert.rejects(run([], {live:[agentRow('one',[taskAction('key')])]},catalogScope(),createHistoryAgentCatalogMainFactsMap([['key',createHistoryAgentCatalogMainFact({startedAt:7,completedAt:9n,status:'completed'})]])),TypeError);
});
test('exact source segments preserve removed prefixes, reordered and repeated historical ordinals',async()=>{
 const rows=farHistoryFixture(4),local=agentRow('local',[taskAction('native',{result:'done'})]);
 const result=await equivalent(rows,{segments:[{start:3,end:4},{row:local},{start:1,end:3},{start:3,end:4}]},catalogScope());
 assert.equal(result.counts.total,4);assert.equal(result.agents.some(row=>row.key==='task:agent-0'),false);
 await assert.rejects(run(rows,{segments:[{start:0,end:5}]},catalogScope()),/HISTORY_AGENT_CURRENT_RECIPE/);
 await assert.rejects(run(rows,{segments:[{start:2,end:2}]},catalogScope()),/HISTORY_AGENT_CURRENT_RECIPE/);
});
test('raw CURRENT getter visitation preserves old repeated accesses with intrinsic Main terminal facts',async()=>{
 const trace=[],raw={toolUseId:'raw',toolName:'Bash',args:{command:'echo',description:'command'},result:'accepted'};
 const action={tool:'__raw__'};Object.defineProperty(action,'rawTool',{enumerable:true,get(){trace.push('rawTool');return raw;}});
 const actions=[action],row=agentRow('raw-entry');Object.defineProperty(row,'actions',{enumerable:true,get(){trace.push('actions');return actions;}});
 const terminal=createHistoryAgentCatalogMainFactsSet();
 const context=catalogScope({isTurnBusy:true,agentProcessAlive:false,terminalBackgroundTaskCalls:terminal});
 const expected=literalCatalog(oracle,effective([],{live:[row]}),context),oldTrace=trace.splice(0);
 const actual=await run([],{live:[row]},context);
 assert.deepEqual(actual.background,expected.background);assert.deepEqual(actual.agents,expected.agents);
 assert.deepEqual(trace,[...oldTrace,...oldTrace],'one literal producer pass plus one exact native replay');
});
test('settings conflict evaluates every alias before native spread and preserves cloned Task getter semantics',async()=>{
 const trace=[],actions=[taskAction('setting-task',{result:'done'})];
 const oldFact={version:1,provider:'codex',kind:'model',value:'old'};
 const local=agentRow('settings',[],{role:'slash',sourceIdentity:'shared',sourceIdentityAliases:['alias'],settingsFact:oldFact});
 Object.defineProperty(local,'actions',{enumerable:true,get(){trace.push('spread/actions');return actions;}});
 const fact={version:1,provider:'codex',kind:'model',live:true};
 Object.defineProperty(fact,'value',{enumerable:true,get(){trace.push('live/value');return 'new';}});
 const live=agentRow('settings-live',[],{role:'slash',sourceIdentity:'shared',sourceIdentityAliases:['alias'],settingsFact:fact});
 const recipe={segments:[{row:local}],live:[live]},expected=literalCatalog(oracle,effective([],recipe)),oldTrace=trace.splice(0);
 const actual=await run([],recipe,catalogScope());
 assert.deepEqual(actual.agents,expected.agents);assert.deepEqual(actual.background,expected.background);
 assert.deepEqual(trace,[...oldTrace,...oldTrace],'eager aliases, spread and one proof replay retain native operation order');
});
