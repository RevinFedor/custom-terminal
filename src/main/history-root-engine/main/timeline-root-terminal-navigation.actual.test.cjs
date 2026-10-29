'use strict';
// Finite SOURCE qualification only. Actual Node SQLite/page store/logical root;
// no app, native UI, provider, MCP, user data, build or position-cache repair.
// NOTED_UNIT_TEST_SQLITE_ADAPTER=<provided adapter> NOTED_TIMELINE_TERMINAL_EVIDENCE=<own dir>
// node --max-old-space-size=80 --max-semi-space-size=4 --expose-gc <this file>
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),v8=require('node:v8'),crypto=require('node:crypto');
const ts=require('typescript');
const SQLite=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createTimelineLogicalRoot,TimelineLogicalRoot}=require('./timeline-root-logical');
const {readTimelineRootTerminalNavigation:read}=require('./timeline-root-terminal-navigation');
const {isTimelineAttributeEntry:isAttributeEntry}=require('../shared/timeline-entry-facts.cjs');
const evidence=process.env.NOTED_TIMELINE_TERMINAL_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'explicit owned evidence directory');
fs.mkdirSync(evidence,{recursive:true});
const heapLimit=v8.getHeapStatistics().heap_size_limit;
assert(heapLimit<=128*1024**2,'TOTAL configured V8 heap <=128MiB');

