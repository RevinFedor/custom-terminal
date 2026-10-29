'use strict';

// Internal reader API only. The controller authenticates the parent and owns
// allocation/admission. A returned document is an independent, immutable text
// lease in that SAME store; it conveys no mutation, input or replay authority.
const {HistoryProjectionArena}=require('./history-projection-arena');
const {isHistoryPagedCursor}=require('./history-paged-store');
const {createPagedJsonProjection}=require('./history-paged-json');
const {frozenSourceBytes}=require('./codex-root-jsonl');
const {createRootPromptText}=require('./codex-root-prompt-text');
const {normalizePatchPath}=require('./codex-root-path');
const {headers:patchHeaders}=require('./codex-root-patch-text');
const ops=require('./history-root-operations');
const text=require('./history-paged-text');
const {createHash}=require('node:crypto');
const {createPagedCopyFormatter}=require('./timeline-paged-copy-format');
const fail=(code,requiredProof)=>Object.assign(new Error(code),{code,...(requiredProof?{requiredProof}:{})});
const eq=(a,b)=>text.isText(a)&&text.isText(b)?text.equal(a,b):a===b;
const truth=v=>text.isText(v)?v.length>0:!!v;
const scalar=c=>c.kind==='text'?smallCursor(c):c.scalar();
function smallCursor(c,max=8192){
 if(c.kind!=='text'||c.length>max)throw fail('TIMELINE_DOCUMENT_IDENTITY');
 let out='';for(const part of c.textChunks())out+=part;return out;
}
function exact(row,id){
 if(eq(row.uuid,id)||eq(row.sourceIdentity,id))return true;
 for(const key of ['sourceIdentityAliases','sourceUuidAliases'])if(Array.isArray(row[key]))
  for(const alias of row[key])if(eq(alias,id))return true;
 return false;
}
function physicalSession(record,fallback){
 return typeof record.__physicalSessionId==='string'&&record.__physicalSessionId.trim()||fallback||'unknown';
}
async function utf8Hash(value,checkpoint){
 const hash=createHash('sha256');let high='',n=0;
 for(const part of text.chunks(value)){
  let chunk=high+part;high='';
  if(/[\uD800-\uDBFF]$/.test(chunk)){high=chunk.at(-1);chunk=chunk.slice(0,-1);}
  hash.update(chunk,'utf8');if(++n%32===0)await checkpoint();
 }
 if(high)hash.update(high,'utf8');return hash.digest('hex');
}
function copyOptions(p={}){
 const includeTools=p.includeTools??false,includeBash=p.includeBash??false;
 return {includeEditing:p.includeEditing??false,includeReading:p.includeReading??false,
  includeSearch:p.includeSearch??includeBash,includeRun:p.includeRun??includeBash,
  includeGit:p.includeGit??includeBash,includeMcp:p.includeMcp??includeTools,
  includeWeb:p.includeWeb??p.includeWebSearch??false,
  includePlan:p.includePlan??p.includeToolSearch??p.includeOtherTools??false,
  includeOther:p.includeOther??p.includeOtherTools??p.includeToolSearch??includeTools,
  includeActions:p.includeActions??true,fromStart:p.fromStart??true,
  includeSubagentResult:p.includeSubagentResult??false,includeSubagentHistory:p.includeSubagentHistory??false,
  includeUser:p.includeUser??true,includeClaude:p.includeClaude??true,includeText:p.includeText??true,
  includeThinking:p.includeThinking??true,includeBash,includeTools,
  includeWebSearch:p.includeWebSearch??false,includeToolSearch:p.includeToolSearch??false,
  includeOtherTools:p.includeOtherTools??includeTools};
}

