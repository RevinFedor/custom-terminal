// Finite owned Source fixtures, real Electron-ABI SQLite/page store and both
// actual grouping implementations. No app, provider, live History or UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {buildHistoryDisplayUnits,resolveHistoryDisplayTarget} from '../../../renderer/utils/historyDisplayUnits.mjs';

const require=createRequire(import.meta.url);
const {HistoryPagedStore,materializeHistoryCursorSync:materialize}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createHistoryRootDisplayView}=require('./history-root-display-view');
const {projectPrimaryHistoryUnit}=require('./history-primary-presentation');
const names={read:'Read',search:'Search',run:'Bash',edit:'Edit',mcp:'MCP',question:'Question'};
const call=(id,family)=>({tool:'__raw__',rawTool:{toolUseId:id,toolName:names[family],family,result:'ok',args:{}}});
const action=(id,family)=>({uuid:id,role:'assistant',content:'',actions:[call(id,family)]});
const comment=(id,content=id,phase='commentary')=>({uuid:id,role:'assistant',content,textPhase:phase,actions:[]});
const user=id=>({uuid:id,role:'user',content:'prompt'});
const compact=units=>units.map(u=>u.kind==='group'?{
  kind:'group',key:u.key,level:u.level,family:u.familyKey,expanded:u.expanded===true,
  ids:u.entries.map(e=>e.uuid),captions:(u.captionEntries||[]).map(e=>e.uuid),
  calls:u.facts.map(f=>[f.family,f.toolUseId,!!f.isError]),
  parent:u.parentGroup?.key||'',
}:{kind:'entry',id:u.entry.uuid,parent:u.expandedGroup?.key||'',inner:u.expandedSubgroup?.key||''});
const fixtures=[
  ['mixed and two comments',[user('u'),comment('t1'),action('r','read'),action('e','edit'),action('s','search'),
    comment('t2'),action('b','run'),action('e2','edit')]],
  ['work before first comment',[action('r','read'),action('e','edit'),comment('t1'),action('b','run'),
    comment('t2'),action('s','search'),action('e2','edit')]],
  ['consecutive text and no-text work',[comment('t1'),comment('t2'),action('r','read'),action('e','edit'),
    user('u'),action('b','run'),action('s','search')]],
  ['one tool per commentary',[comment('t1'),action('r','read'),comment('t2'),action('e','edit')]],
  ['standalone answers and unknown legacy text',[action('a','read'),action('b','edit'),comment('p','partial','partial_answer'),
    action('c','read'),action('d','search'),{uuid:'legacy',role:'assistant',content:'Final without phase'},user('next')]],
  ['interactive and long boundaries',[action('r','read'),action('e','edit'),comment('long','x'.repeat(601)),
    action('s','search'),action('b','run'),action('q','question'),action('r2','read'),action('e2','edit')]],
  ['composite rows',[{uuid:'c1',role:'assistant',content:'first',textPhase:'commentary',actions:[call('c1-r','read'),call('c1-s','search')]},
    action('r','read'),{uuid:'c2',role:'assistant',content:'second',textPhase:'commentary',actions:[call('c2-e','edit'),call('c2-b','run')]},action('b','run')]],
  ['structural legacy commentary and final',[{...action('r','read'),messageId:'same'},action('e','edit'),
    {uuid:'owned',role:'assistant',content:'Owned commentary',messageId:'same'},
    {uuid:'final',role:'assistant',content:'Untyped final',messageId:'different'},user('u')]],
  ['thinking and two commentaries',[comment('t1'),action('r','read'),{uuid:'think',role:'assistant',thinking:'next',messageId:'m'},
    {...comment('t2'),messageId:'m'},{...action('e','edit'),messageId:'m'},action('s','search')]],
  ['dehydrated captions and actions',[
    {uuid:'r',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'r',toolName:'Read',family:'read'}]},
    {uuid:'t1',role:'assistant',rowStub:true,hasContent:true,contentLength:3,textPhase:'commentary'},
    {uuid:'e',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'e',toolName:'Edit',family:'edit'}]},
    {uuid:'t2',role:'assistant',rowStub:true,hasContent:true,contentLength:3,textPhase:'commentary'},
    {uuid:'b',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'b',toolName:'Bash',family:'run'}]},
  ]],
  ['two distinct texts in the same provider message',[
    {...comment('t1'),messageId:'same-message'},{...action('r','read'),messageId:'same-message'},
    {...comment('t2'),messageId:'same-message'},{...action('e','edit'),messageId:'same-message'},
  ]],
  ['separate Research groups remain boundaries',[
    action('r','read'),action('e','edit'),
    ...['a','b'].map(id=>({uuid:'sc-'+id,role:'user',content:'Research answer',
      semanticTags:[{kind:'orchestration',runId:'run-'+id,runKind:'external-research',phase:'completion'}]})),
    action('s','search'),action('b','run'),
  ]],
  ['grouping disabled stays identity',[comment('t'),action('r','read'),action('e','edit')],{enabled:false}],
];

