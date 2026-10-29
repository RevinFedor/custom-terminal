import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryDisplayUnits,
  buildHistoryDisplayUnitsAppended,
  groupFamilyBreakdown,
  resolveHistoryDisplayTarget,
} from './historyDisplayUnits.mjs';

const names={read:'Read',search:'Search',run:'Bash',edit:'Edit',mcp:'MCP'};
const call=(id,family)=>({tool:'__raw__',rawTool:{toolUseId:id,toolName:names[family]||family,family,result:'ok',args:{}}});
const action=(id,family)=>({uuid:id,role:'assistant',content:'',actions:[call(id,family)]});
const comment=(id,content=id,phase='commentary')=>({uuid:id,role:'assistant',content,textPhase:phase,actions:[]});
const user=id=>({uuid:id,role:'user',content:'prompt'});
const summary=units=>units.map(u=>u.kind==='group'
  ? {kind:'group',ids:u.entries.map(e=>e.uuid),captions:(u.captionEntries||[]).map(e=>e.uuid),
    calls:groupFamilyBreakdown(u.facts).map(x=>[x.family,x.count])}
  : {kind:'entry',ids:[u.entry.uuid]});

test('different tools share one work group, the next commentary starts the next group',()=>{
  const rows=[user('u'),comment('t1','Проверяю'),action('r','read'),action('e','edit'),action('s','search'),
    comment('t2','Нашёл причину'),action('b','run'),action('e2','edit')];
  const before=JSON.stringify(rows),units=buildHistoryDisplayUnits(rows);
  assert.deepEqual(summary(units),[
    {kind:'entry',ids:['u']},
    {kind:'group',ids:['t1','r','e','s'],captions:['t1'],calls:[['read',1],['edit',1],['search',1]]},
    {kind:'group',ids:['t2','b','e2'],captions:['t2'],calls:[['run',1],['edit',1]]},
  ]);
  assert.equal(JSON.stringify(rows),before,'raw records are never rewritten');
});

test('work before its first text joins that first group and all following types stay together',()=>{
  const rows=[action('r','read'),action('e','edit'),comment('t1'),action('b','run'),action('s','search'),
    comment('t2'),action('m','mcp'),action('e2','edit')];
  const units=buildHistoryDisplayUnits(rows);
  assert.deepEqual(units.map(u=>u.entries?.map(e=>e.uuid)),[['r','e','t1','b','s'],['t2','m','e2']]);
  assert.deepEqual(units.map(u=>u.captionEntries.map(e=>e.uuid)),[['t1'],['t2']]);
});

test('no caption yet stays one work group; the first text is appended without moving its identity',()=>{
  const initial=[action('r','read'),action('e','edit'),action('s','search')];
  const before=buildHistoryDisplayUnits(initial),after=buildHistoryDisplayUnits([...initial,comment('t1')]);
  assert.equal(before.length,1);assert.equal(after.length,1);
  assert.equal(before[0].kind,'group');assert.equal(after[0].key,before[0].key);
  assert.deepEqual(before[0].captionEntries,[]);assert.deepEqual(after[0].captionEntries.map(e=>e.uuid),['t1']);
});

test('homogeneous work keeps the same root key when a caption or a different tool arrives',()=>{
  const reads=[action('a','read'),action('b','read')],before=buildHistoryDisplayUnits(reads);
  const afterCaption=buildHistoryDisplayUnits([...reads,comment('t')]);
  const afterDifferent=buildHistoryDisplayUnits([...reads,comment('t'),action('e','edit')]);
  assert.equal(before.length,1);assert.equal(afterCaption.length,1);assert.equal(afterDifferent.length,1);
  assert.equal(afterCaption[0].key,before[0].key);assert.equal(afterDifferent[0].key,before[0].key);
  const opened=buildHistoryDisplayUnits([...reads,comment('t'),action('e','edit')],{expandedKeys:new Set([before[0].key])});
  assert.equal(opened[0].expanded,true);assert.ok(opened.some(u=>u.entry?.uuid==='t'));
  assert.notEqual(opened.find(u=>u.kind==='group'&&u.level===2)?.key,before[0].key,'nested aggregate never aliases its outer group');
});

