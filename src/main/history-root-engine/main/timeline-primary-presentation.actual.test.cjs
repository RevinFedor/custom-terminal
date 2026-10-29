'use strict';
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const evidence=process.env.NOTED_TIMELINE_INTEGRATION_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'owned finite evidence directory');
const SQLiteAdapter=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
class SQLite extends SQLiteAdapter{constructor(filename,options){super(filename,options);this.name=filename;}}
const load=Module._load;Module._load=function(id,parent,main){return id==='better-sqlite3'?SQLite:load.call(this,id,parent,main);};
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {CodexRootProjectionOwner}=require('./codex-root-projection-owner');
const {createPrimaryTimelinePresentation:prepare}=require('./timeline-primary-presentation');
const {HistoryRootController}=require('./history-root-controller');
const {HistoryPreparedCache}=require('./history-prepared-cache');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createTimelineLogicalRoot}=require('./timeline-root-logical');
const {createPrimaryTimelineViewPresentation,forkPrimaryTimelineViewPresentation}=require('./timeline-primary-view-presentation');
const {forkFrozenCanonical}=require('./history-frozen-canonical');
const {prepareTimelineRootDocument}=require('./timeline-root-documents');
const workingFileSchema=require('./timeline-working-file-version-schema');
const Manager=require('./database'),api=require('./ipc/codex-data')._api;
const {decorateHistoryPromptPresentations:decorate}=require('./history-prompt-presentations');
const sha=s=>crypto.createHash('sha256').update(s,'utf16le').digest('hex');
const noop={assertCurrent(){},async checkpoint(){}};
function fixture(t,count=2){
 const dir=fs.mkdtempSync(path.join(evidence,'fixture-')),id=crypto.randomUUID(),file=path.join(dir,'rollout-'+id+'.jsonl');
 const db=new SQLite(path.join(dir,'db.sqlite')),manager=new Manager({existingConnection:db});manager.initTables();
 db.exec(workingFileSchema.FILE_TABLE_DDL);workingFileSchema.installTimelineWorkingFileVersions(db);
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:16*1024**2});
 const owner=new CodexRootProjectionOwner(store,{namespace:api.CODEX_ROOT_TIMELINE_NAMESPACE,checkpointEvery:2});
 const body='real Ω🙂\r\n\0\ud800'+('long full input '.repeat(100));
 const records=[{type:'session_meta',payload:{id,cwd:dir}}];let at=0,line=0;
 for(let n=0;n<count;n++)records.push(
  {type:'event_msg',timestamp:'2026-10-25T00:00:'+String(n%60).padStart(2,'0')+'Z',payload:{type:'user_message',message:body+n}},
  {type:'response_item',timestamp:'2026-10-25T00:01:'+String(n%60).padStart(2,'0')+'Z',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:body+' answer '+n}]}});
 const located=records.map(r=>{const x={...r,__line:line++,__byteOffset:at};at+=Buffer.byteLength(JSON.stringify(r)+'\n');return x;});
 fs.writeFileSync(file,records.map(r=>JSON.stringify(r)+'\n').join(''));
 const service={promptPresentationStore:manager,codexData:{_api:api}};
 const payload={toolType:'codex',sessionId:id,cwd:dir,tabId:'OWN',readProfile:'timeline-primary-v1'};
 const holds=new Set(),finalizers=[];const keep=x=>(holds.add(x),x);
 const project=opts=>api.projectCodexRootTimelineFromFile(id,dir,{rootedOwner:owner,sessionsDir:dir,highWaterMark:64,...opts});
 const oracle=()=>{const p=api.createCodexTimelineProjector(id);located.forEach(p.feed);return decorate(manager,{toolType:'codex',sessionId:id,entries:p.finalize()});};
 const metadataOracle=()=>{const p=api.createCodexTimelineProjector(id);located.forEach(p.feed);p.finalize();return p.getSessionMeta();};
 t.after(async()=>{try{for(let i=finalizers.length-1;i>=0;i--)await finalizers[i]();for(const x of holds)x.release();owner.close();api.invalidateJsonlCache(file);
  assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);}
  finally{store.close();db.close();fs.rmSync(dir,{recursive:true});}});
 return{dir,id,file,db,manager,store,owner,body,service,payload,project,oracle,metadataOracle,keep,finalizers};
}
test('actual Timeline FILE prompt preparation equals complete native Timeline+decorator and retained frozen contents',async t=>{
 const f=fixture(t),canonical=f.keep(await f.project()),user=mat(canonical.entries)[0];
 f.manager.saveHistoryPromptPresentation({toolType:'codex',sessionId:f.id,auditTimestamp:user.timestamp,
  transportHash:'owned',entryUuid:user.uuid,chips:[{kind:'prompt',id:'P',label:'full Ω',text:'chip\r\n\0\ud800'}]});
 const p=f.keep(await prepare(f.store,canonical,{service:f.service,payload:f.payload,control:noop}));
 const actual=mat(p.entries);assert.deepEqual(actual,f.oracle());assert.equal(p.readProfile,'timeline-primary-v1');
 assert.equal(p.semanticSnapshotComplete,true);assert.match(p.semanticRevisionToken,/^[a-f0-9]{64}$/);
 assert.equal(sha(actual[0].content),sha(f.oracle()[0].content));assert.equal(p.timelinePreparation.wholeTimelineDTOs,0);
 assert.equal(p.timelinePreparation.globalMemoryBounded,false);assert.equal(p.timelinePreparation.maxNativePromptRows,1);
 const original=structuredClone(actual);f.manager.saveHistoryPromptPresentation({toolType:'codex',sessionId:f.id,auditTimestamp:user.timestamp,
  transportHash:'owned',entryUuid:user.uuid,chips:[{kind:'prompt',id:'P',label:'NEW',text:'new'}]});
 const nextRaw=f.keep(await f.project()),next=f.keep(await prepare(f.store,nextRaw,{service:f.service,payload:f.payload,control:noop}));
 assert.deepEqual(mat(next.entries),f.oracle());assert.notEqual(next.semanticRevisionToken,p.semanticRevisionToken);
 assert.deepEqual(mat(p.entries),original);next.release();p.release();canonical.release();
});
test('Timeline preparation cancellation/source refusal releases provisional owners and preserves the old root',async t=>{
 const f=fixture(t,33),raw=f.keep(await f.project()),baseline=f.store.stats().leases;
 let stepped=0;const control={assertCurrent(){if(stepped)throw Object.assign(Error('owned cancel'),{code:'HISTORY_READ_CANCELLED'});},async checkpoint(){stepped++;}};
 await assert.rejects(prepare(f.store,raw,{service:f.service,payload:f.payload,control}),e=>e.code==='HISTORY_READ_CANCELLED');
 assert.equal(f.store.stats().leases,baseline);assert.equal(mat(raw.entries).length,f.oracle().length);
 fs.appendFileSync(f.file,JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'appended'}})+'\n');
 await assert.rejects(prepare(f.store,raw,{service:f.service,payload:f.payload,control:noop}),e=>e.code==='CODEX_SOURCE_READ_INVALIDATED');
 assert.equal(f.store.stats().leases,baseline);raw.release();
});
test('Timeline stable namespace refuses old parser schema continuation and rebuilds exact contents',async t=>{
 const f=fixture(t),a=f.keep(await f.project({projectionSchema:'source-A'}));
 const same=f.keep(await f.project({projectionSchema:'source-A'}));assert.equal(same.mode,'unchanged');
 const refused=await f.project({projectionSchema:'source-B',cacheOnly:true});assert.equal(refused.success,false);assert.equal(refused.error,'cached_projection_unavailable');
 const b=f.keep(await f.project({projectionSchema:'source-B'}));assert.equal(b.mode,'rebuild');assert.deepEqual(mat(b.entries),f.oracle());
 assert.deepEqual(mat(a.entries),mat(same.entries));for(const x of [a,same,b])x.release();
});
test('actual controller signs rooted Timeline profile, shares cache admission with History and preserves independent frozen roots',async t=>{
 const f=fixture(t);Object.assign(f.service,{ensureCodexProviderForkLineage:async()=>({success:true,required:false}),
  _resolveCodexLineage:()=>({kind:'physical'})});
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'timeline-integration'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'timeline-source-v1',
  sourceOptions:{sessionsDir:f.dir,highWaterMark:64},maxCachedOwners:1,
  prepareTimelineResult:(canonical,payload,control)=>prepare(f.store,canonical,{service:f.service,payload,control})});
 f.finalizers.push(()=>ctl.close());
 const consumerKey='timeline-fixture';const call=(method,extra={})=>ctl.dispatch(method,
  {...f.payload,_historyRootConsumerKey:consumerKey,...extra},{control:noop});
 const cap=await call('openHistoryRoot');assert(cap.success);assert.equal(cap.readProfile,'timeline-primary-v1');
 assert.equal(cap.semanticSnapshotComplete,true);assert.equal(cap.readMetrics.canonicalRows,0);
 assert.equal(cap.totalEntries,f.oracle().length);assert.equal(cap.semanticRevisionToken,cap.revision);
 const state=ctl.plane.state(cap,consumerKey),before=mat(ctl.plane.cursor(state,cap.root.nodeToken));
 assert.deepEqual(before,f.oracle());assert.equal(state.canonicalSource.representation,'codex-timeline-root-v1');
 const meta=mat(ctl.plane.cursor(state,cap.sessionMeta.nodeToken));assert.deepEqual(meta,f.metadataOracle());
 const page=await call('readHistoryRootPage',{...cap.root,kind:'range',offset:0,limit:1,creditBytes:4096});
 assert.equal(page.items.length,1);assert.equal(page.items[0].ordinal,0);assert(page.items[0].value.nodeToken);
 const found=await call('readHistoryRootPage',{...cap.root,kind:'find',field:'uuid',value:before[0].uuid,offset:0,limit:1,creditBytes:4096});
 assert.equal(found.items.length,1);assert.equal(found.items[0].ordinal,0);
 const content=ctl.plane.cursor(state,cap.root.nodeToken).at(0).field('content');
 const full=await call('forkHistoryRootLeaf',ctl.plane.describe(state,content,{inline:false}));
 await assert.rejects(call('readHistoryRootPage',{...cap.root,ownerKey:'foreign',kind:'range',offset:0,limit:1,creditBytes:4096}),e=>e.code==='HISTORY_ROOT_OWNER_MISMATCH');
 const history=await call('openHistoryRoot',{readProfile:undefined});assert(history.success);assert.equal(history.readMetrics.timelineRows,0);
 assert.equal(ctl.store.db.prepare('SELECT count(*) n FROM hp_root_cache_owners').get().n,1,'aggregate History+Timeline owner cap');
 assert.deepEqual(mat(ctl.plane.cursor(state,cap.root.nodeToken)),before,'History eviction cannot close a frozen Timeline view');
 await call('releaseHistoryRoot',history);await call('releaseHistoryRoot',cap);
 let text='',offset=0;
 for(;;){const p=await call('readHistoryRootPage',{...full.payloadDocument,kind:'leaf',offset,limit:512,creditBytes:4096});
  text+=p.text;if(p.done)break;offset=p.nextOffset;}
 assert.equal(text,before[0].content);assert.equal(sha(text),sha(before[0].content));
 await call('releaseHistoryRoot',full);
 assert.equal(ctl.plane.roots.size,0);assert.equal(ctl.store.stats().leases,0);
});
test('actual producer/controller/signed plane/renderer transport/client/model returns bounded full Timeline windows and indexed navigation',async t=>{
 const f=fixture(t,5);Object.assign(f.service,{ensureCodexProviderForkLineage:async()=>({success:true,required:false}),_resolveCodexLineage:()=>({kind:'physical'})});
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'timeline-client-integration'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'timeline-client-source',sourceOptions:{sessionsDir:f.dir},
  prepareTimelineResult:(canonical,payload,control)=>prepare(f.store,canonical,{service:f.service,payload,control})});
 f.finalizers.push(()=>ctl.close());
 const consumerKey='timeline-model-integration',calls=[];
 const methods={'agent-transcript:get-timeline':'openHistoryRoot','agent-transcript:read-page':'readHistoryRootPage',
  'agent-transcript:fork-read-leaf':'forkHistoryRootLeaf','agent-transcript:release-read-root':'releaseHistoryRoot'};
 const invoke=async(channel,payload)=>{calls.push(channel);if(channel==='agent-transcript:cancel-read')return {success:true};
  assert(methods[channel],channel);return ctl.dispatch(methods[channel],{...payload,_historyRootConsumerKey:consumerKey},{control:noop});};
 const {TimelineRootReadModel}=await import('../../../renderer/utils/timelineRootReadModel.mjs');
 const transport=await import('../../../renderer/utils/historyReadTransport.mjs');
 const model=new TimelineRootReadModel(invoke,transport,{creditBytes:3072,maxWindowRows:2});
 try{
  model.noteRange(0,0);await model.open(f.payload);
  const expected=f.oracle();assert.equal(model.totalCount,expected.length);assert.deepEqual(model.entryAt(0),expected[0]);
  assert.equal(sha(model.entryAt(0).content),sha(expected[0].content));assert.equal(model.snapshot().entries.length,1);assert.equal(model.entryAt(1),undefined);
  const found=await model.findUUID(expected[4].uuid);assert.equal(found.index,4);assert.equal(found.header,model.header);
  await model.readWindow(3,3);assert.deepEqual(model.entryAt(3),expected[3]);assert.equal(model.entryAt(0),undefined);
  const cost=calls.length;await model.readWindow(3,3);assert.equal(calls.length,cost,'covered real signed demand has no RPC');
  const old=model.snapshot(),user=expected[0];
  f.manager.saveHistoryPromptPresentation({toolType:'codex',sessionId:f.id,auditTimestamp:user.timestamp,transportHash:'client-owned',entryUuid:user.uuid,
   chips:[{kind:'prompt',id:'new-chip',label:'same UUID changed presentation',text:'full Ω\r\n\0\ud800'}]});
  model.noteRange(0,0);await model.open(f.payload);assert.deepEqual(model.entryAt(0),f.oracle()[0]);
  assert.notEqual(model.header.revision,old.header.revision);assert.deepEqual(old.entries[0],expected[3]);
  const state=ctl.plane.state(model.header,consumerKey),fullCursor=state.indexes.entries.at(0).field('content');
  const document=await model.view.reader.forkText(ctl.plane.describe(state,fullCursor,{inline:false}));
  await model.close();let text='';for await(const part of document.chunks())text+=part;await document.close();
  assert.equal(text,f.oracle()[0].content);assert.equal(sha(text),sha(f.oracle()[0].content));
  assert.equal(ctl.plane.roots.size,0);assert.equal(ctl.store.stats().leases,0);
 }finally{await model.close();}
});
test('ordinary Timeline view client and model consume the real signed view and independent document',async t=>{
 const f=fixture(t,5);Object.assign(f.service,{ensureCodexProviderForkLineage:async()=>{throw Error('legacy recovery forbidden on negotiated root');},
  _resolveCodexLineage:()=>{throw Error('native all-event lineage forbidden on negotiated root');}});
 const prompt=f.oracle()[0];f.manager.saveHistoryPromptPresentation({toolType:'codex',sessionId:f.id,auditTimestamp:prompt.timestamp,
  transportHash:'owned-images',entryUuid:prompt.uuid,chips:[{kind:'image-ref',id:1,path:'/owned/Ω🙂.png',assetId:'OWN-ASSET',availability:'available'},
   {kind:'image-ref',id:2,availability:'missing',error:'owned-asset-missing'}]});
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'timeline-ordinary-model'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'timeline-ordinary-model',sourceOptions:{sessionsDir:f.dir},
  prepareTimelineViewResult:(canonical,payload,control)=>createPrimaryTimelineViewPresentation(f.store,canonical,{service:f.service,payload,control}),
  forkTimelineViewResult:(parent,payload,control,raw)=>forkPrimaryTimelineViewPresentation(f.store,parent,raw,{payload,control}),
  createTimelineDocument:(parent,request,{control})=>prepareTimelineRootDocument({store:f.store,canonicalTimeline:parent.raw,logicalRoot:parent.view.logical,
   action:request.action,logicalRank:request.subject??request.logicalRank,logicalStart:request.logicalStart??request.range?.startSubject,
   logicalEnd:request.logicalEnd??request.range?.endSubject,copyOptions:request.copyOptions||{},control,api})});
 f.finalizers.push(()=>ctl.close());
 const consumerKey='ordinary-timeline-real-view',calls=[],methods={'agent-transcript:get-timeline':'openHistoryRoot',
  'agent-transcript:read-page':'readHistoryRootPage','agent-transcript:fork-read-leaf':'forkHistoryRootLeaf','agent-transcript:release-read-root':'releaseHistoryRoot'};
 const invoke=async(channel,payload)=>{const record={channel,operation:payload?.operation};calls.push(record);
  if(channel==='agent-transcript:cancel-read')return{success:true};assert(methods[channel],channel);
  const reply=await ctl.dispatch(methods[channel],{...payload,_historyRootConsumerKey:consumerKey},{control:noop});
  if(channel==='agent-transcript:get-timeline')record.metrics=reply.readMetrics;return reply;};
 const {TimelineViewReadModel}=await import('../../../renderer/utils/timelineViewReadModel.mjs');
 const model=new TimelineViewReadModel(invoke);f.finalizers.push(()=>model.close());
 await model.requestWindow({offset:0,extent:120,overscan:0,bottom:false});
 await model.refresh({...f.payload,timelineViewOptions:{width:320,viewportExtent:491,layoutFingerprint:'real-model-finite'}},'source');
 const first=model.snapshot(),expected=f.oracle();assert(first&&!first.error);assert.equal(first.header.logicalEntryCount,5);
 assert(first.window.items.length>0&&first.window.items.length<5);
 for(const item of first.window.items)assert.deepEqual(item.subject.entry,expected[item.header.logicalRank]);
 await model.requestWindow({offset:390,extent:100,overscan:0,bottom:false});
 const last=model.snapshot();assert(last.window.items.some(item=>item.header.logicalRank===4));
 const selected=await last.client.row(0);assert.deepEqual(selected.entry,expected[0]);
 assert.equal(selected.entry.imagePaths.length,2);assert.equal(selected.entry.imagePaths[1].availability,'missing');
 assert.equal(selected.entry.imagePaths[1].error,'owned-asset-missing');
 const range=await last.client.query('range',{start:0,end:4});assert.equal(range.count,5);assert.equal(range.startUuid,expected[0].uuid);
 const document=await last.client.document({action:'prompt',subject:selected.subject});
 assert.equal(typeof document,'string');assert.equal(sha(document),sha(expected[0].content));
 const prior=last.header;
 await model.refresh({...f.payload,timelinePresentation:{revision:0,sentHandoffs:[],liveEntries:[],noteAnchors:[]},
  timelineViewOptions:{width:320,viewportExtent:491,layoutFingerprint:'real-model-view-change'}},'view');
 const afterView=model.snapshot();assert.equal(afterView.header.semanticRevisionToken,prior.semanticRevisionToken);
 assert.equal(afterView.header.timelinePresentationIdentity,prior.timelinePresentationIdentity);assert.notEqual(afterView.header.leaseId,prior.leaseId);
 assert.equal(calls.filter(c=>c.channel==='agent-transcript:get-timeline').at(-1).metrics.timelineSemanticPreparations,0);
 await model.close();assert.equal(ctl.plane.roots.size,0);assert.equal(ctl.store.stats().leases,0);
 assert.equal(calls.filter(c=>c.channel==='agent-transcript:get-timeline').length,2,'one source + one view; scroll did not open or reprepare the source');
});

