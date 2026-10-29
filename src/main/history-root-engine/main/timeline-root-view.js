'use strict';
const {createReadWorkBudget}=require('./history-read-control');

// Timeline's visual projection, in the SAME reader page store as its logical
// cut. No DOM/ref slots, ordinal display IDs as authority, or whole Timeline
// DTO. One selected classifier record (full content/tags/proof, no doc/label
// lists) is an explicit compatibility sink; derived memberships stay on
// pages even while that row is selected. This is not a global memory claim.
const {createHash}=require('node:crypto');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {isHistoryPagedCursor,historyPagedCursorAddress,materializeHistoryCursorSync:materialize}=require('./history-paged-store');
const text=require('./history-paged-text');
const F=require('../shared/timeline-entry-facts.cjs');
const P=require('../shared/prompt-origin.cjs');
const {isVisibleAppFork}=require('../shared/fork-operation.cjs');
const {projectNativeQuestionReply}=require('../shared/native-question-reply.cjs');
const fail=code=>Object.assign(new Error('TIMELINE_VIEW_'+code),{code:'TIMELINE_VIEW_'+code});
const eq=(a,b)=>text.isText(a)&&text.isText(b)?text.equal(a,b):a===b;
const truth=v=>text.isText(v)?v.length>0:!!v;
const hash=()=>createHash('sha256');
function feed(h,value){
 if(text.isText(value)){h.update('s'+value.length+':');for(const part of text.chunks(value))h.update(part,'utf16le');}
 else h.update(JSON.stringify(value)??'undefined');h.update(';');return h;
}
function digest(...values){const h=hash();for(const value of values)feed(h,value);return h.digest('hex');}
function markerKind(entry){
 if(entry.questionReplyProof&&projectNativeQuestionReply(entry,s=>createHash('sha256').update(s,'utf8').digest('hex')))return 'question-reply';
 const tag=P.getTerminalMcpTag(entry);
 if(tag?.kind==='orchestration'&&tag.runKind==='external-research'&&typeof tag.runId==='string'&&tag.runId.trim())return 'sc-desktop';
 if(tag)return 'terminal-mcp';
 return P.getAutomaticContinuationKind(entry)||(P.isSystemPromptEntry(entry)?'system':'ordinary');
}
function cursorOf(root){return root?.cursor?root.cursor():root;}
function scalarHeader(cursor){return materialize(cursor);}// fixed vocabulary/scalars ONLY
const MAX_WINDOW=3,MAX_INTENTS=8;

/** optionsRoot: same-store paged object (or lease), optional fields:
 * toolType ('codex' default), expandedLayout, treeMode, forkMarkers[],
 * sessionBoundaries[], sourceGeneration (Main's exact source epoch; preserves
 * append-stable keys; without it keys conservatively use the frozen base cut),
 * lastBoundaryIndex (exact external boundary, optional),
 * expandedAutomatic[stableKey], expandedSemantic[stableKey]. Absent semantic
 * preferences default to the last valid semantic group, like the existing UI.
 * No native N-array inputs. <=8 intents: {key,expanded:boolean}; editNote is a
 * single point {logicalRank,position}. activeRangeAction forces semantic open.
 * Intrinsic geometry remains estimated; the renderer still owns actual styles.
 */
