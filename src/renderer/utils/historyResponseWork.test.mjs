import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryDisplayUnits, buildHistoryDisplayUnitsAppended,
  findHistoryHydrationStub, historyCompositeActionFacts, resolveHistoryDisplayTarget,
  isHistoryDisplayGroupExpanded, setHistoryDisplayGroupExpanded } from './historyDisplayUnits.mjs';
import { historyHydrationCenterForRange } from './historyMaterializedWindow.mjs';
import { historyResponseWorkClock, historyResponseWorkTailTiming } from './historyResponseTiming.mjs';

const tool = (id, family = 'read') => ({ uuid: id, role: 'assistant', content: '', actions: [{
  tool: '__raw__', rawTool: { toolUseId: id, toolName: family === 'edit' ? 'Edit' : 'Read', family, result: 'ok', args: {} },
}] });
const comment = (id, text = id) => ({ uuid: id, role: 'assistant', textPhase: 'commentary', content: text });
const user = id => ({ uuid: id, role: 'user', content: 'question' });
const final = id => ({ uuid: id, role: 'assistant', textPhase: 'final_answer', content: 'answer',
  responseTiming: { intervalId: 7, startTs: 1000, endTs: 4000, durationMs: 3000 } });
const opt = expandedKeys => ({ enabled: true, responseWork: true, expandedKeys: expandedKeys || new Set() });
const kind = u => u.familyKey === 'response-work' ? 'work' : u.kind === 'group' ? 'tools' : u.entry.uuid;
const openAll = rows => buildHistoryDisplayUnits(rows, opt(new Set(
  buildHistoryDisplayUnits(rows,opt()).filter(u=>u.familyKey==='response-work').map(u=>u.key))));

test('the default-closed chapter previews its latest text; opening preserves full source order', () => {
  const rows = [user('u'), comment('a', 'a'.repeat(900)), tool('r'), tool('e', 'edit'),
    comment('b'), tool('r2'), tool('e2', 'edit'), final('f')];
  const copy = JSON.stringify(rows), closed = buildHistoryDisplayUnits(rows, opt());
  assert.deepEqual(closed.map(kind),['u','work','f']);
  assert.equal(closed[1].expanded,false);assert.equal(closed[1].previewEntry.uuid,'b');
  assert.equal(closed[1].previewFact,null,'later tools do not replace a commentary');
  const units = openAll(rows);
  assert.deepEqual(units.map(kind), ['u', 'work', 'a', 'tools', 'b', 'tools', 'f']);
  const work = units[1];
  assert.equal(work.expanded, true); assert.equal(work.entries.length, 6);
  assert.equal(work.responseTiming.durationMs, 3000);
  assert.equal(units.at(-1).suppressResponseTiming, true);
  assert.equal(units[2].entry.content.length, 900);
  assert.equal(units[3].captionEntries.length, 0);
  assert.equal(JSON.stringify(rows), copy);
});

test('outer and inner collapse are independent and resolve the exact hidden source UUID', () => {
  const rows = [comment('a'), tool('r'), tool('e', 'edit'), comment('b'), final('f')];
  const open = openAll(rows), work = open[0], tools = open[2];
  const innerOpen = buildHistoryDisplayUnits(rows, opt(new Set([work.key,tools.key])));
  assert.equal(innerOpen.filter(u => u.expandedGroup?.key === tools.key).length, 2);
  assert.ok(innerOpen.filter(u => u.responseWork?.key === work.key).length >= 4);
  const outerClosed = buildHistoryDisplayUnits(rows, opt(new Set([tools.key])));
  assert.deepEqual(outerClosed.map(kind), ['work', 'f']);
  assert.deepEqual(resolveHistoryDisplayTarget(outerClosed, 'e'), { index: 0, groupKey: work.key });
  assert.equal(outerClosed.at(-1).entry.uuid, 'f');
  let keys=new Set();assert.equal(isHistoryDisplayGroupExpanded(keys,work.key),false);
  keys=setHistoryDisplayGroupExpanded(keys,work.key,true);assert.equal(isHistoryDisplayGroupExpanded(keys,work.key),true);
  keys=setHistoryDisplayGroupExpanded(keys,work.key,false);assert.equal(isHistoryDisplayGroupExpanded(keys,work.key),false);
});

