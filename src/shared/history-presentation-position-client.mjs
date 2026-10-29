// Explicit coordinate capability. No row graph, native UUID Map, source proof,
// input authority, physical-key synthesis, timer, polling or retry lives here.
const PROFILE = 'history-presentation-position-v1';
const QUERY_ENCODING = 'history-presentation-position-query-v2';
const IDENTITY = ['leaseId', 'ownerKey', 'revision', 'generation'];
const CHUNK_CHARS = 128, MAX_EVENTS = 3, CREDIT = 16 * 1024, QUERY_SLOTS = 4;
const OPEN = 'agent-transcript:get-history', PAGE = 'agent-transcript:read-page';
const FORK = 'agent-transcript:fork-read-leaf', RELEASE = 'agent-transcript:release-read-root';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => Object.assign(new Error(code), { code });
const unknown = () => fail('HISTORY_READER_TRANSPORT_UNKNOWN');
const wireBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const same = (a,b) => IDENTITY.every(key => a?.[key] === b?.[key]);
const preallocationRefusal = code => ['HISTORY_ROOT_LEASE_LIMIT', 'HISTORY_ROOT_CONSUMER',
  'HISTORY_ROOT_RELEASED', 'HISTORY_ROOT_OWNER_MISMATCH', 'HISTORY_POSITION_PROFILE'].includes(code);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