test('paged search actual controller/client preserves matches and authenticated Timeline marker facts',async t=>{
 const f=fixture(t,2),cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'paged-search-wire'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'paged-search-wire',sourceOptions:{sessionsDir:f.dir},
  prepareTimelineViewResult:(root,payload,control)=>createPrimaryTimelineViewPresentation(f.store,root,{service:f.service,payload,control})});
 f.finalizers.push(()=>ctl.close());const consumer='paged-search-actual',methods={'agent-transcript:search-history':'openHistoryRoot',
  'agent-transcript:read-page':'readHistoryRootPage','agent-transcript:fork-read-leaf':'forkHistoryRootLeaf','agent-transcript:release-read-root':'releaseHistoryRoot'};
 const invoke=(channel,payload)=>{if(channel==='agent-transcript:cancel-read')return{success:true};assert(methods[channel]);
  return ctl.dispatch(methods[channel],{...payload,_historyRootConsumerKey:consumer},{control:noop});};
 const {openHistoryPagedSearch}=await import('../../../renderer/utils/historyPagedSearchClient.mjs');
 const options={query:'long',type:'all',offset:1,limit:3},result=await openHistoryPagedSearch(invoke,{...f.payload,...options});
 f.finalizers.push(()=>result.searchClient.close());
 const state=ctl.plane.state(result,consumer),rows=mat(state.searchPresentation.frozen.entries),
  expected=require('../shared/history-search.cjs').searchHistoryEntries(rows,options);
 assert.deepEqual(result.matches,expected.matches);assert.equal(result.total,expected.total);assert.equal(result.entryTotal,expected.entryTotal);
 assert.equal(result.turnKeys,undefined);assert.equal(result.entryUuids,undefined);assert(state.searchPresentation.hasTurnKey(expected.turnKeys[0]));
 const ids=rows.slice(0,3).map(row=>row.uuid),flags=await result.searchClient.entryFlags(ids);
 assert.deepEqual(flags,ids.map(entryUuid=>({entryUuid,match:expected.entryUuids.includes(entryUuid)})));
 const timeline=await ctl.dispatch('openHistoryRoot',{...f.payload,readProfile:'timeline-view-v1',_historyRootConsumerKey:consumer,
  timelineViewOptions:{viewportExtent:491,width:320,layoutFingerprint:'search-native'}},{control:noop});
 const markers=await ctl.dispatch('readHistoryRootPage',{...timeline.root,_historyRootConsumerKey:consumer,
  kind:'timeline-query',operation:'search-markers',searchRootLease:result.searchClient.identity,logicalRank:0,currentMatchIndex:1,creditBytes:16384},{control:noop});
 assert.equal(markers.coverage,'exact-source');assert.equal(markers.flags.match,true);assert.equal(markers.flags.current,true);
 fs.appendFileSync(f.file,JSON.stringify({type:'response_item',timestamp:'2026-10-25T02:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'new complete appended prompt'}]}})+'\n');
 const appended=await ctl.dispatch('openHistoryRoot',{...f.payload,readProfile:'timeline-view-v1',_historyRootConsumerKey:consumer,
  timelineViewOptions:{viewportExtent:491,width:320,layoutFingerprint:'appended-search'}},{control:noop});
 const prefix=await ctl.dispatch('readHistoryRootPage',{...appended.root,_historyRootConsumerKey:consumer,kind:'timeline-query',
  operation:'search-markers',searchRootLease:result.searchClient.identity,logicalRank:0,currentMatchIndex:1,creditBytes:16384},{control:noop});
 assert.equal(prefix.coverage,'source-prefix');assert.equal(prefix.flags.match,true,'complete immutable prefix proves membership across append');
 await ctl.dispatch('releaseHistoryRoot',{...appended,_historyRootConsumerKey:consumer},{control:noop});
 fs.writeFileSync(f.file,fs.readFileSync(f.file,'utf8').replace('real Ω','fake Ω'));
 const rewritten=await ctl.dispatch('openHistoryRoot',{...f.payload,readProfile:'timeline-view-v1',_historyRootConsumerKey:consumer,
  timelineViewOptions:{viewportExtent:491,width:320,layoutFingerprint:'rewritten-search'}},{control:noop});
 const mismatch=await ctl.dispatch('readHistoryRootPage',{...rewritten.root,_historyRootConsumerKey:consumer,kind:'timeline-query',
  operation:'search-markers',searchRootLease:result.searchClient.identity,logicalRank:0,currentMatchIndex:1,creditBytes:16384},{control:noop});
 assert.equal(mismatch.coverage,'source-mismatch');assert.equal(mismatch.flags,null,'same UUID/count does not relabel old search as a new source');
 await ctl.dispatch('releaseHistoryRoot',{...rewritten,_historyRootConsumerKey:consumer},{control:noop});
 await assert.rejects(ctl.dispatch('readHistoryRootPage',{...timeline.root,_historyRootConsumerKey:consumer,
  kind:'timeline-query',operation:'search-markers',searchRootLease:{...result.searchClient.identity,ownerKey:'wrong'},logicalRank:0,creditBytes:16384},{control:noop}),/OWNER_MISMATCH/);
 await ctl.dispatch('releaseHistoryRoot',{...timeline,_historyRootConsumerKey:consumer},{control:noop});
 await result.searchClient.close();assert.equal(ctl.plane.roots.size,0);assert.equal(ctl.store.stats().leases,0);
});

test('physical root classification ignores unrelated UI commits while guarding actual lineage changes',async t=>{
 const f=fixture(t,2),foreign=new SQLite(f.dir+'/db.sqlite');f.finalizers.push(()=>foreign.close());
 foreign.exec('CREATE TABLE ordinary_ui_state (key TEXT PRIMARY KEY,value TEXT)');
 let afterRead=()=>foreign.prepare('INSERT OR REPLACE INTO ordinary_ui_state VALUES(?,?)').run('window','saved');
 const scopedApi={...api,projectCodexFullHistoryFromFile:async(...args)=>{const result=await api.projectCodexFullHistoryFromFile(...args);afterRead();return result;}};
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'physical-scope-commits'});
 const ctl=new HistoryRootController({cache,service:f.service,api:scopedApi,Database:SQLite,store:f.store,sourceSchema:'physical-scope-commits',sourceOptions:{sessionsDir:f.dir}});
 f.finalizers.push(()=>ctl.close());const payload={...f.payload,readProfile:undefined,_historyRootConsumerKey:'ui-commit-root'};
 const root=await ctl.dispatch('openHistoryRoot',payload,{control:noop});assert(root.success,'unrelated Main commit cannot invalidate physical metadata');
 await ctl.dispatch('releaseHistoryRoot',{...root,_historyRootConsumerKey:payload._historyRootConsumerKey},{control:noop});
 afterRead=()=>foreign.prepare("INSERT INTO session_history_events(event_key,event_type,provider,session_id,source_session_id,child_session_id,fork_mode,is_direct,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .run('new-exact-lineage','fork','codex',f.id,'parent',f.id,'raw',1,123);
 await assert.rejects(ctl.dispatch('openHistoryRoot',payload,{control:noop}),/LINEAGE_CHANGED/);
 assert.equal(ctl.plane.roots.size,0);
});

