// Test orchestration only. Reuses the connected Electron MCP tools; no input
// backend, provider launch, product queue, retries, or native-scroll substitute.
const running=new WeakSet();
const unknownNative=new WeakMap();
const failed=(value,message)=>Object.assign(Error(value?.error||value?.leaseError||message),
  value?.receiptVersion===1?{nativeInputReceipt:value}:{});
const decode=response=>{
  const text=response?.content?.find(item=>item.type==='text')?.text;
  let value=response?.structuredContent??response;
  if(!response?.structuredContent&&text){
    try{value=JSON.parse(text);}catch(error){if(response?.isError)throw Error(text);throw error;}
  }
  if(response?.isError)throw failed(value,text||'MCP error');
  return value;
};
const checked=response=>{const value=decode(response);if(value?.ok!==true)throw failed(value,'MCP outcome not confirmed');return value;};
const cleanReceipt=value=>value?.receiptVersion===1&&value.op==='drag'
  &&typeof value.operationId==='string'&&value.operationId.length>0
  &&['not-needed','released'].includes(value.cleanup?.state)
  &&value.cleanup.remainingMouseDown===false&&Array.isArray(value.cleanup.remainingModifiers)
  &&value.cleanup.remainingModifiers.length===0&&Array.isArray(value.cleanup.attempts)
  &&value.cleanup.attempts.length<=5
  &&value.cleanup.attempts.every(attempt=>attempt.ok===true&&['mouseUp','keyUp'].includes(attempt.kind))
  &&Number.isSafeInteger(value.events?.posted)&&value.events.posted>=0
  &&Number.isSafeInteger(value.events?.attempted)&&value.events.attempted>=value.events.posted&&value.events.attempted<=100000;
const probeKey='__notedTimedNativeDnD';
function installProbe(plan){return `(()=>{
  const key=${JSON.stringify(probeKey)},id=${JSON.stringify(plan.runId)};
  if(location.href!==${JSON.stringify(plan.targetUrl)})throw Error('target URL changed');
  if(window[key])throw Error('another timed probe owns this document');
  const send=${JSON.stringify(plan.sendSelector)},source=${JSON.stringify(plan.drag.from)};
  if(document.querySelectorAll(send).length!==1||document.querySelectorAll(source).length!==1)throw Error('exact unique targets required');
  const record={id,click:null,pointerdown:null,pointerup:null};
  const hit=(event,selector)=>event.target instanceof Element&&!!event.target.closest(selector);
  const stamp=event=>({receivedWallMs:Date.now(),eventTimestamp:event.timeStamp,trusted:event.isTrusted,pointerId:event.pointerId});
  const click=event=>{if(!record.click&&hit(event,send))record.click=stamp(event);};
  const down=event=>{if(record.click&&!record.pointerdown&&event.button===0&&hit(event,source))record.pointerdown=stamp(event);};
  const up=event=>{if(record.pointerdown&&event.pointerId===record.pointerdown.pointerId)record.pointerup=stamp(event);};
  document.addEventListener('click',click,true);document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);
  window[key]={id,record,dispose(){document.removeEventListener('click',click,true);document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',up,true);}};
  return {id};
})()`;}
function collectProbe(plan){return `(()=>{const key=${JSON.stringify(probeKey)},probe=window[key];
  if(!probe||probe.id!==${JSON.stringify(plan.runId)})return null;
  const record=probe.record;probe.dispose();delete window[key];return record;})()`;}

/** adapter.callTool(name,args) uses the EXISTING MCP connection; guard(stage)
 * must verify the parent-owned private target, resource lease, exact source,
 * two current BUSY turns and fresh headroom for C, using real read-only proof.
 * Abort cancels future steps. In-flight native input is awaited to its own
 * release; a lost native response means UNKNOWN, never a second drag/retry. */
