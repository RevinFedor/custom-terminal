'use strict';
// Bounded read facts for the ordinary Timeline. These are read capabilities;
// existing Main scenarios retain all mutation/runtime/Input authority.
const fail=(code,extra)=>Object.assign(new Error(code),{code,...extra});
const {retainPrimaryTimelineViewPresentation}=require('./timeline-primary-view-presentation');
const {forkFrozenCanonical}=require('./history-frozen-canonical');
const integer=(n,code,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(n)||n<0||n>max)throw fail(code);return n;};
function scalar(plane,state,cursor,max=4096){
 if(cursor.kind==='text'){if(cursor.length>max)return plane.describe(state,cursor,{inline:false});
  let value='';for(const chunk of cursor.textChunks())value+=chunk;return value;}
 if(['undefined','scalar','number','scalar-root'].includes(cursor.kind))return cursor.scalar();
 throw fail('TIMELINE_QUERY_SCALAR');
}
function wireBytes(packet){let old;do{old=packet.creditBytesUsed;packet.creditBytesUsed=Buffer.byteLength(JSON.stringify(packet));}while(old!==packet.creditBytesUsed);return packet.creditBytesUsed;}
async function readTimelineRootQuery(plane,state,request,{consumerKey,control,createDocument}={}){
 const p=state.timelinePresentation;if(!p||p.closed)throw fail('TIMELINE_VIEW_REQUIRED');
 if(request.operation==='outline-item')return require('../../timeline-root-outline-reader')
  .readTimelineOutlineItem(plane,state,request,{consumerKey,control});
 if(plane.cursor(state,request.nodeToken).identity()!==p.view.atoms.identity())throw fail('TIMELINE_QUERY_ROOT_REQUIRED');
 const operation=request.operation;
 if(typeof operation!=='string'||operation.length>32)throw fail('TIMELINE_QUERY_OPERATION');
 const credit=request.creditBytes??16384;integer(credit,'HISTORY_ROOT_CREDIT',65536);if(credit<512)throw fail('HISTORY_ROOT_CREDIT');
 const check=()=>{control?.assertCurrent();plane.state(request,consumerKey);p.view.assert();};
 const packet={success:true,...plane.identity(state),nodeToken:request.nodeToken,kind:'timeline-query',operation,creditBytesUsed:0};
 const describe=cursor=>plane.describe(state,cursor,{inline:false});
 const subject=rank=>{const entry=p.view.actualRow(rank),facts=p.view.logical.root.field('facts').at(rank);
  return{logicalRank:rank,revision:p.view.logical.revision,logicalRevision:p.view.logical.revision,viewRevision:state.revision,
   uuid:scalar(plane,state,entry.field('uuid')),canonicalOrdinal:facts.field('canonicalOrdinal').scalar()};};
 const finish=fields=>{check();Object.assign(packet,fields);const bytes=wireBytes(packet);
  if(bytes>credit)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:bytes});return packet;};
 check();
 if(operation==='search-markers'){
  const search=plane.state(request.searchRootLease,consumerKey),sp=search.searchPresentation;
  if(!sp||search.ownerKey!==state.ownerKey)throw fail('HISTORY_SEARCH_OWNER_MISMATCH');
  let heldSearch,heldView,heldRaw;
  try{
   heldSearch=sp.fork();heldView=p.view.fork();heldRaw=forkFrozenCanonical(plane.store,p.raw);
   if(state.searchCoverageWitness?.leaseId!==search.leaseId||state.searchCoverageWitness?.revision!==search.revision){
    const valid=await require('./history-search-source-coverage').proveHistorySearchSourceCoverage(plane.store,heldSearch.frozen,heldRaw,{control});
    check();plane.state(request.searchRootLease,consumerKey);
    state.searchCoverageWitness={leaseId:search.leaseId,revision:search.revision,valid,
      sameCut:['size','mtimeMs','ctimeMs'].every(k=>search.source?.[k]===state.source?.[k])};
   }
   if(!state.searchCoverageWitness.valid)return finish({flags:null,coverage:'source-mismatch',requiredClass:'source'});
   const aggregate=require('./history-root-search-paged').aggregatePagedHistorySearchMarkers;
   let flags;
   if(request.groupKey!==undefined){
    if(request.logicalRank!==undefined)throw fail('HISTORY_SEARCH_TARGET_REQUIRED');
    const group=heldView.group(request.groupKey);if(!group)throw fail('HISTORY_SEARCH_GROUP_NOT_FOUND');
    const ranks=group.field('memberRanks');let match=false,current=false,currentMatchCovered=request.currentMatchIndex==null||heldSearch.currentKeys(request.currentMatchIndex)!==null;
    for(let i=0;i<ranks.length;i++){
     const item=aggregate(heldSearch,heldView,{logicalRank:ranks.at(i).scalar(),currentMatchIndex:request.currentMatchIndex},{control});
     match||=item.match;current||=item.current;if(match&&(current||request.currentMatchIndex==null))break;
     if(i%32===31){if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));check();}
    }flags={match,current,currentMatchCovered};
   }else flags=aggregate(heldSearch,heldView,{logicalRank:request.logicalRank,currentMatchIndex:request.currentMatchIndex},{control});
   plane.state(request.searchRootLease,consumerKey);return finish({flags,coverage:state.searchCoverageWitness.sameCut?'exact-source':'source-prefix'});
  }finally{heldRaw?.release();heldView?.release();heldSearch?.release();}
 }
 if(operation==='terminal-navigation'){
  const terminalNavigation=await require('./timeline-root-terminal-navigation')
   .readTimelineRootTerminalNavigation(p.view.logical,request.logicalRank,{control,beforeLogicalRank:request.beforeLogicalRank,ifRevision:request.ifRevision});
  return finish({terminalNavigation});
 }
 if(operation==='window'){
  const range=p.view.window({startOrdinal:request.startOrdinal??0,limit:request.limit??3});
  return finish({items:range.items.map(header=>({header,geometry:p.layout.rect(header.visualRank)})),
   nextOrdinal:range.nextOrdinal,done:range.done,layoutInfo:p.layout.info()});
 }
 if(operation==='offset'){
  const offset=request.offset;if(typeof offset!=='number'||!Number.isFinite(offset)||offset<0)throw fail('TIMELINE_QUERY_OFFSET');
  const hit=p.layout.atomAtOffset(offset);
  return finish({hit,sticky:hit?p.view.stickyAt(hit.ordinal):null,layoutInfo:p.layout.info()});
 }
 if(operation==='resolve'){
  const resolved=p.view.resolve(request.uuid!==undefined?{uuid:request.uuid}:{logicalRank:request.logicalRank});
  return finish({resolved,geometry:resolved.found&&resolved.visualRank!==null?p.layout.rect(resolved.visualRank):null,layoutInfo:p.layout.info()});
 }
 if(operation==='row'){
  const entry=p.view.actualRow(request.logicalRank),facts=p.view.factsAt(request.logicalRank);
  return finish({logicalRank:request.logicalRank,subject:subject(request.logicalRank),entry:describe(entry),facts:describe(facts)});
 }
 if(operation==='group'){
  if(typeof request.key!=='string'||!/^[a-f0-9]{64}$/.test(request.key))throw fail('TIMELINE_QUERY_GROUP');
  const g=p.view.group(request.key);if(!g)return finish({found:false});
  const get=name=>scalar(plane,state,g.field(name)),kind=get('kind'),size=g.field('memberRanks').length,start=get('startIndex');
  const groupInfo={groupId:request.key,groupSize:size,groupKind:kind,startIndex:start,endIndex:get('endIndex'),
   displayId:get('displayId'),agentName:get('agentName'),hasTimeout:get('hasTimeout'),expanded:get('expanded'),
   membershipRevision:get('membershipRevision'),isGroupHeader:request.logicalRank===start&&size>1,isGroupChild:kind!=='semantic'&&size>1};
  return finish({found:true,groupInfo,presentation:{editedCount:g.field('edited').length,searchedCount:g.field('searched').length,
   promptLabelCount:g.field('promptLabels').length,isLoop:get('isLoop'),hasPromptChip:get('hasPromptChip'),
   failedCount:get('failedCount'),mcpCount:get('mcpCount'),scCount:get('scCount')},group:describe(g)});
 }
 if(operation==='annotation'){
  const annotation=p.view.annotationAt(request.annotationKind,request.n);
  return finish({annotationKind:request.annotationKind,n:request.n,annotation:describe(annotation)});
 }
 if(operation==='range'){
  const facts=p.view.rangeFacts(request.start,request.end);
  return finish({facts,geometry:facts.visualStart===null?null:p.layout.range(facts.visualStart,facts.visualEnd),layoutInfo:p.layout.info(),
   startSubject:subject(request.start),endSubject:subject(request.end),startEntry:describe(p.view.actualRow(request.start)),endEntry:describe(p.view.actualRow(request.end))});
 }
 if(operation==='rewind'){
  const facts=await p.view.logical.rewindContext(request.logicalRank,{control});check();
  return finish({facts,entry:describe(p.view.actualRow(request.logicalRank))});
 }
 if(operation==='iteration'){
  // A label never opens a Timeline or History snapshot. Borrow only two
  // already-held exact roots of the same tab/session/cwd/consumer.
  if(!request.historyRootLease||typeof request.historyEntryIdentity!=='string')return finish({ordinal:null,reason:'history-root-not-held'});
  const history=plane.state(request.historyRootLease,consumerKey);
  if(history.ownerKey!==state.ownerKey||!history.primaryPresentation?.sourceMetadataCursor)return finish({ordinal:null,reason:'history-owner-mismatch'});
  const borrowed=plane.store.transaction(()=>plane.store.lease(plane.store.referenceForCursor(history.primaryPresentation.sourceMetadataCursor)));
  try{const metadata=borrowed.cursor();
  let index=-1;
  const matches=(cursor,id)=>{const c=cursor.field('uuid');if(c.kind!=='text'||c.length!==id.length)return false;
   let value='';for(const s of c.textChunks())value+=s;return value===id;};
  for(let i=0;i<metadata.length;i++){
   check();if(matches(metadata.at(i),request.historyEntryIdentity)){index=i;break;}
   if(i%32===31){if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));}
  }
  if(index<0)return finish({ordinal:null,reason:'history-entry-not-in-snapshot'});
  let user;
  for(let i=index;i>=0;i--){const row=metadata.at(i);if(scalar(plane,state,row.field('role'))==='user'){user=row;break;}}
  if(!user)return finish({ordinal:null,reason:'history-user-not-in-snapshot'});
  function* ids(){for(const key of ['uuid','sourceIdentity']){const c=user.field(key);if(c.kind==='text'){let value='';for(const s of c.textChunks())value+=s;yield value;}}
   for(const key of ['sourceIdentityAliases','sourceUuidAliases']){const a=user.field(key);if(a.kind==='array')for(let i=0;i<a.length;i++){
    const c=a.at(i);if(c.kind==='text'){let value='';for(const s of c.textChunks())value+=s;yield value;}}}}
  return finish({ordinal:p.view.logical.copiedIteration(ids()),historyRevision:history.revision});
  }finally{borrowed.release();}
 }
 if(operation==='note-neighbour'){
  const rank=integer(request.logicalRank,'TIMELINE_QUERY_RANK',p.view.logical.entries.length-1),direction=request.direction;
  if(![-1,1].includes(direction)||!['before','after','dot'].includes(request.position))throw fail('TIMELINE_QUERY_NOTE_POSITION');
  const current=p.view.actualRow(rank),uuid=scalar(plane,state,current.field('uuid'));
  if(request.position==='dot')return finish({found:false,reason:'dot-note-not-movable'});
  if(direction===-1&&request.position==='after'||direction===1&&request.position==='before')
   return finish({found:true,logicalRank:rank,position:direction===-1?'before':'after',entry:describe(current)});
  for(let i=rank+direction;i>=0&&i<p.view.logical.entries.length;i+=direction){
   check();const candidate=p.view.actualRow(i),id=scalar(plane,state,candidate.field('uuid'));
   if(typeof id!=='string'||id===uuid)continue;
   const note=p.annotations.lookupNote(id),value=note?.field('content');
   const occupied=value&&(value.kind==='text'?value.length>0:!!value.scalar());
   if(!occupied)return finish({found:true,logicalRank:i,position:direction===-1?'after':'before',entry:describe(candidate)});
   if(i%32===0){if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));}
  }return finish({found:false,reason:'no-free-note-anchor'});
 }
 if(operation==='status'){
  const root=p.view.root,outlineIds=root.field('outlineEligibleUuids'),summaryIds=root.field('summaryEligibleUuids');
  const outlineNewCount=await p.annotations.countOutlineNew(outlineIds,{control});check();
  const summarized=await p.annotations.countSummaries(summaryIds,{control});check();
  const state=p.view.arena.state();
  return finish({canonicalEntryCount:p.canonicalEntryCount,logicalEntryCount:p.view.logical.entries.length,visualAtomCount:p.view.length,
   outlineEligibleCount:outlineIds.length,summaryEligibleCount:summaryIds.length,summarizedCount:summarized,outlineNewCount,
   validSemanticGroupCount:state.semantic.length,automaticGroupCount:state.automatic.length,
   noteCount:p.annotations.noteCount,rewindMarkerCount:p.annotations.rewindMarkerCount,summaryCount:p.annotations.summaryCount,
   outlineSourceCount:p.annotations.outlineSourceCount,layoutInfo:p.layout.info()});
 }
 if(operation==='measure'){
  // Stage both the geometry and its bounded reply before changing the current
  // layout. A credit refusal must not commit an unacknowledged measurement.
  const current=p.layout.info();
  if(request.layoutId!==current.layoutId||request.layoutRevision!==current.layoutRevision||request.layoutFingerprint!==current.layoutFingerprint)
   throw fail('TIMELINE_LAYOUT_STALE_MEASUREMENT');
  const layout=p.layout.fork();let transferred=false;
  try{
   layout.applyMeasuredBatch({layoutId:layout.info().layoutId,layoutRevision:request.layoutRevision,
    layoutFingerprint:request.layoutFingerprint,measurements:request.measurements},{control});
   const reply=finish({layoutInfo:layout.info()});
   const old=p.layout;p.layout=layout;transferred=true;old.release();return reply;
  }finally{if(!transferred)layout.release();}
 }
 if(operation==='resize'){
  if(typeof request.viewportExtent!=='number'||!Number.isFinite(request.viewportExtent)||request.viewportExtent<0)throw fail('TIMELINE_QUERY_EXTENT');
  const layout=p.layout.fork({viewportExtent:request.viewportExtent});let transferred=false;
  try{const reply=finish({layoutInfo:layout.info()});const old=p.layout;p.layout=layout;transferred=true;old.release();return reply;}
  finally{if(!transferred)layout.release();}
 }
 if(operation==='retain'){
  plane.assertCapacity();plane.opening++;let result,installed,transferred=false,primary;
  try{
   result=retainPrimaryTimelineViewPresentation(plane.store,p,{control});check();
   installed=plane.install(result,result.entries,{consumerKey,ownerKey:state.ownerKey,revision:state.revision,source:state.source,canonicalSource:result.timelinePresentation.raw});
   const child=installed.state,reply={success:true,__notedHistoryTransport:'root-v1',...plane.identity(child),root:installed.descriptor,
    totalEntries:result.entries.length,sessionMeta:plane.describe(child,result.sessionMeta,{inline:false}),sourceSnapshot:state.source,
    mode:result.mode,readMetrics:result.readMetrics,...result.timelineViewHeader,readProfile:'timeline-view-v1',semanticSnapshotComplete:true,
    retainedSnapshot:true,parentLeaseId:state.leaseId,producerBounded:false,nativeMemoryMeasured:false};
   const bytes=Buffer.byteLength(JSON.stringify(reply));if(bytes>credit)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:bytes});
   check();plane.state(reply,consumerKey);transferred=true;return reply;
  }catch(error){primary=error;throw error;}
  finally{plane.opening--;if(!transferred)try{if(installed)plane.drop(installed.state);else result?.release();}
   catch(error){if(!primary)throw error;plane.metrics.cleanupErrors=(plane.metrics.cleanupErrors||0)+1;}}
 }
 if(operation==='document'){
  if(typeof createDocument!=='function')throw fail('TIMELINE_DOCUMENT_UNAVAILABLE');
  // Allocation/public-capacity admission is owned by the existing controller.
  plane.assertCapacity();plane.opening++;let document,installed,transferred=false,primary;
  try{
   document=await createDocument(p,request,{control});check();
   if(document?.success===false&&document.pendingSource===true)return{success:false,error:document.code,pendingSource:true,
    __notedHistoryTransport:'timeline-document-pending-v1',...plane.identity(state),logicalRevision:p.view.logical.revision};
   if(document?.lease&&!document.root)document={...document,root:document.lease};
   if(!document?.root?.cursor||typeof document.release!=='function')throw fail('TIMELINE_DOCUMENT_CONTRACT');
   const cursor=document.cursor||document.root.cursor();if(cursor.kind!=='text')throw fail('TIMELINE_DOCUMENT_CONTRACT');
   installed=plane.install(document,cursor,{consumerKey,ownerKey:state.ownerKey,revision:state.revision,source:state.source});
   const child=installed.state,descriptor=installed.descriptor;
   const reply={success:true,__notedHistoryTransport:'root-v1',...plane.identity(child),payloadDocument:descriptor,totalChars:descriptor.length,
    encoding:'text',parentLeaseId:state.leaseId,...(document.context?{context:document.context}:{}),
    ...(document.selectedCount!==undefined?{selectedCount:document.selectedCount}:{})};
   const bytes=Buffer.byteLength(JSON.stringify(reply));if(bytes>credit)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:bytes});
   check();plane.state(reply,consumerKey);transferred=true;return reply;
  }catch(error){primary=error;throw error;}
  finally{plane.opening--;if(!transferred)try{if(installed)plane.drop(installed.state);else document?.release?.();}
   catch(error){if(!primary)throw error;plane.metrics.cleanupErrors=(plane.metrics.cleanupErrors||0)+1;}}
 }
 throw fail('TIMELINE_QUERY_OPERATION');
}
module.exports={readTimelineRootQuery};
