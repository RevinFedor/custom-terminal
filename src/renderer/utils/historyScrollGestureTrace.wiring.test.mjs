import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const panelPath = new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
const source = fs.readFileSync(panelPath, 'utf8');

test('upward History scroll trace is bounded and presentation-only', () => {
  assert.match(source, /HISTORY_SCROLL_TRACE_MAX_WHEEL_EVENTS = 20/);
  assert.match(source, /HISTORY_SCROLL_TRACE_MAX_SCROLL_EVENTS = 28/);
  assert.match(source, /HISTORY_SCROLL_TRACE_MAX_MOTION_FRAMES = 18/);
  assert.match(source, /HISTORY_SCROLL_TRACE_MOTION_INTERVAL_MS = 60/);
  assert.match(source, /if \(!event\.isTrusted \|\| !historyPresentationProofRef\.current\.presented\) return/);
  assert.match(source, /if \(!trace && event\.deltaY >= 0\) return/);
  assert.match(source, /SCROLL_GESTURE_BEGIN/);
  assert.match(source, /SCROLL_GESTURE_INPUT/);
  assert.match(source, /SCROLL_GESTURE_SCROLL/);
  assert.match(source, /phase=' \+ phase/);
  assert.match(source, /logHistoryScrollTraceFrame\(trace, 'idle'\)/);
  assert.match(source, /logHistoryScrollTraceFrame\(trace, 'raf'\)/);
  assert.match(source, /logHistoryScrollTraceFrame\(trace, 'post-paint'\)/);
  assert.match(source, /SCROLL_GESTURE_END/);

  const start = source.indexOf('const cancelHistoryScrollTraceScheduledWork');
  // Geometry writers live AFTER the trace. The old slice accidentally
  // included all of them and failed on HEAD independently of instrumentation.
  const end = source.indexOf('const setHistorySeekGeometryMask', start);
  assert.ok(start >= 0 && end > start, 'trace block must stay identifiable');
  const traceBlock = source.slice(start, end);
  assert.doesNotMatch(traceBlock, /scroller\.scrollTop\s*=/);
  assert.doesNotMatch(traceBlock, /scrollToIndex\s*\(/);
  assert.doesNotMatch(traceBlock, /setHistoryTailFollowIntent\s*\(/);
  assert.doesNotMatch(traceBlock, /setHistoryScrollPosition\s*\(/);
  assert.doesNotMatch(traceBlock, /setEntries\s*\(/);
});

test('height diagnostics and seek rejection name their identities without changing geometry', () => {
  const start = source.indexOf('const measureHistoryVirtuosoItemSize');
  const end = source.indexOf('const handleUserScrollIntent', start);
  const measure = source.slice(start, end);
  assert.match(measure, /previousActual=/);
  assert.match(measure, /first-in-wrapper/);
  assert.match(measure, /wrapper-reused/);
  assert.match(measure, /noteGeometryChange/);
  assert.doesNotMatch(measure, /\.scrollTop\s*=|scrollBy\(|scrollTo\(|\.style\.\w+\s*=/);
  assert.match(source, /SCROLL_SEEK_REJECT/);
  assert.match(source, /resizeAgeMs=/);
});

test('seek input comes from trusted outer scrolling, not nested content or mere scroll events', () => {
  const start = source.indexOf('const handleUserScrollIntent');
  const end = source.indexOf('const handleHistoryTouchStart', start);
  const wheel = source.slice(start, end);
  assert.match(wheel, /if \(!event\.isTrusted \|\| !historyPresentationProofRef\.current\.presented\) return/);
  assert.match(wheel, /historyInnerOwnedWheelEvents\.delete\(event\)/);
  assert.match(wheel, /deltaMode === 1/);
  assert.match(wheel, /deltaMode === 2/);
  assert.ok(wheel.indexOf('setScroller(') < wheel.indexOf('armWheelGesture('), 'first input belongs to the new visit before scroll fires');
  assert.match(source, /beginDirectScroll\('scrollbar'\)/);
  assert.match(source, /endDirectScroll\('scrollbar'\)/);
  const scroll = source.slice(source.indexOf('const handleScroll ='), source.indexOf('// Keep entries ref fresh'));
  assert.doesNotMatch(scroll, /armWheelGesture|armKeyScroll|beginDirectScroll/);
});

test('wheel baseline is captured before scroll ownership mutates', () => {
  const handlerStart = source.indexOf('const handleUserScrollIntent');
  const handlerEnd = source.indexOf('const handleHistoryTouchStart', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const traceAt = handler.indexOf('traceHistoryWheelInput(event as WheelEvent)');
  const gestureAt = handler.indexOf('historyUserGestureAtRef.current = performance.now()');
  assert.ok(traceAt >= 0 && gestureAt > traceAt);
  assert.match(handler, /historyInnerOwnedWheelEvents\.delete\(event\).*return/);
});

test('scroll events feed the trace only after presented ownership is proven', () => {
  const handlerStart = source.indexOf('const handleScroll = useCallback');
  const handlerEnd = source.indexOf('// Keep entries ref fresh', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const dormantReturn = handler.indexOf('SCROLL_DORMANT_SKIP');
  const traceAt = handler.indexOf('traceHistoryScrollEvent(el)');
  assert.ok(dormantReturn >= 0 && traceAt > dormantReturn);
});
