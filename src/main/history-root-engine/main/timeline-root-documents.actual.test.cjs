'use strict';
// Finite SOURCE-only actual Node SQLite. No Electron/provider/native UI/MCP,
// profile, build or user source. All filesystem mutations are owned fixtures.
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),v8=require('node:v8'),Module=require('node:module');
const {DatabaseSync}=require('node:sqlite');
const evidence=process.env.NOTED_TIMELINE_DOCUMENT_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'explicit owned evidence path');
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2,'TOTAL V8 heap <=128MiB');
fs.mkdirSync(evidence,{recursive:true});
class SQLite{
 constructor(filename){this.name=filename;this.native=new DatabaseSync(filename);this.depth=0;}
 get inTransaction(){return this.native.isTransaction;}
 exec(s){return this.native.exec(s);}
 prepare(s){const q=this.native.prepare(s),convert=r=>{if(!r)return r;const out={};for(const [k,v]of Object.entries(r))out[k]=v instanceof Uint8Array?Buffer.from(v):v;return out;};
  return{get:(...a)=>convert(q.get(...a)),all:(...a)=>q.all(...a).map(convert),run:(...a)=>q.run(...a),*iterate(...a){for(const r of q.iterate(...a))yield convert(r);}};}
 pragma(s,o={}){const r=this.prepare('PRAGMA '+s).all();return o.simple?Object.values(r[0])[0]:r;}
 transaction(fn){return(...a)=>{if(this.depth)return fn(...a);this.exec('BEGIN');this.depth++;try{const r=fn(...a);this.exec('COMMIT');return r;}catch(e){try{this.exec('ROLLBACK');}catch{}throw e;}finally{this.depth--;}};}
 close(){this.native.close();}
}
const load=Module._load;
Module._load=function(id,parent,main){return id==='better-sqlite3'?SQLite:load.call(this,id,parent,main);};
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {CodexRootProjectionOwner}=require('./codex-root-projection-owner');
const {createTimelineLogicalRoot}=require('./timeline-root-logical');
const {prepareTimelineRootDocument:prepare}=require('./timeline-root-documents');
const api=require('./ipc/codex-data')._api;
const text=require('./history-paged-text');
const stamp='2026-10-25T00:00:00Z';
const rec=(type,payload)=>({type,payload,timestamp:stamp});
const user=message=>rec('event_msg',{type:'user_message',message});
const carrier=value=>rec('response_item',{type:'message',role:'user',content:[{type:'input_text',text:value}]});
const answer=(value,phase='final_answer')=>rec('response_item',{type:'message',role:'assistant',phase,content:[{type:'output_text',text:value}]});
const call=(call_id,name,args,extra={})=>rec('response_item',{type:'function_call',call_id,name,arguments:JSON.stringify(args),...extra});
const output=(call_id,value)=>rec('response_item',{type:'function_call_output',call_id,output:value});
const end=()=>rec('event_msg',{type:'task_complete'});
const special='Ω🙂\ud800_\udfff\0\r\n';
const hash=(s,encoding='utf16le')=>crypto.createHash('sha256').update(s,encoding).digest('hex');
const pins=store=>({leases:store.stats().leases,builders:store.stats().activeBuilders,
 pins:store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n});