test('actual public Timeline composition input preserves handoffs, live replacement, note anchors and working paths',async t=>{
 const f=fixture(t,2),canonical=f.oracle(),tag={kind:'prompt-origin',source:'terminal-mcp'};
 f.db.prepare('INSERT INTO tab_context_files(tab_id,path) VALUES(?,?)').run('OWN','src/live.ts');
 const pending={uuid:'pending-carrier',sessionId:f.id,sourceIdentity:'exact-live-source',type:'user',content:'first full live Ω\r\n\0\ud800',
  timestamp:'2026-10-25T01:00:00Z',handoffId:'pending',isSentHandoffProjection:true,semanticTags:[tag],fileEdits:['src/live.ts']};
 const input={revision:1,sentHandoffs:[{...canonical[0],handoffId:'canonical-receipt',isSentHandoffProjection:true,semanticTags:[tag]},pending],
  liveEntries:[{...pending,isSentHandoffProjection:undefined,isLiveUserProjection:true,semanticTags:undefined,content:'latest exact result Ω\r\n\0\ud800'}],
  noteAnchors:[{uuid:'canonical-note-address',sessionId:f.id,sourceIdentity:'exact-live-source'}]};
 const {mergeTimelineEntriesWithSentHandoffs}=await import('../../../renderer/utils/timelineTranscriptRefresh.mjs'),
  {projectTimelineNoteAnchors}=await import('../../../renderer/utils/timelineNoteIdentity.mjs'),
  {projectTimelineWorkingFileMarkers}=await import('../../../renderer/utils/timelineWorkingFileMarkers.mjs');
 const expected=value=>projectTimelineWorkingFileMarkers(projectTimelineNoteAnchors(
  mergeTimelineEntriesWithSentHandoffs(canonical,value.sentHandoffs,value.liveEntries),value.noteAnchors),[{path:'src/live.ts'}],f.dir,path);
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'timeline-composition-wire'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'timeline-composition-wire',sourceOptions:{sessionsDir:f.dir},
  prepareTimelineViewResult:(root,payload,control)=>createPrimaryTimelineViewPresentation(f.store,root,{service:f.service,payload,control}),
  forkTimelineViewResult:(parent,payload,control,raw)=>forkPrimaryTimelineViewPresentation(f.store,parent,raw,{payload,control})});
 f.finalizers.push(()=>ctl.close());const consumer='timeline-composition',payload={...f.payload,readProfile:'timeline-view-v1',_historyRootConsumerKey:consumer,
  timelinePresentation:input,timelineViewOptions:{viewportExtent:491,width:320,layoutFingerprint:'finite-composition'}};
 const a=await ctl.dispatch('openHistoryRoot',payload,{control:noop}),state=ctl.plane.state(a,consumer);
 assert(a.success);assert.equal(a.timelinePresentationRevision,1);assert.match(a.timelinePresentationIdentity,/^[a-f0-9]{64}$/);
 assert.deepEqual(mat(state.timelinePresentation.view.logical.entries),expected(input));assert.equal(a.logicalEntryCount,3);
 const before=mat(state.timelinePresentation.view.logical.entries),parent={leaseId:a.leaseId,ownerKey:a.ownerKey,revision:a.revision,generation:a.generation};
 const changed={...input,revision:2,liveEntries:[{...input.liveEntries[0],content:'same ID new exact result Ω\r\n\0\ud800'}]};
 const miss=await ctl.dispatch('openHistoryRoot',{...payload,timelineReadClass:'view',timelineParentLease:parent,timelinePresentation:changed},{control:noop});
 assert.equal(miss.success,false);assert.equal(miss.requiredClass,'metadata');assert.equal(miss.reason,'presentation-input-changed');
 const b=await ctl.dispatch('openHistoryRoot',{...payload,timelineReadClass:'metadata',timelineParentLease:parent,timelinePresentation:changed},{control:noop});
 assert(b.success);assert.equal(b.timelinePresentationRevision,2);assert.notEqual(b.timelinePresentationIdentity,a.timelinePresentationIdentity);
 assert.notEqual(b.semanticRevisionToken,a.semanticRevisionToken);assert.deepEqual(mat(ctl.plane.state(b,consumer).timelinePresentation.view.logical.entries),expected(changed));
 assert.deepEqual(mat(state.timelinePresentation.view.logical.entries),before,'older bundle remains frozen after same-ID live replacement');
 await ctl.dispatch('releaseHistoryRoot',{...a,_historyRootConsumerKey:consumer},{control:noop});
 await ctl.dispatch('releaseHistoryRoot',{...b,_historyRootConsumerKey:consumer},{control:noop});assert.equal(ctl.plane.roots.size,0);
});