test('a short legacy answer without phase or structural action proof remains standalone',()=>{
  const answer={uuid:'unknown-answer',role:'assistant',content:'Готово.'};
  const units=buildHistoryDisplayUnits([action('r','read'),action('e','edit'),answer,user('next')]);
  assert.equal(units[0].kind,'group');assert.deepEqual(units[0].captionEntries,[]);
  assert.equal(units[1].entry.uuid,'unknown-answer');assert.equal(units[2].entry.uuid,'next');
});

test('an untyped Claude text structurally owned by a call remains the caption',()=>{
  const first={...action('r','read'),messageId:'response-1'};
  const text={uuid:'legacy-comment',role:'assistant',content:'Проверяю',messageId:'response-1'};
  const units=buildHistoryDisplayUnits([first,action('e','edit'),text]);
  assert.equal(units.length,1);assert.equal(units[0].kind,'group');
  assert.deepEqual(units[0].captionEntries.map(row=>row.uuid),['legacy-comment']);
});

test('consecutive texts never form an empty group or silently replace one another',()=>{
  const units=buildHistoryDisplayUnits([comment('t1'),comment('t2'),action('r','read'),action('e','edit')]);
  assert.deepEqual(summary(units),[
    {kind:'entry',ids:['t1']},
    {kind:'group',ids:['t2','r','e'],captions:['t2'],calls:[['read',1],['edit',1]]},
  ]);
  const onlyTexts=buildHistoryDisplayUnits([comment('x'),comment('y')]);
  assert.deepEqual(summary(onlyTexts),[{kind:'entry',ids:['x']},{kind:'entry',ids:['y']}]);
});

test('one commentary and one tool form a real group, but text alone never does',()=>{
  const units=buildHistoryDisplayUnits([comment('t1'),action('r','read'),comment('t2'),action('e','edit')]);
  assert.deepEqual(summary(units),[
    {kind:'group',ids:['t1','r'],captions:['t1'],calls:[['read',1]]},
    {kind:'group',ids:['t2','e'],captions:['t2'],calls:[['edit',1]]},
  ]);
  assert.deepEqual(summary(buildHistoryDisplayUnits([comment('only')])),[{kind:'entry',ids:['only']}]);
});

test('a live single call becomes one captioned group without losing either source address',()=>{
  const prefix=Array.from({length:12},(_,i)=>user('previous-'+i));
  const old=[...prefix,action('only-call','edit')],options={threshold:2,expandedKeys:new Set()};
  const oldUnits=buildHistoryDisplayUnits(old,options),next=[...old,comment('arrived')];
  const inc=buildHistoryDisplayUnitsAppended(old,oldUnits,next,options,options);
  assert.ok(inc);const full=buildHistoryDisplayUnits(next,options);
  assert.deepEqual(summary(inc.units),summary(full));
  const group=full.at(-1);assert.equal(group.kind,'group');
  assert.deepEqual(group.entries.map(e=>e.uuid),['only-call','arrived']);
  assert.deepEqual(resolveHistoryDisplayTarget(full,'only-call'),{index:12,groupKey:group.key});
  assert.deepEqual(resolveHistoryDisplayTarget(full,'arrived'),{index:12,groupKey:group.key});
});

