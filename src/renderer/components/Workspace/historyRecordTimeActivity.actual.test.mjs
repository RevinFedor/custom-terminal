import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as presentation from '../../utils/historyRecordTimePresentation.mjs';
import recordTimes from '../../../shared/history-record-time.cjs';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(process.env.HISTORY_TIME_SOURCE_PATH || new URL('./HistoryRecordTimeOverlay.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  esModuleInterop: true,
} }).outputText;

// Execute the actual overlay hook; only DOM/observer delivery and React's
// publication sink are controlled. This proves admission, not native paint.
function harness({ presented = true, portalLayer = '' } = {}) {
  const calls = { selectors: 0, rects: 0, styles: 0, hit: 0 };
  const listeners = new Map(), observers = [], frames = new Map(), refs = [], diagnostics = [];
  let cleanup, view = null, hostChanged, frameId = 0;
  class Element {
    constructor(kind, parent = null) {
      this.kind = kind; this.parentElement = parent; this.isConnected = true;
      this.dataset = {}; this.style = {};
    }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    closest(selector) {
      if (selector === '[data-history-time-key]') return this.kind === 'row' ? this : this.parentElement?.closest(selector) || null;
      return null;
    }
    querySelector() { calls.selectors++; return null; }
    querySelectorAll() { calls.selectors++; return []; }
    getBoundingClientRect() { calls.rects++; return { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 }; }
    addEventListener() {} removeEventListener() {}
  }
  const panel = new Element('panel');
  panel.dataset.historyPresented = presented ? '1' : '0'; panel.dataset.historyViewportReady = '1';
  const scroller = new Element('scroller', panel), row = new Element('row', scroller);
  Object.assign(row.dataset, { historyTimeKey: 'exact-row', historyTimeAt: '2026-10-10T17:24:00.000Z',
    historyTimeSourceKind: 'message', historyTimeScope: 'record' });
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); }
  }
  const react = {
    useState: () => [view, next => { view = typeof next === 'function' ? next(view) : next; if (refs[0]) refs[0].current = view; }],
    useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect: callback => { cleanup = callback(); }, useLayoutEffect() {},
  };
  const context = vm.createContext({
    exports: {}, Element, HTMLElement: Element, ResizeObserver: Observer, MutationObserver: Observer,
    getComputedStyle: () => { calls.styles++; return { display: 'block', visibility: 'visible', opacity: '1', fontSize: '14px', fontFamily: 'sans-serif',
      getPropertyValue: name => name === '--history-record-time-layer' ? portalLayer : '' }; },
    innerWidth: 800, innerHeight: 600, CSS: { escape: value => value },
    performance: { now: () => 0 },
    document: { body: new Element('body'), querySelectorAll() { calls.selectors++; return []; },
      elementFromPoint() { calls.hit++; return row; } },
    window: { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); } },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal() {} }
      : name.includes('composerControlsHost') ? { getComposerControlsHost: () => null,
        subscribeComposerControlsHost: (_tab, callback) => { hostChanged = callback; return () => { hostChanged = null; }; } }
      : name.includes('uiPerformanceDiagnostics') ? { uiPerformancePhase() {},
        captureUIHoverAction: () => ({ id: 'own-time-hover' }), uiDiagnosticAbsNow: () => 100,
        uiPerformancePhaseForAction: (id, name, fields) => diagnostics.push({ id, name, fields }),
        uiPerformanceCommitForAction: (id, name, fields) => diagnostics.push({ id, name, fields }) }
      : name.includes('historyRecordTimePresentation') ? presentation
      : name.includes('history-record-time') ? recordTimes : require(name),
  });
  vm.runInContext(compiled, context);
  context.exports.HistoryRecordTimeOverlay({ panelRef: { current: panel }, scrollerRef: { current: scroller }, ownerKey: 'owner', tabId: 'tab' });
  const emit = (name, extra = {}) => listeners.get(name)?.({ key: 'Meta', metaKey: true, target: row, clientX: 10, clientY: 10, ...extra });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const reset = () => Object.keys(calls).forEach(key => { calls[key] = 0; });
  return { calls, panel, row, emit, flush, reset, diagnostics, notify() { observers.forEach(observer => observer.callback()); hostChanged?.(); flush(); },
    dispose() { cleanup(); }, get view() { return view; } };
}