function identity(value) {
  const out = {};
  for (const key of IDENTITY) {
    if (typeof value?.[key] !== 'string' || !value[key] || value[key].length > 2048) throw fail('HISTORY_POSITION_IDENTITY');
    out[key] = value[key];
  }
  return Object.freeze(out);
}
function checkOwner(owns, signal) {
  if (signal?.aborted || owns() !== true || signal?.aborted) throw fail('HISTORY_READ_CANCELLED');
}
function success(value) { if (value?.success !== true) throw fail(typeof value?.error === 'string' ? value.error : 'HISTORY_POSITION_READ_FAILED'); }
function checkedHeader(value, projectionId, unitCount, phase, parent = null) {
  success(value);
  const cap = identity(value);
  if (value.__notedHistoryTransport !== 'root-v1' || value.readProfile !== PROFILE
    || value.projectionId !== projectionId || value.unitCount !== unitCount || value.phase !== phase
    || value.sequence !== 0 || phase === 'querying' && value.pass !== 0
    || parent && (cap.leaseId === parent.leaseId
      || ['ownerKey','revision','generation'].some(key => cap[key] !== parent[key]))) throw fail('HISTORY_POSITION_HEADER');
  return cap;
}
function checkedPage(value, cap, projectionId, unitCount, sequence) {
  success(value);
  if (!same(value,cap) || value.kind !== PROFILE || value.projectionId !== projectionId
    || value.unitCount !== unitCount || value.sequence !== sequence || wireBytes(value) !== value.creditBytesUsed
    || value.creditBytesUsed > CREDIT) throw fail('HISTORY_POSITION_PAGE');
  return value;
}
function checkedResult(value, unitCount) {
  if (value?.kind === 'missing' && Object.keys(value).length === 1) return Object.freeze({kind:'missing'});
  if (value?.kind !== 'found' || ![3, 6].includes(Object.keys(value).length) || !integer(value.index) || value.index >= unitCount
    || !Number.isSafeInteger(value.memberIndex) || value.memberIndex < -1) throw fail('HISTORY_POSITION_RESULT');
  if (Object.keys(value).length === 3) return Object.freeze({kind:'found',index:value.index,memberIndex:value.memberIndex});
  if (!integer(value.memberCount) || value.memberCount < 1 || value.memberIndex >= value.memberCount
    || value.memberIndex === -1 && value.memberCount !== 1 || !integer(value.physicalKeyChars)
    || !value.selection || Object.keys(value.selection).length !== 2
    || !['prepared','current'].includes(value.selection.kind) || !integer(value.selection.ordinal)) throw fail('HISTORY_POSITION_RESULT');
  return Object.freeze({kind:'found',index:value.index,memberIndex:value.memberIndex,memberCount:value.memberCount,
    selection:Object.freeze({kind:value.selection.kind,ordinal:value.selection.ordinal}),physicalKeyChars:value.physicalKeyChars});
}
function* parts(uuid, fields = null) {
  const type = typeof uuid;
  if (!uuid || !['string','number','boolean','bigint'].includes(type)) {
    yield {...fields,type:!uuid?'skip':'unqueryable',text:'',offset:0,done:true}; return;
  }
  const text = type === 'string' ? uuid : String(uuid);
  for (let offset=0;offset<text.length;offset+=CHUNK_CHARS) {
    yield {...fields,type,text:text.slice(offset,offset+CHUNK_CHARS),offset,done:offset+CHUNK_CHARS>=text.length};
  }
}
const rawRead = (invoke, channel, request) => invoke(channel, request);
function cancellable(invoke, channel, request, {signal, owns, receipt, start, readThroughIpc = rawRead} = {}) {
  let rejectAbort;
  const aborted = new Promise((_resolve,reject)=>{rejectAbort=reject;}); aborted.catch(()=>{});
  const onAbort=()=>rejectAbort(fail('HISTORY_READ_CANCELLED'));
  signal?.addEventListener('abort',onAbort,{once:true});
  let pending;
  try {
    checkOwner(owns,signal);
    // Observe raw allocation receipts even when the existing transport settles
    // cancellation first. Only this exact operation owns its eventual cleanup.
    const trackedInvoke=(method,payload)=>{
      let raw;
      try { if(method===channel)start?.(); raw=invoke(method,payload); }
      catch(error) { if(method===channel)receipt?.(null,error); throw error; }
      if(method===channel)Promise.resolve(raw).then(value=>receipt?.(value,null),error=>receipt?.(null,error));
      return raw;
    };
    pending=Promise.resolve(readThroughIpc(trackedInvoke,channel,request,{signal}));pending.catch(()=>{});
    checkOwner(owns,signal);
  } catch(error) {signal?.removeEventListener('abort',onAbort);return Promise.reject(error);}
  return Promise.race([pending,aborted]).then(value=>{checkOwner(owns,signal);return value;})
    .finally(()=>signal?.removeEventListener('abort',onAbort));
}
function deferred() {
  let resolve, reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});
  return {promise,resolve,reject};
}
function allocationCap(value,projectionId,parent) {
  if(!value||value.readProfile!==PROFILE||value.projectionId!==projectionId)return null;
  let cap;try{cap=identity(value);}catch{return null;}
  if(parent&&(cap.leaseId===parent.leaseId||['ownerKey','revision','generation'].some(key=>cap[key]!==parent[key])))return null;
  return cap;
}
// One allocation/cleanup receipt owner. A lost or rejected ACK remains an
// observable UNKNOWN; neither the consumer nor a successor may erase it.
function allocation(invoke,projectionId,parent=null,onChange=()=>{}) {
  const done=deferred();
  let cap=null, started=false, receiptSeen=false, abandoned=false, releaseStarted=false, status='pending', error=null;
  const change=()=>onChange();
  const unresolved=reason=>{if(status!=='pending')return;status='unknown';error=reason||unknown();done.reject(error);change();};
  const confirmed=()=>{if(status!=='pending')return;status='released';done.resolve();change();};
  const release=()=>{
    if(!abandoned||!cap||releaseStarted)return;
    releaseStarted=true; // Reserve before the native invoke can reenter.
    let raw;try{raw=invoke(RELEASE,cap);}catch(reason){unresolved(reason);return;}
    Promise.resolve(raw).then(value=>{
      if(value?.success!==true||value.released!==true||!same(value,cap))throw unknown();
      confirmed();
    },reason=>{throw reason;}).catch(unresolved);
  };
  return Object.freeze({
    begin() { started=true; },
    receipt(value,reason) {
      if(receiptSeen)return;receiptSeen=true;
      cap=allocationCap(value,projectionId,parent);
      if(cap){release();return;}
      // A checked refusal is not an allocated child. A missing/malformed ACK
      // cannot prove absence, so its one slot is retained as UNKNOWN.
      if(preallocationRefusal(value?.success===false?value.error:reason?.code)){confirmed();return;}
      unresolved(reason||unknown());
    },
    adopt(value) { if(cap&&same(cap,value))return; if(receiptSeen)throw unknown();cap=identity(value);started=true;receiptSeen=true; },
    abandon() { abandoned=true;if(!started&&!cap)confirmed();else release();change(); },
    get identity(){return cap;}, get status(){return status;}, get error(){return error;},
    get releaseStarted(){return releaseStarted;}, promise:done.promise,
  });
}
function attachRetirement(error,retirement) {
  // Errors are operation-local. The owner retains this handle even if OPEN
  // was cancelled before the late raw receipt identified its parent lease.
  const result=error instanceof Error?error:unknown();
  Object.defineProperty(result,'positionRetirement',{value:retirement,configurable:true});return result;
}

