import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryMeasurementViewportSync } from './historyMeasurementViewportSync.mjs';

function fixture() {
  const queue = [], events = [];
  const scroller = new EventTarget();
  scroller.isConnected = true;
  scroller.contains = node => node?.parent === scroller;
  const element = { parent: scroller };
  let actualTop = 123.5;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => actualTop,
    set: () => assert.fail('viewport publication cannot write scrollTop'),
  });
  scroller.scrollBy = scroller.scrollTo = () => assert.fail('no second position writer');
  const state = { scroller, owner: 'A:g1:v1', suppressed: false };
  scroller.addEventListener('scroll', event => events.push({
    top: scroller.scrollTop, trusted: event.isTrusted, bubbles: event.bubbles,
  }));
  const sync = createHistoryMeasurementViewportSync({
    getScroller: () => state.scroller,
    getOwnerToken: () => state.owner,
    isSuppressed: () => state.suppressed,
    scheduleMicrotask: task => queue.push(task),
  });
  return { queue, events, state, scroller, element, sync,
    // Simulate the sole virtualizer writer, before the queued notification.
    compensate: delta => { actualTop += delta; },
    drain: () => { while (queue.length) queue.shift()(); },
  };
}

test('one observer batch publishes the compensated fractional position without another write', () => {
  const f = fixture();
  f.sync.schedule(f.element);
  f.sync.schedule({ parent: f.scroller });
  assert.equal(f.queue.length, 1);
  assert.deepEqual(f.events, []);
  f.compensate(11708);
  f.drain();
  assert.deepEqual(f.events, [{ top: 11831.5, trusted: false, bubbles: false }]);
});

for (const invalidate of ['owner', 'visit', 'generation', 'scroller', 'disconnected', 'suppressed', 'cancel']) {
  test(`pending measurement publication is discarded after ${invalidate}`, () => {
    const f = fixture(); f.sync.schedule(f.element);
    f.compensate(11708);
    if (invalidate === 'owner') f.state.owner = 'B:g1:v1';
    if (invalidate === 'visit') f.state.owner = 'A:g1:v3';
    if (invalidate === 'generation') f.state.owner = 'A:g3:v1';
    if (invalidate === 'scroller') f.state.scroller = { isConnected: true };
    if (invalidate === 'disconnected') f.scroller.isConnected = false;
    if (invalidate === 'suppressed') f.state.suppressed = true;
    if (invalidate === 'cancel') f.sync.cancel();
    f.drain(); assert.deepEqual(f.events, []);
  });
}

test('foreign rows and suppressed readers do not schedule work', () => {
  const f = fixture();
  assert.equal(f.sync.schedule({ parent: {} }), false);
  f.state.suppressed = true;
  assert.equal(f.sync.schedule(f.element), false);
  assert.equal(f.queue.length, 0);
});

test('measurement without physical movement does not invent a scroll event', () => {
  const f = fixture(); f.sync.schedule(f.element); f.drain();
  assert.deepEqual(f.events, []);
});

test('a measured row leaving overscan does not cancel the same scroller publication', () => {
  const f = fixture(); f.sync.schedule(f.element);
  f.element.parent = null;
  f.compensate(9000); f.drain();
  assert.equal(f.events[0].top, 9123.5);
});

test('cancellation and stale callbacks cannot clear a later owner batch', () => {
  const f = fixture(); f.sync.schedule(f.element);
  f.sync.cancel(); f.state.owner = 'A:g2:v2';
  f.sync.schedule(f.element); f.compensate(400); f.drain();
  assert.equal(f.events.length, 1);
  f.sync.schedule(f.element); f.compensate(2); f.drain();
  assert.equal(f.events.length, 2);
});

test('two panes coalesce independently', () => {
  const a = fixture(), b = fixture();
  a.sync.schedule(a.element); b.sync.schedule(b.element);
  a.compensate(400); a.drain();
  assert.equal(a.events[0].top, 523.5); assert.equal(b.events.length, 0);
  b.compensate(300); b.drain(); assert.equal(b.events[0].top, 423.5);
});
