// Diagnostic data only: no store imports, layout reads, user text or retained DOM.
const absNow = () => performance.timeOrigin + performance.now();
const short = (value, limit = 140) => String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, limit);
const round = value => Math.round(value * 10) / 10;

export function createUIActionDiagnostics({ now = absNow, emit = console.warn, notify = () => {}, max = 96 } = {}) {
  const boot = Math.floor(now()).toString(36);
  let sequence = 0, current = null, dropped = 0;
  const actions = [];
  const capture = (event, eventAbs, target = {}, frameProof = true) => {
    const action = { id: 'ui-' + boot + '-' + (++sequence).toString(36), event: short(event, 24),
      startAbs: eventAbs, receivedAbs: now(), target: {
        tag: short(target.tag, 40), source: short(target.source, 180), tab: short(target.tab, 80),
        historyOwner: short(target.historyOwner, 80),
      }, phases: [], phasesDropped: 0, frameProof, frames: 0, frame1Abs: null, frame2Abs: null };
    actions.push(action); if (actions.length > max) { actions.shift(); dropped++; }
    current = action;
    return action;
  };
  const phase = (name, values = {}) => {
    if (!current || now() - current.receivedAbs > 2000) return;
    const fields = {};
    for (const [key, value] of Object.entries(values).slice(0, 10)) {
      if (typeof value === 'number' && Number.isFinite(value)) fields[short(key, 32)] = round(value);
      else if (typeof value === 'boolean') fields[short(key, 32)] = value;
      else if (['tab', 'owner', 'reason'].includes(key)) fields[key] = short(value, 80);
    }
    if (current.phases.length >= 32) { current.phases.splice(8, 1); current.phasesDropped++; }
    current.phases.push({ name: short(name, 140), at: round(now()), ...fields });
  };
  const matching = (event, eventAbs) => {
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].event === event && Math.abs(actions[i].startAbs - eventAbs) < 2) return actions[i];
    }
    return null;
  };
  const report = (action, kind, durationMs, extra = {}) => {
    const data = { ...action, kind, durationMs: round(durationMs), ...extra,
      inputDelayMs: round(action.receivedAbs - action.startAbs), ringDropped: dropped,
      coverage: 'temporal-overlap; frames-are-callbacks-not-pixel-proof' };
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
  const navigation = event.type === 'keydown' && (event.metaKey || event.ctrlKey
    || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Enter', ' '].includes(event.key));
  return diagnostics.capture(event.type, performance.timeOrigin + event.timeStamp,
    describeDiagnosticTarget(event.target), discrete || navigation || wheel);
}
export function uiPerformancePhase(name, values) { diagnostics?.phase(name, values); }
export function currentUIActionId() { return diagnostics?.currentId() || null; }
export function recordUIEventTiming(entry) {
  return diagnostics?.eventTiming(entry.name, performance.timeOrigin + entry.startTime, entry.duration, {
    browserInteractionId: entry.interactionId || 0,
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
