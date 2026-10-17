// Diagnostic data only: no store imports, layout reads, user text or retained DOM.
const absNow = () => performance.timeOrigin + performance.now();
// Never coerce objects (toString/toJSON can expose content), or copy a URL.
const short = (value, limit = 140) => typeof value === 'string'
  && !/\w+:\/\/|^(?:data|blob|javascript|mailto|tel):|^\/\/|www\./i.test(value.slice(0, limit))
  ? value.slice(0, limit).replace(/[\r\n\t]/g, ' ') : '';
const round = value => Math.round(value * 10) / 10;
export const DIAGNOSTIC_COUNTER_LIMIT = 0xffffffff;
const increment = value => Math.min(DIAGNOSTIC_COUNTER_LIMIT, value + 1);
export const UI_ACTION_COVERAGE = 'temporal-overlap; frames-are-callbacks-not-pixel-proof';
const shortcuts = new Set(['Copy', 'Cut', 'Paste', 'SelectAll', 'DeleteToStart', 'Undo', 'Redo']);
// Snapshots are data, unlike DOM/KeyboardEvent objects whose getters live on
// their prototypes. Do not accept inherited fields or invoke snapshot getters.
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? round(value) : null;
const keyClass = key => {
  switch (key) {
    case 'Meta': case 'Control': case 'Alt': case 'Shift': case 'Escape': case 'Enter': case 'Tab': return key;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'Arrow': return 'Arrow';
    case ' ': case 'Space': return 'Space';
    default: return 'Other';
  }
};

export function describeDiagnosticKey(event) {
  if (event?.type !== 'keydown' && event?.type !== 'keyup') return {};
  // Read key/code only to classify them. Never retain either or enumerate an event.
  const fields = { keyClass: keyClass(event.key), meta: event.metaKey === true, ctrl: event.ctrlKey === true,
    alt: event.altKey === true, shift: event.shiftKey === true, repeat: event.repeat === true };
  if ((fields.meta || fields.ctrl) && !fields.alt) {
    // Physical code is classified, never retained. Plain typing remains Other.
    let code;
    try { code = event.code; } catch { /* An unavailable accessor keeps the ordinary key evidence. */ }
    const shortcut = typeof code === 'string' ? { KeyC: 'Copy', KeyX: 'Cut', KeyV: 'Paste', KeyA: 'SelectAll',
      Backspace: fields.meta ? 'DeleteToStart' : null, KeyZ: fields.shift ? 'Redo' : 'Undo' }[code] : null;
    if (shortcuts.has(shortcut)) fields.shortcutClass = shortcut;
  }
  return fields;
}

function keySnapshot(snapshot) {
  const result = Object.create(null);
  if (typeof own(snapshot, 'keyClass') !== 'string') return result;
  result.keyClass = keyClass(own(snapshot, 'keyClass'));
  if (shortcuts.has(own(snapshot, 'shortcutClass'))) result.shortcutClass = own(snapshot, 'shortcutClass');
  for (const field of ['meta', 'ctrl', 'alt', 'shift', 'repeat']) result[field] = own(snapshot, field) === true;
  return result;
}

function targetSnapshot(target) {
  return Object.assign(Object.create(null), { tag: short(own(target, 'tag'), 40),
    source: short(own(target, 'source'), 180), tab: short(own(target, 'tab'), 80),
    historyOwner: short(own(target, 'historyOwner'), 80) });
}

function clipboardSnapshot(value) {
  const result = Object.create(null);
  for(const key of ['rangeCount','selectedChars']) result[key] = finite(own(value,key));
  for(const key of ['collapsed','sameTextNode','defaultPreventedAtCapture','finalDefaultPrevented','trusted']) {
    const field = own(value,key);
    result[key] = typeof field === 'boolean' ? field : null;
  }
  for(const key of ['anchorTab','focusTab','anchorEntry','focusEntry']) result[key] = short(own(value,key),80);
  return result;
}

export function describeDiagnosticClipboard(event) {
  if (!['copy','cut','paste'].includes(event?.type)) return null;
  const result = {defaultPreventedAtCapture:event.defaultPrevented === true,
    finalDefaultPrevented:null,trusted:event.isTrusted === true};
  try {
    const doc = event.target?.ownerDocument || globalThis.document;
    const selection = doc?.getSelection?.();
    if (!selection) return clipboardSnapshot(result);
    result.rangeCount=selection.rangeCount;result.collapsed=selection.isCollapsed;
    result.sameTextNode=!!selection.anchorNode && selection.anchorNode===selection.focusNode && selection.anchorNode.nodeType===3;
    result.selectedChars=result.sameTextNode ? Math.abs(selection.focusOffset-selection.anchorOffset) : null;
    for(const [prefix,node] of [['anchor',selection.anchorNode],['focus',selection.focusNode]]) {
      const element=node?.nodeType===3 ? node.parentElement : node;
      result[prefix+'Tab']=element?.closest?.('[data-tab-id]')?.getAttribute('data-tab-id') || '';
      result[prefix+'Entry']=element?.closest?.('[data-entry-uuid]')?.getAttribute('data-entry-uuid') || '';
    }
  } catch { /* Missing selection stays unknown. Never read its text for diagnosis. */ }
  return clipboardSnapshot(result);
}

