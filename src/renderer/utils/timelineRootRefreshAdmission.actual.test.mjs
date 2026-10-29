// Actual callback and drain-effect extraction. Controlled protocol/model leaves;
// no React DOM, app, profile, provider or native interaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {mergeTimelineReadClass} from './timelineViewClient.mjs';
const ts=createRequire(import.meta.url)('typescript');
const current=readFileSync(new URL('../components/Workspace/TimelineRootSurface.tsx',import.meta.url),'utf8');
function callbacks(source){
 const ast=ts.createSourceFile('TimelineRootSurface.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let refresh,drain;
 const walk=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='refresh'&&node.initializer?.arguments)refresh=node.initializer.arguments[0].getText(ast);
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes('refreshPending.current = null; refresh(readClass)'))drain=node.arguments[0].getText(ast);ts.forEachChild(node,walk);};walk(ast);assert(refresh&&drain);
 return{refresh,drain};
}
function fixture(source=current){
 const sourceCallbacks=callbacks(source),calls=[],signals=[],errors=[];let finish,failed;
 const result=new Promise((resolve,reject)=>{finish=resolve;failed=reject;});const livePayload={source:'CURRENT'};
 const env={sessionId:'session',scrollRef:{current:{clientHeight:100}},positive:n=>Number.isFinite(n)&&n>0,latest:{current:{isVisible:true,isTurnBusy:false}},gateRef:{current:true},document:{visibilityState:'visible'},refreshPending:{current:null},intents:{current:['intent']},activeRef:{current:true},tabId:'tab',timelineOwner:'owner',props:{onInitialSourceSignal:x=>signals.push(x)},report:e=>errors.push(e),payload:()=>livePayload,mergeTimelineReadClass,isTurnBusy:false,isVisible:true,historyGate:true,model:{refresh:(payload,readClass)=>{calls.push({payload,readClass});return result;}}};
 const evaluate=body=>vm.runInNewContext(ts.transpileModule('(()=>{const actual = '+body+'; return actual;})()',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,env);
 const refresh=evaluate(sourceCallbacks.refresh);env.refresh=refresh;const drain=evaluate(sourceCallbacks.drain);
 return{env,calls,signals,errors,refresh,drain,finish,failed,livePayload};
}
if(process.env.NOTED_TIMELINE_REFRESH_BASELINE)test('old gate edge schedules duplicate view/source intents',async()=>{const f=fixture(readFileSync(process.env.NOTED_TIMELINE_REFRESH_BASELINE,'utf8'));f.env.refreshPending.current='source';const pending=f.refresh('view');f.drain();assert.deepEqual(f.calls.map(x=>x.readClass),['view','source']);f.finish();await pending;});
test('gate opening admits strongest pending class exactly once using current payload',async()=>{
 const f=fixture();f.env.refreshPending.current='source';const pending=f.refresh('view');assert.equal(f.env.refreshPending.current,null);f.drain();assert.equal(f.calls.length,1);assert.equal(f.calls[0].readClass,'source');assert.equal(f.calls[0].payload,f.livePayload);f.finish();assert.equal(await pending,true);assert.equal(f.signals.length,1);
});
test('every read-class pair preserves source > metadata > view',async()=>{
 for(const left of ['source','metadata','view'])for(const right of ['source','metadata','view']){const f=fixture();f.env.refreshPending.current=left;const p=f.refresh(right);assert.equal(f.calls[0].readClass,mergeTimelineReadClass(left,right));assert.equal(f.env.refreshPending.current,null);f.finish();await p;}
});
test('height, presentation, busy and document admission retain intent without starting work',async()=>{
 for(const block of ['height','gate','hidden','busy','document']){const f=fixture();if(block==='height')f.env.scrollRef.current.clientHeight=0;if(block==='gate')f.env.gateRef.current=false;if(block==='hidden')f.env.latest.current.isVisible=false;if(block==='busy')f.env.latest.current.isTurnBusy=true;if(block==='document')f.env.document.visibilityState='hidden';f.refresh('source');assert.equal(f.calls.length,0);assert.equal(f.env.refreshPending.current,'source');f.env.scrollRef.current.clientHeight=100;f.env.gateRef.current=true;f.env.latest.current.isVisible=true;f.env.latest.current.isTurnBusy=false;f.env.document.visibilityState='visible';const p=f.refresh('view');f.drain();assert.equal(f.calls.length,1);assert.equal(f.calls[0].readClass,'source');f.finish();await p;}
});
test('later admitted events remain a separate current-payload intent',async()=>{const f=fixture();const first=f.refresh('view');const second=f.refresh('metadata');assert.deepEqual(f.calls.map(x=>x.readClass),['view','metadata']);f.finish();await first;await second;});
test('late authoring intents and owner loss keep existing continuation semantics',async()=>{const f=fixture();const p=f.refresh('source');const late=['later'];f.env.intents.current=late;f.finish();await p;assert.equal(f.env.intents.current,late);const g=fixture();const q=g.refresh('source');g.env.activeRef.current=false;g.finish();await q;assert.equal(g.signals.length,0);});
test('failure is reported once without retry or class fallback',async()=>{const f=fixture(),error=Object.assign(Error('exact refusal'),{code:'UNKNOWN'});const p=f.refresh('source');f.failed(error);assert.equal(await p,false);assert.equal(f.calls.length,1);assert.equal(f.errors[0],error);});
