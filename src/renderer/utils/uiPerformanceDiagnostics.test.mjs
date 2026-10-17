import test from 'node:test';
import assert from 'node:assert/strict';
import { createUIActionDiagnostics, createStylesheetDiagnostics, describeDiagnosticKey,
  describeDiagnosticTarget, describeDiagnosticClipboard, recordUIClipboardOutcome, createUIClipboardOutcomeQueue,
  summarizeUIAction, formatDiagnosticKey, UI_ACTION_COVERAGE } from './uiPerformanceDiagnostics.mjs';

test('a removed click target keeps captured source and correlated frame/native outcome', () => {
  let time = 100; const logs = [], native = [];
  const d = createUIActionDiagnostics({ now: () => time, emit: s => logs.push(JSON.parse(s.slice(s.indexOf('{')))), notify: s => native.push(s) });
  const target = { tag: 'button', source: 'HistorySearchBar.tsx:33', secretText: 'SECRET' };
  const a = d.capture('click', 92, target); target.source = '';
  time = 110; d.phase('commit', { ms: 7, text: 'SECRET' });
  d.frame(300); d.frame(320);
  d.eventTiming('click', 92, 230, { handlerMs: 7 });
  assert.equal(logs[1].id, a.id); assert.equal(logs[1].target.source, 'HistorySearchBar.tsx:33');
  assert.equal(native[0].id, a.id); assert.equal(logs[0].frame2Abs, 320);
  assert.deepEqual(Object.keys(native[0]).sort(), ['durationMs', 'event', 'id', 'startAbs'], 'native counters channel stays intact');
  assert.equal(logs[0].coverage, UI_ACTION_COVERAGE);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});
test('rings and phase lists are bounded and late work is not attributed to old input', () => {
  let time = 100; const logs = [];
  const d = createUIActionDiagnostics({ now: () => time, emit: s => logs.push(s), max: 4 });
  for (let i = 0; i < 10; i++) { time++; d.capture('keydown', time, {}, false); }
  assert.equal(d.matching('keydown', 101), null);
  for (let i = 0; i < 100; i++) d.phase('phase', { count: i });
  const current = d.matching('keydown', time);
  assert.equal(current.phases.length, 32); assert.equal(current.phasesDropped, 68);
  assert.equal(current.phases.at(-1).count, 99, 'the final phase must survive a busy middle');
  assert.deepEqual(d.health(), { actionRingEvicted: 6, actionPhasesDropped: 68 });
  time += 2100; d.phase('unrelated'); assert.equal(current.phasesDropped, 68);
});
test('stylesheet identities expose nested mount/remove without reading rules or walking descendants', () => {
  const d = createStylesheetDiagnostics();
  const sheet = { ownerNode: null, get cssRules() { throw Error('do not inspect CSS'); } };
  d.sample([]); assert.equal(d.sample([sheet]).added.length, 1);
  assert.equal(d.sample([sheet]).added.length, 0);
  assert.equal(d.sample([]).removed.length, 1);
});

test('a delayed rAF keeps mutations with its delivery time even if its frame timestamp predates the click', () => {
  const records = [];
  const d = createUIActionDiagnostics({ now: () => 200, emit: s => records.push(JSON.parse(s.slice(s.indexOf('{')))) });
  d.capture('click', 195, { source: 'button' });
  d.frame(450, { added: [{ id: 1 }], removed: [], omitted: 0 }, 180);
  d.frame(465, null, 460);
  assert.equal(records[0].styles.added[0].id, 1);
  assert.equal(records[0].frame1Abs, 450); assert.equal(records[0].frame1RafTimestampAbs, 180);
});