async function createTimelineRootView({store,logicalRoot,optionsRoot=null,preferencesRoot=null,
 intents=[],editNote=null,activeRangeAction=false,control}={}){
 if(!logicalRoot?.entries||typeof logicalRoot.fork!=='function'||logicalRoot.store!==store)throw fail('LOGICAL_REQUIRED');
 if(!Array.isArray(intents)||intents.length>MAX_INTENTS||intents.some(i=>!i||typeof i.key!=='string'||i.key.length!==64||typeof i.expanded!=='boolean'))throw fail('INTENTS');
 if(editNote&&(!Number.isSafeInteger(editNote.logicalRank)||editNote.logicalRank<0||editNote.logicalRank>=logicalRoot.entries.length||!['dot','before','after'].includes(editNote.position)))throw fail('NOTE_INTENT');
 const options=cursorOf(optionsRoot),preferences=cursorOf(preferencesRoot);
 for(const c of [options,preferences])if(c){if(!isHistoryPagedCursor(c)||!['array','object'].includes(c.kind))throw fail('PAGED_OPTIONS_REQUIRED');store.referenceForCursor(c);}
 const endBuild=store.beginBuild();let held,arena,lease,transferred=false;const readers=[];
 const metrics={classifierRowSinks:0,maxNativeRowSinks:1,wholeTimelineDTOs:0,globalMemoryBounded:false,
  selectedRowCompatibility:true,classifierExcludedListsPaged:true,actualUI:false};
 const check=()=>control?.assertCurrent();
 const work=createReadWorkBudget(control);
 try{
  check();held=logicalRoot.fork();arena=new HistoryProjectionArena(store,held.lease);
  // Cross-root cursors preserve their OWN owner index. Reopen a fixed number
  // of read arenas; never decode a foreign owner-root as this arena's graph.
  function read(cursor){
   store.referenceForCursor(cursor); // validate SAME store + live owner
   const address=historyPagedCursorAddress(cursor);let view;
   if(address.owners){
    // A public cursor resolves its root owner to a page. Give that exact page
    // ONE fresh alias in the frozen owner index; all children keep their own
    // original index. O(1) COW metadata, no traversal/import/UUID table.
    const alias=store.transaction(()=>{const id=address.owners.length,owners=store.vectorSet(address.owners,id,address.ref.id);
     const at=store.put({kind:'owner-root',owners,imported:address.imported,nextId:id+1,root:{type:'owner',id}},[owners.page,address.imported?.page||0]);
     return {type:'page',id:at};});
    const pin=store.lease(alias);
    try{view=new HistoryProjectionArena(store,pin);}finally{pin.release();}
   }else{view=new HistoryProjectionArena(store);view.step(()=>{view.state().value=cursor;});readers.push(view);return {value:view.state().value,cursor:view.pin.cursor().field('value')};}
   readers.push(view);return {value:view.state(),cursor:view.pin.cursor()};
  }
  const optionRead=options?read(options):null,optionValues=optionRead?.value,frozenOptions=optionRead?.cursor;
  const notesCursor=held.annotations?.notes,outlineCursor=held.annotations?.outline;
  const notes=notesCursor?read(notesCursor).value:null;
  const outline=outlineCursor?.kind==='object'?read(outlineCursor).value:null;
  const overrideCursor=held.annotations?.turnActionOverrides,summaryCursor=held.annotations?.promptSummaries;
  const overrides=overrideCursor?read(overrideCursor).value:null,summaries=summaryCursor?read(summaryCursor).value:null;
  const step=fn=>arena.step(fn),record=fields=>arena.record(fields),make=kind=>arena.make(kind);
  const s=step(()=>{const s=arena.state();s.entries=s.rows;s.logicalFacts=s.facts;
   s.options=frozenOptions||record({});s.preferences=make('array');s.prefIndex=make('map');
   s.facts=make('array');s.atoms=make('array');s.keys=make('map');s.representatives=make('array');
   s.automatic=make('array');s.semantic=make('array');s.groups=make('map');s.semanticByUuid=make('map');s.actionIndex=make('map');s.actions=make('array');s.metaIndex=make('map');s.summaryIndex=make('map');s.eligibleIndex=make('map');s.uuidIndex=make('map');
   s.outlineEligibleUuids=make('array');s.summaryEligibleUuids=make('array');
   s.forks=make('array');s.forkAnnotations=make('array');s.forkAt=make('map');s.noteIndex=make('map');
   s.notes=notesCursor||null;s.outline=outlineCursor||null;s.summaries=summaryCursor||null;s.overrides=overrideCursor||null;s.stickyOwners=make('array');s.activeSticky=null;
   s.count=s.entries.length;s.lastBoundary=-1;s.sourceGeneration=digest(optionValues?.sourceGeneration||JSON.stringify(held.base.descriptor));
   return s;});
  const o=optionValues||{},expanded=truth(o.expandedLayout),tree=truth(o.treeMode),isCodex=eq(o.toolType||'codex','codex'),isGemini=eq(o.toolType,'gemini');
  const list=(value,name)=>{if(value===undefined||value===null)return step(()=>make('array'));if(!Array.isArray(value))throw fail(name);return value;};
  const pref=(key,value)=>step(()=>{s.prefIndex.set(key,value);});
  if(preferences){if(preferences.kind!=='array')throw fail('PREFERENCES');
   const p=read(preferences).value;for(let i=0;i<p.length;i++){const item=p[i];pref(item.key,item.expanded);await work();}}
  for(const field of ['expandedAutomatic','expandedSemantic']){
   const values=list(o[field],'PREFERENCES');for(let i=0;i<values.length;i++){pref(values[i],true);await work();}
  }
  for(const intent of intents)pref(intent.key,intent.expanded);
  for(let i=0;i<(notes?.length||0);i++){step(()=>s.noteIndex.set(notes[i].entry_uuid,i));await work();}
  const normalizeAction=value=>{let result=text.trim(text.coerce(value||'')),end=result.length;
   while(end&&['.','。'].includes(text.small(text.slice(result,end-1,end))))end--;return text.slice(result,0,end);};
  const addAction=(uuid,description,role,manual)=>{if(truth(uuid)&&description.length){const index=s.actions.length;s.actions.push(record({description,role,manual}));s.actionIndex.set(uuid,index);}};
  const turns=list(outline?.outline?.turns,'OUTLINE_TURNS'),metas=list(outline?.outline?.metaPrompts,'OUTLINE_META');
  const schema=text.number(outline?.schemaVersion||outline?.outline?.schemaVersion||1);
  if(schema>=2)for(let n=0;n<turns.length;n++){
   const turn=turns[n];step(()=>addAction(text.coerce(turn?.uuid||''),normalizeAction(turn?.description||turn?.detail||''),turn?.role,false));await work();
  }
  if(overrides)for(let n=0;n<overrides.length;n++){
   const override=overrides[n];step(()=>addAction(text.coerce(override?.entryUuid||''),normalizeAction(override?.actionLabel||''),undefined,true));await work();
  }
  for(let n=0;n<metas.length;n++){step(()=>s.metaIndex.set(metas[n]?.uuid,n));await work();}
  if(summaries)for(let n=0;n<summaries.length;n++){step(()=>s.summaryIndex.set(summaries[n].entryUuid,n));await work();}
  let eligible=0;
  for(let i=0;i<s.count;i++){
   check();const e=s.entries[i];
   // Explicit selected-one-entry legacy classifier sink. Read only the fixed
   // vocabulary those existing predicates use. In particular docs, labels,
   // subagent lists and visual members NEVER enter this native DTO, even if
   // one source row alone contains N of them. Content/tags/question proof are
   // still variable-size compatibility sinks; no global memory bound claimed.
   const cursor=held.entries.at(i),selected={};
   for(const key of ['uuid','type','role','content','isCompactSummary','isSubAgent','isSubAgentTimeout','isSentHandoffProjection','semanticTags','questionReplyProof']){
    const field=cursor.field(key);if(field.kind!=='undefined')selected[key]=materialize(field,{control});
   }
   if(selected.questionReplyProof)for(const key of ['toolName','toolUseId','isError','args']){
    const field=cursor.field(key);if(field.kind!=='undefined')selected[key]=materialize(field,{control});
   }
   metrics.classifierRowSinks++;
   const automaticKind=F.timelineAutomaticGroupKind(selected),marker=markerKind(selected);
   const titleEligible=!!selected.uuid&&!selected.isSentHandoffProjection&&!selected.isSubAgent&&!selected.isSubAgentTimeout&&!P.getTerminalMcpTag(selected)&&F.isEligibleTimelineTitleEntry(selected);
   step(()=>{
    const next=s.entries[i+1],note=s.noteIndex.get(e.uuid),n=note===undefined?null:notes[note];
    s.uuidIndex.set(e.uuid,i);if(titleEligible){s.eligibleIndex.set(e.uuid,eligible++);s.outlineEligibleUuids.push(e.uuid);}
    if(!!selected.uuid&&!selected.isSentHandoffProjection&&!P.getTerminalMcpTag(selected)&&F.isEligibleTimelineTitleEntry(selected))s.summaryEligibleUuids.push(e.uuid);
    s.facts.push(record({logicalRank:i,canonicalOrdinal:s.logicalFacts[i].canonicalOrdinal,uuid:e.uuid,
     attribute:F.isTimelineAttributeEntry(selected),automaticKind,markerKind:marker,titleEligible,
     automaticIndex:null,semanticIndex:null,semanticMemberIndex:null,clusterHead:null,clusterCount:1,clusterNoise:false,
     hiddenCompact:eq(e.type,'compact')&&!!next?.isCompactSummary,
     emptyContinuation:eq(e.type,'user')&&!text.trim(text.coerce(e.content||'')).length&&!e.hasImage,
     noteOrdinal:note??null,notePosition:n?.position||'before',hasNote:truth(n?.content),
     rewindMarked:held.annotations?.hasRewindMarker?.(selected.uuid)||false,
     actionOrdinal:s.actionIndex.get(e.uuid)??null,metaPromptOrdinal:s.metaIndex.get(e.uuid)??null,
     summaryOrdinal:s.summaryIndex.get(e.uuid)??null,summaryEligible:!!selected.uuid&&!selected.isSentHandoffProjection&&!P.getTerminalMcpTag(selected)&&F.isEligibleTimelineTitleEntry(selected),
     semanticRole:undefined,semanticDetail:undefined}));
    if(!isCodex&&!isGemini&&(eq(e.type,'compact')||e.isPlan))s.lastBoundary=eq(e.type,'compact')&&next?.isCompactSummary?i+1:i;
   });await work();
  }
  if(o.lastBoundaryIndex!==undefined){if(!Number.isSafeInteger(o.lastBoundaryIndex)||o.lastBoundaryIndex< -1||o.lastBoundaryIndex>=s.count)throw fail('BOUNDARY');step(()=>{s.lastBoundary=o.lastBoundaryIndex;});}
  const snapshots=list(o.forkMarkers,'FORKS'),sessions=list(o.sessionBoundaries,'SESSIONS');
  for(let m=0;m<snapshots.length;m++){
   const marker=snapshots[m];if(!marker||typeof marker!=='object'||text.isText(marker)||Array.isArray(marker))continue;
   const uuids=Array.isArray(marker.entry_uuids)?marker.entry_uuids:step(()=>make('array')),forkOrdinal=s.forks.length;
   const f=step(()=>record({snapshotComplete:marker.snapshot_complete!==false,membership:make('set'),normalizedUuids:make('array'),snapshotCount:0,rawEmpty:false,boundaryIndex:-1,matchedCount:0,
    visible:isVisibleAppFork({hidden:marker.hidden,operationKind:text.isText(marker.operationKind)?text.materialize(marker.operationKind,'timeline-fork-kind'):marker.operationKind,
     operation_kind:text.isText(marker.operation_kind)?text.materialize(marker.operation_kind,'timeline-fork-kind'):marker.operation_kind,
     forkMode:text.isText(marker.forkMode)?text.materialize(marker.forkMode,'timeline-fork-mode'):marker.forkMode,
     fork_mode:text.isText(marker.fork_mode)?text.materialize(marker.fork_mode,'timeline-fork-mode'):marker.fork_mode,
     origin:text.isText(marker.origin)?text.materialize(marker.origin,'timeline-fork-origin'):marker.origin})}));
   step(()=>{f.marker=frozenOptions.field('forkMarkers').at(m);});
   step(()=>{const annotation=make('object');
    for(const key of ['source_session_id','fork_session_id','created_at','hidden','provider','event_key','is_direct','metadata_copied',
      'fork_mode','operation_kind','origin','source_tab_id','child_tab_id','source_project_id','child_project_id','boundary_entry_uuid','snapshot_complete'])
     if(marker[key]===null||typeof marker[key]!=='object'||text.isText(marker[key]))annotation[key]=marker[key];
    annotation.snapshotCount=0;s.forkAnnotations.push(annotation);});
   for(let n=0;n<uuids.length;n++){const id=uuids[n];if(text.isText(id)){const normalized=text.trim(id);if(normalized.length&&!f.membership.has(normalized))step(()=>{f.membership.add(normalized);f.normalizedUuids.push(normalized);});}await work();}
   // Invalid raw markers are skipped above; annotations use the compact
   // fork ordinal, while f.marker retains the original raw source position.
   step(()=>{f.snapshotCount=f.membership.size;f.rawEmpty=f.snapshotCount===0;s.forkAnnotations[forkOrdinal].snapshotCount=f.snapshotCount;});
   for(let i=0;i<s.count;i++){
    // Exact legacy timelineEntryUuid trims row UUIDs for the boundary only.
    const e=s.entries[i],id=text.trim(text.coerce(e.uuid||e.userUuid||e.entry_uuid||''));
    if(id.length&&f.membership.has(id))step(()=>{f.boundaryIndex=i;f.matchedCount++;});await work();
   }
   step(()=>{s.forks.push(f);if(f.boundaryIndex>=0&&!s.forkAt.has(f.boundaryIndex))s.forkAt.set(f.boundaryIndex,forkOrdinal);});await work();
  }
  const makeGroup=(kind,start,end,displayId)=>step(()=>{
   const first=s.entries[start];return record({kind,startIndex:start,endIndex:end,displayId,
    memberRanks:make('array'),edited:make('array'),searched:make('array'),promptLabels:make('array'),
    editedSet:make('set'),searchedSet:make('set'),labelSet:make('set'),names:make('set'),
    isLoop:false,hasPromptChip:false,hasTimeout:false,failedCount:0,mcpCount:0,scCount:0,expanded:false,forcedOpen:false,
    firstAnchor:digest(first.uuid,first.sourceIdentity,s.logicalFacts[start].canonicalOrdinal,start),key:null,membershipRevision:null});
  });
  const addDoc=(g,field,value)=>{if(text.isText(value)&&text.trim(value).length&&!g[field+'Set'].has(value)){g[field+'Set'].add(value);g[field].push(value);}};
  async function aggregate(g,rank){
   const e=s.entries[rank];step(()=>{g.memberRanks.push(rank);g.hasTimeout=g.hasTimeout||!!e.isSubAgentTimeout;
    if(e.isSubAgentTimeout)g.failedCount++;if(eq(s.facts[rank].markerKind,'terminal-mcp'))g.mcpCount++;
    if(eq(s.facts[rank].markerKind,'sc-desktop'))g.scCount++;
    if(truth(e.subAgentName))g.names.add(e.subAgentName);});
   for(const [source,target] of [['docsEdited','edited'],['docsSearchQueries','searched']]){
    const a=e[source];if(Array.isArray(a))for(let j=0;j<a.length;j++){step(()=>addDoc(g,target,a[j]));await work();}
   }
   step(()=>{if(eq(e.type,'docs_edit'))addDoc(g,'edited',e.content);if(eq(e.type,'docs_search'))addDoc(g,'searched',e.content);});
   // Classifiers already selected exactly one row above. These tag/label scans
   // keep their variable cardinality page backed and don't retain that DTO.
   const tags=e.semanticTags;if(Array.isArray(tags))for(let j=0;j<tags.length;j++){
    if(eq(tags[j]?.kind,'prompt-origin')&&eq(tags[j]?.source,'loop'))step(()=>{g.isLoop=true;});await work();
   }
   step(()=>{g.hasPromptChip=g.hasPromptChip||e.hasPromptChip===true;});
   const labels=e.promptChipLabels;if(Array.isArray(labels))for(let j=0;j<labels.length;j++){
    if(text.isText(labels[j])&&text.trim(labels[j]).length)step(()=>{const label=text.trim(labels[j]);if(!g.labelSet.has(label)){g.labelSet.add(label);g.promptLabels.push(label);}});await work();
   }
   const chips=e.promptChips;if(Array.isArray(chips))for(let j=0;j<chips.length;j++){
    if(eq(chips[j]?.kind,'prompt'))step(()=>{g.hasPromptChip=true;const label=text.isText(chips[j].label)?text.trim(chips[j].label):'';
     if(label.length&&!g.labelSet.has(label)){g.labelSet.add(label);g.promptLabels.push(label);}});await work();
   }
  }
  function finishGroup(g,h,index){step(()=>{
   g.membershipRevision=h.digest('hex');
   // A verified append can extend the SAME automatic run. Keep its user's
   // expansion preference while the immutable membership revision still
   // identifies each particular snapshot. Semantic definitions keep their
   // exact membership in the key; a rewrite changes the source generation.
   g.key=eq(g.kind,'semantic')?digest(s.sourceGeneration,g.kind,g.firstAnchor,g.membershipRevision)
    :digest(s.sourceGeneration,g.kind,g.firstAnchor);
   g.agentName=eq(g.kind,'orchestration')?'Terminal MCP':g.names.size===1?g.names.values().next().value:g.names.size>1?`${g.names.size} agents`:'Claude';
   if(!g.promptLabels.length&&g.hasPromptChip)g.promptLabels.push('PROMPT');
   s.groups.set(g.key,record({kind:g.kind,index}));
  });}
  let groupCounter=0;
  for(let i=0;i<s.count;){const kind=s.facts[i].automaticKind;if(!kind){i++;continue;}
   let end=i+1;while(end<s.count&&eq(s.facts[end].automaticKind,kind)){end++;await work();}
   const g=makeGroup(kind,i,end-1,`group-${groupCounter++}`),h=hash(),index=s.automatic.length;
   for(let rank=i;rank<end;rank++){feed(h,s.entries[rank].uuid);feed(h,rank);await aggregate(g,rank);step(()=>{s.facts[rank].automaticIndex=index;});await work();}
   finishGroup(g,h,index);step(()=>{g.expanded=s.prefIndex.get(g.key)===true;s.automatic.push(g);});i=end;await work();
  }
  // Semantic validation is exactly consecutive positions in the eligible
  // UUID stream, not consecutive logical/canonical ordinals.
  const rawGroups=list(outline?.outline?.groups,'OUTLINE_GROUPS');
  for(let n=0;n<rawGroups.length;n++){
   const raw=rawGroups[n],members=Array.isArray(raw?.memberUuids)?raw.memberUuids:null;
   if(!members||members.length<2)continue;
   const first=s.eligibleIndex.get(members[0]);if(first===undefined)continue;
   let valid=true;for(let j=0;j<members.length;j++){if(s.eligibleIndex.get(members[j])!==first+j){valid=false;break;}await work();}
   if(!valid)continue;
   const start=s.uuidIndex.get(members[0]),end=s.uuidIndex.get(members[members.length-1]);
   const g=makeGroup('semantic',start,end,raw.id),h=hash(),index=s.semantic.length;
   step(()=>{g.outlineGroup=outlineCursor.field('outline').field('groups').at(n);g.rawGroupOrdinal=n;g.title=raw.title;});
   for(let j=0;j<members.length;j++){
    const uuid=members[j],rank=s.uuidIndex.get(uuid);feed(h,uuid);feed(h,rank);
    step(()=>{s.semanticByUuid.set(uuid,record({index,memberIndex:j}));s.facts[rank].semanticIndex=index;s.facts[rank].semanticMemberIndex=j;});await aggregate(g,rank);
    const e=s.entries[rank],next=s.entries[rank+1],f=s.facts[rank];
    if(activeRangeAction||f.hasNote||f.rewindMarked||rank===s.lastBoundary||s.forkAt.has(rank)||next&&truth(e.sessionId)&&truth(next.sessionId)&&!eq(e.sessionId,next.sessionId))step(()=>{g.forcedOpen=true;});
    await work();
   }
   finishGroup(g,h,index);step(()=>s.semantic.push(g));await work();
  }
  for(let rank=0;rank<s.count;rank++){const membership=s.semanticByUuid.get(s.entries[rank].uuid);if(membership)step(()=>{s.facts[rank].semanticIndex=membership.index;s.facts[rank].semanticMemberIndex=membership.memberIndex;});await work();}
  let validSemanticPrefs=0;
  for(let g=0;g<s.semantic.length;g++){if(s.prefIndex.get(s.semantic[g].key)===true)validSemanticPrefs++;await work();}
  const explicitSemantic=Array.isArray(o.expandedSemantic),restoreLast=!preferences&&!validSemanticPrefs&&(!explicitSemantic||o.expandedSemantic.length>0);
  for(let n=0;n<s.semantic.length;n++){
   const g=s.semantic[n],start=n===0?0:g.startIndex,end=n+1<s.semantic.length?s.semantic[n+1].startIndex-1:s.count-1;
   step(()=>{g.expanded=g.forcedOpen||s.prefIndex.get(g.key)===true||restoreLast&&n===s.semantic.length-1;});
   for(let rank=start;rank<=end;rank++){
    const e=s.entries[rank],f=s.facts[rank];if(!s.semanticByUuid.has(e.uuid)&&truth(e.uuid)&&(eq(e.type,'compact')||e.isCompactSummary||isCodex&&f.emptyContinuation))step(()=>{s.semanticByUuid.set(e.uuid,record({index:n,memberIndex:-1}));f.semanticIndex=n;f.semanticMemberIndex=-1;});await work();
   }
  }
  for(let rank=0;rank<s.count;rank++){const membership=s.semanticByUuid.get(s.entries[rank].uuid);if(membership)step(()=>{s.facts[rank].semanticIndex=membership.index;s.facts[rank].semanticMemberIndex=membership.memberIndex;});await work();}
  // Last duplicate metadata wins, exactly as new Map(group.members.map(...)).
  for(let n=0;n<s.semantic.length;n++){
   const g=s.semantic[n],raw=rawGroups[g.rawGroupOrdinal],meta=list(raw.members,'SEMANTIC_MEMBER_META');
   const byUuid=step(()=>make('map'));
   for(let j=0;j<meta.length;j++){step(()=>byUuid.set(meta[j].uuid,j));await work();}
   for(let rank=0;rank<s.count;rank++)if(s.facts[rank].semanticIndex===n&&s.facts[rank].semanticMemberIndex>=0){
    const ordinal=byUuid.get(s.entries[rank].uuid),member=ordinal===undefined?null:meta[ordinal];if(member)step(()=>{s.facts[rank].semanticRole=member.role;s.facts[rank].semanticDetail=member.description||member.detail;});await work();
   }
  }
  if(isCodex)for(let i=0;i<s.count;){
   if(!eq(s.entries[i].type,'compact')){i++;continue;}const head=i;let count=0;
   while(i<s.count&&(eq(s.entries[i].type,'compact')||s.facts[i].emptyContinuation)){if(eq(s.entries[i].type,'compact'))count++;i++;await work();}
   for(let rank=head;rank<i;rank++){step(()=>{const f=s.facts[rank];f.clusterHead=head;f.clusterCount=count;f.clusterNoise=!eq(s.entries[rank].type,'compact');});await work();}
  }
  const atom=(kind,rank,base,weight=0,extra={})=>step(()=>{
   const f=rank===null?null:s.facts[rank],identity=digest(s.sourceGeneration,kind,rank,f?.uuid??'',extra.groupKey??'',extra.markerOrdinal??null);
   const a=record({key:identity,identity,kind,visualRank:s.atoms.length,logicalRank:rank,canonicalOrdinal:f?.canonicalOrdinal??null,
    baseExtent:base,flexWeight:weight,estimated:false,intrinsic:false,groupKey:null,automaticGroupIndex:f?.automaticIndex??null,
    semanticGroupIndex:f?.semanticIndex??null,noteOrdinal:null,markerOrdinal:null,sticky:false,expanded:false,
    compactClusterCount:f?.clusterCount??1,noteDot:false,isOldHistory:rank!==null&&!isCodex&&s.lastBoundary>=0&&rank<=s.lastBoundary,...extra});
   if(kind==='semantic-header')s.activeSticky=s.atoms.length;s.stickyOwners.push(s.activeSticky);s.keys.set(identity,s.atoms.length);s.atoms.push(a);return s.atoms.length-1;
  });
  if(s.count){let emptyAny=false,emptyVisible=false,firstEmpty=null;
   for(let m=0;m<s.forks.length;m++){const f=s.forks[m];if(f.rawEmpty){emptyAny=true;if(f.visible&&f.snapshotComplete){emptyVisible=true;firstEmpty??=m;}}await work();}
   let startsChild=false;for(let n=0;n<sessions.length;n++){if(truth(s.entries[0].sessionId)&&eq(sessions[n].childSessionId,s.entries[0].sessionId))startsChild=true;await work();}
   if(startsChild&&!emptyAny)atom('plan-beginning',0,8);
   if(emptyVisible)atom('fork-beginning',0,8,0,{markerOrdinal:firstEmpty});
  }
  for(let rank=0;rank<s.count;rank++){
   const e=s.entries[rank],f=s.facts[rank],g=f.automaticIndex===null?null:s.automatic[f.automaticIndex],sg=f.semanticIndex===null?null:s.semantic[f.semanticIndex];
   const semanticStart=sg&&f.semanticMemberIndex===0,autoHeader=g&&g.memberRanks.length>1&&g.startIndex===rank,autoChild=g&&g.memberRanks.length>1;
   if(expanded&&sg&&!sg.expanded&&!f.attribute){if(semanticStart){const rep=atom('semantic-header',rank,30,0,{groupKey:sg.key,sticky:true,expanded:false,estimated:true,intrinsic:true});step(()=>{sg.headerRank=rep;});}await work();continue;}
   if(autoChild&&!autoHeader&&!g.expanded||f.clusterHead!==null&&f.clusterHead!==rank||f.hiddenCompact){await work();continue;}
   if(expanded&&semanticStart){const rep=atom('semantic-header',rank,30,0,{groupKey:sg.key,sticky:true,expanded:true,estimated:true,intrinsic:true});step(()=>{sg.headerRank=rep;});}
   const collapsed=autoHeader&&!g.expanded,hasNote=f.hasNote||editNote?.logicalRank===rank,pos=editNote?.logicalRank===rank?editNote.position:f.notePosition;
   if(collapsed&&hasNote&&eq(pos,'before'))atom('note-before',rank,6,0,{noteOrdinal:f.noteOrdinal});
   if(autoHeader){const rep=atom('automatic-header',rank,20,collapsed&&!expanded?1:0,{groupKey:g.key,expanded:g.expanded,noteDot:!!hasNote&&eq(pos,'dot'),noteOrdinal:hasNote?f.noteOrdinal:null});step(()=>{g.headerRank=rep;s.representatives[rank]=rep;});}
   if(!collapsed){
    if(hasNote&&eq(pos,'before'))atom('note-before',rank,6,0,{noteOrdinal:f.noteOrdinal});
    // Same right-slot density rule as buildTimelineCornerBadges: the count
    // joins activity icons; saved prompt is upper-left and never adds density.
    let right=(g&&collapsed?g.isLoop:false)?1:0;
    if(!g||!collapsed){const tags=e.semanticTags;if(Array.isArray(tags))for(let j=0;j<tags.length;j++){if(eq(tags[j]?.kind,'prompt-origin')&&eq(tags[j]?.source,'loop')){right++;break;}await work();}}
    if(e.docsEdited?e.docsEdited.length:eq(e.type,'docs_edit')&&truth(e.content))right++;
    if(e.docsSearchQueries?e.docsSearchQueries.length:eq(e.type,'docs_search')&&truth(e.content))right++;
    if(e.subAgents?.length)right++;
    if((eq(e.type,'compact')||e.isCompactSummary)&&!tree&&f.clusterCount>1)right++;
    const base=f.markerKind==='sc-desktop'?32:right>=3||tree?22:autoChild&&g.expanded?14:20;
    const rep=atom('entry',rank,base,expanded?0:1,{groupKey:autoChild?g.key:null,noteDot:!!hasNote&&eq(pos,'dot'),noteOrdinal:hasNote?f.noteOrdinal:null,estimated:!!expanded,intrinsic:!!expanded});
    step(()=>{s.representatives[rank]=rep;});
    if(hasNote&&eq(pos,'after'))atom('note-after',rank,6,0,{noteOrdinal:f.noteOrdinal});
   }
   if(collapsed&&hasNote&&eq(pos,'after'))atom('note-after',rank,6,0,{noteOrdinal:f.noteOrdinal});
   if(rank===s.lastBoundary)atom('last-boundary',rank,8);
   const markerOrdinal=s.forkAt.get(rank),fork=markerOrdinal===undefined?null:s.forks[markerOrdinal],old=!isCodex&&s.lastBoundary>=0&&rank<=s.lastBoundary;
   if(fork?.visible&&!old)atom('fork',rank,20,0,{markerOrdinal});
   let plan=false;const next=s.entries[rank+1];
   if(rank<s.count-1&&!fork&&next&&truth(e.sessionId)&&truth(next.sessionId)&&!eq(e.sessionId,next.sessionId)){
    plan=true;for(let m=0;m<s.forks.length;m++){const membership=s.forks[m].membership;if(membership.has(e.uuid)&&membership.has(next.uuid)){plan=false;break;}await work();}
   }
   if(plan&&!old)atom('plan-boundary',rank,8);await work();
  }
  // Every hidden row resolves to its owning representative without hidden DOM
  // slots. A structural point that is itself suppressed has no fake row.
  for(let rank=0;rank<s.count;rank++){
   const f=s.facts[rank];let rep=s.representatives[rank];
   if(rep===undefined){const sg=f.semanticIndex===null?null:s.semantic[f.semanticIndex],g=f.automaticIndex===null?null:s.automatic[f.automaticIndex];
    if(expanded&&sg&&!sg.expanded&&!f.attribute)rep=sg.headerRank;
    else if(g&&g.memberRanks.length>1&&!g.expanded)rep=g.headerRank;
    else if(f.clusterHead!==null)rep=s.representatives[f.clusterHead];
    else if(f.hiddenCompact)rep=s.representatives[rank+1];
   }
   step(()=>{s.representatives[rank]=rep??null;});await work();
  }
  for(const groups of [s.automatic,s.semantic])for(let n=0;n<groups.length;n++){
   const g=groups[n];step(()=>s.preferences.push(record({key:g.key,expanded:s.prefIndex.get(g.key)===true||(!preferences&&eq(g.kind,'semantic')&&restoreLast&&n===groups.length-1)})));await work();
  }
  // Prefix counts and a paged representative interval index. A range query
  // never builds a list of UUIDs/members and does not rescan the full Timeline.
  step(()=>{s.entryPrefix=arena.own([0]);s.headerPrefix=arena.own([0]);s.notePrefix=arena.own([0]);s.stripPrefix=arena.own([0]);
   s.repMin=make('array');s.repMax=make('array');let base=1;while(base<s.count)base*=2;s.repTreeBase=base;});
  let entryCount=0,headerCount=0,noteCount=0,stripCount=0;
  for(let i=0;i<s.atoms.length;i++){
   const kind=s.atoms[i].kind;if(eq(kind,'entry'))entryCount++;else if(eq(kind,'semantic-header')||eq(kind,'automatic-header'))headerCount++;
   else if(eq(kind,'note-before')||eq(kind,'note-after'))noteCount++;else stripCount++;
   step(()=>{s.entryPrefix.push(entryCount);s.headerPrefix.push(headerCount);s.notePrefix.push(noteCount);s.stripPrefix.push(stripCount);});await work();
  }
  for(let i=0;i<s.repTreeBase;i++){const rep=i<s.count?s.representatives[i]:null;step(()=>{s.repMin[s.repTreeBase+i]=rep??s.atoms.length;s.repMax[s.repTreeBase+i]=rep??-1;});await work();}
  for(let i=s.repTreeBase-1;i>0;i--){step(()=>{s.repMin[i]=Math.min(s.repMin[i*2],s.repMin[i*2+1]);s.repMax[i]=Math.max(s.repMax[i*2],s.repMax[i*2+1]);});await work();}
  step(()=>{s.revision=digest('timeline-visual-v1',held.revision,JSON.stringify(arena.pin.descriptor));lease=arena.publish();});check();
  const out=new TimelineRootView(store,held,lease,metrics);transferred=true;return out;
 }finally{if(!transferred){lease?.release();held?.release();}arena?.close();for(const reader of readers)reader.close();endBuild();}
}