test('idle mounts and resize/control changes do not walk or measure retained History', () => {
  const h = harness();
  assert.equal(h.calls.selectors, 0, 'a timestamp with no Cmd hover must not inspect chrome at mount');
  assert.equal(h.calls.rects, 0);
  for (let i = 0; i < 3; i++) h.notify();
  assert.equal(h.calls.selectors, 0); assert.equal(h.calls.rects, 0); assert.equal(h.view, null);
  h.dispose();
});

test('archive owner layer is inherited into its body Portal without changing ordinary History', () => {
  for (const [value, expected] of [['',25],['161',161]]) {
    const h = harness({portalLayer:value});h.emit('mousemove',{metaKey:false});h.emit('keydown');
    assert.equal(h.view?.portalLayer,expected);h.dispose();
  }
});
test('invalid or nonpositive owner layer preserves the ordinary Portal layer', () => {
  for (const portalLayer of ['0','-1','unknown','2147483648']) {
    const h = harness({portalLayer});h.emit('mousemove',{metaKey:false});h.emit('keydown');
    assert.equal(h.view?.portalLayer,25);h.dispose();
  }
});

test('Cmd then hover and hover then Cmd both acquire the exact timestamp; release stops measurements', () => {
  for (const metaFirst of [true, false]) {
    const h = harness();
    if (metaFirst) { h.emit('keydown'); h.emit('mousemove'); }
    else { h.emit('mousemove', { metaKey: false }); h.emit('keydown'); }
    assert.equal(h.view?.key, 'exact-row'); assert.equal(h.view?.at, '2026-10-10T17:24:00.000Z');
    assert.ok(h.calls.rects > 0, 'the active timestamp still resolves collision geometry');
    h.emit('keyup', { metaKey: false }); assert.equal(h.view, null); h.reset();
    h.notify(); assert.equal(h.calls.selectors, 0); assert.equal(h.calls.rects, 0);
    h.dispose();
  }
});

test('hidden owner never gets geometry on global Cmd or wake; returning under Cmd restores timestamp', () => {
  const h = harness({ presented: false }); h.reset();
  h.emit('mousemove', { metaKey: false }); h.emit('keydown'); h.notify();
  assert.equal(h.calls.selectors, 0); assert.equal(h.calls.rects, 0); assert.equal(h.calls.styles, 0); assert.equal(h.view, null);
  h.panel.dataset.historyPresented = '1'; h.emit('mousemove');
  assert.equal(h.view?.key, 'exact-row');
  h.panel.dataset.historyPresented = '0'; h.notify(); assert.equal(h.view, null);
  h.reset(); h.notify(); assert.equal(h.calls.rects, 0); assert.equal(h.calls.selectors, 0);
  h.dispose();
});

test('each fresh Cmd gesture recollects chrome even without an observer signal', () => {
  const h = harness(); h.emit('mousemove', { metaKey: false }); h.emit('keydown');
  assert.equal(h.view?.key, 'exact-row'); h.emit('keyup'); h.reset();
  h.emit('keydown');
  assert.ok(h.calls.selectors > 0, 'position-only/unobserved chrome changes cannot reuse a previous gesture envelope');
  h.dispose();
});

test('stationary hidden-to-visible wake under held Cmd and same-element caption changes resolve current time', () => {
  const h = harness(); h.emit('mousemove', { metaKey: false }); h.emit('keydown');
  h.panel.dataset.historyPresented = '0'; h.notify(); assert.equal(h.view, null);
  h.panel.dataset.historyPresented = '1'; h.notify(); assert.equal(h.view?.key, 'exact-row');
  h.row.dataset.historyTimeKey = 'caption-2'; h.row.dataset.historyTimeAt = '2026-10-10T17:25:00.000Z';
  h.notify(); assert.equal(h.view?.key, 'caption-2'); assert.equal(h.view?.at, '2026-10-10T17:25:00.000Z');
  h.dispose();
});

test('blur clears point and prevents observer work from resurrecting the old annotation', () => {
  const h = harness(); h.emit('mousemove', { metaKey: false }); h.emit('keydown');
  h.emit('blur'); h.reset(); h.notify(); h.emit('keydown');
  assert.equal(h.view, null); assert.equal(h.calls.selectors, 0); assert.equal(h.calls.rects, 0);
  h.dispose();
});