test('keydown/up use only a key whitelist, including Meta release and printable shortcuts', () => {
  for (const type of ['keydown', 'keyup']) {
    for (const [key, expected] of [
      ...['Meta', 'Control', 'Alt', 'Shift', 'Escape', 'Enter', 'Tab'].map(key => [key, key]),
      ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map(key => [key, 'Arrow']),
      [' ', 'Space'], ['x', 'Other'], ['я', 'Other'], ['🔒', 'Other'], ['SECRET', 'Other'],
      ['https://secret.invalid', 'Other'], ['__proto__', 'Other'], ['constructor', 'Other'], ['toString', 'Other'],
    ]) {
      // Real KeyboardEvent accessors are inherited; never enumerate the event.
      const event = Object.create({ type, key, metaKey: type === 'keydown', ctrlKey: true,
        altKey: true, shiftKey: false, repeat: true, get code() { throw Error('code must not be read'); },
        get text() { throw Error('text must not be read'); } });
      const fields = describeDiagnosticKey(event);
      assert.deepEqual(fields, { keyClass: expected, meta: type === 'keydown', ctrl: true, alt: true, shift: false, repeat: true });
      assert.match(formatDiagnosticKey(fields), new RegExp('keyClass=' + expected));
      assert.doesNotMatch(JSON.stringify(fields), /SECRET|https:|secret.invalid|__proto__|constructor|toString/);
    }
  }
  assert.deepEqual(describeDiagnosticKey({ type: 'click', get key() { throw Error('not a key event'); } }), {});
});

test('removed keyboard target and slow EventTiming retain the exact action, safe key and measured boundaries', () => {
  const logs = [];
  const d = createUIActionDiagnostics({ now: () => 125, emit: s => logs.push(JSON.parse(s.slice(s.indexOf('{')))) });
  let removed = false;
  const target = {
    tagName: 'BUTTON',
    closest(selector) {
      assert.equal(removed, false, 'a retained snapshot must never query the removed node');
      return selector === '[data-insp-path]' ? { getAttribute: name => name === 'data-insp-path' ? 'Control.tsx' : '25' } : null;
    },
    get textContent() { throw Error('do not read target text'); },
    get value() { throw Error('do not read input value'); },
    get href() { throw Error('do not read target URL'); },
    getBoundingClientRect() { throw Error('no layout'); },
  };
  const first = d.capture('keydown', 100, describeDiagnosticTarget(target), true,
    describeDiagnosticKey({ type: 'keydown', key: 'Meta', metaKey: true }));
  const second = d.capture('keydown', 101, {}, false,
    describeDiagnosticKey({ type: 'keydown', key: 'secret-printable' }));
  removed = true;
  assert.notEqual(first.id, second.id);
  assert.equal(d.eventTiming('keydown', 100, 176, { inputDelayMs: 20, handlerMs: 80, presentationMs: 76 }).id, first.id);
  const record = logs[0];
  assert.equal(record.id, first.id); assert.equal(record.keyClass, 'Meta'); assert.equal(record.meta, true);
  assert.equal(record.target.source, 'Control.tsx:25');
  assert.deepEqual([record.inputDelayMs, record.handlerMs, record.presentationMs], [20, 80, 76]);
  const summary = summarizeUIAction(first, { inputDelayMs: 20, handlerMs: 80, presentationMs: 76 });
  assert.equal(summary.target.source, 'Control.tsx:25'); assert.equal(summary.keyClass, 'Meta');
  assert.equal(summary.coverage, UI_ACTION_COVERAGE);
  assert.equal(summarizeUIAction(first, { inputDelayMs: 25 }).handlerMs, null, 'unmeasured is not zero');
});

