'use strict';

// A proved canonical field source, never thin metadata or a live/view alias.
// Normal inputs use the existing complete index as candidates only. Oversized
// inputs receive a signed full-semantic cursor for fixed-page comparison.
const fail=(code,extra)=>Object.assign(new Error(code),{code,...extra});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const PROOF='canonical-prompt-identity-v1';
async function readPrimaryPromptIdentity(plane,state,request,{consumerKey,control}={}) {
 const allowed=['leaseId','ownerKey','revision','generation','nodeToken','parentNodeToken','kind','mode','value',
  'semanticIdentity','metadataIdentity','metadataSchema','semanticRevisionToken','viewRevisionToken','canonicalEntryCount',
  'creditBytes','readDemandId','diagnosticReadId','diagnosticActionId','_historyRootConsumerKey'];
 const p=state.primaryPresentation;
 if(Object.keys(request).some(k=>!allowed.includes(k))||request.kind!=='primary-prompt-identity'||!p?.toolCoverageInputs
  ||p.metadataSchema!==1||p.semanticSnapshotComplete!==true||p.headerCursor?.kind!=='array'||p.durableMetadataCursor?.kind!=='array'
  ||request.metadataSchema!==1||request.semanticIdentity!==p.semanticIdentity||request.metadataIdentity!==p.metadataIdentity
  ||request.semanticRevisionToken!==p.semanticRevisionToken||request.viewRevisionToken!==p.viewRevisionToken
  ||request.revision!==p.viewRevisionToken||!integer(request.canonicalEntryCount)||request.canonicalEntryCount!==p.canonicalEntryCount
  ||!integer(request.creditBytes)||request.creditBytes<512||request.creditBytes>65536
  ||!['point','scan'].includes(request.mode)||(request.mode==='scan'?request.value!==null:
    typeof request.value!=='string'||request.value.length>2048||Buffer.byteLength(request.value)>4096)
  ||plane.cursor(state,request.parentNodeToken).identity()!==p.headerCursor.identity()
  ||plane.cursor(state,request.nodeToken).identity()!==p.durableMetadataCursor.identity()
  ||request.parentNodeToken!==plane.nodeToken(state,p.headerCursor)||request.nodeToken!==plane.nodeToken(state,p.durableMetadataCursor)) {
  throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_QUERY_INVALID');
 }
 const {entries}=p.toolCoverageInputs(),indexes=p.settingsIndexes;
 if(entries.kind!=='array'||entries.length!==request.canonicalEntryCount||p.durableMetadataCursor.length!==entries.length
  ||entries.identity()!==indexes?.entries?.identity())throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_CUT_REQUIRED');
 const check=()=>{
  control?.assertCurrent();
  if(control?.signal?.aborted)throw fail('HISTORY_READ_CANCELLED');
  if(plane.state(request,consumerKey)!==state||state.primaryPresentation!==p)throw fail('HISTORY_ROOT_OWNER_MISMATCH');
  p.toolCoverageInputs();
 };
 let work=0;
 const checkpoint=async()=>{
  if(++work%64===0){if(control?.checkpoint)await control.checkpoint();else await tick();}
  check();
 };
 const exact=request.mode==='point'?request.value.trim():'';
 const matches=async selected=>{
  check();if(selected.kind!=='text'||selected.length!==exact.length)return false;
  let at=0;
  for(const chunk of selected.textChunks()){
   check();if(chunk!==exact.slice(at,at+chunk.length))return false;
   at+=chunk.length;await checkpoint();
  }
  return at===exact.length;
 };
 const rowMatches=async row=>{
  if(row.kind!=='object')throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_ROW');
  if(await matches(row.field('uuid'))||await matches(row.field('sourceIdentity')))return true;
  for(const name of ['sourceIdentityAliases','sourceUuidAliases']){
   const aliases=row.field(name);if(aliases.kind!=='array')continue;
   for(let at=0;at<aliases.length;at++){
    check();if(await matches(aliases.at(at)))return true;await checkpoint();
   }
  }
  return false;
 };
 check();indexes.assertOpen();let match=null;
 for(let from=0;exact&&from<entries.length;){
  check();const candidates=indexes.lookup(exact,{offset:from,limit:3,aliases:true});
  for(const ordinal of candidates.ordinals){
   check();
   // The index includes broader aliases; ONLY complete canonical fields prove
   // a match. The returned row is still the metadata descriptor at that rank.
   if(await rowMatches(entries.at(ordinal))){
    check();const row=p.durableMetadataCursor.at(ordinal);
    if(row.kind!=='object')throw fail('HISTORY_PRIMARY_PROMPT_IDENTITY_ROW');
    match={ordinal,row:plane.describe(state,row,{inline:false})};break;
   }
  }
  if(match||candidates.done)break;
  if(candidates.nextOffset<=from||candidates.nextOffset>entries.length)throw fail('HISTORY_ROOT_INDEX_RANGE');
  from=candidates.nextOffset;await checkpoint();
 }
 check();
 const packet={success:true,...plane.identity(state),kind:'primary-prompt-identity',mode:request.mode,proof:PROOF,
  nodeToken:request.nodeToken,parentNodeToken:request.parentNodeToken,semanticIdentity:p.semanticIdentity,metadataIdentity:p.metadataIdentity,
  metadataSchema:1,semanticRevisionToken:p.semanticRevisionToken,viewRevisionToken:p.viewRevisionToken,
  canonicalEntryCount:entries.length,value:request.value,canonical:plane.describe(state,entries,{inline:false}),match,creditBytesUsed:0};
 let old;
 do{old=packet.creditBytesUsed;packet.creditBytesUsed=Buffer.byteLength(JSON.stringify(packet));}while(old!==packet.creditBytesUsed);
 if(packet.creditBytesUsed>request.creditBytes)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:packet.creditBytesUsed});
 check();plane.metrics.pages++;plane.metrics.maxPacketBytes=Math.max(plane.metrics.maxPacketBytes,packet.creditBytesUsed);
 plane.metrics.maxReturnedItems=Math.max(plane.metrics.maxReturnedItems,match?1:0);return packet;
}
module.exports={readPrimaryPromptIdentity};