for(const [name,rows,config={}] of fixtures)test('paged view matches renderer: '+name,async()=>{
  const store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);
  let source,closed,opened;
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    const plain=buildHistoryDisplayUnits(rows,config),options={...config,complete:true,frozen:true,control:{assertCurrent(){},async checkpoint(){}}};
    closed=await createHistoryRootDisplayView(store,source,options);
    assert.deepEqual(compact(materialize(closed.root.cursor().field('units'))),compact(plain));
    for(const row of rows)assert.deepEqual(closed.resolve(row.uuid),resolveHistoryDisplayTarget(plain,row.uuid));
    const first=plain.find(u=>u.kind==='group');
    if(first){
      const expandedKeys=new Set([first.key]);
      opened=await createHistoryRootDisplayView(store,source,{...options,expandedKeys});
      const expected=buildHistoryDisplayUnits(rows,{...config,expandedKeys});
      assert.deepEqual(compact(materialize(opened.root.cursor().field('units'))),compact(expected));
      for(const row of rows)assert.deepEqual(opened.resolve(row.uuid),resolveHistoryDisplayTarget(expected,row.uuid));
    }
  }finally{
    opened?.close();closed?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0,'all test-owned leases are released');
    const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});

test('actual primary-unit projection delivers each exact caption with thin hidden members',async()=>{
  const rows=[comment('t1','Проверяю **первый**\n\nабзац Ω'),action('r','read'),action('e','edit'),
    comment('t2','Нашёл причину 🙂'),action('b','run')];
  const before=JSON.stringify(rows),store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);let source,view,projected;
  const control={assertCurrent(){},async checkpoint(){}};
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    view=await createHistoryRootDisplayView(store,source,{complete:true,frozen:true,control});
    assert.equal(view.length,2);
    for(const [rank,id] of [[0,'t1'],[1,'t2']]){
      projected=await projectPrimaryHistoryUnit(store,view,rank,{control});
      const unit=materialize(projected.cursor());
      assert.equal(unit.kind,'group');assert.deepEqual(unit.captionEntries.map(e=>e.uuid),[id]);
      assert.equal(unit.captionEntry.content,rows.find(e=>e.uuid===id).content);
      assert.equal(unit.captionEntry.captionTextComplete,true);
      assert.ok(unit.entries.every(e=>e.rowStub===true));
      assert.ok(unit.entries.every(e=>!e.content));
      projected.release();projected=null;
    }
    assert.equal(JSON.stringify(rows),before);
  }finally{
    projected?.release();view?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0,'all test-owned leases are released');
    const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});

const compactResponse=units=>units.map(unit=>({
  kind:unit.kind, key:unit.key||'', family:unit.familyKey||'', expanded:unit.expanded===true,
  ids:unit.kind==='group'?unit.entries.map(entry=>entry.uuid):[unit.entry.uuid],
  parent:unit.responseWork?.key||'', inner:unit.expandedGroup?.key||unit.expandedSubgroup?.key||'',
  timing:unit.responseTiming||null, suppress:unit.suppressResponseTiming===true, tail:unit.activeTail===true,
  firstTimestamp:unit.firstTimestamp||unit.responseWork?.firstTimestamp||'',
  recordTimeAttributes:unit.recordTimeAttributes||{},
  previewEntry:unit.previewEntry?.uuid||'',previewFact:unit.previewFact?.toolUseId||'',
  previewRecordTime:unit.previewRecordTime||null,
}));