test('clipboard shortcut identities survive capture and summaries without recording typed keys or code', () => {
  for(const [code,shortcutClass] of [['KeyA','SelectAll'],['KeyC','Copy'],['KeyX','Cut'],['KeyV','Paste'],['Backspace','DeleteToStart']]) {
    const fields=describeDiagnosticKey({type:'keydown',key:'с',code,metaKey:true});
    assert.equal(fields.keyClass,'Other');assert.equal(fields.shortcutClass,shortcutClass);
    const d=createUIActionDiagnostics({now:()=>100,emit() {}});
    const action=d.capture('keydown',90,{},true,fields);
    assert.equal(summarizeUIAction(action).shortcutClass,shortcutClass);
    assert.doesNotMatch(JSON.stringify(action),/Key[A-Z]|с/);
  }
  assert.equal(describeDiagnosticKey({type:'keydown',key:'c',code:'KeyC'}).shortcutClass,undefined);
  assert.equal(describeDiagnosticKey({type:'keydown',key:'c',code:'KeyC',ctrlKey:true,altKey:true}).shortcutClass,undefined);
  assert.equal(describeDiagnosticKey({type:'keydown',key:'c',code:'__proto__',metaKey:true}).shortcutClass,undefined);
  const malicious={keyClass:'Other',shortcutClass:'SECRET',meta:true};
  assert.equal(summarizeUIAction(malicious).shortcutClass,undefined);
});

test('native selected-copy evidence survives removal without reading text, clipboard data or layout', () => {
  const node={nodeType:3,parentElement:{closest(selector) {return {getAttribute:()=>selector==='[data-tab-id]'?'tab-owned':'entry-owned'};}}};
  const event={type:'copy',isTrusted:true,defaultPrevented:false,
    target:{ownerDocument:{getSelection:()=>({anchorNode:node,focusNode:node,anchorOffset:1,focusOffset:4,
      rangeCount:1,isCollapsed:false,toString(){throw Error('must not read text');}})}},
    get clipboardData(){throw Error('must not read clipboard');}};
  const state=describeDiagnosticClipboard(event);
  assert.equal(state.selectedChars,3);assert.equal(state.anchorEntry,'entry-owned');
  const action={event:'copy',clipboardState:state};
  event.target=null;event.defaultPrevented=true;recordUIClipboardOutcome(action,event);
  const summary=summarizeUIAction(action);
  assert.equal(summary.clipboardState.selectedChars,3);assert.equal(summary.clipboardState.finalDefaultPrevented,true);
  assert.equal(summary.clipboardState.trusted,true);
  const hidden=Object.create({selectedChars:999});hidden.text='SECRET';
  assert.equal(summarizeUIAction({event:'copy',clipboardState:hidden}).clipboardState.selectedChars,null);
  assert.doesNotMatch(JSON.stringify(summary),/SECRET|clipboardData/);
  assert.equal(describeDiagnosticClipboard({type:'keydown',get target(){throw Error('not a clipboard gesture');}}),null);
});

test('clipboard outcome is unknown until a bounded post-dispatch task and keeps the original action after target removal',()=>{
  const tasks=[],logs=[];
  const q=createUIClipboardOutcomeQueue({postTask:fn=>tasks.push(fn),emit:s=>logs.push(JSON.parse(s.slice(s.indexOf('{')))),now:()=>100,max:1});
  const event={type:'copy',defaultPrevented:false,isTrusted:true,target:null};
  const action={id:'ui-native-1',clipboardState:describeDiagnosticClipboard(event)};
  q.enqueue(action,event);
  assert.equal(action.clipboardState.finalDefaultPrevented,null);
  event.defaultPrevented=true;
  const rejected={id:'ui-native-2',clipboardState:describeDiagnosticClipboard(event)};
  q.enqueue(rejected,event);
  assert.equal(rejected.clipboardState.finalDefaultPrevented,null);
  assert.equal(logs[0].reason,'queue-overflow');
  assert.equal(q.health().clipboardOutcomeDropped,1);
  tasks.shift()();
  assert.equal(action.clipboardState.finalDefaultPrevented,true);
  assert.equal(action.clipboardState.defaultPreventedAtCapture,false);
  assert.equal(logs[1].actionId,'ui-native-1');
  q.dispose();
});

