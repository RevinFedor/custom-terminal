import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryScrollSeekController } from './historyScrollSeek.mjs';

const harness = (overrides = {}) => {
  let clock = 1000;
  const timers = [];
  const frames = [];
  const transitions = [];
  const controller = createHistoryScrollSeekController({
    now: () => clock,
    setTimer: (callback, delay) => {
      const token = { callback, at: clock + delay, cancelled: false };
      timers.push(token);
      return token;
    },
    clearTimer: (token) => { if (token) token.cancelled = true; },
    requestFrame: (callback) => frames.push(callback),
    onTransition: (event) => transitions.push(event),
    ...overrides,
  });
  return {
    controller,
    transitions,
    advance(ms) {
      clock += ms;
      let ran;
      do {
        ran = false;
        for (const timer of timers) {
          if (!timer.cancelled && !timer.ran && timer.at <= clock) {
            timer.ran = true;
            timer.callback();
            ran = true;
          }
        }
      } while (ran);
    },
    flushFrames() {
      while (frames.length > 0) frames.shift()();
    },
  };
};

test('a pinned split pane cannot suppress seek in its neighbour', () => {
  const paneA = harness({ isSuppressed: () => true });
  const paneB = harness({ isSuppressed: () => false });

  assert.equal(paneA.controller.configuration.enter(5000), false);
  assert.equal(paneB.controller.configuration.enter(5000), true);
  assert.equal(paneA.controller.isActive(), false);
  assert.equal(paneB.controller.isActive(), true);
});

test('recovery kick belongs to the controller own scroller', () => {
  const paneA = harness();
  const paneB = harness();
  const a = { isConnected: true, scrollTop: 50 };
  const b = { isConnected: true, scrollTop: 80 };
  paneA.controller.setScroller(a);
  paneB.controller.setScroller(b);

  assert.equal(paneA.controller.configuration.enter(5000), true);
  paneA.advance(300);
  assert.equal(a.scrollTop, 49);
  assert.equal(b.scrollTop, 80);
  paneA.flushFrames();
  assert.equal(a.scrollTop, 50);
  assert.equal(b.scrollTop, 80);
});

test('replacing the mounted scroller ends seek and never nudges the replacement', () => {
  const pane = harness();
  const oldScroller = { isConnected: true, scrollTop: 50 };
  const newScroller = { isConnected: true, scrollTop: 90 };
  pane.controller.setScroller(oldScroller);
  assert.equal(pane.controller.configuration.enter(5000), true);

  pane.controller.setScroller(newScroller);
  pane.advance(500);
  pane.flushFrames();

  assert.equal(pane.controller.isActive(), false);
  assert.equal(oldScroller.scrollTop, 50);
  assert.equal(newScroller.scrollTop, 90);
  assert.equal(pane.transitions.at(-1).reason, 'scroller-change');
});

test('machine-scroll cooldown is local to one panel', () => {
  const paneA = harness();
  const paneB = harness();
  paneA.controller.stampMachineScrollCooldown();

  assert.equal(paneA.controller.configuration.enter(5000), false);
  assert.equal(paneB.controller.configuration.enter(5000), true);
});

test('a remounted owner does not inherit the previous owner cooldown or wheel burst', () => {
  const pane = harness();
  pane.controller.setScroller({ isConnected: true, scrollTop: 10 });
  pane.controller.stampMachineScrollCooldown();
  pane.controller.armWheelBurst(700);
  pane.controller.setScroller({ isConnected: true, scrollTop: 20 });

  assert.equal(
    pane.controller.configuration.enter(5000),
    true,
    'owner B starts with its own clean gesture/cooldown state',
  );
});
