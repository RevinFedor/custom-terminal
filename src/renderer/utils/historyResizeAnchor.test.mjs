import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHistoryResizeAnchor, measureHistoryResizeAnchor, registerHistoryResizeSurface, beginHistoryResize } from './historyResizeAnchor.mjs';
import { createHistoryResizeController } from './historyResizeController.mjs';

// Independent deterministic line layout. Browser tests additionally exercise
// actual DOM Range, fonts and the real virtualized HistoryPanel.
export function fixture() {
  const state = { charsPerLine: 60, text: 'abcdefghijklmnopqrstuvwxyz '.repeat(100), rowStart: 800 };
  const scroller = { isConnected: true, scrollTop: 978, clientHeight: 400,
    get scrollHeight() { return state.rowStart + Math.ceil(state.text.length / state.charsPerLine) * 24 + 800; },
    getBoundingClientRect: () => ({ top: 0, bottom: 400, width: 600, height: 400 }),
    querySelectorAll: () => [row],
  };
  const node = { get textContent() { return state.text; }, parentElement: { closest: () => null } };
  const doc = {
    createTreeWalker() { let done = false; return { nextNode: () => done ? null : (done = true, node) }; },
    createRange() {
      let start = 0, end = 0;
      return {
        selectNodeContents(n) { start = 0; end = n.textContent.length; },
        setStart(_node, at) { start = at; }, setEnd(_node, at) { end = at; },
        getBoundingClientRect() {
          const top = state.rowStart - scroller.scrollTop + Math.floor(start / state.charsPerLine) * 24;
          const bottom = state.rowStart - scroller.scrollTop + (Math.floor(Math.max(start, end - 1) / state.charsPerLine) + 1) * 24;
          return { top, bottom, height: bottom - top };
        },
      };
    },
  };
  const row = { ownerDocument: doc,
    getAttribute: (name) => name === 'data-history-unit-key' ? 'unit-A' : 'uuid-A',
    getBoundingClientRect() { const top = state.rowStart - scroller.scrollTop; const height = Math.ceil(state.text.length / state.charsPerLine) * 24; return { top, height, bottom: top + height }; },
  };
  return { state, scroller, row };
}

test('resize preserves the top text position, not the old pixel depth in the row', () => {
  const { state, scroller } = fixture();
  const anchor = captureHistoryResizeAnchor(scroller, false);
  assert.equal(anchor.kind, 'text');
  assert.equal(anchor.textTop, -10);
  state.charsPerLine = 37;
  const before = measureHistoryResizeAnchor(scroller, anchor);
  assert.ok(before.drift > 50, 'old row offset is demonstrably wrong after wrapping');
  scroller.scrollTop += before.drift;
  assert.equal(measureHistoryResizeAnchor(scroller, anchor).drift, 0);
  assert.notEqual(scroller.scrollTop, 978);
});

test('appending streamed text preserves the prefix proof; changing it does not', () => {
  const { state, scroller } = fixture();
  const anchor = captureHistoryResizeAnchor(scroller);
  state.text += ' new streamed suffix';
  assert.equal(measureHistoryResizeAnchor(scroller, anchor).proof, 'text');
  state.text = 'different prefix ' + state.text;
  assert.equal(measureHistoryResizeAnchor(scroller, anchor).proof, 'row-text-changed');
});

test('a removed unit is not replaced by a look-alike message', () => {
  const { scroller, row } = fixture();
  const anchor = captureHistoryResizeAnchor(scroller);
  row.getAttribute = () => 'unit-B';
  assert.equal(measureHistoryResizeAnchor(scroller, anchor), null);
});

test('tail intent remains a separate physical-bottom target', () => {
  const { scroller, state } = fixture();
  const anchor = captureHistoryResizeAnchor(scroller, true);
  assert.deepEqual(anchor, { kind: 'tail' });
  state.charsPerLine = 30;
  scroller.scrollTop += measureHistoryResizeAnchor(scroller, anchor).drift;
  assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight);
});