test('a late unavailable native outcome remains unknown and reports lost evidence',()=>{
  const tasks=[],logs=[];
  const q=createUIClipboardOutcomeQueue({postTask:fn=>tasks.push(fn),emit:s=>logs.push(JSON.parse(s.slice(s.indexOf('{'))))});
  let unavailable=false;
  const event={type:'copy',isTrusted:true,get defaultPrevented(){if(unavailable)throw Error('SECRET');return false;}};
  const action={id:'ui-copy-late',clipboardState:describeDiagnosticClipboard(event)};
  q.enqueue(action,event);unavailable=true;tasks.shift()();
  assert.equal(action.clipboardState.finalDefaultPrevented,null);
  assert.equal(logs[0].reason,'event-unavailable');assert.equal(q.health().clipboardOutcomeDropped,1);
  assert.doesNotMatch(JSON.stringify(logs),/SECRET/);q.dispose();
});

test('summaries and EventTiming reject payloads, object coercion and prototype fields', () => {
  const secret = { toString() { throw Error('no coercion'); }, toJSON() { throw Error('no serialization'); } };
  const action = Object.assign(Object.create({ keyClass: 'Meta', meta: true, target: { source: 'SECRET' } }), {
    event: 'keydown', target: { tag: 'input', source: 'https://secret.invalid', tab: secret },
    key: 'SECRET', code: 'SECRET', text: 'SECRET', phases: new Array(10000).fill('SECRET'),
    toJSON() { throw Error('do not serialize the input'); },
  });
  const timing = Object.assign(Object.create({ handlerMs: 999 }), { inputDelayMs: 100, presentationMs: 4,
    id: 'replacement', payload: secret, target: secret });
  Object.defineProperty(timing, 'text', { enumerable: true, get() { throw Error('do not enumerate extras'); } });
  const summary = summarizeUIAction(action, timing);
  assert.equal(summary.keyClass, undefined); assert.equal(summary.target.source, '');
  assert.equal(summary.target.tab, ''); assert.equal(summary.handlerMs, null);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|replacement|https:|phases|code|payload/);
  assert.ok(JSON.stringify(summary).length < 400);
  const logs = [];
  const d = createUIActionDiagnostics({ now: () => 100, emit: s => logs.push(s) });
  const captured = d.capture('click', 90, { source: 'Control.tsx:25' });
  d.eventTiming('click', 90, 200, timing);
  const record = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.equal(record.id, captured.id); assert.equal(record.target.source, 'Control.tsx:25');
  assert.doesNotMatch(logs[0], /SECRET|replacement|payload/);
});

function dragHarness(mode='frames') {
  const origin=performance.timeOrigin;let time=origin+1000;
  const logs=[];let wakes=0;
  const d=createUIActionDiagnostics({now:()=>time,emit:s=>logs.push(s),onPendingFrame:()=>wakes++});
  d.drag.configure({mode,hz:120,slowMs:1,runId:'controlled-drag'});logs.length=0;
  const a=d.capture('pointerdown',time,{tab:'tab-A'});
  d.drag.event('pending',{pointerId:1,eventAbs:time,gestureId:'gesture-A',x:20,y:30});
  const input=(x,y,stamp=time-origin,type='pointermove',coalesced=2)=>d.drag.input({pointerId:1,type,
    timeStamp:stamp,clientX:x,clientY:y,buttons:type==='pointerup'?0:1,metaKey:false,
    getCoalescedEvents:()=>Array.from({length:coalesced},()=>null),
    get target(){throw Error('text/DOM must not be read');}});
  const records=tag=>logs.filter(s=>s.startsWith(tag+' ')).map(s=>JSON.parse(s.slice(s.indexOf('{'))));
  return {d,a,input,logs,records,wakes:()=>wakes,time:()=>time,set:v=>time=origin+v,advance:v=>time+=v};
}

