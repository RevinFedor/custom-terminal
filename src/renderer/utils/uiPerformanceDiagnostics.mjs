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
  // Read key only to classify it. Never retain key/code, or enumerate an event.
  return { keyClass: keyClass(event.key), meta: event.metaKey === true, ctrl: event.ctrlKey === true,
    alt: event.altKey === true, shift: event.shiftKey === true, repeat: event.repeat === true };
}

function keySnapshot(snapshot) {
  const result = Object.create(null);
  if (typeof own(snapshot, 'keyClass') !== 'string') return result;
  result.keyClass = keyClass(own(snapshot, 'keyClass'));
  for (const field of ['meta', 'ctrl', 'alt', 'shift', 'repeat']) result[field] = own(snapshot, field) === true;
  return result;
}

function targetSnapshot(target) {
  return Object.assign(Object.create(null), { tag: short(own(target, 'tag'), 40),
    source: short(own(target, 'source'), 180), tab: short(own(target, 'tab'), 80),
    historyOwner: short(own(target, 'historyOwner'), 80) });
}

// The direct watchdog gets a thin allowlisted record, never the phase/style
// arrays or an Event/DOM reference. null means that boundary was not measured.
export function summarizeUIAction(action, timing = {}) {
  return Object.assign(Object.create(null), {
    event: short(own(action, 'event') || own(timing, 'event'), 24),
    target: targetSnapshot(own(action, 'target')),
    ...keySnapshot(action),
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
    .map(field => ' ' + field + '=' + Number(fields[field])).join('') : '';
}

export function createUIActionDiagnostics({ now = absNow, emit = console.warn, notify = () => {}, max = 96 } = {}) {
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
    return action;
  };
  const phase = (name, values = {}) => {
    if (!current || now() - current.receivedAbs > 2000) return;
    const fields = Object.create(null);
    for (const key of Object.keys(values).slice(0, 10)) {
      if (['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) continue;
      const value = own(values, key);
      if (typeof value === 'number' && Number.isFinite(value)) fields[short(key, 32)] = round(value);
      else if (typeof value === 'boolean') fields[short(key, 32)] = value;
      else if (['tab', 'owner', 'reason'].includes(key)) fields[key] = short(value, 80);
    }
    if (current.phases.length >= 32) {
      current.phases.splice(8, 1); current.phasesDropped = increment(current.phasesDropped);
      phasesDropped = increment(phasesDropped);
    }
    current.phases.push({ name: short(name, 140), at: round(now()), ...fields });
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
    eventTiming(event, eventAbs, durationMs, extra = {}) {
      const action = matching(event, eventAbs);
      if (action) report(action, 'event-timing', durationMs, extra);
      return action;
    },
    frame(at, styles = null, rafTimestampAbs = at) {
      for (const action of actions) {
        if (!action.frameProof || action.frames >= 2 || action.receivedAbs > at) continue;
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
    pending() { return actions.some(a => a.frameProof && a.frames < 2); },
    health() { return { actionRingEvicted: dropped, actionPhasesDropped: phasesDropped }; },
  };
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
  return diagnostics.capture(event.type, performance.timeOrigin + event.timeStamp,
    describeDiagnosticTarget(event.target), discrete || navigation || wheel, keys);
}
export function uiPerformancePhase(name, values) { diagnostics?.phase(name, values); }
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
