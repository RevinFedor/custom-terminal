import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHistoryDisplayUnits, buildHistoryDisplayUnitsAppended, resolveHistoryDisplayTarget,
  findHistoryHydrationStub } from './historyDisplayUnits.mjs';
const { makeHistoryRowStub, applyHistoryRowWindow } = createRequire(import.meta.url)('../../main/history-entry-window.js');

const reply=i=>({uuid:'sc-'+i,role:'user',content:'answer '+i,semanticTags:[{kind:'orchestration',runId:'run-'+i,
  runKind:'external-research',phase:'completion'}]});

test('two or more strictly adjacent SC completions become one right-side group; a singleton stays a row',()=>{
  const a=reply(1),b=reply(2),c=reply(3),boundary={uuid:'human',role:'user',content:'real user'};
  const units=buildHistoryDisplayUnits([a,b,c,boundary,reply(4)]);
  assert.equal(units.length,3);assert.equal(units[0].kind,'group');assert.equal(units[0].familyKey,'research');
  assert.deepEqual(units[0].entries,[a,b,c]);assert.equal(units[0].captionEntry,null);
  assert.equal(units[1].entry,boundary);assert.equal(units[2].kind,'entry');
});

test('assistant/tool/compact/note/native question and non-SC service records are strict boundaries',()=>{
  const boundaries=[{role:'assistant',content:'caption'}, {role:'assistant',actions:[{rawTool:{toolName:'Bash',args:{command:'pwd'}}}]},
    {role:'compact'},{role:'system'},{role:'goal',content:'Goal continued'},
    {role:'user',content:'<CodeBlock language="json" editable={false}>{}</CodeBlock>'},
    {...reply(8),questionReplyProof:{version:1}},
    {...reply(8),semanticTags:[{kind:'orchestration',runId:'other',runKind:'agent',phase:'completion'}]},
    {...reply(8),semanticTags:[{kind:'orchestration',runId:'other',runKind:'external-research',phase:'request'}]},
    {...reply(8),queueStatus:'application-queued',role:'queued',isLocal:true}];
  for(const entry of boundaries){const units=buildHistoryDisplayUnits([reply(1),{uuid:'boundary',...entry},reply(2)]);
    assert.ok(!units.some(unit=>unit.familyKey==='research'),JSON.stringify(entry));}
});

test('adjacent failed outcomes remain visible in the closed count, including actual Main stubs',()=>{
  const failed={...reply(2),semanticTags:[{...reply(2).semanticTags[0],phase:'failure'}]};
  const rows=[reply(1),failed,reply(3)];
  for(const entries of [rows,rows.map(makeHistoryRowStub)]){
    const group=buildHistoryDisplayUnits(entries)[0];
    assert.equal(group.entries.length,3);assert.equal(group.errorCount,1);
    assert.equal(group.captionEntry,null);
  }
  assert.equal(buildHistoryDisplayUnits([{...reply(1),content:'{"verdict":"reject","error":true}'},reply(3)])[0].errorCount,0);
  const prefix=Array.from({length:12},(_,i)=>({uuid:'prior-'+i,role:'user',content:'ordinary'}));
  const old=[...prefix,reply(1),reply(2),reply(3)],next=[...prefix,old[12],failed,old[14]];
  const update=buildHistoryDisplayUnitsAppended(old,buildHistoryDisplayUnits(old),next);
  assert.ok(update);
  assert.deepEqual(update.units,buildHistoryDisplayUnits(next),'metadata-only outcome change cannot leave an old success count');
});

test('expanded group keeps its header and separate exact-addressable children, not nested History',()=>{
  const rows=[reply(1),reply(2)];const closed=buildHistoryDisplayUnits(rows),key=closed[0].key;
  const units=buildHistoryDisplayUnits(rows,{expandedKeys:new Set([key])});
  assert.equal(units.length,3);assert.equal(units[0].expanded,true);
  assert.equal(units[1].entry,rows[0]);assert.equal(units[2].entry,rows[1]);
  assert.equal(units[1].expandedGroup.key,key);assert.equal(units[2].expandedGroup.last,true);
  assert.deepEqual(resolveHistoryDisplayTarget(closed,'sc-2'),{index:0,groupKey:key});
  assert.deepEqual(resolveHistoryDisplayTarget(units,'sc-2'),{index:2});
});

test('group key survives exact SENT local→canonical adoption and does not combine duplicate run IDs across boundaries',()=>{
  const a=reply(1),local={...a,uuid:'local-prompt',auditEntryUuid:a.uuid,role:'queued',queueStatus:'sent',isLocal:true};
  assert.equal(buildHistoryDisplayUnits([local,reply(2)])[0].key,buildHistoryDisplayUnits([a,reply(2)])[0].key);
  const c={...reply(3),semanticTags:a.semanticTags};
  const units=buildHistoryDisplayUnits([a,reply(2),{uuid:'sep',role:'assistant',content:'final'},c,reply(4)]);
  assert.notEqual(units[0].key,units[2].key);assert.equal(units[0].entries.length,2);
});