test('a long pre-threshold hold is excluded and workflow adoption keeps one physical action',()=>{
  const h=dragHarness();h.set(12000);
  h.d.drag.frame(h.time());assert.equal(h.d.drag.pending(),false);
  assert.equal(h.d.currentId(),null);
  h.input(25,35);h.d.drag.event('threshold',{gestureId:'gesture-A',pointerId:1});
  assert.equal(h.d.drag.pending(),true);
  h.advance(8);h.d.drag.event('start',{gestureId:'gesture-A',sessionId:'host-1',ownerEpoch:1});
  h.d.drag.frame(h.time());
  h.d.drag.event('cancel',{gestureId:'gesture-A',reason:'scope-changed'});
  h.d.drag.event('start',{gestureId:'gesture-A',sessionId:'host-2',ownerEpoch:3,workflowId:'workflow-B'});
  h.advance(8);h.input(30,40);h.d.drag.frame(h.time());
  h.input(30,40,h.time()-performance.timeOrigin,'pointerup',0);
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  const [s]=h.records('[Perf:DragSummary]');
  assert.equal(s.actionId,h.a.id);assert.equal(s.frames,2);assert.ok(s.thresholdAbs-s.down.abs>=11000);
  assert.ok(s.maxCallbackGapMs<10);assert.equal(h.records('[Perf:DragSummary]').length,1);
  assert.equal(h.d.drag.pending(),false);
  const [w]=h.records('[Perf:DragWindow]');
  assert.deepEqual(w.phases.filter(p=>p.name==='start').map(p=>p.sessionId),['host-1','host-2']);
});

test('latest coordinates coalesce once per sampled frame and long gestures keep bounded evidence',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  for(let frame=0;frame<300;frame++){
    h.advance(frame===150?180:8);
    for(let packet=0;packet<10;packet++)h.input(frame*10+packet,40);
    h.d.drag.event('authored',{gestureId:'gesture-A',x:frame*10+9,y:40,left:frame*10,top:30,presentation:'test-author'});
    h.d.drag.frame(h.time());
  }
  assert.equal(h.logs.length,0,'no logger emission in the move/frame hot path');
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'cancel:escape'});
  const [s]=h.records('[Perf:DragSummary]'),[w]=h.records('[Perf:DragWindow]');
  assert.equal(s.inputPackets,3000);assert.equal(s.coalesced,6000);assert.equal(s.frameSampleOverwrites,2700);
  assert.equal(s.frames,300);assert.equal(s.frameEvicted,180);assert.equal(s.maxCallbackGapMs,180);
  assert.equal(w.first.length,8);assert.equal(w.tail.length,8);assert.ok(w.slow.length<=24);
  assert.ok(w.slow.some(f=>f.gapMs===180));assert.equal(s.latestInput.x,2999);
  assert.ok(h.a.drag && !Object.hasOwn(h.a.drag,'slow'),'existing action ring keeps only the cheap join');
});

test('pause/reverse, queued release and unmatched layout remain distinguishable from pixels',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  h.input(60,40);h.advance(8);h.d.drag.frame(h.time());
  h.advance(8);h.d.drag.frame(h.time());
  h.input(35,40);h.d.drag.event('target',{gestureId:'gesture-A',revision:7,at:2});
  h.d.drag.event('layout-receipt',{gestureId:'gesture-A',revision:6,at:1,matches:false});
  h.input(90,40,h.time()-performance.timeOrigin,'pointerup',0);
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  const [s]=h.records('[Perf:DragSummary]'),[w]=h.records('[Perf:DragWindow]');
  assert.equal(w.first[1].moving,false);assert.equal(s.latestInput.x,90);
  assert.equal(s.latestTarget.revision,7);assert.equal(s.latestLayout.revision,6);assert.equal(s.latestLayout.matches,false);
  assert.equal(s.firstAuthoredAbs,null);assert.match(s.coverage,/no OS event ID, compositor or pixel receipt/);
});

