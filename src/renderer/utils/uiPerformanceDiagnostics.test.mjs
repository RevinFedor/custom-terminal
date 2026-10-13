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