test('all affected panels capture before any panel activates, and finish once', () => {
  const events = [];
  const a = { isConnected: true }, b = { isConnected: true }, hidden = { isConnected: false };
  const unbind = [a, b, hidden].map((root, i) => registerHistoryResizeSurface(root, () => {
    events.push('capture:' + i);
    return { activate: () => events.push('lock:' + i), finish: (changed) => events.push('end:' + i + ':' + changed) };
  }));
  try {
    const finish = beginHistoryResize({ contains: () => true });
    assert.deepEqual(events, ['capture:0', 'capture:1', 'lock:0', 'lock:1']);
    finish(false); finish(true);
    assert.deepEqual(events.slice(4), ['end:0:false', 'end:1:false']);
  } finally { unbind.forEach((fn) => fn()); }
});

test('scope isolation excludes another pane host', () => {
  const root = { isConnected: true };
  let calls = 0;
  const remove = registerHistoryResizeSurface(root, () => { calls++; });
  try { beginHistoryResize({ contains: () => false })(); assert.equal(calls, 0); }
  finally { remove(); }
});

function controllerFixture(overrides = {}) {
  const f = fixture();
  let owner = 'A:1', presented = true, width = 600;
  const frames = [], timers = [], phases = [], outcomes = [], runs = [], listeners = new Map(), windowListeners = new Map();
  const stage = { contains: (node) => node === f.scroller, getBoundingClientRect: () => ({ width }) };
  const root = { isConnected: true,
    querySelector: () => stage,
    contains: (node) => node === root,
    setAttribute() {}, removeAttribute() {},
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type) => listeners.delete(type),
    ownerDocument: { defaultView: {
      addEventListener: (type, callback) => windowListeners.set(type, callback),
      removeEventListener: (type) => windowListeners.delete(type),
      ResizeObserver: class { observe() {} disconnect() {} },
    } },
  };
  const controller = createHistoryResizeController({
    root, getScroller: () => f.scroller, getOwner: () => owner,
    isPresented: () => presented, getFollowBottom: () => false,
    requestFrame: (fn) => (frames.push(fn), frames.length), cancelFrame() {},
    setTimer: (fn) => (timers.push(fn), timers.length), clearTimer() {},
    converge: (options) => runs.push(options), jumpToKey: () => false,
    onPrepare() {}, onPhase: (value) => phases.push(value), onFinish: (value) => outcomes.push(value),
    ...overrides,
  });
  return { ...f, root, controller, frames, timers, runs, phases, outcomes, listeners, windowListeners,
    owner: (value) => { owner = value; }, presented: (value) => { presented = value; }, width: (value) => { width = value; } };
}