for(const [name,rows,enabled] of [
  ['mixed comments and timed final',[user('u'),{...comment('a','long '.repeat(200)),timestamp:'2026-10-27T04:00:00Z'},action('r','read'),action('e','edit'),
    comment('b'),action('s','search'),action('b2','run'),{...comment('f','final','final_answer'),
      responseTiming:{intervalId:7,startTs:1000,endTs:4000,durationMs:3000}}],true],
  ['partial and untyped boundary',[action('r','read'),comment('p','partial','partial_answer'),
    {uuid:'legacy',role:'assistant',content:'untyped final'},user('u'),comment('next')],true],
  ['tool grouping disabled',[user('u'),comment('a'),action('r','read'),action('e','edit'),comment('b')],false],
  ['interactive and Research remain outside',[comment('a'),action('r','read'),action('q','question'),
    {uuid:'sc',role:'user',content:'reply',semanticTags:[{kind:'orchestration',runId:'run',runKind:'external-research',phase:'completion'}]},
    comment('b')],true],
  ['stubs, composite and next turn',[
    {uuid:'stub-text',role:'assistant',rowStub:true,hasContent:true,contentLength:901,textPhase:'commentary'},
    {uuid:'stub-read',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'r',toolName:'Read',family:'read'}]},
    {uuid:'composite',role:'assistant',textPhase:'commentary',content:'text and call',actions:[call('e','edit')]},
    {uuid:'q',role:'assistant',content:'need input',actions:[call('q','question')]},
    user('u2'),comment('new','next'),action('b','run')],true],
  ['known hover time range on stub and full rows',[
    {...comment('a'),recordTime:{version:1,kind:'message',scope:'record',timestamp:'2026-10-27T04:00:00Z'}},
    {uuid:'stub-read',role:'assistant',rowStub:true,actionSummary:[{toolUseId:'r',toolName:'Read',family:'read',
      recordTime:{version:1,kind:'tool-call',scope:'record',timestamp:'2026-10-27T04:04:00Z'}}]},
  ],true],
  ['mixed known call and unsupported interactive action remains outside',[
    comment('before'),{uuid:'mixed-question',role:'assistant',content:'',
      actions:[call('known','read'),{tool:'AskUserQuestion'}]},comment('after'),
  ],true],
])test('response-work paged projection and exact addresses: '+name,async()=>{
  const store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);let source,view,projection;
  const control={assertCurrent(){},async checkpoint(){}};
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    for(const selected of ['open','closed','inner']){
      const initial=buildHistoryDisplayUnits(rows,{enabled,responseWork:true,expandedKeys:new Set()});
      const work=initial.find(u=>u.familyKey==='response-work');
      const opened=buildHistoryDisplayUnits(rows,{enabled,responseWork:true,expandedKeys:new Set(work?[work.key]:[])});
      const toolGroup=opened.find(u=>u.kind==='group'&&u.familyKey!=='response-work'&&u.familyKey!=='research');
      const expandedKeys=new Set(selected==='closed'?[]:selected==='inner'&&toolGroup?[work.key,toolGroup.key]
        :work?[work.key]:[]);
      const expected=buildHistoryDisplayUnits(rows,{enabled,responseWork:true,expandedKeys});
      view=await createHistoryRootDisplayView(store,source,{enabled,responseWork:true,expandedKeys,complete:true,frozen:true,control});
      assert.deepEqual(compactResponse(materialize(view.root.cursor().field('units'))),compactResponse(expected),selected);
      for(const row of rows)assert.deepEqual(view.resolve(row.uuid),resolveHistoryDisplayTarget(expected,row.uuid),row.uuid+' '+selected);
      if(selected==='closed'&&work){
        const rank=expected.findIndex(u=>u.key===work.key);
        projection=await projectPrimaryHistoryUnit(store,view,rank,{control});
        const header=materialize(projection.cursor());
        assert.equal(header.entries.length,1,'a whole response is not materialized in its header');
        assert.equal(header.entries[0].uuid,work.entries[0].uuid);
        projection.release();projection=null;
      }
      view.close();view=null;
    }
  }finally{
    projection?.release();view?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0);const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});