const dirs=new Set();let peakHeap=0,peakFixture=0,semanticsComplete=false,oracleComparisons=0,semanticCases=0,semanticPasses=0,cleanupFailures=0;
function semantic(name,fn){semanticCases++;test(name,async t=>{await fn(t);semanticPasses++;});}
function sample(){
 const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapTotal);assert(m.heapTotal<=128*1024**2);
 let total=0;for(const dir of dirs)for(const name of fs.readdirSync(dir)){const st=fs.lstatSync(path.join(dir,name));assert(!st.isSymbolicLink());total+=st.size;}
 peakFixture=Math.max(peakFixture,total);assert(total<=64*1024**2,'TOTAL fixtures <=64MiB');
}
const control={assertCurrent(){},async checkpoint(){sample();await new Promise(r=>setImmediate(r));}};
function publish(store,value){const a=new HistoryProjectionArena(store);try{return a.step(()=>a.publish(value));}finally{a.close();}}
async function fixture(t,source,{presentation=null,prepared=null,anchors=null}={}){
 const dir=fs.mkdtempSync(path.join(evidence,'fixture-')),id=crypto.randomUUID(),file=path.join(dir,'rollout-'+id+'.jsonl');dirs.add(dir);
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:48*1024**2});
 const owner=new CodexRootProjectionOwner(store,{namespace:'codex-timeline-v1',checkpointEvery:2048});
 const records=[rec('session_meta',{id,cwd:dir}),...source];let offset=0;
 const located=records.map((r,i)=>{const raw=JSON.stringify(r)+'\r\n',v={...r,__line:i,__byteOffset:offset};offset+=Buffer.byteLength(raw);return v;});
 fs.writeFileSync(file,records.map(r=>JSON.stringify(r)+'\r\n').join(''));
 const held=new Set(),hold=x=>(held.add(x),x);
 t.after(()=>{try{for(const r of held)r.release();owner.evict(id,dir);owner.close();api.invalidateJsonlCache(file);
  assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});assert.equal(store.db.prepare('SELECT count(*) n FROM hp_pins').get().n,0);sample();}
  catch(error){cleanupFailures++;throw error;}
  finally{store.close();fs.rmSync(dir,{recursive:true});dirs.delete(dir);assert(!fs.existsSync(dir));global.gc?.();}});
 const canonical=hold(await api.projectCodexRootTimelineFromFile(id,dir,{rootedOwner:owner,sessionsDir:dir,highWaterMark:257}));
 assert(canonical.success);
 let base=canonical;
 if(prepared){const a=new HistoryProjectionArena(store,canonical.root);try{const lease=hold(a.step(()=>{
   const rows=a.state();prepared(rows,a);return a.publish(rows);
  }));base={...canonical,root:lease,entries:lease.cursor()};}finally{a.close();}}
 const noteAnchors=typeof anchors==='function'?anchors(mat(canonical.entries)):anchors;
 const p=presentation||noteAnchors?hold(publish(store,{...(presentation||{}),...(noteAnchors?{noteAnchors}: {})})):null;
 const logical=hold(await createTimelineLogicalRoot(store,{...base,semanticSnapshotComplete:true},{presentationRoot:p,control}));
 const doc=(action,opts={})=>prepare({store,canonicalTimeline:canonical,logicalRoot:logical,action,logicalRank:0,control,...opts}).then(r=>r.success?hold(r):r);
 const native=()=>mat(canonical.entries);
 return{store,owner,canonical,logical,doc,native,located,dir,id,file,hold,records};
}
function contents(doc){
 assert(doc.success);assert.equal(doc.cursor.kind,'text');const value=mat(doc.cursor);
 assert.equal(value.length,doc.length);assert.equal(hash(value),doc.digest);
 assert.equal(doc.encoding,'utf16le');return value;
}
async function compare(f,start,end,options={}){
 const rows=f.native(),expected=api.buildCodexRangeExport(f.located,f.id,f.dir,options,rows[start].uuid,rows[end].uuid);
 assert(expected.success,expected.error);
 const doc=await f.doc(start===end?'turn':'range',{logicalRank:start,logicalStart:start,logicalEnd:end,copyOptions:options});
 const actual=contents(doc);assert.equal(actual,expected.content);assert.equal(hash(actual),hash(expected.content));oracleComparisons++;
 return doc;
}