export function recordUIClipboardOutcome(action, event) {
  if (!action?.clipboardState) return;
  action.clipboardState.finalDefaultPrevented=event ? event.defaultPrevented === true : null;
}

export function createUIClipboardOutcomeQueue({emit=console.warn,postTask,now=absNow,max=32}={}) {
  const pending=[];
  let channel=null,scheduled=false,disposed=false,dropped=0;
  max=Math.max(1,Math.min(32,Number.isSafeInteger(max)?max:32));
  const report=(action,event,reason)=>{
    try { recordUIClipboardOutcome(action,event); }
    catch {
      action.clipboardState.finalDefaultPrevented=null;
      reason='event-unavailable';dropped=increment(dropped);
    }
    try {
      emit('[Perf:ClipboardOutcome] '+JSON.stringify({actionId:action.id,observedAbs:round(now()),
        finalDefaultPrevented:action.clipboardState.finalDefaultPrevented,reason,dropped}));
    } catch { dropped=increment(dropped); /* Never interfere with the native clipboard command. */ }
  };
  const flush=()=>{
    scheduled=false;
    for(const entry of pending.splice(0)){
      const event=entry.event.deref();
      report(entry.action,event,event?'post-dispatch-task':'event-unavailable');
    }
  };
  const schedule=()=>{
    if(postTask)return postTask(flush);
    channel ||= new MessageChannel();
    channel.port1.onmessage=flush;
    channel.port2.postMessage(0);
  };
  return {
    enqueue(action,event){
      if(!action?.clipboardState || disposed)return;
      if(pending.length>=max){dropped=increment(dropped);report(action,null,'queue-overflow');return;}
      pending.push({action,event:new WeakRef(event)});
      if(scheduled)return;
      scheduled=true;
      try {schedule();} catch {scheduled=false;for(const entry of pending.splice(0))report(entry.action,null,'task-unavailable');}
    },
    dispose(){disposed=true;pending.length=0;channel?.port1.close();channel?.port2.close();},
    health(){return {clipboardOutcomeDropped:dropped,pendingClipboardOutcomes:pending.length};},
  };
}

// The direct watchdog gets a thin allowlisted record, never the phase/style
// arrays or an Event/DOM reference. null means that boundary was not measured.
export function summarizeUIAction(action, timing = {}) {
  return Object.assign(Object.create(null), {
    event: short(own(action, 'event') || own(timing, 'event'), 24),
    target: targetSnapshot(own(action, 'target')),
    ...keySnapshot(action),
    ...(own(action,'clipboardState') ? {clipboardState:clipboardSnapshot(own(action,'clipboardState'))} : {}),
    inputDelayMs: finite(own(timing, 'inputDelayMs')),
    handlerMs: finite(own(timing, 'handlerMs')),
    presentationMs: finite(own(timing, 'presentationMs')),
    browserInteractionId: finite(own(timing, 'browserInteractionId')),
    coverage: UI_ACTION_COVERAGE,
  });
}

export function formatDiagnosticKey(snapshot) {
  const fields = keySnapshot(snapshot);
  return fields.keyClass ? ' keyClass=' + fields.keyClass + ['meta', 'ctrl', 'alt', 'shift', 'repeat']
    .map(field => ' ' + field + '=' + Number(fields[field])).join('')
    + (fields.shortcutClass ? ' shortcutClass=' + fields.shortcutClass : '') : '';
}

// A gesture belongs to this UIAction recorder, not to a mounted sidebar host.
// Only scalar latest input is touched on pointermove. Samples share its rAF.
const DRAG_FRAME_CAP = 120, DRAG_PHASE_CAP = 32, DRAG_MEMBER_CAP = 128;
const dragStrings = ['gestureId','sessionId','sourceId','owner','ownerKey','workflowId','paneKey',
  'windowId','zone','reason','presentation','mutationId','operationId','runId','axis'];
const dragNumbers = ['pointerId','eventAbs','x','y','left','top','width','height','grabX','grabY',
  'ownerEpoch','revision','at','boundary','depth','scrollTop','scrollLeft','processed','received',
  'sourceLayoutTop','intendedTop','forestOffset','previousBoundaryTop','nextBoundaryTop','queuedOverwrites','generation','publicationRevision','membershipRevision','sourceCount','familyCount','paneCount'];
function dragFields(value) {
  const out = Object.create(null);
  out.identifiersTruncated=0;
  for(const key of dragStrings)if(typeof own(value,key)==='string' && own(value,key).length>120)out.identifiersTruncated++;
  for (const key of dragStrings) if (typeof own(value,key)==='string') out[key]=short(own(value,key),120);
  for (const key of dragNumbers) if (typeof own(value,key)==='number') out[key]=Number.isFinite(own(value,key))?own(value,key):null;
  for (const key of ['meta','accepted','confirmed','current','matches','captured']) if(typeof own(value,key)==='boolean') out[key]=own(value,key);
  return out;
}

