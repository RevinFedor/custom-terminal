import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHistoryDisplayUnits, historyGroupCaptionEntries, findHistoryHydrationStub } from './historyDisplayUnits.mjs';
import { historyGroupCaptionIdentity, resolveHistoryGroupCaption, previousHistoryGroupCaption, rememberHistoryGroupCaption } from './historyGroupCaption.mjs';
import { collectHistoryMaterializedWindowUuids } from './historyMaterializedWindow.mjs';
const { makeHistoryRowStub } = createRequire(import.meta.url)('../../main/history-entry-window.js');
const caption = (uuid, content) => ({ uuid, role: 'assistant', content, textPhase: 'commentary' });
const call = i => ({ uuid: 'call-'+i, role: 'assistant', content: '', actions: [{tool:'__raw__',rawTool:{toolUseId:'tool-'+i,toolName:'Bash',family:'run',args:{command:'node script.js'},result:'done'}}] });

test('count original caption blocks once, not lines/digests/tool outputs/thinking/final answers', () => {
  const a=caption('a','One\nparagraph\nwith lines'),b=caption('b','Second');
  const entries=[a,call(1),b,call(2),{...a}, {uuid:'thought',role:'assistant',thinking:'hidden'},
    {uuid:'result',role:'tool',content:'tool output'}, {...caption('final','Finished'),textPhase:'final_answer'},
    {...caption('partial','Stable answer'),textPhase:'partial_answer'}];
  assert.deepEqual(historyGroupCaptionEntries(entries).map(e=>e.uuid),['a','b']);
});

test('group carries the same original caption list and latest default without changing chronology', () => {
  const rows=[caption('a','First'),call(1),caption('b','Second'),call(2),caption('c','Third'),call(3)];
  const closed=buildHistoryDisplayUnits(rows)[0];
  assert.deepEqual(closed.captionEntries.map(e=>e.uuid),['a','b','c']);
  assert.equal(closed.captionEntry,rows[4]);
  assert.deepEqual(closed.entries,rows);
  const units=buildHistoryDisplayUnits(rows,{expandedKeys:new Set([closed.key])});
  assert.equal(units[0].key,closed.key);
});

test('latest → previous → first → latest wraps without group expansion or row mutation', () => {
  const rows=[caption('a','A'),caption('b','B'),caption('c','C')],before=structuredClone(rows);
  assert.equal(resolveHistoryGroupCaption(rows).entry.uuid,'c');
  let identity=null;const seen=[];
  for(let i=0;i<4;i++){const next=previousHistoryGroupCaption(rows,identity);identity=historyGroupCaptionIdentity(next.entry);seen.push([next.entry.uuid,next.index+1]);}
  assert.deepEqual(seen,[['b',2],['a',1],['c',3],['b',2]]);
  assert.deepEqual(rows,before);
  assert.equal(previousHistoryGroupCaption([]).count,0);
  assert.equal(previousHistoryGroupCaption([rows[0]]).entry,rows[0]);
});

test('exact choice survives append and live/canonical aliases; missing identity falls back to latest', () => {
  const before=[{...caption('live-a','A'),sourceIdentity:'source-a'},caption('b','B')];
  const id=historyGroupCaptionIdentity(before[0]);
  const after=[{...caption('durable-a','A'),sourceIdentity:'new-source-a',sourceIdentityAliases:['source-a']},caption('b','B'),caption('c','C')];
  assert.equal(resolveHistoryGroupCaption(after,id).entry.uuid,'durable-a');
  assert.equal(resolveHistoryGroupCaption(after,'missing').entry.uuid,'c');
});

test('actual Main stubs keep the same count; selected stub uses the existing hydration address', () => {
  const rows=[caption('a','A'),call(1),caption('b','B'),call(2)],full=buildHistoryDisplayUnits(rows)[0];
  const stubs=buildHistoryDisplayUnits(rows.map(makeHistoryRowStub));
  assert.equal(stubs[0].captionEntries.length,full.captionEntries.length);
  const selections=new Map([[stubs[0].key,'b']]);
  assert.equal(findHistoryHydrationStub(stubs,{start:0,end:0},0,selections)?.entry.uuid,'b');
  assert.equal(resolveHistoryGroupCaption(stubs[0].captionEntries,'b').entry.rowStub,true);
  const protectedRows=stubs[0].captionEntries.map(row=>new Proxy(row,{get(target,key){if(key==='content')throw Error('selection read a body');return target[key]}}));
  assert.equal(previousHistoryGroupCaption(protectedRows).entry.uuid,'a');
});

test('selection hints are bounded metadata and belong to the caller, not a global store', () => {
  const a=new Map(),b=new Map();for(let i=0;i<300;i++)rememberHistoryGroupCaption(a,'group-'+i,'uuid-'+i);
  assert.equal(a.size,256);assert.equal(a.has('group-0'),false);assert.equal(b.size,0);
});

test('the most recent visible choice hydrates before unrelated warming and keeps its existing materialized row', () => {
  const first=buildHistoryDisplayUnits([caption('a','A'),call(1),caption('b','B'),call(2)].map(makeHistoryRowStub))[0];
  const second=buildHistoryDisplayUnits([caption('c','C'),call(3),caption('d','D'),call(4)].map(makeHistoryRowStub))[0];
  const selections=new Map([[first.key,'a'],[second.key,'c']]),units=[first,second];
  const found=findHistoryHydrationStub(units,{start:0,end:1},0,selections);
  assert.equal(found.entry.uuid,'c');assert.equal(found.caption,true);
  assert.deepEqual([...collectHistoryMaterializedWindowUuids(units,{start:0,end:1},{overscanUnits:0,captionSelections:selections})],['a','c']);
  assert.equal(collectHistoryMaterializedWindowUuids(units,{start:0,end:1},{maxUuids:1,captionSelections:selections}).size,1,'same existing row budget');
});
