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
  return {
    capture, phase, matching,
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

// One owned request for all actions. No timers, DOM reads or continuous sampling.
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
  if (!diagnostics?.pending()) return;
  const started = performance.now();
  const styles = stylesheetDiagnostics.sample(document.styleSheets);
  diagnostics.phase('diagnostic-stylesheets', { ms: performance.now() - started, count: styles.count });
  // Chromium may invoke this rAF after a long input handler while retaining an
  // earlier frame timestamp. Use actual callback delivery for containment;
  // otherwise the first stylesheet delta was consumed before the action fit.
  diagnostics.frame(absNow(), styles.added.length || styles.removed.length ? styles : null, at);
}
