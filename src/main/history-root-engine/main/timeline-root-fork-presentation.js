'use strict';
// DatabaseManager.getForkMarkers -> normalizeForkMarkers -> selectAppForkMarker,
// represented in the caller's page store. This is view metadata, not a reducer.
const fs=require('node:fs');
const {createHash,randomUUID}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createPagedJsonProjection}=require('./history-paged-json');
const {isHistoryPagedCursor}=require('./history-paged-store');
const text=require('./history-paged-text');
const {normalizeForkOperation,isVisibleAppFork}=require('../shared/fork-operation.cjs');
const {readTimelineForkPresentationFreshness}=require('./timeline-fork-presentation-freshness');
const fail=code=>Object.assign(new Error('TIMELINE_FORK_PRESENTATION_'+code),{code:'TIMELINE_FORK_PRESENTATION_'+code});
const columns=['source_session_id','child_session_id','session_id','entry_uuids_json','occurred_at','created_at',
 'hidden','provider','event_key','is_direct','metadata_copied','fork_mode','operation_kind','origin','source_tab_id',
 'child_tab_id','visual_parent_tab_id','orchestration_run_id','orchestration_parent_run_id','boundary_entry_uuid','snapshot_complete'];
const truth=v=>text.isText(v)?v.length!==0:!!v;
const or=(v,fallback)=>truth(v)?v:fallback;
const equal=(a,b)=>text.isText(a)&&text.isText(b)?text.equal(a,b):a===b;
const trimmed=v=>text.trim(text.coerce(or(v,'')));
const enumValue=(v,values)=>values.find(candidate=>equal(v,candidate))??(truth(v)?'unknown':null);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

/** Same supplied store + manager.db, exact source witness and logical root.
 * Returns optionsRoot (lease) with forkMarkers [] or [directParent], original
 * fields and normalized paged entry_uuids; selected capability/index is frozen.
 * No userDB iterator/transaction across await; no getter, payload .all/JSON.parse.
 */
