import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryCardRevealAnchor } from './historyCardRevealAnchor.mjs';
function fixture({ top=800, maximum=800 }={}) {
  const frames=[],signals=new Set(),outcomes=[],writes=[];
  let currentTop=top, owner='A:1:v1',gesture=1,presented=true,pointer=false;
  const scroller={isConnected:true,contains:node=>node===anchor&&anchor.isConnected,
    getBoundingClientRect:()=>({top:0}),
    get scrollTop(){return currentTop;},set scrollTop(value){writes.push(value);currentTop=Math.max(0,Math.min(maximum,value));},
    addEventListener:(_type,fn)=>signals.add(fn),removeEventListener:(_type,fn)=>signals.delete(fn)};
  const anchor={isConnected:true,getBoundingClientRect:()=>({top:900-currentTop})};
  const controller=createHistoryCardRevealAnchor({getScroller:()=>scroller,getOwnerToken:()=>owner,
    getGestureGeneration:()=>gesture,isPointerGestureActive:()=>pointer,isPresented:()=>presented,
    stabilize:opts=>{
      // Execute the real shared convergence, only its frame transport is deterministic.
      return shared({...opts,requestFrame:fn=>frames.push(fn)});
    }});
  const signal=()=>{for(const fn of [...signals])fn();};
  const run=()=>{let n=0;while(frames.length&&n++<40)frames.shift()();};
  return {controller,scroller,anchor,outcomes,writes,frames,signals,run,signal,
    start:opening=>controller.afterCommit(anchor,opening,result=>outcomes.push(result)),
    compensate:value=>{currentTop=value;signal();},gesture:()=>gesture++,owner:()=>{owner='B:2:v2';},
    hide:()=>{presented=false;},pointer:()=>{pointer=true;},top:()=>currentTop};
}
import { stabilizeHistoryRevealAnchor as shared } from './historyRevealAnchor.mjs';
test('actual convergence repairs the second native subtract, preserving the already-clamped physical bottom',()=>{
  const f=fixture();f.start(false);assert.deepEqual(f.writes,[]);
  f.compensate(200);assert.equal(f.top(),800,'correct before the next painted frame');f.run();
  assert.equal(f.outcomes.at(-1).reason,'settled');assert.equal(f.outcomes.at(-1).writes,1);
});
test('away-from-tail collapse keeps its real reading anchor rather than forcing the maximum',()=>{
  const f=fixture({top:300,maximum:800});f.start(false);f.compensate(150);f.run();assert.equal(f.top(),300);
});
test('no late compensation means no position write on normal collapse',()=>{
  const f=fixture();f.start(false);f.run();assert.deepEqual(f.writes,[]);
});
test('expansion cancels prior ownership without starting a second tail writer',()=>{
  const f=fixture();f.start(false);f.start(true);f.compensate(200);f.run();assert.equal(f.top(),200);assert.deepEqual(f.writes,[]);
});
test('manual input, hidden visit and replacement owner cancel before correction',()=>{
  for(const reason of ['gesture','owner','hide','pointer']){const f=fixture();f.start(false);f[reason]();
    f.compensate(200);f.run();assert.equal(f.top(),200);assert.deepEqual(f.writes,[]);}
});
test('two owners never write one another; cleanup releases capture subscription',()=>{
  const a=fixture(),b=fixture();a.start(false);b.start(false);a.compensate(100);assert.equal(a.top(),800);
  assert.equal(b.top(),800);assert.deepEqual(b.writes,[]);a.controller.cancel();b.controller.cancel();
  assert.equal(a.signals.size,0);assert.equal(b.signals.size,0);
});