export async function sendThenNativeDrag(adapter,input,{signal}={}){
  if(running.has(adapter))throw Error('timed sequence already owns this adapter');
  if(unknownNative.has(adapter))throw Object.assign(Error('previous native release UNKNOWN; external recovery required before another Send'),
    {nativeInputReceipt:unknownNative.get(adapter)});
  if(typeof adapter.callTool!=='function'||typeof adapter.guard!=='function')throw Error('connected tools and authoritative guard required');
  const plan=structuredClone(input);
  if(!plan.runId||!plan.targetUrl||!plan.sendSelector||!plan.drag?.from||!plan.drag.points?.length)throw Error('exact frozen plan required');
  if(!Number.isSafeInteger(plan.drag.expectedMainPid)||plan.drag.expectedMainPid<1||plan.drag.expectedMainPid>2147483647
    ||plan.drag.requireFrontmost!==true)throw Error('exact Main PID and frontmost guard required before Send');
  const waitMs=plan.waitMs??1000;
  if(!Number.isFinite(waitMs)||waitMs<0||waitMs>5000)throw Error('bounded deliberate delay required');
  for(const point of plan.drag.points){
    if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw Error('finite path required before Send');
    for(const key of ['durationMs','pauseMs','steps'])if(point[key]!==undefined&&(!Number.isFinite(point[key])||point[key]<0))throw Error('invalid native path');
  }
  const result={runId:plan.runId,status:'not-started',send:'not-attempted',native:'not-started',release:'not-held',guards:[]};
  const abort=()=>{if(signal?.aborted)throw Object.assign(Error('sequence cancelled'),{name:'AbortError'});};
  const guard=async stage=>{abort();const proof=await adapter.guard(stage,plan);result.guards.push({stage,proof});
    if(proof?.ok!==true)throw Object.assign(Error('precondition not met: '+stage),{name:'PreconditionError'});abort();};
  const preflight=async()=>{
    // Uses the backend's exact Swift Request validator, including every late
    // segment and transformed coordinate, without scrolling or posting input.
    const observation=checked(await adapter.callTool('electron_native_input_status',{dragPlan:plan.drag}));
    const admission=observation.nativeAdmission;result.nativeAdmission=admission;
    if(admission?.available!==true)result.blockingNativeInput=admission;
    if(admission?.state==='unknown'){
      result.blockingNativeInput=admission;unknownNative.set(adapter,admission);
    }
    if(admission?.version!==1||admission.state!=='available'||admission.available!==true||admission.planValidated!==true)
      throw Object.assign(Error('native owner/lease/plan admission unavailable'),{name:'PreconditionError'});
    if(observation.postEventAccess!==true)throw Error('native post-event access unavailable');
  };
  running.add(adapter);let probePossible=false;
  try{
    await guard('before-preflight'); // Prove the connected private page before reading its geometry.
    await preflight();
    await guard('before-send'); // After possible helper compilation, immediately before the timed step.
    await preflight(); // Parent guard awaited: recheck ownership/geometry before Send.
    abort();probePossible=true;result.send='attempted-outcome-unknown';
    result.steps=checked(await adapter.callTool('electron_steps',{continueOnError:false,steps:[
      {action:'evaluate',expression:installProbe(plan)},
      {action:'click',selector:plan.sendSelector,timeout:2000},
      {action:'wait',ms:waitMs},
    ]}));
    result.send='click-returned'; // Not a canonical provider Send receipt.
    await guard('before-native');
    result.native='attempted-outcome-unknown';result.release='unknown';
    const native=checked(await adapter.callTool('electron_native_drag_path',plan.drag));
    result.nativeResult=native;
    if(!cleanReceipt(native)||native.outcome!=='posted'||native.events.posted===0
      ||native.target?.expectedMainPid!==plan.drag.expectedMainPid||native.target?.requireFrontmost!==true
      ||!Number.isFinite(native.timing?.mouseDownWallMs)
      ||!Number.isFinite(native.timing?.mouseUpAfterWallMs)||!Number.isFinite(native.timing?.runEndWallMs)
      ||native.timing.mouseUpAfterWallMs<native.timing.mouseDownWallMs
      ||native.timing.runEndWallMs<native.timing.mouseUpAfterWallMs)
      throw Error('native release receipt incomplete');
    result.native='returned';result.release='backend-posted';
    result.status=signal?.aborted?'cancel-requested-after-native-release':'input-sequence-returned';
  }catch(error){
    result.status=error.name==='AbortError'?'cancelled-before-native':error.name==='PreconditionError'?'precondition-not-met':'stopped';result.error=error.message;
    if(error.nativeInputReceipt){
      result.nativeReceipt=error.nativeInputReceipt;
      const receipt=error.nativeInputReceipt;
      if(receipt.transport?.blockingState==='unknown'){
        result.blockingNativeInput={state:'unknown',blockingOperationId:receipt.transport.blockingOperationId,
          blockingReceipt:receipt.transport.blockingReceipt||receipt};
        unknownNative.set(adapter,result.blockingNativeInput);
      }
      if(receipt.op==='preflight'&&receipt.outcome==='unknown')unknownNative.set(adapter,receipt);
      if(result.native==='attempted-outcome-unknown'&&cleanReceipt(receipt)&&receipt.ok===false
        &&['not-posted','failed','cancelled'].includes(receipt.outcome)){
        result.native='failure-returned';
        result.release=receipt.events.posted===0?'not-held':'backend-posted';
      }
    }
  }
  finally{
    if(result.release==='unknown')unknownNative.set(adapter,result.nativeReceipt||result.nativeResult||{error:result.error});
    if(probePossible)try{
      // electron_evaluate returns {value}, whereas steps/native return {ok,...}.
      const value=decode(await adapter.callTool('electron_evaluate',{expression:collectProbe(plan)}));
      if(!value||!Object.hasOwn(value,'value'))throw Error('probe read outcome not confirmed');
      result.events=value.value;
      const click=result.events?.click?.receivedWallMs,down=result.events?.pointerdown?.receivedWallMs;
      result.sendToReceivedPointerMs=Number.isFinite(click)&&Number.isFinite(down)?down-click:null;
      const posted=result.nativeResult?.timing?.mouseDownWallMs;
      result.sendToPostedPointerMs=Number.isFinite(click)&&Number.isFinite(posted)?posted-click:null;
    }catch(error){result.observationError=error.message;}
    running.delete(adapter);
  }
  return result;
}
