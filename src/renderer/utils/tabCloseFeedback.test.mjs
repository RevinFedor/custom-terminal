import test from 'node:test';
import assert from 'node:assert/strict';
import {beginTabCloseFeedback} from './tabCloseFeedback.mjs';

test('close feedback starts synchronously and ends once', () => {
  const tab={},seen=[];const end=beginTabCloseFeedback({tab,isCurrent:()=>true,publish:()=>seen.push(tab.aiClosing)});
  assert.deepEqual(seen,[true]);end();end();assert.deepEqual(seen,[true,false]);
});
test('nested close callers keep their shared presentation until all settle', () => {
  const tab={},seen=[],args={tab,isCurrent:()=>true,publish:()=>seen.push(tab.aiClosing)};
  const a=beginTabCloseFeedback(args),b=beginTabCloseFeedback(args);a();assert.equal(tab.aiClosing,true);b();assert.deepEqual(seen,[true,false]);
});
test('late cleanup cannot publish a successor or roll back its fresh Map', () => {
  const old={},next={name:'successor'},state={tabs:new Map([['x',old]])},seen=[];
  const end=beginTabCloseFeedback({tab:old,isCurrent:()=>state.tabs.get('x')===old,publish:()=>seen.push(state.tabs)});
  const fresh=new Map([['x',next],['new-neighbour',{}]]);state.tabs=fresh;end();
  assert.strictEqual(state.tabs,fresh);assert.equal(seen.length,1);assert.equal(next.aiClosing,undefined);assert.equal(old.aiClosing,false);
});
test('an existing presentation owner is not cleared by a borrowed close scope', () => {
  const tab={aiClosing:true};let publishes=0;const end=beginTabCloseFeedback({tab,isCurrent:()=>true,publish:()=>publishes++});end();assert.equal(tab.aiClosing,true);assert.equal(publishes,0);
});
test('feedback publication failure cannot strand the flag or replace the close outcome', () => {
  const tab={};const end=beginTabCloseFeedback({tab,isCurrent:()=>true,publish(){throw Error('subscriber');}});
  assert.equal(tab.aiClosing,true);assert.doesNotThrow(end);assert.equal(tab.aiClosing,false);
});