function dragFramePacket(value) {
  if(!value || typeof value!=='object')return value;
  const out=Object.create(null);
  if(Number.isFinite(value.abs))out.abs=value.abs;
  if(value.axis==='x' || value.axis==='y')out.axis=value.axis;
  for(const key of dragNumbers)if(Object.hasOwn(value,key))out[key]=value[key];
  for(const key of ['meta','accepted','confirmed','current','matches','captured'])
    if(typeof value[key]==='boolean')out[key]=value[key];
  return out;
}

const dragAuthorDemand=(author,input)=>!!author && !!input
  && (author.axis!=='y' && input.x!==author.x || author.axis!=='x' && input.y!==author.y);

function createDragDiagnostics({now,emit,onPendingFrame,matching,actions,appendPhase}) {
  let config={mode:'summary',hz:null,slowMs:50,runId:'',operationId:''}, active=null;
  let emitFailed=0, partialGestures=0;
  const mark=(d,phase)=>{
    if(d.config.mode!=='frames')return;
    const name='noted-drag:'+short(d.gestureId || d.action?.id || 'unmatched',120)+':'+phase;
    try { performance.mark(name);performance.clearMarks(name); }
    catch {d.markerUnavailable=increment(d.markerUnavailable || 0);}
  };
  const safeEmit=(tag,value,serialized=null)=>{try {emit(tag+' '+(serialized ?? JSON.stringify(value)));}catch{emitFailed=increment(emitFailed);}};
  const phase=(d,name,fields)=>{
    const item={name,abs:round(now()),...fields};
    if(d.phases.length>=DRAG_PHASE_CAP){d.phases.splice(8,1);d.phaseOmitted=increment(d.phaseOmitted);}
    d.phases.push(item);
  };
  const summary=(d,reason,partial)=>({schema:1,actionId:d.action?.id || null,gestureId:d.gestureId,
    runId:d.config.runId,operationId:d.config.operationId,mode:d.config.mode,hz:d.config.hz,slowMs:d.config.slowMs,
    down:d.down,thresholdAbs:d.thresholdAbs,releaseAbs:d.releaseAbs,endAbs:round(now()),reason,partial,
    inputPackets:d.packets,inputMovePackets:d.moves,coalesced:d.config.mode==='frames'?d.coalesced:null,coalescedUnavailable:d.config.mode==='frames'?d.coalescedUnavailable:null,
    invalidTimestamp:d.invalidTimestamp,frameSampleOverwrites:d.config.mode==='frames'?d.sampleOverwrites:null,
    frames:d.frames,movingFrames:d.movingFrames,maxCallbackGapMs:d.frames?round(d.maxGap):null,maxDeliveryDelayMs:d.validPackets?round(d.maxDelivery):null,
    maxMovingInputAgeMs:d.movingFrames?round(d.maxMovingAge):null,maxAuthoredLagMs:d.author&&d.frames?round(d.maxAuthorLag):null,
    authoredAxis:d.author?.axis || null,
    maxAuthoredErrorX:d.author&&d.frames&&d.author.axis!=='y'?round(d.maxAuthorErrorX):null,
    maxAuthoredErrorY:d.author&&d.frames&&d.author.axis!=='x'?round(d.maxAuthorErrorY):null,
    processedStampUnavailable:d.processedStampUnavailable,maxProcessInputAgeMs:d.processedStamped?round(d.maxProcessAge):null,
    firstAuthoredAbs:d.firstAuthoredAbs,
    authoredWrites:d.authoredWrites,authoredChanges:d.authoredChanges,
    firstLayoutAbs:d.firstLayoutAbs,latestInput:d.input,latestCapture:d.capture,identifiersTruncated:d.identifiersTruncated,latestAuthor:d.author,latestLayout:d.layout,
    latestProcessed:d.processed,latestPublished:d.published,latestGeometry:d.geometry,latestTarget:d.target,phaseOmitted:d.phaseOmitted,memberOmitted:d.memberOmitted,memberOmittedKind:'upper-bound-after-cap',
    frameEvicted:Math.max(0,d.frames-DRAG_FRAME_CAP),counterSaturated:d.packets===DIAGNOSTIC_COUNTER_LIMIT,
    coverage:'browser-event-stamp/JS/authored/React-layout; no OS event ID, compositor or pixel receipt',
    limits:{frames:DRAG_FRAME_CAP,maxStoredFrameObjects:DRAG_FRAME_CAP+8+24,phases:DRAG_PHASE_CAP,members:DRAG_MEMBER_CAP,first:8,slow:24,tail:8},emitFailed});
  const finish=(reason,partial=false)=>{
    const d=active;if(!d)return null;active=null;
    // Ordinary eligible clicks already belong to UIAction. A pending pickup
    // that never crossed the threshold must add neither drag logs nor frames.
    if(d.thresholdAbs===null && !partial)return null;
    partial ||= !d.action || d.memberOmitted>0 || d.phaseOmitted>0 || (d.planOmitted || 0)>0 || d.identifiersTruncated>0;
    if(partial)partialGestures=increment(partialGestures);
    mark(d,'end');
    const report=summary(d,reason,partial);
    report.markerUnavailable=d.markerUnavailable || 0;
    let detailText=null;
    report.detailWindow=d.config.mode!=='frames'?'disabled':d.slow.length || partial?'bounded-window':'not-triggered';
    if(d.config.mode==='frames' && (d.slow.length || partial)){
      const detail={schema:1,gestureId:d.gestureId,actionId:d.action?.id || null,runId:d.config.runId,
        partial,plan:d.plan,planOmitted:d.planOmitted || 0,members:d.members,memberOmitted:d.memberOmitted,phases:d.phases,phaseOmitted:d.phaseOmitted,
        first:d.first,slow:d.slow,tail:d.ring.slice(-8),frameEvicted:report.frameEvicted,
        slowPostMissing:Math.max(0,d.slowPost),limits:{...report.limits,serializedChars:65536},emitFailed};
      // Packet owner strings repeat on every frame. The bounded phases and
      // summary retain the full identities; frame packets join by owner epoch
      // and revision. Compact only at release, outside the move/frame path.
      detail.framePacketIdentity='ownerEpoch/revision; full owners in phases/summary';
      detailText=JSON.stringify(detail,(key,value)=>
        ['processed','published','geometry','author','layout','target'].includes(key)
          ? dragFramePacket(value) : value);
      if(detailText.length>65536){if(!report.partial)partialGestures=increment(partialGestures);report.partial=true;report.detailOmitted='serialized-cap';
        detailText=JSON.stringify({schema:1,gestureId:d.gestureId,partial:true,detailOmitted:'serialized-cap',
          chars:detailText.length,limitChars:65536});}
    }
    if(d.action){
      // The existing 96-action ring retains a cheap join record, never frame windows.
      d.action.drag={gestureId:d.gestureId,reason,endAbs:report.endAbs,partial:report.partial};
      appendPhase(d.action,'drag-end',{reason,ms:report.endAbs-d.down.abs,frames:d.frames});
    }
    safeEmit('[Perf:DragSummary]',report);
    if(detailText!==null)safeEmit('[Perf:DragWindow]',null,detailText);
    return report;
  };
  const event=(name,raw={})=>{
    if(config.mode==='off')return;
    const f=dragFields(raw);
    if(name==='pending'){
      if(active)finish('diagnostic-replaced',true);
      const action=matching('pointerdown',f.eventAbs);
      active={config:{...config},gestureId:f.gestureId || null,action,pointerId:f.pointerId,
        identifiersTruncated:f.identifiersTruncated,down:{abs:f.eventAbs ?? round(now()),receivedAbs:round(now()),...f},input:null,processed:null,
        author:null,layout:null,target:null,thresholdAbs:null,releaseAbs:null,firstAuthoredAbs:null,firstLayoutAbs:null,
        packets:0,moves:0,coalesced:0,coalescedUnavailable:0,invalidTimestamp:0,sampleOverwrites:0,lastSampleSeq:0,
        frames:0,movingFrames:0,validPackets:0,maxGap:0,maxDelivery:0,maxMovingAge:0,
        maxAuthorLag:0,maxAuthorErrorX:0,maxAuthorErrorY:0,processedStampUnavailable:0,processedStamped:0,maxProcessAge:0,authoredWrites:0,authoredChanges:0,lastFrameAbs:null,
        previousInput:null,phases:[],phaseOmitted:0,members:[],memberOmitted:0,ring:[],first:[],slow:[],slowScore:0,slowPost:0};
      phase(active,name,f);return;
    }
    const d=active;
    if(!d || (f.gestureId && d.gestureId && f.gestureId!==d.gestureId)){
      // Durable ACK may arrive after physical release or a following click.
      if(f.gestureId){
        const action=actions.find(a=>a.drag?.gestureId===f.gestureId);
        const commit=name.startsWith('commit-');
        const receipt=['layout-receipt','commit','cancel','release-preview'].includes(name);
        if(commit || (receipt && action)){
          if(action){
            action.drag.latePhases=(action.drag.latePhases || 0)+1;
            if(action.drag.latePhases>16){
              action.drag.lateOmitted=increment(action.drag.lateOmitted || 0);
              if(action.drag.lateOmitted===1)safeEmit('[Perf:DragCommit]',{gestureId:f.gestureId,actionId:action.id,
                partial:true,reason:'late-phase-cap',limit:16});
              return;
            }
            appendPhase(action,name,{revision:f.publicationRevision ?? f.revision,reason:f.reason});
          }
          safeEmit('[Perf:DragCommit]',{abs:round(now()),actionId:action?.id || null,partial:!action,
            postPhysical:true,name,...f});
        }
      }
      return;
    }
    d.identifiersTruncated=Math.min(DIAGNOSTIC_COUNTER_LIMIT,d.identifiersTruncated+f.identifiersTruncated);
    if(f.gestureId)d.gestureId=f.gestureId;
    if(name==='start' && f.gestureId && !d.boundMarker){mark(d,'bound');d.boundMarker=true;}
    if(name==='threshold'){
      d.thresholdAbs ??= now();mark(d,'threshold');
      if(d.config.mode==='frames')onPendingFrame();
    }
    const item={abs:now(),...f};
    if(name==='authored'){
      d.authoredWrites=increment(d.authoredWrites);
      if(!d.author || d.author.left!==f.left || d.author.top!==f.top){
        d.authoredChanges=increment(d.authoredChanges);
        if(d.firstAuthoredAbs===null){d.firstAuthoredAbs=item.abs;mark(d,'first-authored');}
      }
      d.author=item;
      if(dragAuthorDemand(item,d.input))d.authorDemandSince ??= d.input.receivedAbs;
      else d.authorDemandSince=null;
      return;
    }
    if(name==='processed'){d.processed=item;
      if(Number.isFinite(f.eventAbs)){d.processedStamped=increment(d.processedStamped);d.maxProcessAge=Math.max(d.maxProcessAge,item.abs-f.eventAbs);}
      else d.processedStampUnavailable=increment(d.processedStampUnavailable);return;}
    if(name==='published'){d.published=item;return;}
    if(name==='geometry'){d.geometry=item;return;}
    if(name==='layout-receipt'){d.layout=item;d.firstLayoutAbs ??= item.abs;return;}
    if(name==='target')d.target=item;
    if(name==='physical-end'){d.releaseAbs=d.input?.type==='pointerup' || d.input?.type==='pointercancel'
      ? d.input.receivedAbs : null;phase(d,name,f);return finish(f.reason || 'release');}
    if(name==='click-release'){phase(d,name,f);return finish('click-no-drag');}
    if((name==='cancel' || name==='pending-cancel') && !d.thresholdAbs){phase(d,name,f);return finish(f.reason || 'cancel');}
    phase(d,name,f);
  };
  return {
    event,
    configure(value={}){
      if(active)finish('diagnostic-mode-changed',true);
      const mode=own(value,'mode');
      if(['off','summary','frames'].includes(mode))config.mode=mode;
      const hz=own(value,'hz');config.hz=Number.isFinite(hz)&&hz>=20&&hz<=1000?hz:null;
      const slow=own(value,'slowMs');config.slowMs=Number.isFinite(slow)&&slow>0?Math.min(1000,slow):config.hz?2000/config.hz:50;
      config.runId=short(own(value,'runId'),120);config.operationId=short(own(value,'operationId'),120);
      safeEmit('[Perf:DragControl]',{abs:round(now()),...config});return {...config};
    },
    actionId(gestureId){
      if(active?.gestureId===gestureId)return active.action?.id || null;
      return actions.find(a=>a.drag?.gestureId===gestureId)?.id || null;
    },
    enabled(){return config.mode!=='off';},
    pending(){return !!active?.thresholdAbs && active.config.mode==='frames';},
    input(event){
      const d=active;if(!d || config.mode==='off' || event.pointerId!==d.pointerId)return;
      const receivedAbs=now(),eventAbs=performance.timeOrigin+event.timeStamp;
      if(event.type==='gotpointercapture' || event.type==='lostpointercapture'){
        d.capture={type:event.type,abs:round(receivedAbs),eventAbs:finite(eventAbs),pointerId:event.pointerId};
        phase(d,event.type,{pointerId:event.pointerId});return;
      }
      if(!Number.isFinite(eventAbs)||eventAbs>receivedAbs+2){d.invalidTimestamp=increment(d.invalidTimestamp);}
      const valid=Number.isFinite(eventAbs)&&eventAbs<=receivedAbs+2;
      if(d.input && d.lastSampleSeq!==d.packets)d.sampleOverwrites=increment(d.sampleOverwrites);
      d.packets=increment(d.packets);if(event.type==='pointermove')d.moves=increment(d.moves);
      // No Event, target, text or coalesced coordinate list survives this callback.
      const p=d.input || (d.input={});
      Object.assign(p,{seq:d.packets,type:event.type,eventAbs:valid?round(eventAbs):null,receivedAbs:round(receivedAbs),
        x:event.clientX,y:event.clientY,meta:event.metaKey===true,buttons:event.buttons});
      if(dragAuthorDemand(d.author,p))d.authorDemandSince ??= receivedAbs;
      else d.authorDemandSince=null;
      if(valid){d.validPackets=increment(d.validPackets);d.maxDelivery=Math.max(d.maxDelivery,receivedAbs-eventAbs);}
      if(d.config.mode==='frames' && event.type==='pointermove'){
        try {if(typeof event.getCoalescedEvents==='function')d.coalesced=Math.min(DIAGNOSTIC_COUNTER_LIMIT,d.coalesced+event.getCoalescedEvents().length);
          else d.coalescedUnavailable=increment(d.coalescedUnavailable);}
        catch{d.coalescedUnavailable=increment(d.coalescedUnavailable);}
      }
    },
    admission(admission){
      const d=active;if(!d || !admission || config.mode==='off')return;
      if(admission?.gestureId && d.gestureId && d.gestureId!==admission.gestureId)return;
      if(admission?.gestureId)d.gestureId=short(admission.gestureId,120);
      // Scalar guard projection only. Never traverse a tab/History object or stringify the admission.
      d.plan={};d.planOmitted=0;
      for(const key of ['sourceRootIds','rootTabIds','familyIds','paneFamilyIds']){
        const ids=admission[key] || [];d.plan[key]=ids.slice(0,DRAG_MEMBER_CAP).map(id=>short(id,120));
        d.planOmitted+=Math.max(0,ids.length-DRAG_MEMBER_CAP);
      }
      const guards=admission.guards || {}, seen=new Set();
      d.members=[];
      let omitted=0;for(const ids of [admission.familyIds || [],admission.paneFamilyIds || []])for(const id of ids){
        if(seen.has(id))continue;
        if(seen.size>=DRAG_MEMBER_CAP){omitted++;continue;}
        seen.add(id);const g=guards[id];if(!g){omitted++;continue;}d.members.push({id:short(id,120),namespace:short(g.namespace,120),
          workflowId:short(g.workflowId,120),membershipRevision:finite(g.membershipRevision),
          storageId:finite(g.storageId),subjectId:short(g.subjectId,120),parentTabId:short(g.parentTabId,120),
          visualParentTabId:short(g.visualParentTabId,120),groupId:short(g.groupId,120),groupRevision:finite(g.groupRevision)});
      }
      // Once full, omitted is an upper bound (an unseen ID can occur in both families).
      d.memberOmitted=omitted;
      const sourceLayout=admission.workflows?.[admission.sourceWorkflowId]?.layout;
      const sourceIndex=/^pane:(\d+)$/.exec(admission.sourcePaneKey || '');
      phase(d,'admission',{gestureId:d.gestureId,workflowId:admission.sourceWorkflowId,
        paneKey:admission.sourcePaneKey,windowId:sourceIndex?sourceLayout?.splitPanes?.[Number(sourceIndex[1])]?.windowId:null,
        sourceCount:admission.sourceRootIds?.length || 0,
        familyCount:admission.familyIds?.length || 0,paneCount:admission.paneFamilyIds?.length || 0,
        publicationRevision:admission.organizationRevision ?? admission.expectedRevision ?? null});
    },
    frame(at,rafTimestampAbs=at){
      const d=active;if(!d || d.config.mode!=='frames' || !d.thresholdAbs)return;
      const input=d.input?{...d.input}:null;
      const moving=!!input && (!d.previousInput || input.x!==d.previousInput.x || input.y!==d.previousInput.y);
      const gap=at-(d.lastFrameAbs ?? d.thresholdAbs),age=input?.eventAbs==null?null:at-input.eventAbs;
      const errorX=input && d.author && d.author.axis!=='y'?input.x-d.author.x:null;
      const errorY=input && d.author && d.author.axis!=='x'?input.y-d.author.y:null;
      const needsAuthor=errorX!==null && Math.abs(errorX)>.01 || errorY!==null && Math.abs(errorY)>.01;
      const authorLag=needsAuthor?at-Math.max(d.author.abs,d.authorDemandSince ?? input.receivedAbs):0;
      if(d.author){d.maxAuthorLag=Math.max(d.maxAuthorLag,authorLag);
        d.maxAuthorErrorX=Math.max(d.maxAuthorErrorX,Math.abs(errorX || 0));
        d.maxAuthorErrorY=Math.max(d.maxAuthorErrorY,Math.abs(errorY || 0));}
      if(moving)d.movingFrames=increment(d.movingFrames);
      const sample={abs:round(at),rafTimestampAbs:round(rafTimestampAbs),gapMs:round(gap),moving,
        needsAuthor,errorX,errorY,authorLagMs:d.author?round(authorLag):null,
        input,processed:d.processed,published:d.published,geometry:d.geometry,author:d.author,layout:d.layout,target:d.target};
      d.frames=increment(d.frames);d.maxGap=Math.max(d.maxGap,gap);
      if(moving && age!==null)d.maxMovingAge=Math.max(d.maxMovingAge,age);
      if(d.first.length<8)d.first.push(sample);
      if(d.slowPost>0){d.slow.push(sample);d.slowPost--;}
      const score=Math.max(gap,moving?age || 0:0,authorLag);
      if(score>=d.config.slowMs && score>d.slowScore){
        d.slowScore=score;d.slow=[...d.ring.slice(-8),sample];d.slowPost=15;
      }
      d.ring.push(sample);if(d.ring.length>DRAG_FRAME_CAP)d.ring.shift();
      d.lastFrameAbs=at;d.lastSampleSeq=d.packets;d.previousInput=input;
    },
    failed(){emitFailed=increment(emitFailed);},
    dispose(){finish('document-disposed',true);},
    health(){return {dragEmitFailed:emitFailed,dragPartialGestures:partialGestures};},
  };
}