export class HistoryPresentationPositionClient {
  #closed=false;
  #closeController=new AbortController();
  #slots=Array(QUERY_SLOTS).fill(null);
  #parent;
  #retirement=deferred();
  #retirementStatus='pending';
  #retirementError=null;
  constructor(invoke, cap, {projectionId,unitCount,metrics={},readThroughIpc=rawRead}) {
    Object.defineProperties(this,{invoke:{value:invoke},readThroughIpc:{value:readThroughIpc},identity:{value:identity(cap)},
      projectionId:{value:projectionId},unitCount:{value:unitCount}});
    this.metrics={recordVisits:0,transferEvents:0,maxBufferedEvents:0,queries:0,...metrics};
    this.#parent=allocation(invoke,projectionId,null,()=>this.#retired());this.#parent.adopt(this.identity);
  }
  get closed(){return this.#closed;}
  #retired(){
    if(!this.#closed)return;
    const failed=this.#parent.status==='unknown'?this.#parent:this.#slots.find(slot=>slot?.cleanup.status==='unknown')?.cleanup;
    if(failed){this.#retirementStatus='unknown';this.#retirementError=failed.error||unknown();this.#retirement.reject(this.#retirementError);return;}
    if(this.#parent.status==='released'&&this.#slots.every(slot=>slot===null)){this.#retirementStatus='released';this.#retirement.resolve();}
  }
  assertOpen(owns,signal){
    if(this.#closed||this.#closeController.signal.aborted)throw fail('HISTORY_READ_CANCELLED');
    checkOwner(owns,signal);
    if(this.#closed||this.#closeController.signal.aborted||signal?.aborted)throw fail('HISTORY_READ_CANCELLED');
  }
  async resolve(uuid,{owns=()=>true,signal,queryOwner}={}) {
    this.assertOpen(owns,signal);
    if(!['string','number','boolean','bigint'].includes(typeof uuid))throw fail('HISTORY_POSITION_QUERY_TYPE');
    if(!uuid)return Object.freeze({kind:'missing'});
    // Four actual renderer consumers, or at most four generic direct calls.
    // The token is local identity only, never an IPC capability or rank key.
    if(queryOwner!==undefined&&(queryOwner===null||typeof queryOwner!=='object'))throw fail('HISTORY_POSITION_QUERY_OWNER');
    if(queryOwner!==undefined&&this.#slots.some(slot=>slot?.owner===queryOwner))throw unknown();
    const slotIndex=this.#slots.indexOf(null);if(slotIndex<0)throw unknown();
    const parent=this.identity, projectionId=this.projectionId, unitCount=this.unitCount, invoke=this.invoke;
    const controller=new AbortController(),op={owner:queryOwner||{},cleanup:null,consumerDone:false};
    const forward=()=>controller.abort();
    this.#closeController.signal.addEventListener('abort',forward,{once:true});
    signal?.addEventListener('abort',forward,{once:true});
    if(this.#closeController.signal.aborted||signal?.aborted)controller.abort();
    const cleanup=op.cleanup=allocation(invoke,projectionId,parent,()=>{
      if(cleanup.status==='released'&&op.consumerDone&&this.#slots[slotIndex]===op)this.#slots[slotIndex]=null;
      this.#retired();
    });
    this.#slots[slotIndex]=op;
    const assert=()=>{
      this.assertOpen(owns,signal);
      if(this.#slots[slotIndex]!==op||controller.signal.aborted)throw fail('HISTORY_READ_CANCELLED');
    };
    const current=()=>{assert();return true;};
    let child=null,sequence=0,pass=0;
    try {
      assert();
      const response=await cancellable(invoke,FORK,{...parent,encoding:QUERY_ENCODING,projectionId},
        {signal:controller.signal,owns:current,receipt:cleanup.receipt,start:cleanup.begin,readThroughIpc:this.readThroughIpc});
      assert();child=checkedHeader(response,projectionId,unitCount,'querying',parent);
      let result=null;
      for(;;){
        let events=[],phase='querying',nextPass=pass;
        const flush=async()=>{
          assert();const packet=events;events=[];
          const value=await cancellable(invoke,PAGE,{...child,kind:PROFILE,projectionId,operation:'target',sequence,pass,events:packet,creditBytes:CREDIT},
            {signal:controller.signal,owns:current,readThroughIpc:this.readThroughIpc});
          assert();const page=checkedPage(value,child,projectionId,unitCount,++sequence);
          const final=packet[packet.length-1]?.done===true;
          if(page.phase==='done'&&final&&page.pass===pass){phase='done';result=checkedResult(page.result,unitCount);}
          else if(page.phase==='replay'&&final&&page.pass===pass+1&&!Object.hasOwn(page,'result')){phase='replay';nextPass=page.pass;}
          else if(page.phase!=='querying'||final||page.pass!==pass||Object.hasOwn(page,'result'))throw fail('HISTORY_POSITION_PAGE');
        };
        // An explicit replay page requests another pass over the SAME original
        // immutable scalar. No temporary key pages, new lease, retry, newer
        // owner capture or widened deadline is involved in this continuation.
        for(const event of parts(uuid)){assert();events.push(event);if(events.length===MAX_EVENTS)await flush();}
        if(events.length)await flush();assert();
        if(phase==='done'&&result)break;
        if(phase!=='replay'||!integer(nextPass)||nextPass!==pass+1)throw fail('HISTORY_POSITION_INCOMPLETE');
        pass=nextPass;
      }
      if (result?.kind === 'found' && result.selection) {
        let offset = 0, physicalKey = '', done = false;
        while (!done) {
          assert();
          const value = await cancellable(invoke,PAGE,{...child,kind:PROFILE,projectionId,operation:'selection',sequence,offset,creditBytes:CREDIT},
            {signal:controller.signal,owns:current,readThroughIpc:this.readThroughIpc});
          assert(); const page = checkedPage(value,child,projectionId,unitCount,++sequence);
          if (page.phase !== 'selection' || page.offset !== offset || typeof page.text !== 'string'
            || page.text.length > CHUNK_CHARS || page.nextOffset !== offset + page.text.length
            || typeof page.done !== 'boolean' || !page.done && !page.text.length
            || page.nextOffset > result.physicalKeyChars || page.done && page.nextOffset !== result.physicalKeyChars) {
            throw fail('HISTORY_POSITION_SELECTION_PAGE');
          }
          physicalKey += page.text; offset = page.nextOffset; done = page.done;
        }
        result = Object.freeze({kind:'found',index:result.index,memberIndex:result.memberIndex,
          memberCount:result.memberCount,selection:result.selection,physicalKey});
      }
      this.metrics.queries++;
      cleanup.abandon();
      // Cleanup ACK is not data authority. Publish the checked point without
      // waiting on it, but retain the exact slot until ACK, and fence reentry
      // from cleanup invoke/owns against the ORIGINAL client and signal.
      assert();return result;
    } catch(error) {cleanup.abandon();throw error;}
    finally {
      signal?.removeEventListener('abort',forward);
      this.#closeController.signal.removeEventListener('abort',forward);
      op.consumerDone=true;
      if(cleanup.status==='released'&&this.#slots[slotIndex]===op)this.#slots[slotIndex]=null;
      this.#retired();
    }
  }
  stats(){return {...this.metrics,closed:this.#closed,nativeCoordinateEntries:0,
    cleanupSlots:this.#slots.filter(Boolean).length,cleanupUnknown:this.#slots.filter(slot=>slot?.cleanup.status==='unknown').length,
    parentCleanup:this.#parent.status};}
  close(){
    if(!this.#closed){this.#closed=true;this.#closeController.abort();this.#parent.abandon();this.#retired();}
    return this.#parent.promise;
  }
  retirement(){const client=this;return Object.freeze({promise:this.#retirement.promise,
    get status(){return client.#retirementStatus;},get error(){return client.#retirementError;}});}
}

export async function openHistoryPresentationPosition(invoke,{projectionId,unitCount,records,owns=()=>true,signal,readThroughIpc=rawRead}={}) {
  if(typeof invoke!=='function'||!token(projectionId)||!integer(unitCount)||!records
    || typeof records[Symbol.iterator]!=='function'&&typeof records[Symbol.asyncIterator]!=='function'
    || typeof owns!=='function'||typeof readThroughIpc!=='function')throw fail('HISTORY_POSITION_CONFIGURATION');
  checkOwner(owns,signal);
  const allocated=allocation(invoke,projectionId);let client,sequence=0,events=[];
  const metrics={recordVisits:0,transferEvents:0,maxBufferedEvents:0};
  try {
    const response=await cancellable(invoke,OPEN,{toolType:'codex',readTransport:'root-v1',readProfile:PROFILE,projectionId,unitCount},
      {signal,owns,receipt:allocated.receipt,start:allocated.begin,readThroughIpc});
    checkOwner(owns,signal);const cap=checkedHeader(response,projectionId,unitCount,'writing');
    client=new HistoryPresentationPositionClient(invoke,cap,{projectionId,unitCount,metrics,readThroughIpc});
    const flush=async()=>{
      checkOwner(owns,signal);const packet=events;events=[];
      const value=await cancellable(invoke,PAGE,{...cap,kind:PROFILE,projectionId,operation:'append',sequence,events:packet,creditBytes:CREDIT},{signal,owns,readThroughIpc});
      checkOwner(owns,signal);const page=checkedPage(value,cap,projectionId,unitCount,++sequence);
      if(page.phase!=='writing'||!integer(page.records)||!integer(page.indexedKeys)
        ||page.indexedKeys>page.records)throw fail('HISTORY_POSITION_PAGE');
    };
    let physicalIndex = -1, physicalKey = null;
    for await(const record of records){
      checkOwner(owns,signal);
      if(!record||!integer(record.index)||record.index>=unitCount||!Number.isSafeInteger(record.memberIndex)
        ||!integer(record.memberCount))throw fail('HISTORY_POSITION_RECORD');
      const selected = Object.hasOwn(record,'selection');
      const fields={index:record.index,memberIndex:record.memberIndex,memberCount:record.memberCount};
      if (selected) {
        if (typeof record.physicalKey !== 'string' || record.selection !== null
          && (!['prepared','current'].includes(record.selection?.kind) || !integer(record.selection?.ordinal))) throw fail('HISTORY_POSITION_SELECTION');
        if (record.selection) Object.assign(fields,{selectionKind:record.selection.kind,selectionOrdinal:record.selection.ordinal});
        if (record.index !== physicalIndex) {
          physicalIndex = record.index; physicalKey = record.physicalKey;
          const total = physicalKey.length;
          for (let offset=0; offset < total || offset===0; offset+=CHUNK_CHARS) {
            checkOwner(owns,signal);
            events.push({field:'physical-key',index:record.index,text:physicalKey.slice(offset,offset+CHUNK_CHARS),
              offset,done:offset+CHUNK_CHARS>=total});
            metrics.transferEvents++; metrics.maxBufferedEvents=Math.max(metrics.maxBufferedEvents,events.length);
            if(events.length===MAX_EVENTS)await flush();
          }
        } else if (physicalKey !== record.physicalKey) throw fail('HISTORY_POSITION_PHYSICAL_KEY');
      }
      metrics.recordVisits++;
      for(const event of parts(record.uuid,fields)){
        checkOwner(owns,signal);events.push(event);metrics.transferEvents++;
        metrics.maxBufferedEvents=Math.max(metrics.maxBufferedEvents,events.length);
        if(events.length===MAX_EVENTS)await flush();
      }
    }
    if(events.length)await flush();checkOwner(owns,signal);
    const value=await cancellable(invoke,PAGE,{...cap,kind:PROFILE,projectionId,operation:'seal',sequence,creditBytes:CREDIT},{signal,owns,readThroughIpc});
    checkOwner(owns,signal);const page=checkedPage(value,cap,projectionId,unitCount,sequence);
    if(page.phase!=='ready'||page.records!==metrics.recordVisits||!integer(page.indexedKeys)
      ||page.indexedKeys>page.records||!integer(page.skippedFalsy)||!integer(page.unqueryableKeys))throw fail('HISTORY_POSITION_PAGE');
    Object.assign(client.metrics,metrics,{indexedKeys:page.indexedKeys,skippedFalsy:page.skippedFalsy,unqueryableKeys:page.unqueryableKeys});
    checkOwner(owns,signal);return client;
  } catch(error){
    if(client){client.close();throw attachRetirement(error,client.retirement());}
    allocated.abandon();throw attachRetirement(error,allocated);
  }
}
