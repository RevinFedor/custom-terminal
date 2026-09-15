import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { createHistoryWheelDiagnostics } from './historyWheelDiagnostics.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
function actualHandler(name, nextMarker, bindings) {
  const begin = source.indexOf('  const ' + name + ' =');
  const end = source.indexOf(nextMarker, begin);
  assert.ok(begin >= 0 && end > begin);
  const code = transformSync(source.slice(begin, end), { loader: 'ts', target: 'es2022' }).code;
  return new Function(...Object.keys(bindings), code + '\nreturn ' + name + ';')(...Object.values(bindings));
}
function event(deltaY = -4) {
  return { type: 'wheel', isTrusted: true, timeStamp: performance.now(), deltaY, deltaMode: 0,
    target: {}, cancelable: true, defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
}
function observer() {
  const queue = [], logs = [];
  const diagnostics = createHistoryWheelDiagnostics({
    context: () => ({ owner: 'physical-a', tab: '4196', generation: 1, visit: 30, presented: true }),
    defer: fn => { queue.push(fn); return queue.length; },
    frame: () => 1, cancelFrame() {},
    log: text => logs.push(JSON.parse(text.slice('WHEEL_PIPELINE '.length))),
  });
  return { diagnostics, logs, flush: () => { queue.splice(0).forEach(fn => fn()); } };
}

test('actual tool handler keeps native outer, inner and edge routing and unit conversion', () => {
  for (const mode of ['outer', 'inner', 'edge', 'line']) {
    const f = observer(), outer = { scrollTop: 1000 }, inner = { scrollTop: mode === 'edge' ? 0 : 100, clientHeight: 200, scrollHeight: 500 };
    const owned = new WeakSet();
    const handler = actualHandler('handleHistoryToolWheel', '  // ========== SEARCH', {
      useMemo: fn => fn(), historyWheelDiagnostics: f.diagnostics,
      virtuosoScrollerRef: { current: outer }, historyInnerOwnedWheelEvents: owned,
      historyToolScrollBodyFromTarget: () => mode === 'outer' ? null : {},
      findHistoryToolInnerScroller: () => inner,
    });
    const e = event(); if (mode === 'line') e.deltaMode = 1;
    handler(e);
    assert.equal(f.logs.length, 0);
    f.flush();
    assert.equal(f.logs[0].branch, mode === 'outer' ? 'none' : mode === 'edge' ? 'edge' : 'inner');
    assert.equal(outer.scrollTop, mode === 'edge' ? 996 : 1000);
    assert.equal(inner.scrollTop, mode === 'outer' ? 100 : mode === 'edge' ? 0 : mode === 'line' ? 36 : 96);
    assert.equal(e.defaultPrevented, mode !== 'outer');
    assert.equal(owned.has(e), mode === 'inner' || mode === 'line');
    assert.equal(e.cancelBubble, owned.has(e));
  }
});

test('actual intent handler still gives trusted upward wheel reading ownership, without consuming it', () => {
  const f = observer(), actions = [], ref = current => ({ current });
  const callbacks = {
    useMemo: fn => fn(), historyWheelDiagnostics: f.diagnostics,
    historyPresentationProofRef: ref({ presented: true }), historyInnerOwnedWheelEvents: new WeakSet(),
    virtuosoScrollerRef: ref({ hasAttribute: () => false, clientHeight: 1000 }),
    historyScrollerOwnerToken: () => 'scope', historyForegroundPriority: { mark: () => actions.push('priority') },
    tabId: '4196', HISTORY_FOREGROUND_PRIORITY_HOLD_MS: 500,
    traceHistoryWheelInput: () => actions.push('old-trace'),
    historyUserGestureAtRef: ref(0), historyUserGestureGenerationRef: ref(0),
    hydrationBurstRef: ref({ since: 0, count: 0, tripped: false }),
    historyUserScrollDirectionRef: ref(null), historyFontSize: 16, historyTouchYRef: ref(null),
    historyScrollSeekController: { setScroller() {}, armWheelGesture: delta => actions.push(delta), armWheelBurst() {} },
    setHistoryTailFollowIntent: follow => actions.push(['follow', follow]),
    historyTailPinScheduler: { cancel: () => actions.push('cancel-pin') },
    scrollRestoreGenRef: ref(0), cancelHistoryScrollFromUser: () => false,
    lastProgrammaticHistoryScrollRef: ref(null), setHistorySeekGeometryMask() {},
  };
  const handler = actualHandler('handleUserScrollIntent', '  const handleHistoryTouchStart', callbacks);
  const e = event();
  f.diagnostics.wrap('tool', () => {})(e); handler(e);
  assert.equal(e.defaultPrevented, false); assert.equal(e.cancelBubble, false);
  assert.deepEqual(actions, ['priority', 'old-trace', -4, ['follow', false], 'cancel-pin']);
  assert.equal(callbacks.historyUserGestureGenerationRef.current, 1);
  assert.equal(callbacks.scrollRestoreGenRef.current, 1);
  assert.equal(callbacks.historyUserScrollDirectionRef.current, 'up');
  assert.equal(f.logs.length, 0); f.flush();
  assert.deepEqual(f.logs.map(item => item.phase), ['tool', 'intent']);
  assert.equal(f.logs[0].id, f.logs[1].id);
});

test('binding, cleanup, presentation guards and existing scroll reads remain in the actual component', () => {
  assert.match(source, /nextScroller\.addEventListener\('wheel', handleUserScrollIntent, \{ passive: true \}\)/);
  assert.match(source, /nextScroller\.addEventListener\('wheel', handleHistoryToolWheel, \{ capture: true, passive: false \}\)/);
  assert.match(source, /prev\.removeEventListener\('wheel', handleUserScrollIntent\)/);
  assert.match(source, /prev\.removeEventListener\('wheel', handleHistoryToolWheel, true\)/);
  assert.match(source, /historyWheelDiagnostics\.reset\('scroller-changed'\)/);
  assert.match(source, /useEffect\(\(\) => \(\) => historyWheelDiagnostics\.dispose\(\), \[historyWheelDiagnostics\]\)/);
  const start = source.indexOf('  const handleScroll = useCallback');
  const scroll = source.slice(start, source.indexOf('  // Keep entries ref fresh', start));
  assert.ok(scroll.indexOf('SCROLL_DORMANT_SKIP') < scroll.indexOf('historyWheelDiagnostics.observeScroll'));
  assert.match(scroll, /const observedScrollTop = el\.scrollTop;\s+const deltaTop = observedScrollTop - lastScrollTopRef\.current;\s+historyWheelDiagnostics\.observeScroll\(observedScrollTop, scrollHandlerEnteredAt\)/);
  const observerSource = fs.readFileSync(new URL('./historyWheelDiagnostics.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(observerSource, /getBoundingClientRect\(|getComputedStyle\(|clientHeight|scrollHeight|querySelector|sendSync|preventDefault\(|stopPropagation\(|\.scrollTop\s*=/);
});
