import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimelineModifierDiagnostics} from './timelineModifierDiagnostics.mjs';

test('one bounded exact-action summary counts retained owners, publications and hidden cleanup without keeping event data',()=>{
  const tasks=[],logs=[],phases=[];let time=10;
  const d=createTimelineModifierDiagnostics({postTask:fn=>tasks.push(fn),emit:line=>logs.push(JSON.parse(line.slice(line.indexOf('{')))),
    currentId:()=> 'ui-meta-1',annotate:(...args)=>phases.push(args),now:()=>time});
  const event={key:'Meta',get target(){throw Error('no DOM');},get text(){throw Error('no text');}};
  for(let i=0;i<12;i++){time++;d.record(event,{presented:i<2,relevant:i===0,before:i===2,after:i===0,
    reasonMask:i===0?17:0,started:time-0.2});}
  assert.equal(tasks.length,1);assert.equal(logs.length,0);tasks.shift()();
  assert.deepEqual([logs[0].owners,logs[0].presentedRelevant,logs[0].truePublications,logs[0].falsePublications,logs[0].hiddenClears],[12,1,1,1,1]);
  assert.equal(logs[0].reasonMask,17);assert.equal(logs[0].callbackMs,2.4);
  assert.equal(phases[0][0],'ui-meta-1');d.dispose();
});