// Same LF/UTF-8 paged parser as the file producer. Read the held byte proof,
// NEVER the current path (which may now name different bytes or an inode).
async function scanFrozen(arena,size,onRecord,checkpoint,metrics){
 let parser,offset=0,line=0,start=0;
 const store=arena.store;
 try{
  for(const bytes of frozenSourceBytes(arena,0,size)){
   metrics.maxSourceChunkBytes=Math.max(metrics.maxSourceChunkBytes,bytes.length);
   let at=0;
   while(at<bytes.length){
    parser||=createPagedJsonProjection(store,{selectedTokenBytes:64,canonicalReducerRouted:true});
    const lf=bytes.indexOf(10,at),end=lf<0?bytes.length:lf;
    parser.write(bytes.subarray(at,end),offset+at);
    metrics.maxTokenBytes=Math.max(metrics.maxTokenBytes,parser.stats().maxTokenBytes||0);
    if(lf<0)break;
    const result=parser.finish(offset+end);parser=null;
    try{
     if(result.valid)await onRecord(result.lease.cursor(),{line,offset:start});
     else if(!result.empty)throw fail('CODEX_JSONL_RECORD_INVALID');
    }finally{result.lease?.release();}
    line++;start=offset+end+1;at=end+1;await checkpoint();
   }
   offset+=bytes.length;await checkpoint();
  }
  if(offset!==size)throw fail('TIMELINE_DOCUMENT_SOURCE_PROOF_SIZE');
  // An unfinished final record was not committed by the parent's reducer.
  metrics.partialBytes=offset-start;
 }finally{parser?.abort();}
}