// Compile the ACTUAL getSearchLines and duplicate counter, not a hand-written
// reference. Also execute the complete existing text-search click branch with
// an explicitly substituted finite terminal-position oracle.
const source=fs.readFileSync(path.resolve(__dirname,'../../../renderer/components/Workspace/Timeline.tsx'),'utf8');
const extract=(start,end,from=0)=>{
 const a=source.indexOf(start,from),b=source.indexOf(end,a+start.length);
 assert(a>=0&&b>a,'existing Timeline oracle boundary');return source.slice(a,b);
};
const searchSource=extract('function getSearchLines(', '\n  return result;\n}')+'\n  return result;\n}';
const clickStart=source.indexOf('// Gemini/Codex: buffer-text search with multi-line matching.');
const countSource=extract('        let occurrenceIndex = 0;', '\n        // Anchored search:',clickStart);
const clickSource=extract('        const searchLines = getSearchLines(entry.content);', '\n      } else {\n        // Claude:',clickStart);
assert(countSource.includes('e.type !== entry.type')&&countSource.includes('eLines.every((l, j) => l === searchLines[j])'));
assert(clickSource.includes('for (let pi = index - 1; pi >= 0; pi--)')&&clickSource.includes('retrying without anchor'));
const oracleContext={isAttributeEntry,console:{warn(){}}};
vm.createContext(oracleContext);
new vm.Script(ts.transpileModule(searchSource+`
function occurrence(entries,index){const entry=entries[index],searchLines=getSearchLines(entry.content);
${countSource}
return occurrenceIndex;}
function click(entries,index,terminalRegistry){const entry=entries[index],tabId='finite';let found=false;
${clickSource}
return {found,searchLines,occurrenceBefore:occurrenceIndex,startAfterRow};}
globalThis.oracle={getSearchLines,occurrence,click};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText).runInContext(oracleContext);
const oracle=oracleContext.oracle;
const plain=value=>JSON.parse(JSON.stringify(value));
const dirs=new Set();
let semanticComparisons=0,semanticComplete=false,peakHeapTotal=0,peakExternal=0,peakFixtureBytes=0,maxReplyBytes=0;
function sample(){
 const m=process.memoryUsage();peakHeapTotal=Math.max(peakHeapTotal,m.heapTotal);peakExternal=Math.max(peakExternal,m.external);
 assert(m.heapTotal<=128*1024**2,'actual V8 heap <=128MiB');
 let bytes=0;for(const dir of dirs)for(const name of fs.readdirSync(dir)){
  const st=fs.lstatSync(path.join(dir,name));assert(!st.isSymbolicLink());bytes+=st.size;
 }
 peakFixtureBytes=Math.max(peakFixtureBytes,bytes);assert(bytes<=64*1024**2,'all generated fixtures <=64MiB');
}
const control={assertCurrent(){},async checkpoint(){sample();await new Promise(resolve=>setImmediate(resolve));}};
const pins=store=>({leases:store.stats().leases,builders:store.stats().activeBuilders,pins:store.db.prepare('SELECT count(*) n FROM hp_pins').get().n});
function publish(store,value){const a=new HistoryProjectionArena(store);try{return a.step(()=>a.publish(value));}finally{a.close();}}
function fixture(t,{pageBytes=256}={}){
 const dir=fs.mkdtempSync(path.join(evidence,'fixture-'));dirs.add(dir);
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,pageBytes,indexBytes:pageBytes*3,residentPages:3,diskBytes:48*1024**2});
 const held=new Set(),hold=x=>(held.add(x),x);
 const logical=async(entries,presentation)=>{
  const base=hold(publish(store,{entries})),pres=presentation?hold(publish(store,presentation)):null;
  return hold(await createTimelineLogicalRoot(store,{success:true,semanticSnapshotComplete:true,root:base,entries:base.cursor().field('entries')},{presentationRoot:pres,control}));
 };
 t.after(()=>{try{
  for(const r of held)r.release();assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});sample();
 }finally{store.close();fs.rmSync(dir,{recursive:true});dirs.delete(dir);assert(!fs.existsSync(dir));global.gc?.();}});
 return{store,dir,logical,hold};
}
const row=(uuid,content,type='user',extra={})=>({uuid,type,content,sessionId:'finite-session',timestamp:'2026-10-26T00:00:00Z',...extra});
async function compare(logical,entries,rank,options={}){
 const result=await read(logical,rank,{control,...options}),before=options.beforeLogicalRank??rank;
 assert.deepEqual(result.searchLines,plain(oracle.getSearchLines(entries[rank].content)));
 assert.equal(result.occurrenceBefore,oracle.occurrence(entries,rank));
 assert.equal(result.logicalRank,rank);assert.equal(result.logicalCount,entries.length);assert.equal(result.logicalRevision,logical.revision);
 assert.equal(result.uuid,entries[rank].uuid);assert.equal(result.type,entries[rank].type);
 assert.equal(result.isAttribute,isAttributeEntry(entries[rank]));
 assert.equal(result.navigable,!isAttributeEntry(entries[rank])&&result.searchLines.length>0);
 let prior=null;
 for(let i=before-1;i>=0;i--)if(!isAttributeEntry(entries[i])&&oracle.getSearchLines(entries[i].content).length){prior=i;break;}
 if(prior===null){assert.equal(result.previousAnchor,null);assert.equal(result.nextPreviousBeforeRank,null);}
 else{
  assert.equal(result.previousAnchor.logicalRank,prior);assert.equal(result.previousAnchor.uuid,entries[prior].uuid);
  assert.equal(result.previousAnchor.type,entries[prior].type);
  assert.deepEqual(result.previousAnchor.searchLines,plain(oracle.getSearchLines(entries[prior].content)));
  assert.equal(result.previousAnchor.occurrenceBefore,oracle.occurrence(entries,prior));
  assert.equal(result.nextPreviousBeforeRank,prior);
 }
 semanticComparisons++;
 // Semantic oracle comparisons above ALWAYS precede output/cost assertions.
 maxReplyBytes=Math.max(maxReplyBytes,Buffer.byteLength(JSON.stringify(result)));
 assert(maxReplyBytes<65536);assert(result.searchLines.length<=3);for(const line of result.searchLines)assert(line.length<=50);
 return result;
}

test('actual getSearchLines and all-lines/SAME-type occurrence oracle, including Unicode/page boundaries',async t=>{
 const f=fixture(t),common='a mixed prompt '+('long body 🙂 Ω 漢 \0\r\n'.repeat(190));
 const samples=[
  '', ' \r\n\t\ufeff', 'a', 'да', '---', '────────╯', '====\n---\n    ', 'aaaaX', 'aaaaXY',
  'a'.repeat(8192)+'X', '🙂'.repeat(12), '\ud800'.repeat(8), '\udfff'.repeat(8),
  '\r\n\ufeff  Ω\0 value \r\n second\tline\r\n third\n fourth',
  'x'.repeat(49)+'🙂Z', '\0\0\0\nreal\0text', 'a\ra\ra',
  'ab'.repeat(63)+'x🙂'+ '\ud800\0\udfff'+' mixed suffix',
  '─'.repeat(20480)+'╯\n first actual line\n second\n third',
  '\u2028'.repeat(3)+' real \u2029',common,common+'different invisible fourth-line tail',
 ];
 const entries=samples.map((s,i)=>row('sample-'+i,s));
 entries.push(row('type-assistant',common,'assistant'),row('again',common),row('summary-duplicate',common,'user',{isCompactSummary:true}),row('last',common));
 const logical=await f.logical(entries),native=mat(logical.entries);
 assert.equal(native.length,entries.length);
 for(let i=0;i<native.length;i++)await compare(logical,native,i);
 const last=await compare(logical,native,native.length-1);
 assert.equal(last.occurrenceBefore,4,'different full long bodies with same 3 search lines count; type differs do not');
 assert.equal(last.previousAnchor.uuid,'again','compact-summary excluded only as anchor, included in duplicate count');
 assert.equal(last.previousAnchor.occurrenceBefore,2);
});

test('source click oracle: offwindow prior anchors, absent closest candidates and anchored failure fallback',async t=>{
 const f=fixture(t),entries=[row('old0','shared old line'),row('old1','shared old line'),row('plan','Plan to implement','user',{isPlan:true}),
  row('distant','anchor still in xterm'),...Array.from({length:35},(_,i)=>row('missing-'+i,'missing anchor '+i)),
  row('compact','structural point','compact'),row('doc','docs payload','docs_edit'),row('empty',' \r\n'),row('target','continue')];
 const logical=await f.logical(entries),rank=entries.length-1;
 const nativeCalls=[],backendCalls=[];
 const terminal=calls=>({
  findTextBufferRow(tabId,lines,count,start){calls.push(['find',lines,count,start]);return lines[0]==='anchor still in xterm'?91:-1;},
  scrollToTextInBuffer(tabId,lines,count,start){calls.push(['scroll',lines,count,start]);return start===-1;},
 });
 const expected=oracle.click(entries,rank,terminal(nativeCalls));
 let result=await compare(logical,entries,rank),bufferRow=-1;
 const receiver=terminal(backendCalls);
 // Receiver retains ONE root and ONE bounded fact, never an N-anchor graph.
 for(;;){
  const anchor=result.previousAnchor;if(!anchor)break;
  bufferRow=receiver.findTextBufferRow('finite',anchor.searchLines,anchor.occurrenceBefore,-1);
  if(bufferRow>=0||result.nextPreviousBeforeRank===null)break;
  result=await compare(logical,entries,rank,{beforeLogicalRank:result.nextPreviousBeforeRank,ifRevision:result.logicalRevision});
 }
 let found=receiver.scrollToTextInBuffer('finite',result.searchLines,result.occurrenceBefore,bufferRow);
 if(!found&&bufferRow>=0)found=receiver.scrollToTextInBuffer('finite',result.searchLines,result.occurrenceBefore,-1);
 assert.equal(found,expected.found);assert.deepEqual(backendCalls,plain(nativeCalls));assert.equal(result.previousAnchor.logicalRank,3);
 assert.equal(bufferRow,91);assert.deepEqual(backendCalls.slice(-2).map(c=>c[3]),[91,-1]);
 // Explicitly continuing past the oldest valid anchor exhausts without inventing
 // an xterm row or occurrence 0 for the selected rank.
 const oldest=await compare(logical,entries,rank,{beforeLogicalRank:1,ifRevision:logical.revision});
 assert.equal(oldest.previousAnchor.logicalRank,0);
 const exhausted=await compare(logical,entries,rank,{beforeLogicalRank:0,ifRevision:logical.revision});
 assert.equal(exhausted.previousAnchor,null);assert(!('previousBufferRow' in exhausted));
});

test('logical projection owns Goal/service/structural/pending semantics; optional type fields',async t=>{
 const f=fixture(t),base=[row('source','work selected'),row('service','work selected','user',{semanticTags:[{kind:'prompt-origin',source:'terminal-mcp'}]}),
  row('goal','Goal continued','user',{isGoalContinuation:true}),row('status','<codex_internal_context source="user_goal">User set goal status: "paused".</codex_internal_context>'),
  row('continue','bridge','continued'),row('search','search details','docs_search'),row('final','work selected')];
 const logical=await f.logical(base),native=mat(logical.entries);
 assert.deepEqual(native.map(e=>e.uuid),['source','service','continue','search','final']);
 const result=await compare(logical,native,4);
 assert.equal(result.occurrenceBefore,2);assert.equal(result.previousAnchor.uuid,'service');assert.equal(result.previousAnchor.occurrenceBefore,1);
 assert.equal(result.canonicalOrdinal,6);assert.equal(result.previousAnchor.canonicalOrdinal,1);
 // A live carrier represented by canonical source identity must not add a
 // duplicate. Unrepresented prepared text remains paged and has ordinal null.
 const prepared=await f.logical([row('canonical','old canonical'),row('latest','latest canonical')],{
  liveEntries:[row('represented','do not duplicate','user',{sourceIdentity:'canonical',handoffId:'represented'}),
   row('pending','entire pending prepared text '+ 'xy'.repeat(4096),'user',{handoffId:'pending',timestamp:'2026-10-26T00:00:01Z'})],
 });
 const rows=mat(prepared.entries);assert.equal(rows.length,3);assert.equal(rows[2].uuid,'pending');
 const pending=await compare(prepared,rows,2);assert.equal(pending.canonicalOrdinal,null);
 const missing=[{uuid:'without-type',content:'text with no type'},row('next','text with no type')];
 const optional=await f.logical(missing),opt=await compare(optional,missing,1);assert(!('type' in opt.previousAnchor));
 assert(!('type' in await compare(optional,missing,0)));
});

test('finite mixed UTF16 whitespace/separator corpus equals current renderer, not normalized Unicode',async t=>{
 const f=fixture(t),alphabet=['a','b','─','╯','Ω','漢','🙂','\ud800','\udfff','\0','\r','\n',' ','\t','\u00a0','\ufeff','\u2028','\u2029','\u200b'];
 let seed=41;const entries=[];
 for(let i=0;i<24;i++){
  let content='';
  for(let j=0;j<135+i;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;content+=alphabet[seed%alphabet.length];}
  entries.push(row('utf16-'+i,content));
 }
 entries.push(row('astral-threshold','🙂'.repeat(512)+'\ntext after astral')); // .5 UTF16 ratio is meaningful.
 entries.push(row('BMP-threshold','─'.repeat(512)+'╯\ntext after BMP')); // near-separator is filtered.
 entries.push(row('short-repeat','xx\nxxx\n\0\0\n\0\0\0')); // only length>=3 filters separators.
 const logical=await f.logical(entries),native=mat(logical.entries);
 for(let i=0;i<native.length;i++)await compare(logical,native,i);
 assert.equal((await read(logical,24,{control})).searchLines[0],'🙂'.repeat(25));
 assert.equal((await read(logical,25,{control})).searchLines[0],'text after BMP');
});

test('frozen independent lease, cancellation during actual text passes and strict continuation revision',async t=>{
 const f=fixture(t),entries=Array.from({length:38},(_,i)=>row('cancel-'+i,'mixed long content '+ 'z'.repeat(20000)+'終'+i));
 const logical=await f.logical(entries),before=pins(f.store);
 await assert.rejects(read(logical,37,{control:{signal:{aborted:true}}}),{code:'HISTORY_READ_CONSUMER_REVOKED'});
 assert.deepEqual(pins(f.store),before);
 let checkpoints=0;
 await assert.rejects(read(logical,37,{control:{assertCurrent(){},async checkpoint(){if(++checkpoints===2)throw Error('exact demand cancelled');}}}),/exact demand cancelled/);
 assert.equal(checkpoints,2);assert.deepEqual(pins(f.store),before);
 const ac=new AbortController();let called=false;
 await assert.rejects(read(logical,37,{control:{signal:ac.signal,assertCurrent(){},async checkpoint(){called=true;ac.abort();}}}),{code:'HISTORY_READ_CONSUMER_REVOKED'});
 assert(called);assert.deepEqual(pins(f.store),before);
 await assert.rejects(read(logical,-1),{code:'TIMELINE_TERMINAL_NAVIGATION_RANK'});
 await assert.rejects(read(logical,entries.length),{code:'TIMELINE_TERMINAL_NAVIGATION_RANK'});
 await assert.rejects(read(logical,37,{beforeLogicalRank:4}),{code:'TIMELINE_TERMINAL_NAVIGATION_STALE'});
 await assert.rejects(read(logical,37,{beforeLogicalRank:38,ifRevision:logical.revision}),{code:'TIMELINE_TERMINAL_NAVIGATION_BEFORE'});
 for(const beforeLogicalRank of [null,-1,1.5,NaN])
  await assert.rejects(read(logical,37,{beforeLogicalRank,ifRevision:logical.revision}),{code:'TIMELINE_TERMINAL_NAVIGATION_BEFORE'});
 await assert.rejects(read(logical,37,{ifRevision:'different-cut'}),{code:'TIMELINE_TERMINAL_NAVIGATION_STALE'});
 assert.deepEqual(pins(f.store),before);
 const next=await f.logical([row('new','completely different cut')]);
 await assert.rejects(read(next,0,{ifRevision:logical.revision}),{code:'TIMELINE_TERMINAL_NAVIGATION_STALE'});
 const beforeFrozen=pins(f.store);
 let released=false;
 const result=await read(logical,37,{control:{assertCurrent(){},async checkpoint(){
  if(!released){released=true;logical.release();}
 }}});
 assert(released);assert.equal(result.logicalCount,38);assert.equal(result.occurrenceBefore,37);
 assert.deepEqual(result.searchLines,plain(oracle.getSearchLines(entries[37].content)));
 assert.equal(result.occurrenceBefore,oracle.occurrence(entries,37));semanticComparisons++;
 assert.throws(()=>logical.assert(),{code:'TIMELINE_LOGICAL_RELEASED'});
 assert.equal(pins(f.store).leases,beforeFrozen.leases-3,'only the explicitly released logical root loses its three pins');
 semanticComplete=true;
});

test('cost AFTER finite source oracle: streamed long separator and many rows, no whole-body/ID/ref list',async t=>{
 assert(semanticComplete&&semanticComparisons>30,'source semantic oracle finished before cost assertions');
 const f=fixture(t,{pageBytes:1024}),arena=new HistoryProjectionArena(f.store);
 let lease;
 try{
  arena.step(()=>{const s=arena.state();s.rows=arena.make('array');s.facts=arena.make('array');});
  // Create a real immutable logical lease with the real class, directly on
  // pages, to measure THIS reader without claiming upstream Body OPEN closed.
  for(let i=0;i<192;i++){
   arena.step(()=>{
    const s=arena.state();s.rows.push(arena.own(row('cost-'+i,'streamed shared key\nsecond distinct line\nthird distinct line\n'+('tail pair '.repeat(48)))));
    s.facts.push({canonicalOrdinal:i});
   });if(i%32===0)sample();
  }
  // UTF16 leaf written incrementally; no native long line or N-row DTO.
  let leaf;
  f.store.transaction(()=>{const w=f.store.leafWriter();for(let i=0;i<512;i++)w.write('─'.repeat(512));w.write('╯\nfinal meaningful line\nsecond line\nthird line');leaf=w.finish();});
  const textLease=f.hold(f.store.lease(leaf));
  arena.step(()=>{const s=arena.state();s.rows.push(arena.own({uuid:'streamed-long-line',type:'user',content:textLease.cursor()}));s.facts.push({canonicalOrdinal:192});lease=arena.publish();});
 }finally{arena.close();}
 const base=f.hold(publish(f.store,{finite:'held base'}));
 const logical=f.hold(new TimelineLogicalRoot(f.store,lease,base.fork(),null,{}));
 const before=pins(f.store),written=f.store.stats().pagesWritten;
 let yielded=0;
 const audit={assertCurrent(){},async checkpoint(){yielded++;sample();await new Promise(r=>setImmediate(r));}};
 const duplicate=await read(logical,191,{control:audit});
 assert.equal(duplicate.occurrenceBefore,191);assert.equal(duplicate.previousAnchor.occurrenceBefore,190);
 assert.equal(duplicate.previousAnchor.logicalRank,190);
 const long=await read(logical,192,{control:audit});
 assert.deepEqual(long.searchLines,['final meaningful line','second line','third line']);assert.equal(long.occurrenceBefore,0);
 assert.equal(f.store.stats().pagesWritten,written,'read only: fork and scalar navigation write zero data pages');
 assert.deepEqual(pins(f.store),before);assert(yielded>80,'cooperative cancellation points during actual text work');
 assert.equal(logical.arena.metrics.unboundedTextMaterializations||0,0);
 assert.equal(logical.stats().ownership.nativeRows,0);assert.equal(logical.stats().ownership.nativeMapEntries,0);
 assert(f.store.stats().peakPageReadBytes<=1024);assert(f.store.stats().cachedPages<=3);
 assert(!Array.isArray(logical.entries));assert.equal(logical.entries.at(192).field('content').length,262144+'╯\nfinal meaningful line\nsecond line\nthird line'.length);
 sample();
});

test.after(()=>{
 assert.equal(dirs.size,0,'all own SQLite fixtures removed');
 fs.writeFileSync(path.join(evidence,'metrics.json'),JSON.stringify({semanticComparisons,semanticComplete,heapLimit,peakHeapTotal,peakExternal,
  peakFixtureBytes,maxReplyBytes,fixturesRemaining:dirs.size,sqlite:'provided node:sqlite adapter',
  nativeTerminalPositionCache:'OPEN; terminal registry replaced only in finite click oracle',globalMemoryBounded:false},null,2)+'\n');
});