semantic('prompt uses FULL prepared content, not preview; full final has exact UTF8 proof and survives parent release/GC',async t=>{
 const full='a'.repeat(511)+'🙂'+special.repeat(310),prepared='complete prepared '+special.repeat(340);
 const f=await fixture(t,[user('source prompt'),answer(full),end()],{prepared(rows){rows[0].content=prepared;}});
 const prompt=await f.doc('prompt');assert.equal(contents(prompt),prepared);
 const response=await f.doc('full-response');assert.equal(contents(response),full);
 const {resolveTimelineFullResponse}=await import('../../../renderer/utils/timelineEntryPreview.mjs');
 const historyProjector=api.createCodexHistoryProjector(f.id,{}, {canonicalStore:f.store,sourceOptions:{sessionsDir:f.dir}});
 let history;try{f.located.forEach(historyProjector.feed);history=historyProjector.finalize();}finally{historyProjector.close();}
 assert.equal(resolveTimelineFullResponse(history,f.native()[0].responsePreview,s=>hash(s,'utf8')),full);
 assert.equal(response.metrics.wholeSourceRecordGraphs,0);assert.equal(response.metrics.wholeHistoryDTOs,0);
 f.logical.release();f.canonical.release();f.owner.evict(f.id,f.dir);
 while(!f.store.collectStep(256).complete){}
 assert.equal(contents(prompt),prepared);assert.equal(contents(response),full);
 const before=pins(f.store);prompt.release();prompt.release();response.release();response.release();
 assert.equal(pins(f.store).leases,before.leases-2);
 assert.throws(()=>prompt.cursor.kind,{code:'history_lease_released'});
});

semantic('native copyRange oracle: complete UTF16, ordering, tools and all default/detail flag families',async t=>{
 const f=await fixture(t,[carrier('A'),user('A'),rec('response_item',{type:'reasoning',summary:[{text:'think '+special}]}),
  answer('commentary '+special,'commentary'),
  call('read','read_file',{path:'/owned/a.txt'}),output('read','read result '+special),
  call('run','exec_command',{cmd:'git status'}),output('run','shell '+special),
  call('mcp','mcp__owned__inspect',{x:'arg '+special}),output('mcp','MCP '+special),
  rec('response_item',{type:'web_search_call',action:{type:'search',query:'fixture'}}),
  rec('response_item',{type:'tool_search_call',call_id:'tools',arguments:{query:'find'}}),
  rec('response_item',{type:'tool_search_output',call_id:'tools',tools:[{name:'owned'}]}),
  call('spawn','spawn_agent',{message:'inspect',nickname:'owned'},{namespace:'multi_agent_v1'}),output('spawn','{"agent_id":"owned"}'),
  call('wait','wait_agent',{agent_id:'owned'}),output('wait','result '+special),
  answer('final '+special),end(),user('B'),answer('second'),end()]);
 const variants=[{}, {includeUser:false}, {includeClaude:false}, {includeThinking:false}, {includeText:false},
  {includeActions:false}, {includeTools:true,includeBash:true,includeWebSearch:true,includeToolSearch:true,includeOtherTools:true},
  {includeReading:true,includeSearch:true,includeRun:true,includeGit:true,includeMcp:true,includeEditing:true,includeWeb:true,includePlan:true,includeOther:true},
  {includeSubagentResult:true}, {includeSubagentHistory:true},
  {includeTools:true,includeBash:true,includeSearch:false,includeRun:false,includeGit:false,includeMcp:false,includeOther:false,fromStart:false}];
 for(const opts of variants)await compare(f,0,1,opts);
 await compare(f,1,1);await compare(f,1,0,{includeThinking:false});
});

