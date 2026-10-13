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
function harness({ presented = true } = {}) {
  const calls = { selectors: 0, rects: 0, styles: 0, hit: 0 };
  const listeners = new Map(), observers = [], frames = new Map(), refs = [];
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
    getComputedStyle: () => { calls.styles++; return { display: 'block', visibility: 'visible', opacity: '1', fontSize: '14px', fontFamily: 'sans-serif' }; },
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
      : name.includes('uiPerformanceDiagnostics') ? { uiPerformancePhase() {} }
      : name.includes('historyRecordTimePresentation') ? presentation
      : name.includes('history-record-time') ? recordTimes : require(name),
  });
  vm.runInContext(compiled, context);
  context.exports.HistoryRecordTimeOverlay({ panelRef: { current: panel }, scrollerRef: { current: scroller }, ownerKey: 'owner', tabId: 'tab' });
  const emit = (name, extra = {}) => listeners.get(name)?.({ key: 'Meta', metaKey: true, target: row, clientX: 10, clientY: 10, ...extra });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const reset = () => Object.keys(calls).forEach(key => { calls[key] = 0; });
  return { calls, panel, row, emit, flush, reset, notify() { observers.forEach(observer => observer.callback()); hostChanged?.(); flush(); },
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