test('late durable reply joins the original gesture after a following ordinary click',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  h.advance(5000);const click=h.d.capture('click',h.time(),{tab:'other'});
  h.d.drag.event('commit-ipc-reply',{gestureId:'gesture-A',mutationId:'workflow-drag:gesture-A',publicationRevision:77,generation:9,accepted:true});
  const [ack]=h.records('[Perf:DragCommit]');assert.equal(ack.actionId,h.a.id);assert.equal(ack.generation,9);
  assert.notEqual(ack.actionId,click.id);assert.equal(ack.partial,false);
  assert.equal(h.d.drag.actionId('gesture-A'),h.a.id,'the existing Main causal envelope gets the old action, not current click');
});

test('OFF reads no pointer fields, wakes no drag frame, and configuration change is explicit partial',()=>{
  const h=dragHarness('off'),before=h.wakes();
  h.d.drag.input(new Proxy({},{get(){throw Error('OFF must not inspect input');}}));
  h.d.drag.event('threshold',{gestureId:'gesture-A'});h.d.drag.frame(h.time());
  assert.equal(h.d.drag.pending(),false);assert.equal(h.wakes(),before);assert.equal(h.logs.length,0);
  h.d.drag.configure({mode:'frames',hz:60});
  h.d.drag.event('pending',{pointerId:1,eventAbs:h.time(),gestureId:'gesture-A'});
  h.d.drag.event('threshold',{gestureId:'gesture-A'});h.d.drag.configure({mode:'off'});
  assert.equal(h.records('[Perf:DragSummary]')[0].partial,true);
  assert.equal(h.d.drag.pending(),false);
});

test('unknown timestamps, metadata truncation and logger failure are not reported as complete zero loss',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  h.input(1,2,NaN);h.d.drag.input({pointerId:1,type:'pointermove',timeStamp:1000,clientX:1,clientY:3});
  const familyIds=Array.from({length:140},(_,i)=>'tab-'+i),guards=Object.fromEntries(familyIds.map(id=>[id,
    {namespace:'n',workflowId:'w',membershipRevision:1,storageId:3,subjectId:'s',secret:'PRIVATE'}]));
  h.d.drag.admission({gestureId:'gesture-A',familyIds,paneFamilyIds:familyIds,guards});
  for(let i=0;i<70;i++)h.d.drag.event('navigation-accepted',{gestureId:'gesture-A',revision:i,text:'PRIVATE'});
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'cancel:escape'});
  const [s]=h.records('[Perf:DragSummary]'),[w]=h.records('[Perf:DragWindow]');
  assert.equal(s.invalidTimestamp,1);assert.equal(s.coalescedUnavailable,1);
  assert.ok(s.memberOmitted>0);assert.equal(s.partial,true);assert.ok(w.members.length<=128);
  assert.ok(w.phases.length<=32);assert.ok(s.phaseOmitted>0);assert.doesNotMatch(h.logs.join('\n'),/PRIVATE/);
  const bad=createUIActionDiagnostics({now:()=>performance.timeOrigin+1,emit(){throw Error('sink unavailable');}});
  bad.drag.configure({mode:'summary'});assert.equal(bad.drag.health().dragEmitFailed,1);
});

test('below-threshold cancellation and document disposal cannot leave drag sampling alive',()=>{
  const h=dragHarness();h.d.drag.event('pending-cancel',{gestureId:'gesture-A',reason:'blur'});
  assert.equal(h.d.drag.pending(),false);assert.equal(h.records('[Perf:DragSummary]').length,0);
  const other=dragHarness();other.d.drag.event('threshold',{gestureId:'gesture-A'});other.d.drag.dispose();
  assert.equal(other.d.drag.pending(),false);assert.equal(other.records('[Perf:DragSummary]')[0].partial,true);
});

test('an eligible ordinary click retains its UIAction without drag emission or a drag frame',()=>{
  const h=dragHarness('summary'),wakes=h.wakes();
  h.input(21,31);h.d.drag.event('click-release',{pointerId:1});
  assert.equal(h.d.drag.pending(),false);assert.equal(h.wakes(),wakes);
  assert.equal(h.logs.length,0);assert.equal(h.d.matching('pointerdown',h.time()),h.a);
});