test('metadata-only stubs have the same groups; content is never read for classification',()=>{
  const a=reply(1),b=reply(2),key=buildHistoryDisplayUnits([a,b])[0].key;
  assert.ok(key);
  const stubs=[a,b].map(row=>({...row,content:'',rowStub:true,hasContent:true}));
  assert.equal(buildHistoryDisplayUnits(stubs)[0].key,key);
  const protectedRows=[a,b].map(row=>new Proxy(row,{get(target,property){if(property==='content')throw Error('body read');return target[property]}}));
  assert.equal(buildHistoryDisplayUnits(protectedRows)[0].key,key);
  assert.equal(findHistoryHydrationStub(buildHistoryDisplayUnits(stubs),{start:0,end:0},0),null,'closed summary does not hydrate hidden answers');
  const open=buildHistoryDisplayUnits(stubs,{expandedKeys:new Set([key])});
  assert.equal(findHistoryHydrationStub(open,{start:1,end:2},0)?.entry.uuid,'sc-1');
});

test('incremental append/delta equals full rebuild when the adjacent tail becomes/grows a group',()=>{
  const prefix=Array.from({length:12},(_,i)=>({uuid:'prefix-'+i,role:'user',content:'normal'}));
  let rows=[...prefix,reply(1)],units=buildHistoryDisplayUnits(rows);
  for(const next of [[...rows,reply(2)],[...rows,reply(2),reply(3)]]){
    const appended=buildHistoryDisplayUnitsAppended(rows,units,next);
    assert.ok(appended);assert.deepEqual(appended.units,buildHistoryDisplayUnits(next));
    rows=next;units=appended.units;
  }
  const changed=rows.map(row=>row.uuid==='sc-2'?{...row,semanticTags:[]}:row);
  const delta=buildHistoryDisplayUnitsAppended(rows,units,changed);
  assert.ok(delta);assert.deepEqual(delta.units,buildHistoryDisplayUnits(changed));
});

test('grouping kill switch remains identity projection',()=>{
  const rows=[reply(1),reply(2)];assert.deepEqual(buildHistoryDisplayUnits(rows,{enabled:false}),rows.map(entry=>({kind:'entry',entry})));
});

test('actual Main row stubs retain small grouping provenance, not response text or generated envelopes',()=>{
  const rows=[reply(1),reply(2)].map(row=>({...row,semanticTags:row.semanticTags.map(tag=>({...tag,
    envelopeText:'large generated header'.repeat(1000),bodyProjectionHash:'a'.repeat(64),bodyStart:20}))}));
  const stubs=rows.map(makeHistoryRowStub);
  assert.equal(buildHistoryDisplayUnits(stubs)[0].key,buildHistoryDisplayUnits(rows)[0].key);
  assert.deepEqual(stubs[0].semanticTags,[{kind:'orchestration',runId:'run-1',runKind:'external-research',phase:'completion'}]);
  assert.equal(stubs[0].content,undefined);
  assert.ok(rows[0].semanticTags[0].envelopeText,'source metadata is not mutated');
  const mixed={...reply(3),semanticTags:[{kind:'tab-message',messageId:'message',phase:'reply',
    sourceTabId:'source',targetTabId:'target'},...reply(3).semanticTags]};
  assert.equal(buildHistoryDisplayUnits([makeHistoryRowStub(mixed),...stubs])[0].kind,'entry','tab-message priority survives dehydration');
});

test('actual hydration windows do not change Research composition or display-unit addresses',()=>{
  const before=Array.from({length:12},(_,i)=>({uuid:'before-'+i,role:'user',content:'ordinary'}));
  const after=Array.from({length:12},(_,i)=>({uuid:'after-'+i,role:'assistant',content:'A long standalone answer. '.repeat(80)}));
  const rows=[...before,reply(1),reply(2),reply(3),...after];
  const shape=entries=>buildHistoryDisplayUnits(entries).map(unit=>unit.kind==='group'
    ?{kind:unit.kind,key:unit.key,members:unit.entries.map(e=>e.uuid)}:{kind:unit.kind,uuid:unit.entry.uuid});
  for(const centerUuid of ['before-2','sc-2','after-10']){
    const window=applyHistoryRowWindow(rows,{centerUuid,radius:2,alwaysHydrateTail:1});
    assert.ok(window.entries.some(entry=>entry.rowStub),'real dehydration must occur');
    assert.deepEqual(shape(window.entries),shape(rows));
  }
});
