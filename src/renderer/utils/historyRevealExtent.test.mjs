import test from 'node:test';
import assert from 'node:assert/strict';
import { holdHistoryRevealExtent } from './historyRevealExtent.mjs';

function fixture() {
  const state = { committed: false, current: true, natural: 1000, actual: 40, known: 40 };
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.active = true; observers.push(this); }
    observe() {}
    disconnect() { this.active = false; }
  }
  class Element extends EventTarget {
    children = [];
    attributes = new Map();
    style = {};
    isConnected = true;
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    appendChild(child) { this.children.push(child); child.parent = this; }
    remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
    getBoundingClientRect() { return { top: Number.parseFloat(this.style.top) || 0,
      bottom: (Number.parseFloat(this.style.top) || 0) + (Number.parseFloat(this.style.height) || 0) }; }
  }
  const viewport = new Element();
  viewport.getBoundingClientRect = () => ({ top: 0 });
  const list = new Element();
  list.getBoundingClientRect = () => ({ top: 0, bottom: state.natural, height: state.natural });
  const row = new Element();
  row.setAttribute('data-index', '20');
  row.getAttribute = (key) => key === 'data-known-size' ? String(state.known) : null;
  row.getBoundingClientRect = () => ({ height: state.actual });
  list.appendChild(row);
  viewport.appendChild(list);
  viewport.querySelector = () => list;
  const scroller = new Element();
  scroller.scrollTop = 900;
  scroller.clientHeight = 100;
  scroller.querySelector = () => viewport;
  scroller.ownerDocument = {
    createElement: () => new Element(),
    defaultView: { ResizeObserver: Observer, MutationObserver: Observer },
  };
  const outcomes = [];
  const start = () => holdHistoryRevealExtent({ scroller,
    isCommitted: () => state.committed, isCurrent: () => state.current,
    onFinish: (outcome) => outcomes.push(outcome),
  });
  const notify = async () => {
    for (const observer of observers) if (observer.active) observer.callback();
    await Promise.resolve();
  };
  const naturalPlusGuards = () => Math.max(state.natural,
    ...viewport.children.filter((child) => child !== list).map((child) => child.getBoundingClientRect().bottom));
  const clamp = () => { scroller.scrollTop = Math.min(scroller.scrollTop, naturalPlusGuards() - scroller.clientHeight); };
  return { state, scroller, viewport, list, row, start, outcomes, observers, notify, clamp };
}

test('growing group keeps the current position reachable across an intermediate shorter list', async () => {
  const f = fixture();
  f.start();
  await f.notify();
  assert.equal(f.outcomes.length, 0, 'the unchanged pre-click list is not completion proof');
  f.state.committed = true;
  f.state.natural = 791; // production: temporary -209px before inserted rows are measured
  f.clamp();
  await f.notify();
  assert.equal(f.scroller.scrollTop, 900);
  assert.equal(f.outcomes.length, 0, 'the guard must never count itself as measured content');
  f.state.natural = 1220;
  f.state.known = 600;
  await f.notify();
  assert.equal(f.outcomes.length, 0, 'new geometry must first reach the virtualizer');
  f.state.known = f.state.actual;
  await f.notify();
  assert.equal(f.outcomes[0].reason, 'measured');
  assert.equal(f.viewport.children.length, 1);
  assert.ok(f.observers.every((observer) => !observer.active));
  assert.equal(f.scroller.scrollTop, 900, 'the extent holder is not another scroll writer');
});

test('collapse drops the guard immediately and accepts the actual shorter range', async () => {
  const f = fixture();
  const cancel = f.start();
  f.state.natural = 700;
  cancel('collapse');
  f.clamp();
  await f.notify();
  assert.equal(f.scroller.scrollTop, 600);
  assert.deepEqual(f.outcomes.map((entry) => entry.reason), ['collapse']);
  assert.equal(f.viewport.children.length, 1);
});

for (const event of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
  test(`new ${event} owns position and cancels the pending extent`, async () => {
    const f = fixture();
    f.start();
    f.scroller.dispatchEvent(new Event(event));
    await f.notify();
    assert.equal(f.outcomes[0].reason, 'user-input');
    assert.equal(f.viewport.children.length, 1);
    f.state.committed = true;
    await f.notify();
    assert.equal(f.outcomes.length, 1);
  });
}

test('owner change invalidates the measurement before any release proof is accepted', async () => {
  const f = fixture();
  f.start();
  f.state.committed = true;
  f.state.current = false;
  await f.notify();
  assert.equal(f.outcomes[0].reason, 'stale-owner');
  assert.equal(f.viewport.children.length, 1);
});

test('zero-height or absent DOM rows cannot finish a reveal', async () => {
  const f = fixture();
  const cancel = f.start();
  f.state.committed = true;
  f.state.actual = f.state.known = 0;
  await f.notify();
  assert.equal(f.outcomes.length, 0);
  f.list.children = [];
  await f.notify();
  assert.equal(f.outcomes.length, 0);
  cancel();
});

test('an older guard cannot serve as evidence for a replacement transaction', async () => {
  const f = fixture();
  const first = f.start();
  const second = f.start();
  f.state.committed = true;
  f.state.natural = 800;
  await f.notify();
  assert.equal(f.outcomes.length, 0);
  first('superseded');
  second('cancelled');
  assert.equal(f.viewport.children.length, 1);
});