test('a stopped author is caught with healthy callbacks, while a settled physical pause is not a stall',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  h.input(20,30);h.d.drag.event('authored',{gestureId:'gesture-A',x:20,y:30,left:10,top:20});
  for(let i=0;i<40;i++){h.advance(8);h.d.drag.frame(h.time());}
  h.input(50,30);
  for(let i=0;i<40;i++){h.advance(8);h.d.drag.frame(h.time());}
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  const [s]=h.records('[Perf:DragSummary]'),[w]=h.records('[Perf:DragWindow]');
  assert.equal(s.maxCallbackGapMs,8);assert.equal(s.maxAuthoredLagMs,320,'exclude the preceding settled pause');
  assert.equal(s.maxAuthoredErrorX,30);assert.ok(w.slow.some(f=>f.needsAuthor));
  assert.equal(w.first[7].authorLagMs,0,'a settled pause must not become an author stall');
});


test('release before adoption paint preserves a bounded late exact receipt without restarting sampling',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  for(let i=0;i<30;i++)h.d.drag.event('layout-receipt',{gestureId:'gesture-A',ownerEpoch:4,revision:i,matches:true});
  const records=h.records('[Perf:DragCommit]');
  assert.equal(records[0].actionId,h.a.id);assert.equal(records[0].ownerEpoch,4);
  assert.equal(records[0].postPhysical,true);assert.equal(records.length,17);
  assert.equal(records.at(-1).partial,true);assert.equal(records.at(-1).reason,'late-phase-cap');
  assert.equal(h.d.drag.pending(),false);
});

test('a short real-ID gesture retains its slow window within the existing serialization cap',()=>{
  const h=dragHarness();h.d.drag.event('threshold',{gestureId:'gesture-A'});
  const owner={gestureId:'gesture-A',sessionId:'bbbf2f86-1e72-4129-94fc-bea8b8014ab7',
    sourceId:'reserve-tab:tab-025c7369-39f8-4660-a786-2fdc7a7da5f0',
    ownerKey:'reserve:night17-ux-a:bbbf2f86-1e72-4129-94fc-bea8b8014ab7',
    workflowId:'night17-ux-a',ownerEpoch:1,pointerId:1,x:45,y:91.5,grabY:4,depth:0,boundary:0};
  h.d.drag.event('start',owner);
  for(let i=0;i<73;i++){
    h.advance(i===30?49.6:8.3);h.input(45,91.5);
    const packet={...owner,revision:i,eventAbs:h.time()-2,presentation:'compensated-layout-not-pixels',
      sourceLayoutTop:82,intendedTop:87.5,forestOffset:0,processed:i,received:i,queuedOverwrites:0};
    for(const phase of ['processed','published','geometry','layout-receipt'])h.d.drag.event(phase,packet);
    h.d.drag.event('authored',{...owner,revision:i,eventAbs:packet.eventAbs,axis:'y',top:87.5,
      intendedTop:87.5,forestOffset:0,presentation:'in-tree-source-y-style-not-pixels'});
    h.d.drag.frame(h.time());
  }
  h.d.drag.event('physical-end',{gestureId:'gesture-A',reason:'release'});
  const [s]=h.records('[Perf:DragSummary]'),[w]=h.records('[Perf:DragWindow]');
  assert.equal(s.detailOmitted,undefined);assert.equal(s.partial,false);assert.equal(w.first.length,8);
  assert.ok(w.slow.some(f=>f.gapMs===49.6));assert.ok(JSON.stringify(w).length<65536);
  assert.equal(w.first[0].geometry.ownerEpoch,1);assert.equal(s.latestGeometry.ownerKey,owner.ownerKey);
  assert.equal(w.first[0].author.axis,'y');assert.equal(s.authoredWrites,73);
  assert.ok(w.phases.some(p=>p.ownerKey===owner.ownerKey));
});