// Storage port of buildCodexCleanEntries, NOT a History-unit-to-Timeline
// derivation. Growing clean rows, carrier queues, calls, rollback facts and
// selections and selected Copy formatting stay on pages. Final renderer/
// clipboard joins remain outside this producer's bounded packet seam.
function cleanProjection(arena,api,sessionId,options){
 const step=fn=>arena.step(fn),s=step(()=>{
  const s=arena.state();s.rows=arena.make('array');s.pending=arena.make('array');
  s.instructions=arena.make('array');s.calls=arena.make('map');s.topCompacts=arena.make('array');
  s.compactHead=0;s.turn=-1;s.thinking='';s.canonical=null;s.latest=null;return s;
 });
 const prompt=createRootPromptText(arena);
 const push=value=>{const row=arena.own({...value,turnIndex:s.turn});s.rows.push(row);return row;};
 const identity=(r,prefix)=>`${prefix}-${physicalSession(r,sessionId)}-${r.__line}`;
 const argsOf=p=>p.args&&typeof p.args==='object'?p.args:p.arguments!=null
  ?text.isText(p.arguments)?text.parseJson(p.arguments,{raw:p.arguments}):p.arguments
  :p.input!=null&&!text.isText(p.input)?p.input:{};
 const nameOf=p=>p.toolName||p.name||p.tool_name||p.type||'tool';
 function patchPaths(value){
  const paths=arena.make('set');
  if(text.isText(value)&&value.includes('*** Begin Patch'))for(const h of patchHeaders(value)){
   const normalized=normalizePatchPath(h.filePath);if(truth(normalized))paths.add(normalized);
  }return paths;
 }
 function samePaths(left,right){if(!left.size||left.size!==right.size)return false;
  for(const value of left)if(!right.has(value))return false;return true;}
 function attachPatch(payload){
  const direct=s.calls.get(payload?.call_id);
  if(direct&&(eq(direct.toolName,'apply_patch')||eq(direct.toolName,'exec')&&text.isText(direct.args?.input)&&direct.args.input.includes('apply_patch'))){
   direct.patches.push(payload);return;
  }
  if(!api.parseCodexPatchApplyChanges(payload))return;
  const paths=arena.make('set');for(const key of ops.keys(payload.changes||{})){
   const normalized=normalizePatchPath(key);if(truth(normalized))paths.add(normalized);
  }
  const tid=text.coerce(payload.turn_id||'');let candidate=null,count=0;
  for(const call of s.calls.values()){
   if(!eq(call.toolName,'exec')||truth(tid)&&truth(call.turnId)&&!eq(tid,call.turnId)||!text.isText(call.args?.input))continue;
   let matches=false;
   for(const nested of api.findCodexExecNestedCalls(call.args.input)){
    if(!eq(nested.toolName,'apply_patch'))continue;
    const patch=api.resolveSimpleJsCallValue(call.args.input,nested);
    if(text.isText(patch)&&samePaths(patchPaths(patch),paths)){matches=true;break;}
   }
   if(matches){candidate=call;count++;}
  }
  if(count===1){candidate.patches.push(payload);return;}if(count>1)return;
  for(const call of s.calls.values()){
   if(truth(tid)&&truth(call.turnId)&&!eq(tid,call.turnId))continue;
   if(eq(call.toolName,'apply_patch')||eq(call.toolName,'exec')&&text.isText(call.args?.input)&&call.args.input.includes('apply_patch')){
    candidate=call;count++;
   }
  }
  if(count===1)candidate.patches.push(payload);
 }
 function rollback(payload){
  const requested=Number(payload.num_turns||payload.turns||1);
  const removed=arena.make('set');
  for(let i=s.rows.length-1;requested>0&&i>=0;i--){const tid=s.rows[i].turnIndex;
   if(typeof tid==='number')removed.add(tid);if(removed.size>=requested)break;
  }
  for(let i=s.rows.length-1;i>=0;i--)if(removed.has(s.rows[i].turnIndex))s.rows.splice(i,1);
  s.turn=-1;for(const row of s.rows)s.turn=Math.max(s.turn,typeof row.turnIndex==='number'?row.turnIndex:-1);
  for(let i=s.pending.length-1;i>=0;i--)if(!s.rows.includes(s.pending[i].entry))s.pending.splice(i,1);
  s.instructions.length=0;s.thinking='';
 }
 function user(record,event){
  const p=record.payload||{},value=prompt.presentation(record),goal=prompt.goal(value);
  if(event){
   const notice=p.message||api.extractTextContent(p.content)||'';
   if(text.coerce(notice).includes('<subagent_notification>'))return;
  }else if(!truth(value)||value.includes('<subagent_notification>'))return;
  if(prompt.aborted(value)||prompt.environment(value))return;
  if(prompt.instructions(value)){
   if(event){const at=s.instructions.findIndex(v=>prompt.matches(v,value));if(at>=0)s.instructions.splice(at,1);}
   else s.instructions.push(value);
   s.canonical=value;return;
  }
  s.instructions.length=0;
  if(event){
   const at=s.pending.findIndex(v=>prompt.matches(v.text,value));
   const pending=at>=0?s.pending.splice(at,1)[0]:null;
   if(!pending)s.turn++;
   const fields={kind:goal?'goal':'user',text:goal?'Goal continued':value,sourceUuid:identity(record,'codex-user')};
   if(pending?.entry)Object.assign(pending.entry,fields);else push(fields);
  }else{
   if(truth(s.canonical)&&prompt.matches(s.canonical,value))return;
   s.turn++;const entry=push({kind:goal?'goal':'user',text:goal?'Goal continued':value,sourceUuid:identity(record,'codex-user')});
   s.pending.push({entry,text:value});
  }
  s.canonical=value;
 }
 function feed(record){return step(()=>{
  const p=record.payload||{};
  if(record.type==='compacted'){
   s.topCompacts.push(record.__line);push({kind:'compact',sourceUuid:identity(record,'codex-compact'),packet:{record,latest:s.latest}});return;
  }
  if(record.type==='event_msg'){
   if(p.type==='task_started')s.canonical=null;
   if(p.type==='patch_apply_end')attachPatch(p);
   else if(p.type==='user_message'){
    // The native compact companion prepass resets even for ignored service
    // users; only interrupted-user envelopes leave its queue untouched.
    if(!prompt.aborted(prompt.presentation(record))){s.topCompacts.length=0;s.compactHead=0;}
    user(record,true);
   }else if(p.type==='thread_rolled_back')rollback(p);
   else if(p.type==='turn_aborted')s.thinking='';
   else if(api.isCompactPayload(p)){
    if(s.compactHead<s.topCompacts.length)s.compactHead++;
    else push({kind:'compact',sourceUuid:identity(record,'codex-compact'),packet:{record,latest:s.latest}});
   }else if(p.type==='token_count')s.latest=p.info||s.latest;
   else if(p.type==='task_complete'){s.pending.length=0;s.instructions.length=0;}
   return;
  }
  if(record.type!=='response_item')return;
  if(p.type==='message'&&p.role==='user'){user(record,false);return;}
  if(p.type==='reasoning'){
   const value=api.extractReasoning(p.summary||p.content);
   if(truth(value))s.thinking=truth(s.thinking)?text.concat([s.thinking,value],'\n',arena):value;return;
  }
  if(p.type==='message'&&p.role==='assistant'){
   if(!options.includeClaude){s.thinking='';return;}
   const value=options.includeText?api.extractTextContent(p.content):'';
   const thinking=options.includeThinking&&truth(s.thinking)?text.concat(['<thinking>\n',s.thinking,'\n</thinking>'],'',arena):'';
   const content=text.concat([thinking,value].filter(truth),'\n\n',arena).trim();
   if(truth(content))push({kind:'assistant',text:content});s.thinking='';return;
  }
  if(p.type==='web_search_call'){push({kind:'tool',packet:{record}});return;}
  if(p.type==='tool_search_call'){
   s.calls.set(p.call_id||identity(record,'codex-tool-search'),{record,patches:arena.make('array')});return;
  }
  if(p.type==='function_call'||p.type==='custom_tool_call'){
   s.calls.set(p.call_id||p.id||identity(record,'codex-call'),{record,toolName:nameOf(p),args:argsOf(p),turnId:p.turn_id||'',patches:arena.make('array')});return;
  }
  if(p.type==='tool_search_output'||p.type==='function_call_output'||p.type==='custom_tool_call_output'){
   const id=p.call_id||p.id;push({kind:'tool',packet:{record,call:s.calls.get(id)}});s.calls.delete(id);
  }
 });}
 return {state:s,feed};
}