test('resize holds wheel/navigation input until text-aware convergence has finished', () => {
  const f = controllerFixture();
  try {
    const finish = beginHistoryResize(f.root);
    let prevented = 0;
    f.listeners.get('wheel')({ type: 'wheel', target: f.scroller,
      preventDefault() { prevented++; }, stopImmediatePropagation() {} });
    assert.equal(prevented, 1);
    f.state.charsPerLine = 37;
    finish(true);
    const run = f.runs[0];
    assert.equal(run.cancelled(), null);
    assert.ok(run.measureDrift() > 50);
    run.jump();
    assert.equal(run.measureDrift(), 0);
    assert.equal(f.controller.active(), true);
    run.onSettled({ settled: '1', attempts: 3, driftPx: 0 });
    assert.equal(f.controller.active(), false);
    assert.equal(f.outcomes[0].restored, true);
    f.listeners.get('wheel')({ type: 'wheel', target: f.scroller, preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
  } finally { f.controller.dispose(); }
});

test('owner change aborts without writing a replacement history; hidden panes never join', () => {
  const f = controllerFixture();
  try {
    f.presented(false); beginHistoryResize(f.root)(true);
    assert.equal(f.controller.active(), false);
    f.presented(true); const finish = beginHistoryResize(f.root);
    const top = f.scroller.scrollTop;
    finish(true); f.owner('B:1');
    assert.equal(f.runs[0].cancelled(), 'owner-change');
    f.runs[0].onAborted({ reason: 'owner-change' });
    assert.equal(f.scroller.scrollTop, top);
    assert.equal(f.controller.active(), false);
  } finally { f.controller.dispose(); }
});

test('duplicate geometry notifications get one remount; cancelling needs no restore', () => {
  const f = controllerFixture();
  try {
    const finish = beginHistoryResize(f.root);
    assert.equal(f.controller.claimRemount(), true);
    assert.equal(f.controller.claimRemount(), false);
    finish(false);
    assert.equal(f.runs.length, 0);
    assert.equal(f.controller.active(), false);
  } finally { f.controller.dispose(); }
});

test('native resize uses the last old-width text snapshot, not post-reflow pixels', () => {
  const f = controllerFixture();
  try {
    f.frames.shift()(); // Last painted old-width snapshot.
    const old = captureHistoryResizeAnchor(f.scroller);
    f.state.charsPerLine = 37; f.width(370);
    f.windowListeners.get('resize')();
    assert.equal(f.controller.active(), true);
    f.timers.at(-1)();
    f.runs[0].jump();
    assert.equal(measureHistoryResizeAnchor(f.scroller, old).drift, 0);
  } finally { f.controller.dispose(); }
});

test('tail does not accept an estimated bottom before the real last row is ready', () => {
  let ready = false;
  const jumps = [];
  const f = controllerFixture({ getFollowBottom: () => true,
    isContentReady: () => ready, jumpToKey: (...args) => (jumps.push(args), true) });
  try {
    beginHistoryResize(f.root)(true);
    const run = f.runs[0];
    assert.equal(run.measureDrift(), null);
    run.jump();
    assert.deepEqual(jumps, [[null, null, true]]);
    assert.equal(f.controller.active(), true);
    ready = true;
    run.jump();
    assert.equal(run.measureDrift(), 0);
    run.onSettled({ settled: '1' });
    assert.equal(f.outcomes[0].restored, true);
  } finally { f.controller.dispose(); }
});

test('a changed prefix falls back within its own row; unreachable gap clamps to the real range', () => {
  const events = [];
  const f = controllerFixture({ log: (event) => events.push(event) });
  try {
    beginHistoryResize(f.root)(true);
    f.state.text = 'short replacement';
    f.state.rowStart = 0;
    f.scroller.clientHeight = 800;
    const run = f.runs[0];
    run.jump();
    assert.equal(f.scroller.scrollTop, f.scroller.scrollHeight - f.scroller.clientHeight);
    assert.equal(run.measureDrift(), 0);
    run.onSettled({ settled: '1' });
    assert.equal(events.at(-1).clamped, true);
    assert.equal(events.at(-1).proof, 'row-text-changed');
    assert.notEqual(events.at(-1).textDriftPx, 0);
  } finally { f.controller.dispose(); }
});

test('stagnation is not reported as a restored reading position', () => {
  const f = controllerFixture();
  try {
    beginHistoryResize(f.root)(true);
    f.runs[0].onSettled({ settled: 'drift', driftPx: 80 });
    assert.equal(f.outcomes[0].reason, 'not-settled');
    assert.equal(f.outcomes[0].restored, false);
    assert.equal(f.controller.active(), false, 'a failure must not trap user input forever');
  } finally { f.controller.dispose(); }
});

test('consecutive reflows keep the original character, not the new line start', () => {
  const f = controllerFixture();
  try {
    const original = captureHistoryResizeAnchor(f.scroller);
    for (const [chars, width] of [[37, 370], [60, 600], [41, 410]]) {
      beginHistoryResize(f.root)(true);
      f.state.charsPerLine = chars; f.width(width);
      const run = f.runs.at(-1);
      run.jump(); run.measureDrift(); run.onSettled({ settled: '1' });
      assert.equal(measureHistoryResizeAnchor(f.scroller, original).drift, 0);
    }
    f.scroller.scrollTop += 150; // A real reading change replaces the old point.
    const next = captureHistoryResizeAnchor(f.scroller);
    beginHistoryResize(f.root)(true);
    f.state.charsPerLine = 55; f.width(550);
    f.runs.at(-1).jump();
    assert.equal(measureHistoryResizeAnchor(f.scroller, next).drift, 0);
  } finally { f.controller.dispose(); }
});
