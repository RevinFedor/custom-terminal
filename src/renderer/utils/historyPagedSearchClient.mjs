import {HistoryRootClient,historyRootIdentity,isHistoryRootDescriptor} from './historyRootReadClient.mjs';
import {readHistoryThroughIpc} from './historyReadTransport.mjs';
import {readTimelineSelectedValue} from './timelineRootReadModel.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const equal=(a,b)=>['leaseId','ownerKey','revision','generation'].every(k=>a?.[k]===b?.[k]);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const check=value=>{if(!value)throw fail('HISTORY_SEARCH_HEADER_INVALID');};
function header(value,scope){
 const identity=historyRootIdentity(value),s=value.sourceSnapshot;
 check(value.success===true&&value.__notedHistoryTransport==='root-v1'&&value.readProfile==='history-search-v1'
  &&value.searchSchema1===1&&isHistoryRootDescriptor(value.root)&&equal(value.root,identity)&&value.root.kind==='array'
  &&value.viewRevisionToken===identity.revision&&/^[a-f0-9]{64}$/.test(identity.revision)
  &&['total','entryTotal','offset','limit','returned','totalEntries'].every(k=>integer(value[k]))
  &&value.limit>=1&&value.limit<=5000&&value.returned<=value.limit&&value.root.length===value.returned&&value.totalEntries===value.returned
  &&value.offset<=Number.MAX_SAFE_INTEGER-value.returned&&(value.returned===0||value.offset+value.returned<=value.total)
  &&typeof value.truncated==='boolean'&&value.truncated===(value.offset+value.returned<value.total)
  &&value.markerCoverage==='complete'&&value.currentMatchCoverage==='complete'
  &&value.root.protocol==='history-root-v1'&&typeof value.root.nodeToken==='string'&&value.root.nodeToken.length>0&&value.root.nodeToken.length<=8192
  &&s&&s.sessionId===scope.sessionId&&typeof s.filePath==='string'&&typeof s.fileIdentity==='string'
  &&typeof s.sourceGeneration==='string'&&integer(s.size)&&Number.isFinite(s.mtimeMs)&&Number.isFinite(s.ctimeMs));
 const root=Object.freeze({...identity,protocol:'history-root-v1',kind:'array',nodeToken:value.root.nodeToken,length:value.root.length});
 return Object.freeze({...identity,readProfile:'history-search-v1',searchSchema1:1,root,total:value.total,entryTotal:value.entryTotal,
  offset:value.offset,limit:value.limit,returned:value.returned,truncated:value.truncated,
  sourceSnapshot:Object.freeze({filePath:s.filePath,sessionId:s.sessionId,fileIdentity:s.fileIdentity,sourceGeneration:s.sourceGeneration,
   size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs})});
}
export class HistoryPagedSearchClient{
 constructor(invoke,result,scope){this.header=header(result,scope);this.identity=historyRootIdentity(result);this.invoke=invoke;
  this.reader=new HistoryRootClient(invoke,this.header.root,{pageBytes:16384,pageItems:3});this.references=new Set(['owner']);this.closed=false;this.lane=null;}
 async serial(operation){while(this.lane)await this.lane.catch(()=>{});if(this.closed)throw fail('HISTORY_READ_CANCELLED');
  const work=Promise.resolve().then(operation);this.lane=work;try{return await work;}finally{if(this.lane===work)this.lane=null;}}
 async matches({signal}={}){
  return this.serial(async()=>{const out=[];let offset=0;
   while(offset<this.header.returned){if(signal?.aborted)throw fail('HISTORY_READ_CANCELLED');
    const page=await this.reader.range(this.reader.root,{offset,limit:3});
    for(const item of page.items){const value=await readTimelineSelectedValue(this.reader,item.value,{signal});
     check(value&&typeof value.entryUuid==='string'&&integer(value.matchIndex)&&value.matchIndex===this.header.offset+out.length);
     out.push(Object.freeze(value));}
    if(page.nextOffset<=offset)throw fail('HISTORY_SEARCH_PAGE_PROGRESS');offset=page.nextOffset;
   }check(out.length===this.header.returned);return Object.freeze(out);
  });
 }
 async entryFlags(entryUuids){return this.serial(async()=>{
  if(!Array.isArray(entryUuids)||entryUuids.length<1||entryUuids.length>3)throw fail('HISTORY_SEARCH_IDS');
  const result=await this.invoke('agent-transcript:read-page',{...this.identity,nodeToken:this.reader.root.nodeToken,kind:'search-flags',entryUuids,creditBytes:16384});
  check(result?.success===true&&equal(result,this.identity)&&result.nodeToken===this.reader.root.nodeToken&&result.kind==='search-flags'
   &&Array.isArray(result.items)&&result.items.length===entryUuids.length&&integer(result.creditBytesUsed)
   &&result.creditBytesUsed<=16384&&new TextEncoder().encode(JSON.stringify(result)).byteLength===result.creditBytesUsed
   &&result.items.every((v,i)=>v.entryUuid===entryUuids[i]&&typeof v.match==='boolean'));
  return result.items;
 });}
 retain(){if(this.closed)throw fail('HISTORY_READ_CANCELLED');const token={};this.references.add(token);return()=>this.release(token);}
 async release(token){if(!this.references.delete(token)||this.references.size)return;this.closed=true;await this.reader.close();}
 close(){return this.release('owner');}
}
export async function openHistoryPagedSearch(invoke,payload,{signal}={}){
 let observed,client,released=false;
 const discard=async value=>{if(released||!value?.leaseId)return;released=true;
  try{await invoke('agent-transcript:release-read-root',historyRootIdentity(value));}catch(error){console.warn('[HistorySearch] release-unconfirmed code='+String(error?.code||error?.message));}};
 const guarded=(channel,request)=>Promise.resolve(invoke(channel,request)).then(result=>{
  if(channel==='agent-transcript:search-history'){observed=result;if(signal?.aborted)void discard(result);}return result;});
 try{
  const result=await readHistoryThroughIpc(guarded,'agent-transcript:search-history',{...payload,toolType:'codex',readTransport:'root-v1',readProfile:'history-search-v1'},{signal});
  if(result?.success!==true)throw fail(result?.error||'HISTORY_SEARCH_FAILED');
  client=new HistoryPagedSearchClient(invoke,result,payload);const matches=await client.matches({signal});
  if(signal?.aborted)throw fail('HISTORY_READ_CANCELLED');
  return Object.freeze({success:true,...client.header,matches,searchClient:client});
 }catch(error){if(client)await client.close();else await discard(observed);throw error;}
}