function endpoint(logical,value){
 let rank=value;
 if(typeof value==='string'){
  const match=logical.lookup(value,{limit:2});
  if(match.totalMatches!==1)throw fail(match.totalMatches?'TIMELINE_DOCUMENT_AMBIGUOUS':'TIMELINE_DOCUMENT_STALE');
  rank=match.ordinals[0];
 }else if(value&&typeof value==='object'){
  if(value.revision!==logical.revision)throw fail('TIMELINE_DOCUMENT_STALE');
  rank=value.logicalRank;
  if(value.uuid!==undefined){const found=endpoint(logical,value.uuid);if(found!==rank)throw fail('TIMELINE_DOCUMENT_STALE');}
 }
 if(!Number.isSafeInteger(rank)||rank<0||rank>=logical.entries.length)throw fail('TIMELINE_DOCUMENT_RANGE');
 if(value&&typeof value==='object'&&value.canonicalOrdinal!==undefined
  &&scalar(logical.root.field('facts').at(rank).field('canonicalOrdinal'))!==value.canonicalOrdinal)throw fail('TIMELINE_DOCUMENT_STALE');
 return rank;
}

async function prepareTimelineRootDocument({store,canonicalTimeline,logicalRoot,action,logicalStart,logicalEnd,logicalRank,
 copyOptions:requestedOptions={},control,api=require('./ipc/codex-data')._api}={}){
 if(!store||logicalRoot?.store!==store||!canonicalTimeline?.success
  ||canonicalTimeline.representation!=='codex-timeline-root-v1'||!isHistoryPagedCursor(canonicalTimeline.entries)
  ||!canonicalTimeline.checkpoint?.fork||!canonicalTimeline.sourceSnapshot)throw fail('TIMELINE_DOCUMENT_PARENT_REQUIRED');
 const assistantOnly=!!requestedOptions.assistantOnly&&(action==='turn'||action==='range');
 const contextLimit=Math.max(500,Math.min(16000,Number(requestedOptions.maxChars)||8000));
 const options=assistantOnly?copyOptions({includeUser:true,includeClaude:true,includeText:true,includeThinking:false,
  includeBash:false,includeTools:false,includeWebSearch:false,includeToolSearch:false,includeOtherTools:false})
  :copyOptions(requestedOptions); // capture all flags before the first yield
 if(!['prompt','turn','range','full','full-response'].includes(action))throw fail('TIMELINE_DOCUMENT_ACTION');
 store.referenceForCursor(canonicalTimeline.entries);logicalRoot.assert();
 let held,source,sourceArena,canonicalArena,metadataLease,logicalArena,cleanArena,pendingLease,lease,context,selectedCount,primaryError,transferred=false;
 const endBuild=store.beginBuild();
 const metrics={wholeTimelineDTOs:0,wholeHistoryDTOs:0,wholeLineStrings:0,wholeSourceRecordGraphs:0,
  maxNativeRowSinks:0,pagedCopyPackets:0,maxSelectedRowChars:0,maxSourceChunkBytes:0,maxTokenBytes:0,
  globalMemoryBounded:false,bodyStatus:'PAGED: selected Copy packet; OPEN: renderer/clipboard joins',sourceRecords:0};
 const check=()=>{if(control?.signal?.aborted)throw fail('HISTORY_READ_CONSUMER_REVOKED');control?.assertCurrent();store.assertOpen();};
 const checkpoint=async()=>{check();if(control?.checkpoint)await control.checkpoint();else await new Promise(r=>setImmediate(r));check();};
 try{
  check();held=logicalRoot.fork();source=canonicalTimeline.checkpoint.fork();
  sourceArena=new HistoryProjectionArena(store,source);logicalArena=new HistoryProjectionArena(store,held.lease);
  canonicalArena=new HistoryProjectionArena(store,canonicalTimeline.root);
  if(canonicalTimeline.sessionMeta)metadataLease=store.lease(store.referenceForCursor(canonicalTimeline.sessionMeta));
  const canonicalRows=canonicalArena.state();
  const file=sourceArena.state().file,snapshot=canonicalTimeline.sourceSnapshot;
  if(!file||file.projectionFlavor!=='timeline'||!eq(file.sessionId,snapshot.sessionId)
   ||!eq(file.filePath,snapshot.filePath)||file.fileSize!==snapshot.size||!eq(file.fileIdentity,snapshot.fileIdentity)
   ||file.fileMtimeMs!==snapshot.mtimeMs||file.fileCtimeMs!==snapshot.ctimeMs||!Number.isSafeInteger(file.fileSize)||file.fileSize<0)
   throw fail('TIMELINE_DOCUMENT_SOURCE_PROOF_REQUIRED');
  const sessionId=snapshot.sessionId,start=endpoint(held,action==='range'?logicalStart:logicalRank);
  const end=action==='range'?endpoint(held,logicalEnd):start,lo=assistantOnly?start:Math.min(start,end),hi=assistantOnly?start:Math.max(start,end);
  const logicalState=logicalArena.state(),row=logicalState.rows[start];
  // Verify canonical references against the held raw cut, including note UUID
  // substitutions. A logical rank is not a clean-export turn coordinate.
  const canonicalAt=rank=>{
   const ordinal=logicalState.facts[rank].canonicalOrdinal;
   if(ordinal===null||ordinal===undefined)return null;
   if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=canonicalRows.length)throw fail('TIMELINE_DOCUMENT_STALE');
   const raw=canonicalRows[ordinal];
   const selected=logicalState.rows[rank];
   if(!exact(selected,raw.uuid)&&!exact(selected,raw.sourceIdentity))throw fail('TIMELINE_DOCUMENT_STALE');
   return raw;
  };
  let body;
  if(action==='prompt'){
   if(!canonicalAt(start)){
    // Optional explicit caller callback transfers ONE text lease. A preview
    // or an unbound full string can never satisfy this seam.
    const pending=await api.resolveTimelinePendingPrompt?.({store,logicalRoot:held,logicalRank:start,control});
    pendingLease=pending?.lease;check();
    if(!pending?.fullPrepared||pending.logicalRevision!==held.revision||pending.logicalRank!==start
     ||!eq(pending.sourceIdentity,row.sourceIdentity||row.uuid)||!pendingLease)
     return Object.freeze({success:false,pendingSource:true,code:'TIMELINE_DOCUMENT_PENDING_SOURCE',
      logicalRank:start,revision:held.revision,requiredProof:'Complete prepared prompt text lease bound to this exact logical revision/rank/sourceIdentity; a live preview is not a full source.'});
    const content=pendingLease.cursor();store.referenceForCursor(content);
    if(content.kind!=='text')throw fail('TIMELINE_DOCUMENT_PROMPT_CONTENT_REQUIRED');
    body=content.textChunks();
   }else{
    if(!text.isText(row.content))throw fail('TIMELINE_DOCUMENT_PROMPT_CONTENT_REQUIRED');
    body=text.chunks(row.content);
   }
  }else{
   cleanArena=new HistoryProjectionArena(store);
   const clean=cleanProjection(cleanArena,api,sessionId,options),s=clean.state;
   let targetPreview=null,fullMatches=0;
   if(action==='full'||action==='full-response'){
    if(!canonicalAt(start))throw fail('TIMELINE_DOCUMENT_PENDING_SOURCE','Canonical source identity for this held final response');
    targetPreview=row.responsePreview;
    if(!targetPreview||targetPreview.version!==1||!text.isText(targetPreview.sourceIdentity)
     ||!text.isText(targetPreview.content)||!text.isText(targetPreview.contentHash)
     ||!Number.isSafeInteger(targetPreview.contentLength)||targetPreview.contentLength<targetPreview.content.length)
     throw fail('TIMELINE_DOCUMENT_FINAL_PROOF_REQUIRED');
   }else cleanArena.step(()=>{
    s.selected=cleanArena.make('map');s.compacts=cleanArena.make('set');s.selectedTurns=cleanArena.make('set');
   });
   if(!targetPreview){
    if(!canonicalAt(lo)||!canonicalAt(hi))throw fail('TIMELINE_DOCUMENT_PENDING_SOURCE','Canonical source identity for both selected logical endpoints');
    const from=logicalState.facts[lo].canonicalOrdinal,to=logicalState.facts[hi].canonicalOrdinal;
    const canonicalLo=Math.min(from,to),canonicalHi=Math.max(from,to);selectedCount=canonicalHi-canonicalLo+1;
    // Hidden Goal points still belong to the native canonical interval
    // BETWEEN the exact chosen endpoints. Mounted/logical row counts must
    // not silently remove their copy text or extend the chosen end.
    for(let ordinal=canonicalLo;ordinal<=canonicalHi;ordinal++){
    const selected=canonicalRows[ordinal];
    cleanArena.step(()=>{
     if(eq(selected.type,'compact'))s.compacts.add(selected.uuid);
     else if(eq(selected.type,'user')){
      if(s.selected.has(selected.uuid))throw fail('TIMELINE_DOCUMENT_AMBIGUOUS');s.selected.set(selected.uuid,0);
     }
    });await checkpoint();
    }
   }
   await scanFrozen(sourceArena,file.fileSize,async(cursor,address)=>{
    check();metrics.sourceRecords++;
    const record=cleanArena.step(()=>{
     const r=cursor.kind==='object'?cleanArena.own(cursor):cleanArena.make('object');
     r.__line=address.line;r.__byteOffset=address.offset;return r;
    });
    if(targetPreview){
     const p=record.payload||{},id=`codex-assistant-source-${physicalSession(record,sessionId)}-${address.offset}`;
     if(record.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&eq(id,targetPreview.sourceIdentity)){
      fullMatches++;
      if(p.phase==='commentary'||p.phase==='partial_answer'||p.isApiErrorMessage||p.is_api_error_message)throw fail('TIMELINE_DOCUMENT_FINAL_MISMATCH');
      const content=cleanArena.step(()=>api.extractTextContent(p.content));
      if(!text.isText(content)||content.length!==targetPreview.contentLength||!content.startsWith(targetPreview.content)
       ||!eq(await utf8Hash(content,checkpoint),targetPreview.contentHash))throw fail('TIMELINE_DOCUMENT_FINAL_MISMATCH');
      cleanArena.step(()=>{s.full=content;});
     }
    }else clean.feed(record);
   },checkpoint,metrics);
   if(targetPreview){
    if(fullMatches!==1)throw fail(fullMatches?'TIMELINE_DOCUMENT_AMBIGUOUS':'TIMELINE_DOCUMENT_FINAL_SOURCE_REQUIRED');
    body=text.chunks(s.full);
   }else{
    // Join selected canonical identities before consulting the clean reducer's
    // OWN turn coordinates, exactly like the native copy-range oracle.
    for(let i=0;i<s.rows.length;i++){
     const entry=s.rows[i];if((entry.kind==='user'||entry.kind==='goal')&&s.selected.has(entry.sourceUuid))cleanArena.step(()=>{
      if(s.selected.get(entry.sourceUuid)!==0||typeof entry.turnIndex!=='number'||s.selectedTurns.has(entry.turnIndex))throw fail('TIMELINE_DOCUMENT_AMBIGUOUS');
      s.selected.set(entry.sourceUuid,1);s.selectedTurns.add(entry.turnIndex);
     });if(i%32===31)await checkpoint();
    }
    for(const n of s.selected.values())if(n!==1)throw fail('TIMELINE_DOCUMENT_COPY_IDENTITY_REQUIRED');
    if(assistantOnly){
     let first=null,last=null,count=0,chars=0;
     for(let i=0;i<s.rows.length;i++){
      const entry=s.rows[i];if(entry.kind==='assistant'&&s.selectedTurns.has(entry.turnIndex)){
       const value=entry.text.trim();if(truth(value)){chars+=value.length+(count?2:0);first??=value;last=value;count++;}
      }if(i%32===31)await checkpoint();
     }
     if(!count)throw fail('TIMELINE_DOCUMENT_NO_COMPLETED_RESPONSE');
     context=Object.freeze({assistantMessageCount:count,turnIndex:canonicalAt(start).turnIndex});
     if(chars<=contextLimit)body=(function*(){let first=true;for(let i=0;i<s.rows.length;i++){
      const entry=s.rows[i];if(entry.kind!=='assistant'||!s.selectedTurns.has(entry.turnIndex))continue;
      if(!first)yield '\n\n';first=false;yield*text.chunks(entry.text.trim());
     }})();
     else{
      const head=count===1?Math.floor(contextLimit*.4):Math.min(Math.floor(contextLimit*.35),first.length);
      const tail=Math.max(0,contextLimit-head-3);
      body=(function*(){yield*text.chunks(first.slice(0,head).trimEnd());yield '\n…\n';yield*text.chunks(last.slice(-tail).trimStart());})();
     }
    }else{
    const formatPacket=createPagedCopyFormatter(cleanArena,api,check);
    const meta=metadataLease?.cursor();
    const metaValue=key=>meta?.kind==='object'?scalar(meta.field(key)):undefined;
    const cwd=scalar(source.cursor().field('file').field('cwd'))||metaValue('cwd')||'unknown';
    body=(function*(){
     let first=true,selectedCount=0;
     function* part(value){if(!first)yield '\n';first=false;yield*text.chunks(value);}
     yield*part('# Codex Range Export');yield*part(`Session: ${sessionId}`);yield*part(`CWD: ${cwd}`);
     const fork=metaValue('forked_from_id');if(fork)yield*part(`Forked from: ${fork}`);yield*part('');
     for(let i=0;i<s.rows.length;i++){
      check();const entry=s.rows[i];
      if(entry.kind==='compact'?!s.compacts.has(entry.sourceUuid)
       :entry.kind==='user'&&!options.includeUser||!s.selectedTurns.has(entry.turnIndex))continue;
      const value=entry.packet?formatPacket(entry.packet,options):entry.text;
      if(entry.packet){metrics.pagedCopyPackets=(metrics.pagedCopyPackets||0)+1;metrics.maxSelectedRowChars=Math.max(metrics.maxSelectedRowChars,value.length);}
      // Native clean projection has no row for a disabled tool. Conversely,
      // an empty User IS a structural row: its valid copy is header-only.
      if(entry.kind==='tool'&&!truth(value))continue;
      selectedCount++;if(!text.isText(value)||!truth(value.trim()))continue;
      const content=value.trim();
      if(entry.kind==='user'){yield*part('---');yield*part('');yield*part('👤 USER:');yield*part(content);yield*part('');}
      else if(entry.kind==='assistant'){yield*part('🤖 CODEX:');yield*part(content);yield*part('');}
      else if(entry.kind==='tool')yield*part(content);
      else{yield*part(content);yield*part('');}
     }
     if(!selectedCount)throw fail('TIMELINE_DOCUMENT_NO_COPYABLE_CONTENT');
    })();
    }
   }
  }
  // Pin only the resulting UTF-16 leaf; no logical/source/clean dependency
  // survives publication. beginBuild protects incremental unpinned pages.
  const writer=store.leafWriter();let chunks=0;
  for(const part of body){check();store.transaction(()=>writer.write(part));if(++chunks%32===0)await checkpoint();}
  check();const ref=store.transaction(()=>writer.finish());lease=store.lease(ref);
  const node=store.json(ref.id),cursor=lease.cursor();check();
  const result=Object.freeze({success:true,action,lease,cursor,length:node.totalChars,digest:node.digest,
   encoding:'utf16le',digestAlgorithm:'sha256',logicalRevision:held.revision,logicalStart:lo,logicalEnd:hi,
   ...(context?{context}:{}),...(selectedCount===undefined?{}:{selectedCount}),metrics:Object.freeze({...metrics}),release:lease.release});
  transferred=true;return result;
 }catch(error){primaryError=error;throw error;
 }finally{
  let cleanupError;
  for(const dispose of [()=>{if(!transferred)lease?.release();},()=>pendingLease?.release(),()=>cleanArena?.close(),
   ()=>metadataLease?.release(),()=>canonicalArena?.close(),()=>logicalArena?.close(),()=>sourceArena?.close(),
   ()=>source?.release(),()=>held?.release(),endBuild])try{dispose();}catch(error){cleanupError||=error;}
  if(cleanupError&&!primaryError){if(transferred)lease?.release();throw cleanupError;}
 }
}
module.exports={prepareTimelineRootDocument};