async function captureTimelineRootForkPresentation({store,manager,sessionId,logicalRoot,readSourceWitness,
 control,cooperate=tick,chunkBytes=1024}={}){
 if(!store||store.closed||!manager?.db?.prepare||typeof sessionId!=='string'||!sessionId||sessionId.length>4096
  ||!logicalRoot||logicalRoot.store!==store||typeof logicalRoot.fork!=='function'||typeof logicalRoot.assert!=='function'
  ||!isHistoryPagedCursor(logicalRoot.entries)||logicalRoot.entries.kind!=='array'
  ||typeof readSourceWitness!=='function'||typeof cooperate!=='function'
  ||!Number.isSafeInteger(chunkBytes)||chunkBytes<64||chunkBytes>4096)throw fail('CONFIGURATION');
 const db=manager.db,dbPath=db.name,logicalRevision=logicalRoot.revision;
 if(db===store.db||typeof dbPath!=='string'||!dbPath||dbPath===':memory:')throw fail('READ_CONNECTION_REQUIRED');
 const stats={rows:0,sqlChunks:0,maxSQLChunkBytes:0,parserWrites:0,maxParserWriteBytes:0,checkpoints:0,
  nativeRowBatch:1,wholeJSONParses:0,wholeTimelineDTOs:0,tieScalarSinks:0,globalMemoryBounded:false,sqlNativeMemoryBounded:false};
 function witness(){
  control?.assertCurrent();logicalRoot.assert();
  if(logicalRoot.revision!==logicalRevision)throw fail('LOGICAL_CHANGED');
  if(manager.db!==db||db.name!==dbPath||db.inTransaction!==false)throw fail('CONNECTION_CHANGED');
  const sourceRevision=readSourceWitness();
  if(typeof sourceRevision!=='string'||!sourceRevision||sourceRevision.length>4096)throw fail('SOURCE_WITNESS_REQUIRED');
  const physical=fs.statSync(dbPath,{bigint:true}),fresh=readTimelineForkPresentationFreshness(db);
  if(!fresh)throw fail('WITNESS_UNKNOWN');
  return {sourceRevision,logicalRevision,dbPath,device:String(physical.dev),inode:String(physical.ino),...fresh};
 }
 const before=witness();
 function guard(){const current=witness();for(const key of Object.keys(before)){
  if(key==='dataVersion'&&before.mode==='scoped'&&current.mode==='scoped')continue;
  if(current[key]!==before[key])throw Object.assign(fail('CAPTURE_CHANGED'),{reason:key});
 }}
 async function checkpoint(){guard();await cooperate();stats.checkpoints++;guard();}
 let arena,logicalRead,root,held,endBuild;
 try{
  store.referenceForCursor(logicalRoot.entries);held=logicalRoot.fork();endBuild=store.beginBuild();arena=new HistoryProjectionArena(store);logicalRead=new HistoryProjectionArena(store,held.lease);
  // No collection of source IDs on the JS heap. Resolve current Timeline UUID
  // precedence/trim on pages (not source aliases), including duplicate rows.
  arena.step(()=>{const s=arena.state();s.ids=arena.make('map');
   s.markers=arena.make('array');s.boundaries=arena.make('array');s.memberships=arena.make('array');
   s.forkMarkers=arena.make('array');s.selectedOrdinal=null;});
  const state=arena.state();
  for(let rank=0;rank<held.entries.length;rank++){
   arena.step(()=>{const e=logicalRead.state().rows[rank],id=trimmed(or(e.uuid,or(e.userUuid,or(e.entry_uuid,''))));
    if(id.length){const prior=state.ids.get(id);state.ids.set(id,{rank,count:(prior?.count||0)+1});}});
   if(rank%32===31)await checkpoint();else guard();
  }
  async function load(table,rowid,column){
   guard();const info=db.prepare(`SELECT typeof(${column}) AS kind,length(CAST(${column} AS BLOB)) AS bytes FROM main.${table} WHERE rowid=?`).get(rowid);
   if(!info)throw fail('ROW_CHANGED');
   if(info.kind==='null')return null;
   if(info.kind==='integer'||info.kind==='real')return db.prepare(`SELECT ${column} AS value FROM main.${table} WHERE rowid=?`).get(rowid).value;
   // Native snapshot parser rejects non-string JSON, including BLOB.
   if(info.kind==='blob'&&column==='entry_uuids_json')return null;
   if(info.kind!=='text')throw fail('COLUMN_TYPE');
   if(!Number.isSafeInteger(info.bytes)||info.bytes<0)throw fail('ROW_CHANGED');
   const read=db.prepare(`SELECT substr(CAST(${column} AS BLOB),?,?) AS bytes FROM main.${table} WHERE rowid=?`),decoder=new StringDecoder('utf8'),writer=store.leafWriter();
   for(let offset=1;offset<=info.bytes;){
    guard();const part=read.get(offset,chunkBytes,rowid)?.bytes;
    if(!ArrayBuffer.isView(part)||!part.byteLength||part.byteLength>chunkBytes)throw fail('ROW_CHANGED');
    store.transaction(()=>writer.write(decoder.write(part)));offset+=part.byteLength;stats.sqlChunks++;
    stats.maxSQLChunkBytes=Math.max(stats.maxSQLChunkBytes,part.byteLength);await checkpoint();
   }
   let ref;store.transaction(()=>{writer.write(decoder.end());ref=writer.finish();});return text.fromRef(arena,ref);
  }
  async function parseMembership(value){
   const ids=arena.step(()=>arena.make('array')),membership=arena.step(()=>arena.make('set'));
   if(!text.isText(value)||!value.length)return {ids,membership};
   const parser=createPagedJsonProjection(store,{selectedTokenBytes:64,jsonWhitespaceOnly:true});let result,offset=0,quoted=false,escaped=false;
   try{
    for(const part of text.chunks(value)){
     let encoded='';const flush=()=>{if(!encoded)return;const bytes=Buffer.from(encoded,'utf8');parser.write(bytes,offset);offset+=bytes.length;
      stats.parserWrites++;stats.maxParserWriteBytes=Math.max(stats.maxParserWriteBytes,bytes.length);encoded='';};
     for(let i=0;i<part.length;i++){const c=part[i],unit=part.charCodeAt(i),piece=quoted&&!escaped&&unit>=128?'\\u'+unit.toString(16).padStart(4,'0'):c;
      if(encoded.length+piece.length>128)flush();encoded+=piece;
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;
     }flush();await checkpoint();
    }
    result=parser.finish(offset);if(!result.valid)return {ids,membership};
    const parsed=arena.step(()=>arena.own(result.lease.cursor()));
    if(Array.isArray(parsed))for(let n=0;n<parsed.length;n++){
     arena.step(()=>{const v=parsed[n];if(text.isText(v)){const id=text.trim(v);if(id.length&&!membership.has(id)){membership.add(id);ids.push(id);}}});
     if(n%32===31)await checkpoint();else guard();
    }
    return {ids,membership};
   }finally{result?.lease?.release();parser.abort();}
  }
  async function append(rowid,projected=false){
   const v={};for(const column of columns)v[column]=await load('session_history_events',rowid,column);
   let parsed;
   if(projected){const boundary=await load('timeline_fork_origins',projected,'boundary_entry_uuid');
    parsed=arena.step(()=>{const ids=arena.make('array'),membership=arena.make('set');if(truth(boundary)){ids.push(boundary);membership.add(boundary);}return {ids,membership,boundary};});
   }else parsed=await parseMembership(v.entry_uuids_json);
   // Getter then normalizeForkMarkers: projected UUID also trimmed/deduplicated.
   if(projected)arena.step(()=>{const id=truth(parsed.boundary)?text.trim(parsed.boundary):'';parsed.ids=arena.make('array');parsed.membership=arena.make('set');
    if(id.length){parsed.ids.push(id);parsed.membership.add(id);}});
   arena.step(()=>{
    const marker=arena.record({source_session_id:v.source_session_id,fork_session_id:or(v.child_session_id,v.session_id),entry_uuids:parsed.ids,
     created_at:or(v.occurred_at,v.created_at),hidden:truth(v.hidden),provider:v.provider,event_key:v.event_key,
     is_direct:projected?false:truth(v.is_direct),view_session_id:projected?sessionId:null,metadata_copied:truth(v.metadata_copied),
     fork_mode:or(v.fork_mode,null),operation_kind:normalizeForkOperation(enumValue(v.operation_kind,['fork','rewind','edit','delete','provider'])),
     origin:or(v.origin,null),source_tab_id:or(v.source_tab_id,null),child_tab_id:or(v.child_tab_id,null),visual_parent_tab_id:or(v.visual_parent_tab_id,null),
     orchestration_run_id:or(v.orchestration_run_id,null),orchestration_parent_run_id:or(v.orchestration_parent_run_id,null),
     boundary_entry_uuid:or(projected?parsed.boundary:v.boundary_entry_uuid,null),snapshot_complete:v.snapshot_complete!==0});
    state.markers.push(marker);state.memberships.push(parsed.membership);
   });stats.rows++;
   let boundaryIndex=-1,boundaryUuid=null,matchedCount=0;
   for(let n=0;n<parsed.ids.length;n++){
    const id=parsed.ids[n],match=state.ids.get(id);if(match){matchedCount+=match.count;if(match.rank>boundaryIndex){boundaryIndex=match.rank;boundaryUuid=id;}}
    if(n%32===31)await checkpoint();else guard();
   }
   arena.step(()=>state.boundaries.push({atBeginning:parsed.ids.length===0,boundaryIndex,boundaryUuid,matchedCount,snapshotCount:parsed.ids.length}));await checkpoint();
  }
  // Exact Native order, one scalar rowid at a time; origin appended last.
  const next=db.prepare(`SELECT id FROM main.session_history_events WHERE event_type='fork' AND (source_session_id=? OR session_id=?) ORDER BY COALESCE(occurred_at,created_at),id LIMIT 1 OFFSET ?`);
  for(let n=0;;n++){guard();const row=next.get(sessionId,sessionId,n);if(!row)break;await append(row.id);}
  guard();const origin=db.prepare(`SELECT event.id AS id,origin.rowid AS origin_id FROM main.timeline_fork_origins origin JOIN main.session_history_events event ON event.event_key=origin.event_key WHERE origin.session_id=?`).get(sessionId);
  if(origin)await append(origin.id,origin.origin_id);
  let direct=null,fallback=null,visibleCount=0,directCount=0,proven=false;
  const created=m=>{const n=text.number(or(m.occurred_at,or(m.created_at,0)));return Number.isFinite(n)?n:0;};
  function better(a,b){
   const left=state.markers[a],right=state.markers[b],la=state.boundaries[a],rb=state.boundaries[b];
   const order=created(left)-created(right)||la.boundaryIndex-rb.boundaryIndex||la.snapshotCount-rb.snapshotCount;
   if(order)return order>0;
   // Native localeCompare has locale/ICU semantics. Two selected scalar sinks
   // ONLY at an exact tie; never materialize any membership or ID collection.
   stats.tieScalarSinks+=2;
   return text.materialize(trimmed(left.source_session_id),'timeline-fork-tie-source')
    .localeCompare(text.materialize(trimmed(right.source_session_id),'timeline-fork-tie-source'))>0;
  }
  for(let n=0;n<state.markers.length;n++){
   const m=state.markers[n];const visible=isVisibleAppFork({hidden:m.hidden,operation_kind:m.operation_kind,
    fork_mode:enumValue(m.fork_mode,['full','latest_compact','history_edit','history_delete','history_rewind']),
    origin:enumValue(m.origin,['app','terminal-mcp','orchestration','legacy-fork-marker'])})&&m.snapshot_complete!==false;
   if(visible){visibleCount++;
    if(equal(trimmed(m.fork_session_id),sessionId.trim())){
     directCount++;if(m.is_direct&&!proven){direct=null;proven=true;}
     if((!proven||m.is_direct)&&(direct===null||better(n,direct)))direct=n;
    }
    if(fallback===null&&equal(m.view_session_id,sessionId)&&(!truth(m.boundary_entry_uuid)||state.ids.has(m.boundary_entry_uuid)))fallback=n;
   }
   if(n%32===31)await checkpoint();else guard();
  }
  const selected=direct??fallback;
  arena.step(()=>{state.selectedOrdinal=selected;state.markerCount=state.markers.length;state.visibleCount=visibleCount;state.directCount=directCount;
   if(selected!==null)state.forkMarkers.push(state.markers[selected]);
   state.selectedBoundary=selected===null?null:state.boundaries[selected];});
  guard();root=arena.step(()=>arena.publish());guard();
  const captureWitness=Object.freeze({captureId:randomUUID(),sessionId,...before});
  const revision=createHash('sha256').update(JSON.stringify(captureWitness)).digest('hex');
  return snapshot(store,root,captureWitness,revision,Object.freeze({...stats,ownership:Object.freeze(arena.inspectOwnership()),arena:Object.freeze({...arena.metrics})}));
 }catch(error){root?.release();throw error;}finally{arena?.close();logicalRead?.close();held?.release();endBuild?.();}
}
function snapshot(store,root,captureWitness,revision,stats){
 const c=root.cursor(),selectedOrdinal=c.field('selectedOrdinal').scalar();let released=false;
 const selected=selectedOrdinal===null?null:c.field('forkMarkers').at(0);
 function hasEntryUuid(uuid){void c.kind;if(selectedOrdinal===null)return false;const a=new HistoryProjectionArena(store,root);
  try{return a.state().memberships[selectedOrdinal].has(uuid);}finally{a.close();}}
 return Object.freeze({root,optionsRoot:root,forkMarkers:c.field('forkMarkers'),selected,
  selectedBoundary:c.field('selectedBoundary'),selectedOrdinal,selectedCount:selected===null?0:1,
  markerCount:c.field('markerCount').scalar(),visibleCount:c.field('visibleCount').scalar(),directCount:c.field('directCount').scalar(),
  entryUuidCount:selected?.field('entry_uuids').length??0,hasEntryUuid,captureWitness,revision,stats,
  fork(){void c.kind;return snapshot(store,root.fork(),captureWitness,revision,stats);},
  release(){if(released)return;released=true;root.release();}});
}
module.exports={captureTimelineRootForkPresentation};