test('reader-owned logical Timeline equals existing canonical/handoff/live/note/working/goal composition with exact aliases and range facts',async t=>{
 const f=fixture(t,5),raw=f.keep(await f.project()),prepared=f.keep(await prepare(f.store,raw,{service:f.service,payload:f.payload,control:noop}));
 const canonical=f.oracle(),tag={kind:'prompt-origin',source:'terminal-mcp'};
 const handoffs=[{...canonical[0],handoffId:'already',isSentHandoffProjection:true,semanticTags:[tag]},
  {uuid:'stale',sessionId:f.id,sourceIdentity:'source-stale',type:'user',content:'already passed',handoffId:'stale',isSentHandoffProjection:true,timestamp:'2026-10-24T00:00:00Z'},
  {uuid:'live-before-note',sessionId:f.id,sourceIdentity:'source-live',type:'user',content:'full live Ω\r\n\0\ud800',handoffId:'pending',isSentHandoffProjection:true,
   semanticTags:[tag],timestamp:'2026-10-25T00:05:00Z'}];
 const live=[{...handoffs[2],semanticTags:undefined,isSentHandoffProjection:undefined,isLiveUserProjection:true,content:'latest complete live Ω\r\n\0\ud800'}];
 const noteAnchors=[{uuid:'saved-note-uuid',sessionId:f.id,sourceIdentity:'source-live'}];
 const files=[{path:'src/owned.ts'}],p=new HistoryProjectionArena(f.store);let presentation;
 try{presentation=p.step(()=>p.publish({sentHandoffs:handoffs,liveEntries:live,noteAnchors,workingFiles:files}));}finally{p.close();}
 f.keep(presentation);
 const {mergeTimelineEntriesWithSentHandoffs}=await import('../../../renderer/utils/timelineTranscriptRefresh.mjs');
 const {projectTimelineNoteAnchors}=await import('../../../renderer/utils/timelineNoteIdentity.mjs');
 const {projectTimelineWorkingFileMarkers}=await import('../../../renderer/utils/timelineWorkingFileMarkers.mjs');
 const {filterTimelineGoalPresentation}=await import('../../../renderer/utils/codexGoalPresentation.mjs');
 const expected=filterTimelineGoalPresentation(projectTimelineWorkingFileMarkers(projectTimelineNoteAnchors(
  mergeTimelineEntriesWithSentHandoffs(canonical,handoffs,live),noteAnchors),files,f.dir,path),'codex');
 const view=await createTimelineLogicalRoot(f.store,prepared,{presentationRoot:presentation,cwd:f.dir,control:noop});
 try{assert.deepEqual(mat(view.entries),expected);assert.equal(view.entries.length,6);assert.equal(view.lookup('live-before-note').ordinals[0],5);
  assert.deepEqual(view.lookup('saved-note-uuid',{uuidOnly:true}).ordinals,[5]);assert.equal(view.lookup('source-live').totalMatches,1);
  const range=view.rangeFacts(0,5);assert.equal(range.count,6);assert.equal(range.hasCompact,false);assert.equal(range.hasContinued,false);
  assert.equal(range.startUuid,expected[0].uuid);assert.equal(range.endUuid,'saved-note-uuid');
  assert.equal(view.stats().wholeTimelineDTOs,0);assert.equal(view.stats().ownership.nativeRows,0);assert.equal(view.stats().ownership.nativeMapEntries,0);assert(view.stats().ownership.handleCache<=3);
  const old=mat(view.entries);prepared.release();raw.release();presentation.release();assert.deepEqual(mat(view.entries),old);
 }finally{view.release();}
});
test('composed actual Timeline view/annotations/layout preserves pure-fork ownership after old demand and parent close',async t=>{
 const f=fixture(t,5),raw=f.keep(await f.project());let revoked=false;
 const original={assertCurrent(){if(revoked)throw Object.assign(Error('original closed demand'),{code:'HISTORY_READ_CANCELLED'});},async checkpoint(){}};
 const payload={...f.payload,readProfile:'timeline-view-v1',timelineViewOptions:{viewportExtent:491,width:320,layoutFingerprint:'real-style-A'}};
 const first=f.keep(await createPrimaryTimelineViewPresentation(f.store,raw,{service:f.service,payload,control:original}));
 assert.equal(first.readProfile,'timeline-view-v1');assert.equal(first.timelineViewHeader.logicalEntryCount,5);
 assert.equal(first.timelineViewHeader.visualAtomCount,5);assert.equal(first.entries.length,5);
 assert.equal(first.timelineViewHeader.layoutInfo.count,5);
 assert.deepEqual(mat(first.timelinePresentation.view.logical.entries),f.oracle());
 revoked=true;assert.deepEqual(first.timelinePresentation.freshness(noop),{ok:true},'retained view is not owned by its closed OPEN demand');
 const raw2=f.keep(forkFrozenCanonical(f.store,raw));
 const viewPayload=parent=>({...payload,timelinePresentationIdentity:parent.presentationIdentity});
 const child=await forkPrimaryTimelineViewPresentation(f.store,first.timelinePresentation,raw2,{payload:viewPayload(first.timelinePresentation),control:noop});
 assert.equal(child.kind,'hit');f.keep(child.result);first.release();
 assert.deepEqual(child.result.timelinePresentation.freshness(noop),{ok:true});
 const raw3=f.keep(forkFrozenCanonical(f.store,raw2));let closed=false;
 const control={assertCurrent(){},async checkpoint(){if(!closed){closed=true;child.result.release();}}};
 const grandchild=await forkPrimaryTimelineViewPresentation(f.store,child.result.timelinePresentation,raw3,{payload:viewPayload(child.result.timelinePresentation),control});
 assert(closed,'parent closed during actual asynchronous view rebuild');assert.equal(grandchild.kind,'hit');f.keep(grandchild.result);
 assert.deepEqual(grandchild.result.timelinePresentation.freshness(noop),{ok:true});
 assert.equal(grandchild.result.readMetrics.timelineSemanticPreparations,0);assert.equal(grandchild.result.readMetrics.timelineAnnotationCaptures,0);
 const snapshot=mat(grandchild.result.entries);f.store.db.prepare('ATTACH DATABASE ? AS sidecar').run(f.dir+'/db.sqlite');
 f.store.db.prepare('INSERT INTO sidecar.timeline_notes(entry_uuid,session_id,tab_id,content,position) VALUES(?,?,?,?,?)').run(f.oracle()[0].uuid,f.id,'OWN','new same scope note','before');
 const raw4=f.keep(forkFrozenCanonical(f.store,raw3)),miss=await forkPrimaryTimelineViewPresentation(f.store,grandchild.result.timelinePresentation,raw4,{payload:viewPayload(grandchild.result.timelinePresentation),control:noop});
 assert.equal(miss.kind,'miss');assert.equal(miss.requiredClass,'metadata');assert.deepEqual(mat(grandchild.result.entries),snapshot);
 grandchild.result.release();raw4.release();
});
test('actual signed Timeline queries serve bounded windows, global geometry, off-window facts and pure view admission',async t=>{
 const f=fixture(t,5);Object.assign(f.service,{ensureCodexProviderForkLineage:async()=>({success:true,required:false}),_resolveCodexLineage:()=>({kind:'physical'})});
 const cache=new HistoryPreparedCache({directory:f.dir+'/cache',maxBytes:32*1024**2,schema:'timeline-view-query'});
 const ctl=new HistoryRootController({cache,service:f.service,api,Database:SQLite,store:f.store,sourceSchema:'timeline-view-query',sourceOptions:{sessionsDir:f.dir},
  prepareTimelineViewResult:(canonical,payload,control)=>createPrimaryTimelineViewPresentation(f.store,canonical,{service:f.service,payload,control}),
  forkTimelineViewResult:(parent,payload,control,raw)=>forkPrimaryTimelineViewPresentation(f.store,parent,raw,{payload,control}),
  createTimelineDocument:(parent,request,{control})=>prepareTimelineRootDocument({store:f.store,canonicalTimeline:parent.raw,logicalRoot:parent.view.logical,
   action:request.action,logicalRank:request.subject??request.logicalRank,logicalStart:request.logicalStart,logicalEnd:request.logicalEnd,copyOptions:request.copyOptions||{},control,api})});
 f.finalizers.push(()=>ctl.close());
 const consumerKey='timeline-queries',base={...f.payload,readProfile:'timeline-view-v1',_historyRootConsumerKey:consumerKey,
  timelineViewOptions:{width:320,viewportExtent:491,layoutFingerprint:'measured-query-style'}};
 const call=(method,extra={})=>ctl.dispatch(method,{...base,...extra},{control:noop});
 const cap=await call('openHistoryRoot');assert.equal(cap.readProfile,'timeline-view-v1');assert.equal(cap.timelineViewSchema,1);
 const query=(operation,extra={},root=cap.root)=>call('readHistoryRootPage',{...root,kind:'timeline-query',operation,creditBytes:16384,...extra});
 const outlineItem=await call('readHistoryRootPage',{leaseId:cap.leaseId,ownerKey:cap.ownerKey,revision:cap.revision,generation:cap.generation,
  timelineParentLease:{leaseId:cap.leaseId,ownerKey:cap.ownerKey,revision:cap.revision,generation:cap.generation},
  kind:'timeline-query',operation:'outline-item',offset:0,creditBytes:16384});
 assert.equal(outlineItem.logicalRank,0);assert.equal(outlineItem.total,5);assert.equal(outlineItem.entry.kind,'object');
 const terminal=await query('terminal-navigation',{logicalRank:4});assert.equal(terminal.terminalNavigation.logicalRank,4);
 assert.equal(terminal.terminalNavigation.logicalRevision,cap.logicalRevisionToken);assert(terminal.terminalNavigation.searchLines.length<=3);
 const window=await query('window',{startOrdinal:0,limit:3});assert.equal(window.items.length,3);assert.equal(window.nextOrdinal,3);
 assert.equal(window.creditBytesUsed,Buffer.byteLength(JSON.stringify(window)));assert(window.creditBytesUsed<=16384);
 assert.equal(window.items[0].geometry.start,0);assert.equal(window.layoutInfo.totalExtent,491);
 const target=await query('resolve',{uuid:f.oracle()[4].uuid});assert.equal(target.resolved.logicalRank,4);assert.equal(target.resolved.canonicalOrdinal,4);
 const row=await query('row',{logicalRank:4}),state=ctl.plane.state(cap,consumerKey);assert.deepEqual(mat(ctl.plane.cursor(state,row.entry.nodeToken)),f.oracle()[4]);
 const range=await query('range',{start:0,end:4});assert.equal(range.facts.count,5);assert.equal(range.geometry.count,5);
 const rewind=await query('rewind',{logicalRank:4});assert.equal(rewind.facts.targetIndex,4);assert.equal(rewind.facts.rewindableCount,5);assert.equal(rewind.facts.skipDuplicates,0);
 const note=await query('note-neighbour',{logicalRank:4,position:'before',direction:-1});assert(note.found);assert.equal(note.logicalRank,3);assert.equal(note.position,'after');
 const rect=window.items[0].geometry;
 const beforeCredit=state.timelinePresentation.layout.info();
 await assert.rejects(query('measure',{creditBytes:512,layoutId:rect.layoutId,layoutRevision:rect.layoutRevision,layoutFingerprint:rect.layoutFingerprint,
  measurements:[{ordinal:0,key:rect.key,identity:rect.identity,layoutFingerprint:rect.layoutFingerprint,intrinsicExtent:126.5}]}),/CREDIT_TOO_SMALL/);
 assert.deepEqual(state.timelinePresentation.layout.info(),beforeCredit,'reply credit refusal leaves the previous geometry current');
 await assert.rejects(query('resize',{creditBytes:512,viewportExtent:640}),/CREDIT_TOO_SMALL/);
 assert.deepEqual(state.timelinePresentation.layout.info(),beforeCredit,'resize credit refusal also preserves the old layout');
 const measured=await query('measure',{layoutId:rect.layoutId,layoutRevision:rect.layoutRevision,layoutFingerprint:rect.layoutFingerprint,
  measurements:[{ordinal:0,key:rect.key,identity:rect.identity,layoutFingerprint:rect.layoutFingerprint,intrinsicExtent:126.5}]});
 assert.equal(measured.layoutInfo.layoutRevision,rect.layoutRevision+1);
 await assert.rejects(query('measure',{layoutId:rect.layoutId,layoutRevision:rect.layoutRevision,layoutFingerprint:rect.layoutFingerprint,
  measurements:[{ordinal:0,key:rect.key,identity:rect.identity,layoutFingerprint:rect.layoutFingerprint,intrinsicExtent:10}]}));
 const status=await query('status');assert.equal(status.logicalEntryCount,5);assert.equal(status.noteCount,0);assert.equal(status.validSemanticGroupCount,0);
 const child=await call('openHistoryRoot',{timelineReadClass:'view',timelinePresentationIdentity:cap.timelinePresentationIdentity,
  timelineParentLease:{leaseId:cap.leaseId,ownerKey:cap.ownerKey,revision:cap.revision,generation:cap.generation}});
 assert(child.success);assert.equal(child.readMetrics.timelineSemanticPreparations,0);assert.notEqual(child.leaseId,cap.leaseId);
 await call('releaseHistoryRoot',cap);const after=await query('window',{startOrdinal:4,limit:1},child.root);assert.equal(after.items[0].header.logicalRank,4);
  const retained=await query('retain',{},child.root);assert(retained.success&&retained.retainedSnapshot);assert.notEqual(retained.leaseId,child.leaseId);
  await call('releaseHistoryRoot',child);
  const document=await query('document',{action:'prompt',subject:row.subject},retained.root);assert(document.success);assert(document.payloadDocument);
  assert.notEqual(document.leaseId,retained.leaseId);await call('releaseHistoryRoot',retained);
  let text='',offset=0;for(;;){const page=await call('readHistoryRootPage',{...document.payloadDocument,kind:'leaf',offset,limit:512,creditBytes:4096});
   text+=page.text;if(page.done)break;offset=page.nextOffset;}
  assert.equal(text,f.oracle()[4].content);assert.equal(sha(text),sha(f.oracle()[4].content));await call('releaseHistoryRoot',document);
  assert.equal(ctl.plane.roots.size,0);assert.equal(ctl.store.stats().leases,0);
});