test('a finite long closed work heading keeps its full UUID map without projecting its bodies',async()=>{
  const rows=Array.from({length:80},(_,i)=>comment('long-'+i,'full text '+i+' Ω'));
  const options={responseWork:true,expandedKeys:new Set()};
  const store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);let source,view,projection,checkpoints=0;
  const control={assertCurrent(){},async checkpoint(){checkpoints++;}};
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    view=await createHistoryRootDisplayView(store,source,{...options,complete:true,frozen:true,control});
    assert.equal(view.length,1);
    assert.deepEqual(view.resolve('long-79'),{index:0,groupKey:'work:uuid:long-0'});
    projection=await projectPrimaryHistoryUnit(store,view,0,{control});
    const header=materialize(projection.cursor());
    assert.equal(header.entries.length,1);assert.equal(header.entries[0].uuid,'long-0');
    assert.equal(header.entries[0].content,undefined);
    assert.equal(header.previewEntry.uuid,'long-79');assert.equal(header.previewEntry.content,'full text 79 Ω');
    assert.ok(checkpoints>rows.length,'the paged construction keeps yielding');
  }finally{
    projection?.release();view?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0);const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});

test('the selected long commentary is projected as a bounded UTF-16-safe prefix',async()=>{
  const long='a'.repeat(511)+'😀'+'z'.repeat(2000);
  const rows=[comment('first','earlier'),action('read','read'),comment('last',long),action('edit','edit')];
  const store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);let source,view,projection;
  const control={assertCurrent(){},async checkpoint(){}};
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    view=await createHistoryRootDisplayView(store,source,{responseWork:true,complete:true,frozen:true,control});
    projection=await projectPrimaryHistoryUnit(store,view,0,{control});
    const header=materialize(projection.cursor());
    assert.equal(header.previewEntry.uuid,'last');assert.equal(header.previewEntry.content,'a'.repeat(511));
    assert.equal(header.previewEntry.previewTruncated,true);assert.equal(header.previewFact,null);
    assert.equal(header.entries[0].content,undefined);
    assert.ok(JSON.stringify(header).length<5000,'the full commentary is not in the header payload');
  }finally{
    projection?.release();view?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0);const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});

test('a tool-only work heading projects only the last tool label, never arguments or output',async()=>{
  const rows=[action('first','read'),action('last','edit')];
  rows[1].actions[0].rawTool.args={file_path:'/test/safe.ts',secret:'not-for-preview'};
  rows[1].actions[0].rawTool.result='private output';rows[1].actions[0].rawTool.isError=true;
  const store=new HistoryPagedStore({pageBytes:1024,indexBytes:2048,residentPages:3,diskBytes:32*1024**2});
  const arena=new HistoryProjectionArena(store);let source,view,projection;
  const control={assertCurrent(){},async checkpoint(){}};
  try{
    source=arena.step(()=>arena.publish(arena.own(rows)));arena.close();
    view=await createHistoryRootDisplayView(store,source,{responseWork:true,complete:true,frozen:true,control});
    projection=await projectPrimaryHistoryUnit(store,view,0,{control});
    const header=materialize(projection.cursor());
    assert.equal(header.previewEntry,null);assert.equal(header.previewFact.family,'edit');
    assert.equal(header.previewFact.isError,true);
    assert.doesNotMatch(JSON.stringify(header.previewFact),/not-for-preview|private output/);
  }finally{
    projection?.release();view?.close();source?.release();arena.close();
    assert.equal(store.stats().leases,0);const dir=store.temporaryDirectory;store.close();assert.equal(fs.existsSync(dir),false);
  }
});
