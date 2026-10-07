import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHistoryToolNavigationTarget, historyToolNavigationNode, flashHistoryNavigationNode } from './historyToolNavigation.mjs';
const entry = (uuid, id) => ({ uuid, role:'assistant', actions:[{rawTool:{toolUseId:id}}] });
test('tool call identity survives row re-key, never body or name equality', () => {
  const tool={toolUseId:'call'};
  assert.equal(resolveHistoryToolNavigationTarget([entry('new','call')],'old',tool).uuid,'new');
  assert.equal(resolveHistoryToolNavigationTarget([{uuid:'old',content:'call',role:'user'}],'old',tool),null);
  assert.equal(resolveHistoryToolNavigationTarget([entry('a','call'),entry('b','call')],'a',tool),null);
});
test('exact stub can be hydrated before the call identity is known', () => {
  const stub={uuid:'old',rowStub:true};
  assert.equal(resolveHistoryToolNavigationTarget([stub],'old',{toolUseId:'call'}).uuid,'old');
  assert.equal(resolveHistoryToolNavigationTarget([{...stub,rowStub:false}],'old',{toolUseId:'call'}),null);
});
test('inner header lookup is exact even for punctuation in opaque IDs', () => {
  const wanted='call:"[]:canonical:0', head={};
  const row={querySelectorAll:() => [{getAttribute:() => 'wrong'},
    {getAttribute:() => wanted, querySelector:s => {assert.equal(s,'.cb-tool-head');return head;}}]};
  assert.equal(historyToolNavigationNode(row,wanted),head);
  assert.equal(historyToolNavigationNode(row,'missing'),null);
});
test('one-shot flash is attached to the settled header, not a timer or detached node', () => {
  const calls=[],animation={};
  assert.equal(flashHistoryNavigationNode({isConnected:false},'r'),null);
  const node={isConnected:true,animate:(frames,options) => {calls.push({frames,options});return animation;}};
  assert.equal(flashHistoryNavigationNode(node,'r'),animation);
  assert.equal(calls.length,1);assert.equal(calls[0].options.iterations,1);
  assert.equal(calls[0].options.duration,500);assert.equal(animation.id,'history-source:r');
});
