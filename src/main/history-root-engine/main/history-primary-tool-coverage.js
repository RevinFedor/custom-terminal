'use strict';

// Read only the held pre-overlay semantic cut and its frozen captured claims.
// Three claims at most; no inventory of historical IDs/results and no new pins.
const {createHash}=require('node:crypto');
const fail=(code,fields)=>Object.assign(new Error(code),{code,...fields});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const object=c=>['object','map','set'].includes(c.kind);
const truth=c=>c.kind==='text'?c.length>0:['object','array','map','set'].includes(c.kind)?true:!!c.scalar();
async function textEqual(a,b,check,checkpoint,suffix='') {
 if(a.kind!=='text'||b.kind!=='text'||a.length+suffix.length!==b.length)return false;
 const left=(function*(){yield* a.textChunks();if(suffix)yield suffix;})();
 const right=b.textChunks();let x='',y='',xd=false,yd=false,steps=0;
 try{for(;;){check();if(!x&&!xd){const n=left.next();x=n.value||'';xd=!!n.done;}
  if(!y&&!yd){const n=right.next();y=n.value||'';yd=!!n.done;}
  if(xd&&yd)return !x&&!y;
  const n=Math.min(x.length,y.length);if(!n||x.slice(0,n)!==y.slice(0,n))return false;
  x=x.slice(n);y=y.slice(n);if(++steps%64===0)await checkpoint();
 }}finally{left.return?.();right.return?.();}
}
async function strictEqual(a,b,check,checkpoint) {
 if(a.kind==='text'||b.kind==='text')return textEqual(a,b,check,checkpoint);
 const container=c=>['object','array','map','set'].includes(c.kind);
 if(container(a)||container(b))return container(a)&&container(b)&&a.identity()===b.identity();
 return a.scalar()===b.scalar(); // Preserve NaN, -0, undefined and object identity; never JSON/deep equality.
}
async function covered(entries,key,expected,check,checkpoint) {
 let steps=0;
 for(const row of entries.rows()) {
  check();const actions=row.field('actions');
  if(actions.kind!=='array')continue;
  for(const action of actions.rows()) {
   check();if(!object(action))continue;
   const raw=action.field('rawTool'),direct=action.field('toolUseId');
   const id=direct.kind==='text'?direct:object(raw)?raw.field('toolUseId'):direct;
   if(id.kind!=='text'||!id.length)continue;
   const tool=action.field('tool');
   if(tool.kind==='text'&&tool.length===4&&[...tool.textChunks()].join('')==='Task') {
    if(await textEqual(id,key,check,checkpoint)||await textEqual(id,key,check,checkpoint,':canonical:0'))return 'task';
   }else if(tool.kind==='text'&&tool.length===7&&[...tool.textChunks()].join('')==='__raw__'
     &&object(raw)&&await textEqual(id,key,check,checkpoint)) {
    const result=raw.field('result'),ref=truth(raw.field('resultRef'));
    if((ref?result.kind==='text':await strictEqual(result,expected.field('result'),check,checkpoint))
      &&truth(raw.field('isError'))===truth(expected.field('isError')))return ref?'result-ref':'raw';
   }
   if(++steps%32===0)await checkpoint();
  }
  if(++steps%32===0)await checkpoint();
 }
 check();return 'absent'; // Only a complete canonical/action scan can publish a known negative.
}
async function readPrimaryToolCoverage(plane,state,request,{consumerKey,control}={}) {
 const allowed=['leaseId','ownerKey','revision','generation','nodeToken','kind','offset','limit','creditBytes',
  'semanticIdentity','metadataIdentity','claimRevision','readDemandId','diagnosticReadId','diagnosticActionId','_historyRootConsumerKey'];
 const p=state.primaryPresentation;
 if(Object.keys(request).some(k=>!allowed.includes(k))||!p?.toolCoverageInputs
  ||request.semanticIdentity!==p.semanticIdentity||request.metadataIdentity!==p.metadataIdentity
  ||!integer(request.claimRevision)||!request.claimRevision||!integer(request.offset)
  ||!integer(request.limit)||request.limit<1||request.limit>3||!integer(request.creditBytes)
  ||request.creditBytes<512||request.creditBytes>65536
  ||plane.cursor(state,request.nodeToken).identity()!==p.durableMetadataCursor.identity())throw fail('HISTORY_PRIMARY_TOOL_QUERY_INVALID');
 const check=()=>{control?.assertCurrent();plane.state(request,consumerKey);};
 const checkpoint=async()=>{check();if(control?.checkpoint)await control.checkpoint();else await tick();check();};
 const {claims,entries,hashCursor}=p.toolCoverageInputs();
 if(!['map','array'].includes(claims.kind)||entries.kind!=='array')throw fail('HISTORY_PRIMARY_TOOL_CLAIMS_REQUIRED');
 const pairs=claims.kind==='map'?claims.pairs():(function*(){for(const value of claims.rows())yield [value.field('toolUseId'),value];})();
 const packet={success:true,...plane.identity(state),nodeToken:request.nodeToken,kind:request.kind,
  semanticIdentity:p.semanticIdentity,metadataIdentity:p.metadataIdentity,claimRevision:request.claimRevision,
  offset:request.offset,nextOffset:request.offset,done:false,items:[],creditBytesUsed:0};
 const bytes=()=>{let old;do{old=packet.creditBytesUsed;packet.creditBytesUsed=Buffer.byteLength(JSON.stringify(packet));}while(old!==packet.creditBytesUsed);return packet.creditBytesUsed;};
 let at=0,ended=true;
 for(const [key,value]of pairs) {
  check();if(at++<request.offset){if(at%32===0)await checkpoint();continue;}
  if(packet.items.length===Math.min(request.limit,plane.maxItems,3)){ended=false;break;}
  if(key.kind!=='text'||!key.length||!object(value))throw fail('HISTORY_PRIMARY_TOOL_CLAIM_INVALID');
  const proof=await covered(entries,key,value,check,checkpoint);
  const hash=createHash('sha256');await hashCursor(plane.store,value,hash,{assertCurrent:check,checkpoint});
  const item={ordinal:at-1,key:plane.describe(state,key,{inline:false}),fingerprint:hash.digest('hex'),proof,covered:proof!=='absent'};
  packet.items.push(item);packet.nextOffset=at;
  const required=bytes();
  if(required>request.creditBytes){packet.items.pop();packet.nextOffset=at-1;ended=false;
   if(!packet.items.length)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL',{minimumCreditBytes:required});break;}
 }
 if(at<request.offset)throw fail('HISTORY_PRIMARY_TOOL_OFFSET');
 packet.done=ended;check();if(bytes()>request.creditBytes)throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
 plane.metrics.maxReturnedItems=Math.max(plane.metrics.maxReturnedItems,packet.items.length);
 plane.metrics.maxPacketBytes=Math.max(plane.metrics.maxPacketBytes,packet.creditBytesUsed);
 return packet;
}
module.exports={readPrimaryToolCoverage};
