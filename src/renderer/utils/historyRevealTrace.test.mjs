import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRevealTrace } from './historyRevealTrace.mjs';
function fixture() {
  const logs = []; let reads = 0;
  const state = { owner:'A', generation:1, visit:2, actionId:'action', gesture:3, follow:true,
    presented:true, content:'NEVER LOG BODY' };
  const trace = createHistoryRevealTrace({ getState:()=>state, log:value=>logs.push(value), now:()=>10 });
  const begin = () => trace.begin({card:'exact-card',unitKey:'unit',opening:false,
    snapshot:{scrollTop:100,scrollHeight:400,clientHeight:300,anchorTop:25,anchorHeight:30}});
  const measure = () => { reads++; return {scrollTop:90,scrollHeight:390,clientHeight:300,anchorTop:25,anchorHeight:20}; };
  return {trace,logs,state,begin,measure,reads:()=>reads};
}
test('bounded begin/commit/measurement/settle signal shares exact owner and never reads at commit',()=>{
  const f=fixture(),commit=f.begin();f.state.follow=false;commit();assert.equal(f.reads(),0);
  f.trace.measure('other',f.measure);assert.equal(f.reads(),0);
  f.trace.measure('unit',f.measure);f.trace.viewportSync({before:100,after:90});f.trace.cancel('cleanup');
  assert.deepEqual(f.logs.map(x=>x.phase),['begin','commit','measurement','settle-signal','closed']);
  assert.equal(f.logs[2].deltaTop,-10);assert.equal(f.logs[3].settled,'signal-only-not-pixel-proof');
  assert.doesNotMatch(JSON.stringify(f.logs),/NEVER LOG BODY/);
});
test('the same row can resize repeatedly without unbounded geometry work or records',()=>{
  const f=fixture();f.begin()();for(let i=0;i<100;i++){f.trace.measure('unit',f.measure);f.trace.viewportSync({before:100,after:90});}
  assert.equal(f.reads(),1);assert.equal(f.logs.length,4);
});
test('a new gesture is explicit, not erased or treated as a machine writer',()=>{
  const f=fixture();f.begin()();f.state.gesture++;f.trace.measure('unit',f.measure);
  assert.equal(f.logs[2].gestureChanged,true);assert.equal(f.state.gesture,4);
});
test('owner generation/visit replacement cannot attribute a foreign measurement',()=>{
  for(const key of ['owner','generation','visit']){const f=fixture();f.begin()();f.state[key]=key==='owner'?'B':99;
    f.trace.measure('unit',f.measure);assert.equal(f.reads(),0);assert.equal(f.logs.at(-1).reason,'owner-changed');}
});
test('new toggle closes the previous lease and an old commit cannot update its replacement',()=>{
  const f=fixture(),old=f.begin(),fresh=f.begin();old();fresh();
  assert.deepEqual(f.logs.map(x=>x.phase),['begin','closed','begin','commit']);
  assert.equal(f.logs[2].id,2);
});
test('hidden owner or unavailable diagnostics never steer state or schedule work',()=>{
  const f=fixture();f.state.presented=false;assert.equal(f.begin(),null);assert.deepEqual(f.logs,[]);
  const trace=createHistoryRevealTrace({getState:()=>{throw Error('gone');},log:()=>{throw Error('gone');}});
  assert.equal(trace.begin({}),null);
});
test('long neighbouring identities never match merely because their logged prefixes coincide',()=>{
  const f=fixture(),prefix='same'.repeat(100);
  f.trace.begin({card:'c',unitKey:prefix+'A',opening:false,snapshot:null})();
  f.trace.measure(prefix+'B',f.measure);assert.equal(f.reads(),0);
  f.trace.measure(prefix+'A',f.measure);assert.equal(f.reads(),1);
});
