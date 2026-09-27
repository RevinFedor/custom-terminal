import test from 'node:test';
import assert from 'node:assert/strict';
import { installHistoryScrollWriterDiagnostics } from './historyScrollWriterDiagnostics.mjs';

function fixture(options={}) {
  let reads=0, writes=0, argumentReads=0, current=0, context=null, time=100;
  const calls=[], output=[], tasks=new Map(); let next=0;
  const prototype={
    scrollTo(options){ argumentReads++; current=Number(options.top); calls.push(['to',this,options]); return 'to-result'; },
    scrollBy(options){ argumentReads++; current+=Number(options.top); calls.push(['by',this,options]); return 'by-result'; },
  };
  Object.defineProperty(prototype,'scrollTop',{ configurable:true, enumerable:true,
    get(){reads++;return current},set(value){writes++;current=Number(value)} });
  const scroller=Object.create(prototype);
  const originalTo=scroller.scrollTo, originalBy=scroller.scrollBy;
  const dispose=installHistoryScrollWriterDiagnostics(scroller,{
    context:()=>context,log:r=>output.push(r),now:()=>time,
    schedule:fn=>{const id=++next;tasks.set(id,fn);return id},cancel:id=>tasks.delete(id),...options,
  });
  return {scroller,prototype,originalTo,originalBy,dispose,output,calls,tasks,
    counts:()=>({reads,writes,argumentReads}),
    active(gid=1){context={owner:'A',generation:1,visit:1,gid}},
    flush(){time+=10;const callbacks=[...tasks.values()];tasks.clear();callbacks.forEach(fn=>fn())},
  };
}
test('native methods, setter and borrowed receiver keep their behavior without extra layout reads',()=>{
  const f=fixture(); f.active();
  const option={top:35,behavior:'auto'};
  assert.equal(f.scroller.scrollTo(option),'to-result');
  assert.equal(f.scroller.scrollBy({top:-4}),'by-result');
  f.scroller.scrollTop=17;
  assert.deepEqual(f.counts(),{reads:0,writes:1,argumentReads:2});
  assert.equal(f.scroller.scrollTop,17);
  assert.equal(f.counts().reads,1);
  assert.equal(f.output.length,0,'logging is deferred');
  f.flush();
  assert.deepEqual(f.output.map(r=>[r.method,r.y]),[['scrollTo',35],['scrollBy',-4],['scrollTop=',17]]);
  assert.ok(f.output.every(r=>r.logLagMs===10&&r.stack.includes('historyScrollWriterDiagnostics.test.mjs')));
  assert.equal(f.calls[0][1],f.scroller);
  assert.equal(f.calls[0][2],option);
  f.dispose();
  assert.equal(f.scroller.scrollTo,f.originalTo);
  assert.equal(f.scroller.scrollBy,f.originalBy);
  assert.equal(Object.hasOwn(f.scroller,'scrollTop'),false);
});
test('options getters are evaluated only by native behavior and original errors propagate',()=>{
  const f=fixture(); f.active(); let gets=0;
  const error=new Error('native option failed');
  f.scroller.scrollTo({get top(){gets++;return 22}});
  assert.equal(gets,1);
  assert.throws(()=>f.scroller.scrollTo({get top(){gets++;throw error}}),e=>e===error);
  assert.equal(gets,2);
  f.flush();
  assert.deepEqual(f.output.map(r=>r.y),[null,null]);
  f.dispose();
});
test('inactive and exhausted gestures do not allocate more queued records',()=>{
  const f=fixture({maxPerGesture:2,maxPending:3});
  f.scroller.scrollTo({top:2});assert.equal(f.tasks.size,0);
  f.active();
  for(let i=0;i<20;i++)f.scroller.scrollTo({top:i});
  f.flush();assert.equal(f.output.length,2);
  assert.deepEqual(f.output.map(r=>r.limitReached),[false,true]);
  f.scroller.scrollBy({top:1});f.flush();assert.equal(f.output.length,2);
  f.active(2);
  for(let i=0;i<20;i++)f.scroller.scrollTop=i;
  f.flush();assert.equal(f.output.length,4);
  f.dispose();
});
test('cleanup drains captured context, cancels the task and preserves a later interceptor',()=>{
  const f=fixture();f.active();f.scroller.scrollTo({top:2});
  const later=()=>99;f.scroller.scrollTo=later;
  f.dispose();f.dispose();
  assert.equal(f.tasks.size,0);
  assert.equal(f.output.length,1);
  assert.equal(f.scroller.scrollTo,later);
  assert.equal(Object.hasOwn(f.scroller,'scrollBy'),false);
});
test('diagnostic failures cannot prevent the actual scroll',()=>{
  const f=fixture({context:()=>{throw new Error('diagnostic failure')}});
  assert.equal(f.scroller.scrollTo({top:8}),'to-result');
  assert.equal(f.scroller.scrollTop,8);f.dispose();
});