class TimelineRootView{
 constructor(store,logical,lease,metrics){this.store=store;this.logical=logical;this.lease=lease;this.root=lease.cursor();this.atoms=this.root.field('atoms');this.arena=new HistoryProjectionArena(store,lease);this.metrics=Object.freeze({...metrics});this.closed=false;this.revision=this.arena.state().revision;}
 assert(){if(this.closed)throw fail('RELEASED');this.arena.assertOpen();}
 get length(){this.assert();return this.atoms.length;}
 lookup(key){this.assert();if(typeof key!=='string'||key.length!==64)throw fail('ATOM_KEY');const rank=this.arena.state().keys.get(key);return rank===undefined?null:scalarHeader(this.atomAt(rank));}
 atomAt(rank){this.assert();if(!Number.isSafeInteger(rank)||rank<0||rank>=this.length)throw fail('VISUAL_RANK');return this.atoms.at(rank);}
 window({startOrdinal=0,limit=MAX_WINDOW}={}){this.assert();if(!Number.isSafeInteger(startOrdinal)||startOrdinal<0||startOrdinal>this.length||!Number.isSafeInteger(limit)||limit<1||limit>MAX_WINDOW)throw fail('WINDOW');
  const items=[];for(let i=startOrdinal;i<this.length&&items.length<limit;i++)items.push(scalarHeader(this.atomAt(i)));const nextOrdinal=startOrdinal+items.length;
  return Object.freeze({revision:this.revision,items:Object.freeze(items),nextOrdinal,done:nextOrdinal===this.length});}
 resolve({logicalRank,uuid}={}){this.assert();if(uuid!==undefined){const found=this.logical.lookup(uuid,{limit:2});if(found.totalMatches!==1)return{ambiguous:found.totalMatches>1,found:false};logicalRank=found.ordinals[0];}
  const s=this.arena.state();if(!Number.isSafeInteger(logicalRank)||logicalRank<0||logicalRank>=s.count)return{found:false};const rank=s.representatives[logicalRank];
  return Object.freeze({found:true,logicalRank,canonicalOrdinal:s.facts[logicalRank].canonicalOrdinal,visualRank:rank,representative:rank===null?null:scalarHeader(this.atomAt(rank)),revision:this.revision});}
 actualRow(logicalRank){this.assert();if(!Number.isSafeInteger(logicalRank)||logicalRank<0||logicalRank>=this.logical.entries.length)throw fail('LOGICAL_RANK');return this.logical.entries.at(logicalRank);}
 factsAt(logicalRank){this.actualRow(logicalRank);return this.root.field('facts').at(logicalRank);}
 group(key){this.assert();const g=this.arena.state().groups.get(key);return g?this.root.field(eq(g.kind,'semantic')?'semantic':'automatic').at(g.index):null;}
 annotationAt(kind,ordinal){this.assert();let c;
  if(kind==='action')c=this.root.field('actions');else if(kind==='meta'){const outline=this.root.field('outline');if(outline.kind==='object')c=outline.field('outline').field('metaPrompts');}
  else if(kind==='summary')c=this.root.field('summaries');else if(kind==='note')c=this.root.field('notes');
  else if(kind==='fork')c=this.root.field('forkAnnotations');
  if(!c||c.kind!=='array'||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=c.length)throw fail('ANNOTATION');return c.at(ordinal);}
 stickyAt(visualRank){this.atomAt(visualRank);const rank=this.arena.state().stickyOwners[visualRank];return rank===null?null:scalarHeader(this.atomAt(rank));}
 rangeFacts(start,end){this.assert();const logical=this.logical.rangeFacts(start,end),s=this.arena.state();
  let left=start+s.repTreeBase,right=end+s.repTreeBase,min=s.atoms.length,max=-1;
  while(left<=right){if(left%2===1){min=Math.min(min,s.repMin[left]);max=Math.max(max,s.repMax[left]);left++;}if(right%2===0){min=Math.min(min,s.repMin[right]);max=Math.max(max,s.repMax[right]);right--;}left=Math.floor(left/2);right=Math.floor(right/2);}
  const lower=rank=>{let lo=0,hi=s.atoms.length;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(s.atoms[mid].logicalRank<rank)lo=mid+1;else hi=mid;}return lo;};
  const a=lower(start),b=lower(end+1),count=prefix=>prefix[b]-prefix[a];
  return Object.freeze({...logical,visualStart:min===s.atoms.length?null:min,visualEnd:max===-1?null:max,
   visibleEntries:count(s.entryPrefix),headers:count(s.headerPrefix),notes:count(s.notePrefix),strips:count(s.stripPrefix),viewRevision:this.revision});}
 fork(){this.assert();let logical,lease;try{logical=this.logical.fork();lease=this.lease.fork();return new TimelineRootView(this.store,logical,lease,this.metrics);}catch(error){logical?.release();lease?.release();throw error;}}
 clone(){return this.fork();}
 withOptions({optionsRoot=this.root.field('options'),intents=[],editNote=null,activeRangeAction=false,control}={}){this.assert();return createTimelineRootView({store:this.store,logicalRoot:this.logical,optionsRoot,preferencesRoot:this.root.field('preferences'),intents,editNote,activeRangeAction,control});}
 stats(){this.assert();const s=this.arena.state();return{...this.metrics,revision:this.revision,logicalCount:s.count,atomCount:s.atoms.length,automaticGroups:s.automatic.length,semanticGroups:s.semantic.length,lastBoundaryIndex:s.lastBoundary,ownership:this.arena.inspectOwnership(),maxWindowItems:MAX_WINDOW};}
 release(){if(this.closed)return;this.closed=true;let error;for(const release of [()=>this.arena.close(),()=>this.lease.release(),()=>this.logical.release()])try{release();}catch(e){error||=e;}if(error)throw error;}
 close(){this.release();}
}
module.exports={createTimelineRootView,TimelineRootView,MAX_WINDOW,MAX_INTENTS};