test('a finite thousand-call mixed work span keeps every call under its one commentary',()=>{
  const rows=[comment('t1'),...Array.from({length:1000},(_,i)=>({uuid:'u'+i,role:'assistant',content:'',
    actionSummary:[{toolUseId:'call-'+i,toolName:i%2?'Edit':'Read',family:i%2?'edit':'read',subject:'src/file-'+i+'.js'}]})),
    comment('t2'),action('last','search')];
  const units=buildHistoryDisplayUnits(rows);
  assert.equal(units.length,2);assert.equal(units[0].facts.length,1000);assert.equal(units[0].entries.length,1001);
  assert.deepEqual(units[0].captionEntries.map(e=>e.uuid),['t1']);
  assert.deepEqual(units[1].captionEntries.map(e=>e.uuid),['t2']);
  assert.equal(resolveHistoryDisplayTarget(units,'u999').groupKey,units[0].key);
});

test('standalone answers, long text, user messages and interactive questions stay boundaries',()=>{
  const question={uuid:'question',role:'assistant',content:'',actions:[call('question','question')]};
  const items=[action('a','read'),action('b','edit'),comment('partial','partial','partial_answer'),
    action('c','search'),action('d','run'),comment('long','x'.repeat(601)),
    action('e','read'),action('f','edit'),question,action('g','search'),action('h','run'),
    comment('final','done','final_answer'),user('next')];
  const units=buildHistoryDisplayUnits(items);
  assert.deepEqual(units.map(u=>u.kind==='group'?u.entries.map(e=>e.uuid):u.entry.uuid),[
    ['a','b'],'partial',['c','d'],'long',['e','f'],'question',['g','h'],'final','next',
  ]);
});

test('text on a composite action remains the only caption and cannot be buried in an inner series',()=>{
  const composite=(id,label,families)=>({uuid:id,role:'assistant',content:label,textPhase:'commentary',
    actions:families.map((family,i)=>call(id+'-'+i,family))});
  const rows=[composite('c1','first',['read','search']),action('r','read'),
    composite('c2','second',['edit','run']),action('b','run')];
  const closed=buildHistoryDisplayUnits(rows);
  assert.deepEqual(closed.map(u=>u.captionEntries.map(e=>e.uuid)),[['c1'],['c2']]);
  const open=buildHistoryDisplayUnits(rows,{expandedKeys:new Set([closed[0].key])});
  assert.ok(open.some(u=>u.kind==='entry'&&u.entry.uuid==='c1'),'commentary row remains visible after outer expansion');
  assert.deepEqual(resolveHistoryDisplayTarget(closed,'c2'),{index:1,groupKey:closed[1].key});
});

test('dehydrated stubs retain the same boundaries, keys and caption identity',()=>{
  const rows=[action('r','read'),action('e','edit'),comment('t1'),action('s','search'),
    comment('t2'),action('b','run'),action('e2','edit')];
  const stubs=rows.map(row=>({uuid:row.uuid,role:row.role,rowStub:true,
    ...(row.content?{hasContent:true,contentLength:row.content.length,textPhase:row.textPhase}:{}),
    ...(row.actions.length?{actionSummary:row.actions.map(a=>({...a.rawTool}))}:{})}));
  const full=buildHistoryDisplayUnits(rows),stub=buildHistoryDisplayUnits(stubs);
  assert.deepEqual(summary(stub),summary(full));assert.deepEqual(stub.map(x=>x.key),full.map(x=>x.key));
});

test('live append and full regrouping agree when the first and next texts arrive',()=>{
  const prefix=Array.from({length:12},(_,i)=>user('previous-'+i));
  const options={threshold:2,expandedKeys:new Set()};
  let entries=[...prefix,action('r','read'),action('e','edit')],units=buildHistoryDisplayUnits(entries,options);
  for(const next of [comment('t1'),action('s','search'),comment('t2'),action('b','run'),action('e2','edit')]){
    const rows=[...entries,next],inc=buildHistoryDisplayUnitsAppended(entries,units,rows,options,options);
    assert.ok(inc,'unchanged user prefix remains reusable');
    const full=buildHistoryDisplayUnits(rows,options);
    assert.deepEqual(summary(inc.units),summary(full));assert.deepEqual(inc.units.map(x=>x.key),full.map(x=>x.key));
    entries=rows;units=inc.units;
  }
});
