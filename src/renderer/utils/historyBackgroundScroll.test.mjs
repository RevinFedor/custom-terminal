import test from 'node:test';
import assert from 'node:assert/strict';
import { bindHistoryBackgroundScroll } from './historyBackgroundScroll.mjs';

// Actual binding/controller with controlled dimensions and event delivery.
// No native browser gesture or Electron E2E is claimed by these tests.
function fixture(width = 100, contentWidth = 300) {
  const element = () => ({ listeners: new Map(),
    addEventListener(name, callback, options) { this.listeners.set(name, { callback, options }); },
    removeEventListener(name) { this.listeners.delete(name); },
  });
  const viewport = { ...element(), clientWidth: width, scrollWidth: contentWidth, scrollLeft: 0 };
  const content = {}, wheelHost = element(), edges = [], observed = [];
  viewport.contains = target => target === viewport || target === content;
  let refresh, disconnected = false;
  const controller = bindHistoryBackgroundScroll({ viewport, content, wheelHost, onEdges: edge => edges.push(edge),
    createObserver(callback) { refresh = callback; return { observe(n) { observed.push(n); }, disconnect() { disconnected = true; } }; },
  });
  const wheel = (properties = {}) => {
    const event = { deltaX: 0, deltaY: 30, deltaMode: 0, ctrlKey: false, shiftKey: false,
      target: content, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    wheelHost.listeners.get('wheel')?.callback(event); return event;
  };
  return { viewport, content, wheelHost, controller, edges, observed, wheel,
    refresh: () => refresh(), disconnected: () => disconnected };
}
test('overflow arrows follow left, middle, right and content removal without repeated publication', () => {
  const f = fixture();
  assert.deepEqual(f.edges, [{ left: false, right: true }]);
  f.refresh(); assert.equal(f.edges.length, 1);
  f.wheel(); assert.deepEqual(f.edges.at(-1), { left: true, right: true });
  f.wheel({ deltaY: 999 }); assert.equal(f.viewport.scrollLeft, 200);
  assert.deepEqual(f.edges.at(-1), { left: true, right: false });
  f.viewport.scrollLeft = 0; f.viewport.scrollWidth = 80; f.refresh();
  assert.deepEqual(f.edges.at(-1), { left: false, right: false });
  assert.deepEqual(f.observed, [f.viewport, f.content]); f.controller.dispose();
});
test('ordinary vertical wheel scrolls horizontally without Shift and only consumes movement', () => {
  const f = fixture();
  assert.equal(f.wheelHost.listeners.get('wheel').options.passive, false);
  assert.equal(f.wheel().prevented, true); assert.equal(f.viewport.scrollLeft, 30);
  assert.equal(f.wheel({ deltaY: -999 }).stopped, true); assert.equal(f.viewport.scrollLeft, 0);
  assert.equal(f.wheel({ deltaY: -30 }).prevented, false);
  f.viewport.scrollWidth = 80; assert.equal(f.wheel().prevented, false);
  f.controller.dispose();
});
test('native horizontal and Shift inside the viewport, plus Ctrl zoom, keep browser ownership', () => {
  const f = fixture();
  for (const event of [{ deltaX: 20, deltaY: 0 }, { shiftKey: true }, { ctrlKey: true }]) {
    assert.equal(f.wheel(event).prevented, false); assert.equal(f.viewport.scrollLeft, 0);
  }
  f.controller.dispose();
});
test('wheel above an absolute arrow also reaches the strip, including trackpad horizontal input', () => {
  const f = fixture();
  assert.equal(f.wheel({ target: {}, deltaX: 45, deltaY: 0 }).prevented, true);
  assert.equal(f.viewport.scrollLeft, 45);
  assert.equal(f.wheel({ target: {}, shiftKey: true, deltaY: 15 }).prevented, true);
  assert.equal(f.viewport.scrollLeft, 60); f.controller.dispose();
});
test('line/page wheel units and arrow steps are bounded to the real viewport range', () => {
  const f = fixture();
  f.wheel({ deltaMode: 1, deltaY: 2 }); assert.equal(f.viewport.scrollLeft, 32);
  f.wheel({ deltaMode: 2, deltaY: 1 }); assert.equal(f.viewport.scrollLeft, 132);
  f.controller.step(1); assert.equal(f.viewport.scrollLeft, 200);
  f.controller.step(-1); assert.equal(f.viewport.scrollLeft, 120);
  f.controller.dispose();
});
test('resize events recalculate edges, and cleanup rejects late observations/input', () => {
  const f = fixture();
  f.viewport.clientWidth = 320; f.refresh();
  assert.deepEqual(f.edges.at(-1), { left: false, right: false });
  f.viewport.clientWidth = 100; f.refresh();
  assert.deepEqual(f.edges.at(-1), { left: false, right: true });
  f.controller.dispose(); assert.equal(f.disconnected(), true);
  assert.equal(f.viewport.listeners.size, 0); assert.equal(f.wheelHost.listeners.size, 0);
  const count = f.edges.length;
  f.viewport.scrollLeft = 100; f.refresh(); f.controller.step(-1);
  assert.equal(f.edges.length, count); assert.equal(f.viewport.scrollLeft, 100);
});