test('interactive questions and user turns are not hidden in a work chapter', () => {
  const question = { uuid: 'q', role: 'assistant', content: '', actions: [{ tool: 'AskUserQuestion' }] };
  const units = openAll([comment('a'), tool('r'), question, user('u2'), comment('b'), final('f')]);
  assert.deepEqual(units.map(kind), ['work', 'a', 'r', 'q', 'u2', 'work', 'b', 'f']);
  const mixed={uuid:'mixed-question',role:'assistant',content:'',actions:[...tool('known').actions,{tool:'AskUserQuestion'}]};
  const mixedUnits=openAll([comment('before'),mixed,comment('after')]);
  assert.deepEqual(mixedUnits.map(kind),['work','before','mixed-question','work','after']);
});

test('untagged final without proof remains visible, partial answer remains full work text', () => {
  const legacy = { uuid: 'legacy', role: 'assistant', content: 'done' };
  const partial = { uuid: 'partial', role: 'assistant', textPhase: 'partial_answer', content: 'x'.repeat(1000) };
  const units = openAll([tool('r'), partial, legacy]);
  assert.deepEqual(units.map(kind), ['work', 'r', 'partial', 'legacy']);
  assert.equal(units.at(-1).suppressResponseTiming, undefined);
});

test('a single source record containing both text and calls stays one exact visible row',()=>{
  const composite={uuid:'composite',role:'assistant',textPhase:'commentary',content:'Рабочий текст',
    actions:[...tool('r').actions,...tool('e','edit').actions]};
  const units=openAll([composite,final('f')]);
  assert.deepEqual(units.map(kind),['work','composite','f']);
  assert.equal(units[1].entry,composite);
  assert.equal(units[1].entry.actions.length,2);
  assert.equal(historyCompositeActionFacts(composite).length,2);
  const unknown={...composite,actions:[...composite.actions,{tool:'AskUserQuestion'}]};
  assert.equal(historyCompositeActionFacts(unknown),null,'an interactive action is never hidden in this tool group');
  const missingId={...composite,actions:[composite.actions[0],{...composite.actions[1],rawTool:{
    ...composite.actions[1].rawTool,toolUseId:''}}]};
  assert.equal(historyCompositeActionFacts(missingId),null,'unaddressable calls stay individually reachable');
  const stale={...composite,actionSummary:[{toolUseId:'different',toolName:'Read',family:'read'},
    {toolUseId:'e',toolName:'Edit',family:'edit'}]};
  assert.equal(historyCompositeActionFacts(stale),null,'stale summary cannot own a different real call');
});

test('source identity keeps work chapter key stable across a live-to-durable row', () => {
  const live = { ...comment('temporary'), sourceIdentity: 'canonical-1' };
  const durable = { ...live, uuid: 'durable' };
  assert.equal(buildHistoryDisplayUnits([live], opt())[0].key, buildHistoryDisplayUnits([durable], opt())[0].key);
});

test('work header keeps the actual record-time range and never invents an unknown endpoint',()=>{
  const time=timestamp=>({version:1,kind:'message',scope:'record',timestamp});
  const first={...comment('a'),recordTime:time('2026-10-27T04:00:00Z')};
  const last={...comment('b'),recordTime:time('2026-10-27T04:02:00Z')};
  const heading=buildHistoryDisplayUnits([first,last],opt())[0];
  assert.equal(heading.recordTimeAttributes['data-history-time-at'],'2026-10-27T04:00:00Z');
  assert.equal(heading.recordTimeAttributes['data-history-time-end-at'],'2026-10-27T04:02:00Z');
  assert.deepEqual(buildHistoryDisplayUnits([first,comment('unknown')],opt())[0].recordTimeAttributes,{});
  const stub={uuid:'stub',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'r',toolName:'Read',family:'read',
    recordTime:{version:1,kind:'tool-call',scope:'record',timestamp:'2026-10-27T04:04:00Z'}}]};
  assert.equal(buildHistoryDisplayUnits([first,stub],opt())[0].recordTimeAttributes['data-history-time-end-at'],
    '2026-10-27T04:04:00Z');
});

test('a visible closed work heading requests only its selected commentary stub',()=>{
  const row={uuid:'c',role:'assistant',textPhase:'commentary',hasContent:true,contentLength:1200,rowStub:true};
  const closed=buildHistoryDisplayUnits([row],opt());
  const target=findHistoryHydrationStub(closed,{start:0,end:0},100);
  assert.equal(target.entry.uuid,'c');assert.equal(target.caption,true,'the exact visible preview owns hydration');
  assert.equal(historyHydrationCenterForRange(closed,{start:0,end:0},'fallback'),'c');
  const alreadyAvailable=buildHistoryDisplayUnits([{...row,content:'доступный текст'}],opt());
  assert.equal(findHistoryHydrationStub(alreadyAvailable,{start:0,end:0},100),null,
    'a text-bearing stub does not start a hydration loop');
});

