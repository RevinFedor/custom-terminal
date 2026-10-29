'use strict';
// Reader-owned logical Timeline order. Source remains its own rooted reducer.
// ONE/TWO selected row graphs below are explicit compatibility sinks; arrays,
// identity indexes, pending points and rank facts stay in the supplied store.
const path=require('node:path');
const {createHash}=require('node:crypto');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {materializeHistoryCursorSync:materialize,isHistoryPagedCursor}=require('./history-paged-store');
const text=require('./history-paged-text');
const F=require('../shared/timeline-entry-facts.cjs');
const {getTerminalMcpTag,isServicePromptEntry}=require('../shared/prompt-origin.cjs');
const fail=code=>Object.assign(new Error(code),{code});
function* rewindUnits(value){
 if(!text.isText(value))throw fail('TIMELINE_REWIND_TEXT_REQUIRED');
 let seen=false,space=false;
 for(const part of text.chunks(value))for(let i=0;i<part.length;i++){
  const c=part[i];if(/\s/.test(c)){if(seen)space=true;continue;}
  if(space){yield ' ';space=false;}yield c;seen=true;
 }
}
async function rewindKey(value,checkpoint){
 const hash=createHash('sha256'),buffer=Buffer.alloc(2048);let used=0,length=0;
 for(const unit of rewindUnits(value)){
  buffer.writeUInt16LE(unit.charCodeAt(0),used);used+=2;length++;
  if(used===buffer.length){hash.update(buffer);used=0;}
  if(length%32768===0)await checkpoint();
 }
 if(used)hash.update(buffer.subarray(0,used));
 return {length,hash:hash.digest('hex')};
}
async function sameRewindText(a,b,checkpoint){
 const x=rewindUnits(a),y=rewindUnits(b);let count=0;
 for(;;){const l=x.next(),r=y.next();if(l.done||r.done)return l.done===r.done;if(l.value!==r.value)return false;
  if(++count%32768===0)await checkpoint();}
}
function* identities(entry){
 for(const key of ['uuid','sourceIdentity'])if(typeof entry?.[key]==='string'&&entry[key])yield entry[key];
 for(const key of ['sourceIdentityAliases','sourceUuidAliases'])if(Array.isArray(entry?.[key]))
  for(const id of entry[key])if(typeof id==='string'&&id)yield id;
}
function* candidateIds(entry){
 for(const key of ['uuid','sourceIdentity']){const id=String(entry?.[key]||'').trim();if(id)yield id;}
 if(Array.isArray(entry?.sourceIdentityAliases))for(const value of entry.sourceIdentityAliases){const id=String(value||'').trim();if(id)yield id;}
}
const equal=(a,b)=>text.isText(a)?text.isText(b)&&text.equal(a,b):text.isText(b)?false:a===b;
const small=value=>text.isText(value)?text.materialize(value,'timeline-one-identity-sink'):value;
function exact(entry,id){
 if(equal(entry.uuid,id)||equal(entry.sourceIdentity,id))return true;
 for(const key of ['sourceIdentityAliases','sourceUuidAliases']){
  const a=entry[key];if(Array.isArray(a))for(let i=0;i<a.length;i++)if(equal(a[i],id))return true;
 }
 return false;
}
async function createTimelineLogicalRoot(store,base,{presentationRoot=null,annotations=null,workingFiles=null,cwd='',control}={}){
 if(!base?.success||!base.semanticSnapshotComplete||!isHistoryPagedCursor(base.entries)||base.entries.kind!=='array')
  throw fail('TIMELINE_LOGICAL_SOURCE_REQUIRED');
 store.referenceForCursor(base.entries);
 const presentation=presentationRoot?.cursor?.();
 if(presentation&&presentation.kind!=='object')throw fail('TIMELINE_LOGICAL_PRESENTATION_REQUIRED');
 if(presentation)store.referenceForCursor(presentation);
 const arena=new HistoryProjectionArena(store);
 const metrics={canonicalRows:0,logicalRows:0,pointComparisons:0,anchorComparisons:0,sortComparisons:0,
  maxNativeRowSinks:2,wholeTimelineDTOs:0,globalMemoryBounded:false,bodySink:'selected-full-row-compatibility'};
 let frame,lease,heldBase,heldAnnotations,transferred=false,steps=0;
 const checkpoint=async()=>{control?.assertCurrent();if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));control?.assertCurrent();};
 const work=async()=>{if(++steps%32===0)await checkpoint();else control?.assertCurrent();};
 const array=name=>{const c=presentation?.field(name);if(!c||c.kind==='undefined')return null;if(c.kind!=='array')throw fail('TIMELINE_LOGICAL_PRESENTATION_ARRAY');return c;};
 const handoffs=array('sentHandoffs'),live=array('liveEntries'),anchors=array('noteAnchors'),files=workingFiles||array('workingFiles');
 if(files){if(!isHistoryPagedCursor(files)||files.kind!=='array')throw fail('TIMELINE_LOGICAL_WORKING_FILES_REQUIRED');store.referenceForCursor(files);}
 const row=cursor=>{control?.assertCurrent();return materialize(cursor,{control});};
 const native=value=>{let l;try{l=arena.step(()=>arena.publish(value));return row(l.cursor());}finally{l?.release();}};
 const insert=(map,id,rank)=>{let ords=map.get(id);if(!ords){ords=arena.make('array');map.set(id,ords);}
  if(!ords.length||ords[ords.length-1]!==rank)ords.push(rank);};
 const represented=entry=>{for(const id of candidateIds(entry))if(frame.canonicalIds.has(id))return true;return false;};
 const matched=(a,candidate)=>{metrics.pointComparisons++;for(const id of candidateIds(candidate))if(exact(a,id))return true;return false;};
 const own=value=>arena.step(()=>arena.own(value));
 function point(entry){return arena.step(()=>({entry:arena.own(entry),alive:true,
   time:Date.parse(entry?.timestamp||''),handoffId:entry?.handoffId}));}
 const compare=(a,b)=>{metrics.sortComparisons++;const delta=a.time-b.time;
  return Number.isFinite(delta)&&delta!==0?delta:String(small(a.handoffId)||'').localeCompare(String(small(b.handoffId)||''));};
 async function sortedAlive(records){
  const sorted=arena.step(()=>arena.make('array'));
  for(let n=0;n<records.length;n++){
   const item=records[n];if(!item.alive)continue;
   let lo=0,hi=sorted.length;
   while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(compare(sorted[mid],item)>0)hi=mid;else lo=mid+1;await work();}
   arena.step(()=>{for(let at=sorted.length;at>lo;at--)sorted[at]=sorted[at-1];sorted[lo]=item;});await work();
  }return sorted;
 }
 async function upsert(current,input){
  const records=arena.step(()=>arena.make('array'));
  if(current)arena.step(()=>{for(let i=0;i<current.length;i++)records.push({entry:current[i].entry,alive:true,time:current[i].time,handoffId:current[i].handoffId});});
  const count=input?.length||0;
  for(let i=0;i<count;i++){
   const candidate=input.kind==='array'?row(input.at(i)):native(input[i].entry);
   if(!candidate?.handoffId)continue;
   let tags=candidate.semanticTags;const p=point(candidate);
   for(let j=records.length-1;j>=0;j--){const prior=records[j];if(!prior.alive)continue;
    const match=matched(prior.entry,candidate);
    if(!tags?.length&&prior.entry.semanticTags?.length&&match)tags=prior.entry.semanticTags;
    if(equal(prior.handoffId,candidate.handoffId)||match)arena.step(()=>{prior.alive=false;});
    await work();
   }
   arena.step(()=>{if(tags?.length&&tags!==candidate.semanticTags)p.entry.semanticTags=tags;records.push(p);});
   await work();
  }return sortedAlive(records);
 }
 async function retain(points){
  const out=arena.step(()=>arena.make('array'));
  for(let i=0;i<points.length;i++){
   const p=points[i],entry=native(p.entry);let newer=0;
   if(represented(entry))continue;
   if(Number.isFinite(p.time))for(let j=0;j<frame.promptTimes.length;j++){
    if(frame.promptTimes[j]>p.time&&++newer>=2)break;await work();
   }
   if(newer<2)arena.step(()=>out.push(p));await work();
  }return out;
 }
 try{
  control?.assertCurrent();
  heldBase=base.root.fork();heldAnnotations=annotations?.fork?.();
  frame=arena.step(()=>{const s=arena.state();s.rows=arena.make('array');s.canonical=arena.make('array');s.canonicalIds=arena.make('map');
   s.promptTimes=arena.make('array');s.ids=arena.make('map');s.uuidIndex=arena.make('map');s.facts=arena.make('array');
   s.eligible=arena.make('array');s.compactPrefix=arena.make('array');s.continuedPrefix=arena.make('array');
   s.rewindUserPrefix=arena.make('array');s.rewindKeys=arena.make('map');
   s.linked=arena.make('map');s.canonicalCount=base.entries.length;return s;});
  for(let i=0;i<base.entries.length;i++){
   let entry=row(base.entries.at(i)),count=0,tag;
   if(!getTerminalMcpTag(entry)&&handoffs)for(let h=0;h<handoffs.length;h++){
    const candidate=row(handoffs.at(h)),candidateTag=getTerminalMcpTag(candidate);
    if(candidate.isSentHandoffProjection===true&&candidateTag&&F.timelineEntryMatchesSentHandoff(entry,candidate)){
     count++;if(count===1)tag=candidateTag;else break;
    }await work();
   }
   if(count===1)entry={...entry,semanticTags:[...(entry.semanticTags||[]),tag]};
   arena.step(()=>{frame.canonical.push(arena.own(entry));for(const id of identities(entry))frame.canonicalIds.set(id,true);
    if(entry.type==='user'&&!isServicePromptEntry(entry)){const t=Date.parse(entry.timestamp||'');if(Number.isFinite(t))frame.promptTimes.push(t);}
    metrics.canonicalRows++;});await work();
  }
  const retainedHandoffs=await retain(await upsert(null,handoffs)),retainedLive=await retain(await upsert(null,live));
  const pending=await upsert(retainedHandoffs,retainedLive);
  if(files)for(let i=0;i<files.length;i++){const value=row(files.at(i)).path;
   if(typeof value==='string'&&value.trim()&&(path.isAbsolute(value)||cwd))arena.step(()=>frame.linked.set(path.resolve(cwd||'/',value),true));await work();}
  let eligibleCount=0,compactCount=0,continuedCount=0,rewindUsers=0;
  const total=frame.canonical.length+pending.length;
  for(let i=0;i<total;i++){
   let entry=native(i<frame.canonical.length?frame.canonical[i]:pending[i-frame.canonical.length].entry);
   if(anchors){let count=0,match;
    for(let n=0;n<anchors.length;n++){const anchor=row(anchors.at(n));metrics.anchorComparisons++;
     if(anchor.sessionId===entry.sessionId&&(F.timelineEntryMatchesSentHandoff(anchor,{uuid:entry.uuid,sourceIdentity:entry.sourceIdentity,sourceIdentityAliases:entry.sourceIdentityAliases}))){
      count++;if(count===1)match=anchor;else break;
     }await work();}
    if(count===1&&match.uuid!==entry.uuid)entry={...entry,uuid:match.uuid,sourceUuidAliases:[...new Set([...(entry.sourceUuidAliases||[]),entry.uuid])]};
   }
   if(Array.isArray(entry.fileEdits)&&frame.linked.size){
    const edited=new Set(entry.docsEdited||[]);
    for(const value of entry.fileEdits){if(typeof value!=='string'||!value.trim()||!path.isAbsolute(value)&&!cwd)continue;
     const target=path.resolve(cwd||'/',value);
     if(!frame.linked.has(target)||target.split(path.sep).some(p=>p.toLowerCase()==='docs')||path.basename(target)==='CLAUDE.md')continue;
     edited.add(target);
    }
    if(edited.size!==(entry.docsEdited?.length||0))entry={...entry,docsEdited:[...edited]};
   }
   if(F.codexGoalPresentation(entry,'codex')){await work();continue;}
   const rank=frame.rows.length,isEligible=!!entry.uuid&&!entry.isSentHandoffProjection&&!getTerminalMcpTag(entry)&&F.isEligibleTimelineTitleEntry(entry);
   const menuKey=entry.type==='user'?await rewindKey(entry.content,checkpoint):null;
   arena.step(()=>{frame.eligible.push(eligibleCount);if(isEligible)eligibleCount++;
    frame.compactPrefix.push(compactCount);if(entry.type==='compact'||entry.isCompactSummary)compactCount++;
    frame.continuedPrefix.push(continuedCount);if(entry.type==='continued')continuedCount++;
    frame.rewindUserPrefix.push(rewindUsers);if(menuKey){rewindUsers++;insert(frame.rewindKeys,menuKey.hash,rank);}
    frame.rows.push(arena.own(entry));insert(frame.uuidIndex,entry.uuid,rank);
    for(const id of identities(entry))insert(frame.ids,id,rank);
    frame.facts.push({canonicalOrdinal:i<frame.canonical.length?i:null,attribute:F.isTimelineAttributeEntry(entry),
     automaticGroupKind:F.timelineAutomaticGroupKind(entry),titleEligible:isEligible,
     hasCompact:entry.type==='compact'||!!entry.isCompactSummary,hasContinued:entry.type==='continued',
     rewindMenuHash:menuKey?.hash,rewindMenuLength:menuKey?.length});
    metrics.logicalRows++;});await work();
  }
  arena.step(()=>{frame.eligible.push(eligibleCount);frame.compactPrefix.push(compactCount);frame.continuedPrefix.push(continuedCount);
   frame.rewindUserPrefix.push(rewindUsers);
   lease=arena.publish(frame);});control?.assertCurrent();
  const out=new TimelineLogicalRoot(store,lease,heldBase,heldAnnotations,metrics);transferred=true;return out;
 }finally{if(!transferred){lease?.release();heldBase?.release();heldAnnotations?.release();}arena.close();}
}
class TimelineLogicalRoot{
 constructor(store,lease,base,annotations,metrics){this.store=store;this.lease=lease;this.base=base;this.annotations=annotations;
  this.arena=new HistoryProjectionArena(store,lease);this.root=lease.cursor();this.entries=this.root.field('rows');this.closed=false;this.metrics=Object.freeze({...metrics});
  this.revision=createHash('sha256').update(JSON.stringify(['timeline-logical-v1',lease.descriptor,annotations?.revision||null])).digest('hex');}
 assert(){if(this.closed)throw fail('TIMELINE_LOGICAL_RELEASED');this.lease.cursor();}
 lookup(id,{offset=0,limit=3,uuidOnly=false}={}){
  this.assert();if(typeof id!=='string'||!id||id.length>4096||!Number.isSafeInteger(offset)||offset<0||offset>this.entries.length
    ||!Number.isSafeInteger(limit)||limit<1||limit>3)throw fail('TIMELINE_LOGICAL_LOOKUP');
  const values=(uuidOnly?this.arena.state().uuidIndex:this.arena.state().ids).get(id),count=values?.length||0;
  let lo=0,hi=count;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(values[mid]<offset)lo=mid+1;else hi=mid;}
  const ordinals=[];for(let i=lo;i<count&&ordinals.length<limit;i++)ordinals.push(values[i]);
  return Object.freeze({totalMatches:count,ordinals:Object.freeze(ordinals),done:lo+ordinals.length>=count});
 }
 rangeFacts(start,end){
  this.assert();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=this.entries.length)throw fail('TIMELINE_LOGICAL_RANGE');
  const state=this.arena.state(),eligible=state.eligible;
  return Object.freeze({count:end-start+1,titleEligibleCount:eligible[end+1]-eligible[start],
   hasCompact:state.compactPrefix[end+1]>state.compactPrefix[start],hasContinued:state.continuedPrefix[end+1]>state.continuedPrefix[start],
   startUuid:small(this.arena.state().rows[start].uuid),endUuid:small(this.arena.state().rows[end].uuid),revision:this.revision});
 }
 async rewindContext(rank,{control}={}){
  this.assert();if(!Number.isSafeInteger(rank)||rank<0||rank>=this.entries.length)throw fail('TIMELINE_LOGICAL_RANGE');
  const state=this.arena.state(),fact=state.facts[rank];
  if(!fact.rewindMenuHash)throw fail('TIMELINE_REWIND_TARGET_NOT_USER');
  const checkpoint=async()=>{this.assert();control?.assertCurrent();if(control?.checkpoint)await control.checkpoint();
   else await new Promise(resolve=>setImmediate(resolve));this.assert();control?.assertCurrent();};
  const candidates=state.rewindKeys.get(fact.rewindMenuHash);let lo=0,hi=candidates.length;
  while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(candidates[mid]<=rank)lo=mid+1;else hi=mid;}
  let duplicates=0;
  for(let i=lo;i<candidates.length;i++){const other=candidates[i];
   if(state.facts[other].rewindMenuLength===fact.rewindMenuLength
    &&await sameRewindText(state.rows[rank].content,state.rows[other].content,checkpoint))duplicates++;
   if(i%32===31)await checkpoint();else{this.assert();control?.assertCurrent();}}
  return Object.freeze({entryIndex:rank,targetIndex:state.rewindUserPrefix[rank],
   rewindableCount:state.rewindUserPrefix[this.entries.length],lastBoundaryIdx:-1,skipDuplicates:duplicates,
   menuSource:'full-text',revision:this.revision});
 }
 copiedIteration(identities){
  this.assert();const state=this.arena.state();let first=null;
  for(const id of identities){if(typeof id!=='string'||!id)continue;const ranks=state.uuidIndex.get(id);
   if(!ranks)continue;for(let i=0;i<ranks.length;i++){const rank=ranks[i];if(first!==null&&rank>=first)break;
    if(state.eligible[rank+1]>state.eligible[rank]){first=rank;break;}}}
  return first===null?null:state.eligible[first]+1;
 }
 stats(){this.assert();return{...this.metrics,ownership:this.arena.inspectOwnership(),canonicalCount:this.arena.state().canonicalCount,logicalCount:this.entries.length};}
 // Visual/layout consumers hold an independent frozen logical+annotation cut.
 fork(){this.assert();let lease,base,annotations;try{lease=this.lease.fork();base=this.base.fork();annotations=this.annotations?.fork?.();
  return new TimelineLogicalRoot(this.store,lease,base,annotations,this.metrics);
 }catch(error){lease?.release();base?.release();annotations?.release();throw error;}}
 release(){if(this.closed)return;this.closed=true;let error;
  for(const dispose of [()=>this.arena.close(),()=>this.lease.release(),()=>this.base.release(),()=>this.annotations?.release()])
   try{dispose();}catch(e){error||=e;}if(error)throw error;}
}
module.exports={createTimelineLogicalRoot,TimelineLogicalRoot};