test('Fedor fast-control: hovering then Meta admits the timestamp on keydown without waiting for a frame or release', () => {
  const h = harness();
  try {
    h.emit('mousemove', { metaKey: false }); assert.equal(h.view, null);
    h.emit('keydown', { timeStamp: 100 });
    assert.equal(h.view?.key, 'exact-row');
    assert.equal(h.view.diagnostic.actionId, 'own-time-hover');
    assert.ok(h.diagnostics.some(p => p.id === 'own-time-hover' && p.name === 'history-record-time:view-request'));
    // No flush or keyup was used to obtain the admitted React publication.
    h.emit('keyup', { metaKey: false }); assert.equal(h.view, null);
  } finally { h.dispose(); }
});

test('timestamp visible-style commit is once-per-gesture data, without a new layout/paint probe', () => {
  const ast = ts.createSourceFile('overlay.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
      && node.arguments[0]?.getText(ast).includes('history-record-time:visible-commit')) callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(callback);
  const phases = [], view = { diagnostic: { actionId: 'own-gesture', requestedAbs: 100, committed: false } };
  const fn = vm.runInNewContext('(' + ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.trim().replace(/;$/, '') + ')', {
    view, labelRef: { current: { getBoundingClientRect() { throw Error('no extra geometry'); } } }, tabId: 'tab',
    uiDiagnosticAbsNow: () => 120, uiPerformanceCommitForAction: (id, name, fields) => phases.push({ id, name, fields }),
  });
  fn(); assert.equal(phases.length, 0, 'unpositioned/hidden label is not a visible commit');
  view.position = { left: 1, top: 2 }; fn(); fn();
  assert.equal(phases.length, 1); assert.equal(phases[0].name, 'history-record-time:visible-commit');
  assert.equal(phases[0].fields.durationMs, 20);
});

test('actual overlay admits the group interval, updates its end and releases without extra idle work', () => {
  const h = harness();
  h.row.dataset.historyTimeKind = 'group';
  h.row.dataset.historyTimeKey = 'group:time-range';
  h.row.dataset.historyTimeEndAt = '2026-10-10T17:29:00.000Z';
  h.emit('mousemove', { metaKey: false }); h.emit('keydown');
  assert.equal(h.view?.key, 'group:time-range');
  assert.equal(h.view?.endAt, '2026-10-10T17:29:00.000Z');
  assert.equal(h.view?.scope, 'group');
  assert.match(h.view?.label, / — /);
  h.row.dataset.historyTimeEndAt = '2026-10-10T17:31:00.000Z'; h.notify();
  assert.equal(h.view?.endAt, '2026-10-10T17:31:00.000Z');
  h.row.dataset.historyTimeEndAt = '2026-10-10T17:31:12.000Z'; h.notify();
  assert.equal(h.view?.endAt, '2026-10-10T17:31:12.000Z');
  h.emit('keyup'); h.reset(); h.notify();
  assert.equal(h.view, null); assert.equal(h.calls.rects, 0); assert.equal(h.calls.selectors, 0);
  h.dispose();
});

test('layout measurement dependencies change when only seconds of a group endpoint change', () => {
  const ast = ts.createSourceFile('overlay.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let dependencies;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
      && node.arguments[0].getText(ast).includes('controllerRef.current?.measure')) dependencies = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(dependencies);
  const get = new Function('view', 'return ' + dependencies);
  const before = { key: 'group', at: '2026-10-10T17:24:00Z', endAt: '2026-10-10T17:31:00Z', label: 'same minute label' };
  assert.notDeepEqual(get(before), get({ ...before, endAt: '2026-10-10T17:31:12Z' }));
});

test('invalid or reversed range metadata cannot reuse a previous hovered interval', () => {
  for (const bad of ['not-a-date', '2026-10-10T17:23:00.000Z']) {
    const h = harness(); h.emit('mousemove');
    assert.equal(h.view?.key, 'exact-row');
    h.row.dataset.historyTimeEndAt = bad; h.notify();
    assert.equal(h.view, null); h.dispose();
  }
});