export function createUIActionDiagnostics({ now = absNow, emit = console.warn, notify = () => {}, onPendingFrame = () => {}, max = 96 } = {}) {
  const boot = Math.floor(now()).toString(36);
  let sequence = 0, current = null, dropped = 0, phasesDropped = 0;
  max = Number.isFinite(max) ? Math.max(1, Math.min(96, Math.floor(max))) : 96;
  const actions = [];
  const capture = (event, eventAbs, target = {}, frameProof = true, keys = {}) => {
    const action = { id: 'ui-' + boot + '-' + (++sequence).toString(36), event: short(event, 24),
      startAbs: eventAbs, receivedAbs: now(), target: targetSnapshot(target),
      ...((event === 'keydown' || event === 'keyup') ? keySnapshot(keys) : {}),
      phases: [], phasesDropped: 0, frameProof, frames: 0, frame1Abs: null, frame2Abs: null };
    actions.push(action); if (actions.length > max) { actions.shift(); dropped = increment(dropped); }
    current = action;
    if (frameProof) onPendingFrame();
    return action;
  };
  const appendPhase = (action, name, values = {}) => {
    const fields = Object.create(null);
    for (const key of Object.keys(values).slice(0, 10)) {
      if (['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) continue;
      const value = own(values, key);
      if (typeof value === 'number' && Number.isFinite(value)) fields[short(key, 32)] = round(value);
      else if (typeof value === 'boolean') fields[short(key, 32)] = value;
      else if (['tab', 'owner', 'reason'].includes(key)) fields[key] = short(value, 80);
    }
    if (action.phases.length >= 32) {
      action.phases.splice(8, 1); action.phasesDropped = increment(action.phasesDropped);
      phasesDropped = increment(phasesDropped);
    }
    action.phases.push({ name: short(name, 140), at: round(now()), ...fields });
  };
  const phase = (name,values={})=>{
    if(current && now()-current.receivedAbs<=2000)appendPhase(current,name,values);
  };
  const matching = (event, eventAbs) => {
    let nearest = null, distance = 2;
    for (let i = actions.length - 1; i >= 0; i--) {
      const delta = Math.abs(actions[i].startAbs - eventAbs);
      if (actions[i].event === event && delta < distance) { nearest = actions[i]; distance = delta; }
      if (distance === 0) break;
    }
    return nearest;
  };
  const report = (action, kind, durationMs, extra = {}) => {
    const data = { ...action, kind, durationMs: round(durationMs),
      ...summarizeUIAction(action, extra),
      inputDelayMs: finite(own(extra, 'inputDelayMs')) ?? round(action.receivedAbs - action.startAbs),
      ringDropped: dropped };
    emit('[Perf:UIAction] ' + JSON.stringify(data));
    if (durationMs >= 100) notify({ id: action.id, event: action.event, startAbs: action.startAbs, durationMs });
  };
  const drag=createDragDiagnostics({now,emit,onPendingFrame,matching,actions,appendPhase});
  return {
    drag, capture, phase, matching,
    phaseForAction(id,name,values={}){
      const action=actions.find(action=>action.id===id);
      if(!action)return false;
      appendPhase(action,name,values);return true;
    },
    eventTiming(event, eventAbs, durationMs, extra = {}) {
      const action = matching(event, eventAbs);
      if (action) report(action, 'event-timing', durationMs, extra);
      return action;
    },
    frame(at, styles = null, rafTimestampAbs = at) {
      // Snapshot: an action captured reentrantly starts on the next callback.
      for (const action of [...actions]) {
        if (!Number.isFinite(action.receivedAbs) || !action.frameProof || action.frames >= 2 || action.receivedAbs > at) continue;
        if (styles) {
          action.styles ||= { added: [], removed: [], omitted: 0 };
          for (const key of ['added', 'removed']) {
            const merged = [...action.styles[key], ...styles[key]];
            action.styles[key] = merged.slice(0, 24);
            action.styles.omitted += Math.max(0, merged.length - 24);
          }
          action.styles.omitted += styles.omitted;
        }
        action.frames++;
        if (action.frames === 1) { action.frame1Abs = round(at); action.frame1RafTimestampAbs = round(rafTimestampAbs); }
        else {
          action.frame2Abs = round(at);
          action.frame2RafTimestampAbs = round(rafTimestampAbs);
          report(action, 'second-frame', at - action.startAbs);
        }
      }
    },
    currentId() { return current && now() - current.receivedAbs <= 2000 ? current.id : null; },
    pending() { const at = now(); return actions.some(a => a.frameProof && a.frames < 2
      && Number.isFinite(a.receivedAbs) && a.receivedAbs <= at); },
    health() { return { actionRingEvicted: dropped, actionPhasesDropped: phasesDropped }; },
  };
}

// One owned request for actions and opt-in active gestures. No timers, DOM reads or idle sampling.
// A ticket is installed before requesting so reentrant wakes cannot duplicate it.
export function createUIFrameScheduler({ request, cancel, hasPending, onFrame, onIdle = () => {} }) {
  let ticket = null, running = false, disposed = false;
  const wake = () => {
    if (disposed || running || ticket || !hasPending()) return;
    const own = { id: null };
    ticket = own;
    own.id = request(timestamp => {
      if (disposed || ticket !== own) return;
      ticket = null;
      running = true;
      try { onFrame(timestamp); }
      finally {
        running = false;
        if (!disposed && hasPending()) wake();
        else onIdle();
      }
    });
    // Disposal can occur reentrantly inside the request adapter before its ID returns.
    if (disposed || ticket !== own) cancel(own.id);
  };
  return { wake, dispose() {
    if (disposed) return;
    disposed = true;
    if (ticket) cancel(ticket.id);
    ticket = null;
    onIdle();
  } };
}

export function describeDiagnosticTarget(target) {
  if (!target || typeof target.closest !== 'function') return {};
  const source = target.closest('[data-insp-path]');
  const pane = target.closest('[data-terminal-pane-wrapper]');
  const tab = target.closest('[data-tab-id]');
  const history = target.closest('[data-history-owner]');
  return { tag: target.tagName?.toLowerCase(),
    source: source ? short(source.getAttribute('data-insp-path'), 150) + ':' + short(source.getAttribute('data-insp-line'), 16) : '',
    tab: tab?.getAttribute('data-tab-id') || pane?.getAttribute('data-terminal-pane-wrapper') || '',
    historyOwner: history?.getAttribute('data-history-owner') || '' };
}

// CSSOM identities reveal even a STYLE inside a newly inserted subtree without
// scanning that subtree. No cssRules/textContent/computed style/geometry reads.
export function createStylesheetDiagnostics() {
  const ids = new WeakMap();
  let sequence = 0, before = new Map();
  return {
    sample(sheets) {
      const next = new Map();
      for (const sheet of Array.from(sheets || [])) {
        if (!ids.has(sheet)) ids.set(sheet, ++sequence);
        const id = ids.get(sheet);
        next.set(id, before.get(id) || { id, ...describeDiagnosticTarget(sheet.ownerNode) });
      }
      const added = [...next.values()].filter(item => !before.has(item.id));
      const removed = [...before.values()].filter(item => !next.has(item.id));
      before = next;
      return { count: next.size, added: added.slice(0, 24), removed: removed.slice(0, 24),
        omitted: Math.max(0, added.length - 24) + Math.max(0, removed.length - 24) };
    },
  };
}

let diagnostics = null;
let stylesheetDiagnostics = null;
let lastWheelCapturedAt = -Infinity;
export function installUIActionDiagnostics(options = {}) {
  diagnostics ||= createUIActionDiagnostics(options);
  stylesheetDiagnostics ||= createStylesheetDiagnostics();
  stylesheetDiagnostics.sample(document.styleSheets);
  return diagnostics;
}
export function captureUIAction(event) {
  if (!diagnostics) return null;
  const wheel = event.type === 'wheel';
  if (wheel) {
    const at = performance.now();
    if (at - lastWheelCapturedAt < 200) return null;
    lastWheelCapturedAt = at;
  }
  const discrete = event.type === 'click' || event.type === 'pointerdown';
  const keys = describeDiagnosticKey(event);
  const navigation = (event.type === 'keydown' || event.type === 'keyup') && (keys.meta || keys.ctrl
    || ['Meta', 'Control', 'Alt', 'Shift', 'Arrow', 'Escape', 'Enter', 'Space', 'Tab'].includes(keys.keyClass));
  const clipboardState=describeDiagnosticClipboard(event);
  const action=diagnostics.capture(event.type, performance.timeOrigin + event.timeStamp,
    describeDiagnosticTarget(event.target), discrete || navigation || wheel || !!clipboardState, keys);
  if(clipboardState)action.clipboardState=clipboardState;
  return action;
}
export function uiDragDiagnostic(name, fields) { try { diagnostics?.drag.event(name,fields); } catch { diagnostics?.drag.failed(); } }
export function uiDragInput(event) { try { diagnostics?.drag.input(event); } catch { diagnostics?.drag.failed(); } }
export function uiDragAdmission(admission) { try { diagnostics?.drag.admission(admission); } catch { diagnostics?.drag.failed(); } }
export function uiDragActionId(gestureId) { return diagnostics?.drag.actionId(gestureId) || null; }
export function uiDragDiagnosticsEnabled() { return diagnostics?.drag.enabled() || false; }
export function uiPerformancePhase(name, values) { diagnostics?.phase(name, values); }
export function uiPerformancePhaseForAction(id,name,values) { return diagnostics?.phaseForAction(id,name,values) || false; }
export function currentUIActionId() { return diagnostics?.currentId() || null; }
export function getUIActionDiagnosticHealth() {
  return diagnostics?.health() || { actionRingEvicted: 0, actionPhasesDropped: 0 };
}
export function recordUIEventTiming(entry) {
  return diagnostics?.eventTiming(entry.name, performance.timeOrigin + entry.startTime, entry.duration, {
    browserInteractionId: entry.interactionId || 0,
    inputDelayMs: round(entry.processingStart - entry.startTime),
    handlerMs: round(entry.processingEnd - entry.processingStart),
    presentationMs: round(entry.duration - (entry.processingEnd - entry.startTime)),
  });
}
export function recordUIFrame(at) {
  diagnostics?.drag.frame(absNow(),at);
  // A drag frame alone must not sample stylesheet identities.
  if (!diagnostics?.pending()) return;
  const started = performance.now();
  const styles = stylesheetDiagnostics.sample(document.styleSheets);
  diagnostics.phase('diagnostic-stylesheets', { ms: performance.now() - started, count: styles.count });
  // Chromium may invoke this rAF after a long input handler while retaining an
  // earlier frame timestamp. Use actual callback delivery for containment;
  // otherwise the first stylesheet delta was consumed before the action fit.
  diagnostics.frame(absNow(), styles.added.length || styles.removed.length ? styles : null, at);
}