test('late hydration of an older commentary cannot replace the newer selected preview',()=>{
  const stub=id=>({uuid:id,role:'assistant',rowStub:true,hasContent:true,contentLength:30,textPhase:'commentary'});
  const old=stub('old'),latest=stub('latest');
  const before=buildHistoryDisplayUnits([old,tool('call'),latest],opt());
  assert.equal(before[0].previewEntry.uuid,'latest');
  const after=buildHistoryDisplayUnits([{...old,content:'старый текст'},tool('call'),latest],opt());
  assert.equal(after[0].previewEntry.uuid,'latest');
  const target=findHistoryHydrationStub(after,{start:0,end:0},50);
  assert.equal(target.entry.uuid,'latest');assert.equal(target.caption,true);
});

test('the separate compaction clock is not moved into an answer work heading',()=>{
  const running={state:'running',phase:'response',startTs:1};
  const compacting={state:'running',phase:'compacting',startTs:2};
  assert.equal(historyResponseWorkTailTiming(running),running);
  assert.equal(historyResponseWorkTailTiming(compacting),null);
  assert.equal(historyResponseWorkClock({activeTail:true,firstTimestamp:'1970-01-01T00:00:03.000Z'},compacting),null);
});

test('a live clock never attaches to an older or unproven tail',()=>{
  const timing={state:'running',startTs:4000};
  assert.equal(historyResponseWorkClock({activeTail:true,firstTimestamp:'1970-01-01T00:00:03.999Z'},timing),null);
  assert.equal(historyResponseWorkClock({activeTail:true,firstTimestamp:''},timing),null);
  assert.equal(historyResponseWorkClock({activeTail:true,firstTimestamp:'1970-01-01T00:00:04.100Z'},timing),timing);
  assert.equal(historyResponseWorkClock({activeTail:false,firstTimestamp:'1970-01-01T00:00:04.100Z'},timing),null);
  const units=openAll([{...comment('live'),timestamp:'1970-01-01T00:00:04.100Z'}]);
  assert.equal(historyResponseWorkClock(units[0],timing),timing);
  assert.equal(historyResponseWorkClock(units[1].responseWork,timing),timing);
});

test('latest tool is shown only until the first text, without inventing counts',()=>{
  const calls=[tool('r'),tool('e','edit')];
  const before=buildHistoryDisplayUnits(calls,opt())[0];
  assert.equal(before.previewEntry,null);assert.equal(before.previewFact.toolUseId,'e');
  const withText=buildHistoryDisplayUnits([...calls,comment('note'),tool('later')],opt())[0];
  assert.equal(withText.previewEntry.uuid,'note');assert.equal(withText.previewFact,null);
  const next=buildHistoryDisplayUnits([...calls,comment('note'),tool('later'),comment('new')],opt())[0];
  assert.equal(next.previewEntry.uuid,'new');
  const onlyThinking=buildHistoryDisplayUnits([{uuid:'think',role:'assistant',thinking:'private'}],opt())[0];
  assert.equal(onlyThinking.previewEntry,null);assert.equal(onlyThinking.previewFact,null);
});

test('manual disclosure stays open through later events and completion; explicit close stays closed',()=>{
  const initial=[user('u'),tool('r')],work=buildHistoryDisplayUnits(initial,opt())[1];
  let keys=setHistoryDisplayGroupExpanded(new Set(),work.key,true);
  const complete=[...initial,comment('note'),tool('e','edit'),final('f')];
  let units=buildHistoryDisplayUnits(complete,opt(keys));
  assert.equal(units[1].key,work.key);assert.equal(units[1].expanded,true);
  assert.equal(units.at(-1).entry.uuid,'f');
  keys=setHistoryDisplayGroupExpanded(keys,work.key,false);
  units=buildHistoryDisplayUnits([...initial,comment('later'),tool('another')],opt(keys));
  assert.equal(units[1].expanded,false);assert.equal(units[1].previewEntry.uuid,'later');
});

test('live append yields the same chapter, final timing, membership and keys as a full build', () => {
  const prefix = Array.from({ length: 12 }, (_, i) => user('old-' + i));
  let rows = [...prefix, comment('a'), tool('r')];
  let units = buildHistoryDisplayUnits(rows, opt());
  for (const row of [tool('e', 'edit'), comment('b'), tool('r2'), final('f')]) {
    const next = [...rows, row], incremental = buildHistoryDisplayUnitsAppended(rows, units, next, opt(), opt());
    assert.ok(incremental); assert.deepEqual(incremental.units, buildHistoryDisplayUnits(next, opt()));
    rows = next; units = incremental.units;
  }
});