semantic('patch events/nested tools use existing formatter; paged selected packet preserves native output',async t=>{
 const f=await fixture(t,[user('patch'),call('patch','apply_patch',{patch:'*** Begin Patch\n*** Add File: /owned/a\n+x\n*** End Patch'}),
  rec('event_msg',{type:'patch_apply_end',call_id:'patch',success:true,changes:{'/owned/a':{type:'add',content:'exact '+special}}}),output('patch','ok'),
  call('nested','exec',{input:'const p = "*** Begin Patch\\n*** Add File: /owned/b\\n+x\\n*** End Patch"; await tools.apply_patch(p);'}),
  rec('event_msg',{type:'patch_apply_end',call_id:'unrelated-event-space',success:true,changes:{'/owned/b':{type:'add',content:'nested actual'}}}),output('nested','ok'),
  call('long','mcp__owned__long',{body:special.repeat(30)}),output('long','x'.repeat(61000)),answer('done'),end()]);
 const doc=await compare(f,0,0,{includeEditing:true,includeTools:true});
 assert.equal(doc.metrics.maxNativeRowSinks,0);assert.match(doc.metrics.bodyStatus,/OPEN/);assert.equal(doc.metrics.globalMemoryBounded,false);
 assert.equal(doc.metrics.wholeTimelineDTOs,0);assert.equal(doc.metrics.wholeLineStrings,0);
 assert(doc.metrics.maxSourceChunkBytes<=f.store.pageBytes);assert(doc.metrics.maxTokenBytes<=64);
});

semantic('carrier/rollback/service/compact structural coordinates stay identical to native oracle',async t=>{
 const f=await fixture(t,[user('<environment_context>ignored</environment_context>'),carrier('discard'),user('discard'),answer('gone'),end(),
  rec('event_msg',{type:'thread_rolled_back',num_turns:1}),
  carrier('keep\r\nbody'),user('keep\n\nbody'),
  rec('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:12500}}}),
  rec('compacted',{message:'secret',post_tokens:2345,replacement_history:[{role:'assistant',content:[{text:'DO NOT EXPORT'}]}]}),
  rec('event_msg',{type:'token_count',info:{last_token_usage:{total_tokens:2345}}}),
  rec('event_msg',{type:'context_compacted'}),answer('before next'),end(),user('next'),answer('next final'),end()]);
 assert.equal(f.canonical.entries.length,3);
 await compare(f,0,2);await compare(f,1,1);await compare(f,0,1,{includeUser:false});
 await compare(f,0,2,{includeThinking:false,includeActions:false});
});

semantic('frozen exact bytes after SAME-size rewrite, inode replacement and append never extend selected end',async t=>{
 const f=await fixture(t,[user('first '+special),answer('old '+special.repeat(250)),end(),user('last'),answer('last old'),end()]);
 const original=fs.readFileSync(f.file),expected=api.buildCodexRangeExport(f.located,f.id,f.dir,{},f.native()[0].uuid,f.native()[0].uuid).content;
 fs.writeFileSync(f.file,Buffer.alloc(original.length,32));
 fs.renameSync(f.file,path.join(f.dir,'replaced-own.jsonl'));fs.writeFileSync(f.file,JSON.stringify(user('replacement'))+'\n');
 assert.equal(contents(await f.doc('turn')),expected);assert.equal(contents(await f.doc('full')),'old '+special.repeat(250));
 fs.appendFileSync(f.file,JSON.stringify(user('future'))+'\n'+JSON.stringify(answer('future answer'))+'\n');
 assert.equal(contents(await f.doc('turn')),expected);
});

semantic('variable frozen proof chunks split UTF8/LF arbitrarily; pending tail is not a full source record',async t=>{
 const f=await fixture(t,[user(special.repeat(20)),answer(special.repeat(230)),end()]);
 const bytes=Buffer.concat([fs.readFileSync(f.file),Buffer.from('{"uncommitted":"🙂')]);
 const a=new HistoryProjectionArena(f.store,f.canonical.checkpoint);let cp;
 try{a.step(()=>{const chunks=a.make('array');let at=0,i=0;
   while(at<bytes.length){const n=[1,7,257,13,1023][i++%5];chunks.push(bytes.subarray(at,at+n).toString('base64'));at+=n;}
   a.state().sourceProof=chunks;a.state().file.fileSize=bytes.length;
  });cp=f.hold(a.checkpoint());}finally{a.close();}
 const canonical={...f.canonical,checkpoint:cp,sourceSnapshot:{...f.canonical.sourceSnapshot,size:bytes.length}};
 const doc=f.hold(await prepare({store:f.store,canonicalTimeline:canonical,logicalRoot:f.logical,action:'full',logicalRank:0,control}));
 assert.equal(contents(doc),special.repeat(230));assert(doc.metrics.partialBytes>0);
 const range=f.hold(await prepare({store:f.store,canonicalTimeline:canonical,logicalRoot:f.logical,action:'turn',logicalRank:0,control}));
 const oracle=api.buildCodexRangeExport(f.located,f.id,f.dir,{},f.native()[0].uuid,f.native()[0].uuid);assert.equal(contents(range),oracle.content);
});

semantic('pending point has typed pendingSource, never preview; note aliases resolve canonical rows and ambiguity/stale refuse',async t=>{
 const f=await fixture(t,[user('source'),answer('final'),end()],{presentation:{liveEntries:[{uuid:'live',handoffId:'pending',type:'user',content:'PREVIEW ONLY',timestamp:stamp,sessionId:'owned'}]}});
 const baseline=pins(f.store),pending=await f.doc('prompt',{logicalRank:1});assert.equal(pending.pendingSource,true);assert.equal(pending.success,false);
 assert.deepEqual(pins(f.store),baseline);
 await assert.rejects(f.doc('range',{logicalStart:0,logicalEnd:1}),{code:'TIMELINE_DOCUMENT_PENDING_SOURCE'});
 await assert.rejects(f.doc('prompt',{logicalRank:{logicalRank:0,revision:'old'}}),{code:'TIMELINE_DOCUMENT_STALE'});
 // Two current logical rows claiming one alias must refuse, even if one is an exact UUID match.
 const g=await fixture(t,[user('a'),answer('A'),end(),user('b'),answer('B'),end()],{prepared(rows){rows[0].sourceUuidAliases=['shared'];rows[1].sourceUuidAliases=['shared'];}});
 await assert.rejects(g.doc('prompt',{logicalRank:'shared'}),{code:'TIMELINE_DOCUMENT_AMBIGUOUS'});
 const h=await fixture(t,[user('a'),answer('A'),end()],{anchors:rows=>[{uuid:'note-alias',sessionId:rows[0].sessionId,sourceIdentity:rows[0].sourceIdentity}]});
 assert.equal(contents(await h.doc('prompt',{logicalRank:'note-alias'})),'a');
 const native=api.buildCodexRangeExport(h.located,h.id,h.dir,{},h.native()[0].uuid,h.native()[0].uuid);
 assert.equal(contents(await h.doc('turn',{logicalRank:'note-alias'})),native.content);oracleComparisons++;
 assert.equal(contents(await h.doc('prompt',{logicalRank:h.native()[0].uuid})),'a');
 // One explicit complete prepared lease may resolve a pending point; the
 // resolver's lease is transferred and released once, not pinned forever.
 let released=0;
 const resolveTimelinePendingPrompt=async({logicalRoot,logicalRank})=>{
  const lease=publish(f.store,'full pending '+special.repeat(50));
  return{fullPrepared:true,logicalRevision:logicalRoot.revision,logicalRank,sourceIdentity:'live',
   lease:{cursor:lease.cursor,release(){released++;lease.release();}}};
 };
 const resolved=await f.doc('prompt',{logicalRank:1,api:{...api,resolveTimelinePendingPrompt}});
 assert.equal(contents(resolved),'full pending '+special.repeat(50));assert.equal(released,1);
 resolved.release();assert.deepEqual(pins(f.store),baseline);
});

semantic('range exact refs outside window, reverse endpoints and source append preserve the chosen last turn',async t=>{
 const records=[];for(let i=0;i<7;i++)records.push(user('prompt '+i),answer('answer '+i+special),end());
 const f=await fixture(t,records),rows=f.native(),reference=i=>({logicalRank:i,revision:f.logical.revision,uuid:rows[i].sourceIdentity,canonicalOrdinal:i});
 fs.appendFileSync(f.file,JSON.stringify(user('beyond chosen end'))+'\n'+JSON.stringify(answer('DO NOT COPY'))+'\n');
 const doc=await f.doc('range',{logicalStart:reference(6),logicalEnd:reference(1)});
 const expected=api.buildCodexRangeExport(f.located,f.id,f.dir,{},rows[1].uuid,rows[6].uuid);
 assert.equal(contents(doc),expected.content);oracleComparisons++;
 await assert.rejects(f.doc('range',{logicalStart:{...reference(1),canonicalOrdinal:0},logicalEnd:reference(6)}),{code:'TIMELINE_DOCUMENT_STALE'});
});

semantic('assistantOnly flag uses exact native bounded context/truncation and retains response count',async t=>{
 const f=await fixture(t,[user('prompt'),answer(special.repeat(240),'commentary'),answer('last '+special.repeat(260)),end()]);
 for(const maxChars of [500,501.5,8000,0]){
  const expected=api.buildCodexTurnAssistantContext(f.located,f.id,f.native()[0].uuid,maxChars);assert(expected.success);
  const doc=await f.doc('turn',{copyOptions:{assistantOnly:true,maxChars,includeThinking:true,includeText:false}});
  assert.equal(contents(doc),expected.assistantText);assert.equal(doc.context.assistantMessageCount,expected.assistantMessageCount);
  assert.equal(doc.context.turnIndex,expected.turnIndex);oracleComparisons++;
 }
});

semantic('final preview hash/length/source identity mismatch cannot export preview or neighbouring final',async t=>{
 for(const change of [p=>{p.contentHash='0'.repeat(64);},p=>{p.contentLength++;},p=>{p.sourceIdentity='foreign';},p=>{p.content='other';},p=>{delete p.contentHash;}]){
  const f=await fixture(t,[user('a'),answer(special.repeat(240)),end()],{prepared(rows){change(rows[0].responsePreview);}});
  const baseline=pins(f.store);await assert.rejects(f.doc('full'),e=>/^TIMELINE_DOCUMENT_FINAL_/.test(e.code));assert.deepEqual(pins(f.store),baseline);
 }
});

semantic('cancel, quota, formatter failure and early publication failure clean all transient leases/builders',async t=>{
 const f=await fixture(t,[user(special.repeat(30)),answer(special.repeat(240)),end()]);
 const baseline=pins(f.store);let checks=0;
 await assert.rejects(f.doc('full',{control:{assertCurrent(){if(++checks===4)throw Object.assign(new Error('cancel'),{code:'OWN_CANCEL'});},checkpoint:control.checkpoint}}),{code:'OWN_CANCEL'});
 assert.deepEqual(pins(f.store),baseline);
 const budget=f.store.diskBudget;f.store.diskBudget=1;
 try{await assert.rejects(f.doc('prompt'),{code:'HISTORY_BACKING_FULL'});}finally{f.store.diskBudget=budget;}
 assert.deepEqual(pins(f.store),baseline);
 const g=await fixture(t,[user('tool'),call('x','read_file',{path:'a'}),output('x','x'),end()]);
 const gp=pins(g.store);await assert.rejects(g.doc('turn',{api:{...api,codexHistoryActionsForCall(){throw Object.assign(new Error('formatter'),{code:'OWN_FORMATTER'});}}}),{code:'OWN_FORMATTER'});
 assert.deepEqual(pins(g.store),gp);
 const original=f.store.lease;
 f.store.lease=function(ref,...args){const meta=this.json(ref.id);if(meta.kind==='text')throw Object.assign(new Error('publish'),{code:'OWN_PUBLICATION'});return original.call(this,ref,...args);};
 try{await assert.rejects(f.doc('prompt'),{code:'OWN_PUBLICATION'});}finally{f.store.lease=original;}
 assert.deepEqual(pins(f.store),baseline);semanticsComplete=true;
});

semantic('hidden Goal interval, docs/read nested tool filters and physical canonical source IDs preserve native oracle',async t=>{
 const f=await fixture(t,[user('first'),answer('first answer'),end(),
  user('<codex_internal_context source="goal">Continue this goal.</codex_internal_context>'),answer('continued answer'),end(),
  user('last'),call('docs','mcp__knowledge__docs_search',{query:'fixture only'}),output('docs','docs response'),
  call('nested','exec',{input:'const result = await tools.exec_command({cmd:"cat /owned/fixture.txt"}); text(result);'}),output('nested','read details'),
  answer('last answer'),end()]);
 assert.equal(f.canonical.entries.length,3);assert.equal(f.logical.entries.length,2);
 const native=api.buildCodexRangeExport(f.located,f.id,f.dir,{},f.native()[0].uuid,f.native()[2].uuid);
 assert.equal(contents(await f.doc('range',{logicalStart:0,logicalEnd:1})),native.content);oracleComparisons++;
 const opts={includeReading:true,includeMcp:true,includeThinking:true};
 const detailed=api.buildCodexRangeExport(f.located,f.id,f.dir,opts,f.native()[0].uuid,f.native()[2].uuid);
 assert.equal(contents(await f.doc('range',{logicalStart:0,logicalEnd:1,copyOptions:opts})),detailed.content);oracleComparisons++;
 const g=await fixture(t,[{...user('physical'),__physicalSessionId:'physical-owned'},
  {...answer(special.repeat(230)),__physicalSessionId:'physical-owned'},end()]);
 await compare(g,0,0);assert.equal(contents(await g.doc('full')),special.repeat(230));
});

semantic('in-flight parent release, missing source proof and empty-copy refuse without leaking or reopening a file',async t=>{
 const f=await fixture(t,[user('parent'),answer(special.repeat(230)),end()]);let released=false;
 const doc=await f.doc('turn',{control:{assertCurrent(){},async checkpoint(){
  if(!released){released=true;f.canonical.release();f.logical.release();f.owner.evict(f.id,f.dir);}
  await control.checkpoint();
 }}});
 assert(released);assert.match(contents(doc),/parent/);
 const g=await fixture(t,[user('empty'),answer('answer'),end()]),baseline=pins(g.store);
 await assert.rejects(g.doc('turn',{copyOptions:{includeUser:false,includeClaude:false}}),{code:'TIMELINE_DOCUMENT_NO_COPYABLE_CONTENT'});
 assert.deepEqual(pins(g.store),baseline);
 const a=new HistoryProjectionArena(g.store,g.canonical.checkpoint);let cp;
 try{a.step(()=>{a.state().sourceProof.length=1;});cp=g.hold(a.checkpoint());}finally{a.close();}
 const bad={...g.canonical,checkpoint:cp};
 await assert.rejects(prepare({store:g.store,canonicalTimeline:bad,logicalRoot:g.logical,action:'full',logicalRank:0,control}),{code:'codex_root_source_proof_missing'});
 const blank=await fixture(t,[user('   '),end()]);
 const empty=await compare(blank,0,0);assert.equal(contents(empty).trim().split('\n').length,3);
});

test('work-bound evidence follows semantics; no native N collection or whole Root capture claimed',()=>{
 assert(semanticsComplete);assert.equal(semanticPasses,semanticCases);assert.equal(cleanupFailures,0);assert.equal(dirs.size,0);assert(oracleComparisons>=18);
 const source=fs.readFileSync(path.join(__dirname,'timeline-root-documents.js'),'utf8');
 assert(!/new (Map|Set)|\.capture\(|readFile|createReadStream|fs\.open|wholeTimeline\(/.test(source));
 const result={semanticsComplete,semanticCases,semanticPasses,cleanupFailures,oracleComparisons,heapLimit:v8.getHeapStatistics().heap_size_limit,peakHeap,peakFixture,
  adapter:'explicit node:sqlite DatabaseSync',scope:'finite SOURCE only',body:'paged selected packet; OPEN final renderer/clipboard joins',nativeUI:false,globalMemoryBounded:false};
 fs.writeFileSync(path.join(evidence,'RESULT.json'),JSON.stringify(result,null,2)+'\n');
});
