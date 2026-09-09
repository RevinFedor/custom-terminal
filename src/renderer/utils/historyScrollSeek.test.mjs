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
  paneA.controller.beginDirectScroll('scrollbar');
  paneB.controller.beginDirectScroll('scrollbar');

  assert.equal(paneA.controller.configuration.enter(5000), false);
  assert.equal(paneB.controller.configuration.enter(5000), true);
  assert.equal(paneA.controller.isActive(), false);
  assert.equal(paneB.controller.isActive(), true);
});

test('a tiny upward wheel preserves real rows instead of forcing placeholders', () => {
  const pane = harness();
  assert.equal(pane.controller.armWheelGesture(-4), false);
  assert.equal(pane.controller.configuration.enter(100_000), false);
  assert.equal(pane.controller.isActive(), false);
});

test('a readable slow wheel series never replaces row-local DOM', () => {
  const pane = harness();
  for (const delta of [-4, -4, -8, -12, -18, -24, -32]) {
    assert.equal(pane.controller.armWheelGesture(delta), false);
    assert.equal(pane.controller.configuration.enter(100_000), false);
    pane.advance(30);
  }
  assert.equal(pane.controller.isActive(), false);
});

test('the production 216px ordinary trackpad profile does not bypass the velocity gate', () => {
  const pane = harness();
  assert.equal(pane.controller.armWheelGesture(-4), false);
  pane.advance(55);
  assert.equal(pane.controller.armWheelGesture(-103), false);
  pane.advance(46);
  assert.equal(pane.controller.armWheelGesture(-109), false);
  assert.equal(pane.controller.configuration.enter(100_000), false);
  assert.equal(pane.controller.isActive(), false);
});

test('the production 05:17 ordinary wheel keeps real rows at displacement sample 258px', () => {
  const pane = harness();
  assert.equal(pane.controller.armWheelGesture(-4, 22_323.3), false);
  pane.advance(35);
  assert.equal(pane.controller.armWheelGesture(-111.3, 22_358.3), true);
  pane.advance(18);
  assert.equal(pane.controller.armWheelGesture(-125.1, 22_376.3), true);

  assert.equal(pane.controller.configuration.enter(-258), false);
  assert.equal(pane.controller.isActive(), false);
  assert.deepEqual(pane.transitions, []);
});

test('a long readable traverse across unmeasured rows stays out of seek', () => {
  const pane = harness();
  for (let index = 0; index < 60; index += 1) {
    assert.equal(pane.controller.armWheelGesture(-40, 10_000 + index * 80), false);
    assert.equal(pane.controller.configuration.enter(100_000), false);
    pane.advance(80);
  }
  assert.equal(pane.controller.isActive(), false);
});

test('confirmed wheel packets never bypass the measured fast-scroll threshold', () => {
  const pane = harness();
  assert.equal(pane.controller.armWheelGesture(-4), false);
  pane.advance(18);
  assert.equal(pane.controller.armWheelGesture(-28), false);
  pane.advance(18);
  assert.equal(pane.controller.armWheelGesture(-94), true);

  assert.equal(pane.controller.configuration.enter(20), false);
  assert.equal(pane.controller.isActive(), false);
  assert.equal(pane.controller.configuration.enter(3501), false, 'packets do not explain a +3501px jump');
  pane.controller.armWheelGesture(-4000);
  assert.equal(pane.controller.configuration.enter(-3501), true);
  assert.equal(pane.controller.isActive(), true);
  assert.equal(pane.controller.configuration.exit(0), false);
  pane.advance(400);
  assert.equal(pane.controller.configuration.exit(0), true);
  assert.equal(pane.controller.isActive(), false);
});

test('physical packet timestamps remove probe suppression but cannot enter seek at low measured velocity', () => {
  const pane = harness();
  assert.equal(pane.controller.armWheelGesture(-4, 10_000), false);
  pane.advance(90);
  assert.equal(pane.controller.armWheelGesture(-28, 10_018), false);
  pane.advance(90);
  assert.equal(pane.controller.armWheelGesture(-94, 10_036), true);
  assert.equal(pane.controller.configuration.enter(20), false);
  assert.equal(pane.controller.configuration.enter(3501), false);
  pane.controller.armWheelGesture(-4000, 10_054);
  assert.equal(pane.controller.configuration.enter(-3501), true);
});

test('a huge single wheel packet lowers but never removes the measured velocity gate', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-700);
  pane.controller.armWheelBurst(-700);
  assert.equal(pane.controller.configuration.enter(-2500), false);
  pane.controller.armWheelGesture(-3000);
  assert.equal(pane.controller.configuration.enter(-2700), true);
});

test('a downward wheel does not force scroll seek', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-100);
  pane.controller.armWheelGesture(20);
  assert.equal(pane.controller.configuration.enter(20), false);
});

test('recovery kick belongs to the controller own scroller', () => {
  const paneA = harness();
  const paneB = harness();
  const a = { isConnected: true, scrollTop: 50 };
  const b = { isConnected: true, scrollTop: 80 };
  paneA.controller.setScroller(a, 'owner-a');
  paneB.controller.setScroller(b, 'owner-b');
  paneA.controller.beginDirectScroll('scrollbar');

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
  pane.controller.setScroller(oldScroller, 'owner-a');
  pane.controller.beginDirectScroll('scrollbar');
  assert.equal(pane.controller.configuration.enter(5000), true);

  pane.controller.setScroller(newScroller, 'owner-a');
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
  paneA.controller.beginDirectScroll('scrollbar');
  paneB.controller.beginDirectScroll('scrollbar');
  paneA.controller.stampMachineScrollCooldown();

  assert.equal(paneA.controller.configuration.enter(5000), false);
  assert.equal(paneB.controller.configuration.enter(5000), true);
});

test('a machine owner that starts during seek forces the placeholder lifecycle to end', () => {
  let suppressed = false;
  const pane = harness({ isSuppressed: () => suppressed });
  pane.controller.beginDirectScroll('scrollbar');
  assert.equal(pane.controller.configuration.enter(5000), true);
  suppressed = true;
  assert.equal(pane.controller.configuration.exit(5000), true);
  assert.equal(pane.controller.isActive(), false);
  assert.equal(pane.transitions.at(-1).reason, 'suppressed');
});

test('a hidden/suppressed pane exits before the recovery timer can nudge scrollTop', () => {
  let suppressed = false;
  const pane = harness({ isSuppressed: () => suppressed });
  const scroller = { isConnected: true, scrollTop: 50 };
  pane.controller.setScroller(scroller, 'owner-a');
  pane.controller.beginDirectScroll('scrollbar');
  assert.equal(pane.controller.configuration.enter(5000), true);
  suppressed = true;
  pane.advance(300);
  pane.flushFrames();
  assert.equal(scroller.scrollTop, 50);
  assert.equal(pane.controller.isActive(), false);
  assert.equal(pane.transitions.at(-1).reason, 'suppressed');
});

test('a same-owner callback-ref remount cannot erase machine-scroll cooldown', () => {
  const pane = harness();
  const firstScroller = { isConnected: true, scrollTop: 10 };
  const replacementScroller = { isConnected: true, scrollTop: 20 };
  pane.controller.setScroller(firstScroller, 'owner-a');
  pane.controller.stampMachineScrollCooldown();
  pane.controller.armWheelBurst(700);
  // React callback refs may deliver null -> element around a render even
  // though the semantic History owner did not change.
  pane.controller.setScroller(null, 'owner-a');
  pane.controller.setScroller(replacementScroller, 'owner-a');
  pane.controller.beginDirectScroll('scrollbar');

  assert.equal(
    pane.controller.configuration.enter(5000),
    false,
    'the delayed velocity echo of owner A stays suppressed',
  );
});

test('a genuinely new owner does not inherit cooldown or wheel burst', () => {
  const pane = harness();
  pane.controller.setScroller({ isConnected: true, scrollTop: 10 }, 'owner-a');
  pane.controller.stampMachineScrollCooldown();
  pane.controller.armWheelBurst(700);
  pane.controller.setScroller({ isConnected: true, scrollTop: 20 }, 'owner-b');
  assert.equal(pane.controller.configuration.enter(5000), false, 'owner B has no input yet');
  pane.controller.beginDirectScroll('scrollbar');

  assert.equal(
    pane.controller.configuration.enter(5000),
    true,
    'owner B starts with its own clean gesture/cooldown state',
  );
});

test('09 September tab-4553: an upward wheel cannot authorize the +4993 resize sample', () => {
  const pane = harness();
  for (const [wait, delta] of [[0, -4], [42, -252.5], [23, -153.8], [61, -354.5]]) {
    pane.advance(wait);
    pane.controller.armWheelGesture(delta);
    pane.controller.armWheelBurst(delta);
  }
  pane.advance(184);
  assert.equal(pane.controller.configuration.enter(4993), false);
  assert.equal(pane.controller.isActive(), false);
});

test('a same-direction shrink cannot inflate a small wheel into fast seek either', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-4);
  pane.advance(25);
  pane.controller.armWheelGesture(-125);
  assert.equal(pane.controller.configuration.enter(-5000), false);
});

test('old wheel input must not authorize a later unowned geometry echo', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-4);
  pane.advance(25);
  pane.controller.armWheelGesture(-125);
  pane.advance(500);
  assert.equal(pane.controller.configuration.enter(-5000), false);
});

test('large user input alone still cannot enable seek when the list barely moves', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-4000);
  pane.controller.armWheelBurst(-4000);
  assert.equal(pane.controller.configuration.enter(-100), false);
  assert.equal(pane.controller.configuration.enter(-3900), true);
});

test('one wheel packet cannot corroborate multiple displacement samples', () => {
  const pane = harness();
  pane.controller.armWheelGesture(-3100);
  pane.controller.armWheelBurst(-3100);
  assert.equal(pane.controller.configuration.enter(-1000), false);
  assert.equal(pane.controller.configuration.enter(-1000), false);
  assert.equal(pane.controller.configuration.enter(-4993), false);
});

test('wheel magnitude and direction remain local to a panel and presentation owner', () => {
  const a = harness(), b = harness();
  a.controller.setScroller({}, 'owner-a:visit-1');
  a.controller.armWheelGesture(-5000);
  assert.equal(b.controller.configuration.enter(-5000), false);
  a.controller.setScroller({}, 'owner-a:visit-2');
  assert.equal(a.controller.configuration.enter(-5000), false);
});

test('a scrollbar scrub is allowed without wheel input, but release evidence expires', () => {
  const pane = harness();
  pane.controller.beginDirectScroll('scrollbar');
  pane.advance(2000);
  assert.equal(pane.controller.configuration.enter(5000), true);
  pane.controller.endDirectScroll('scrollbar');
  pane.advance(400);
  assert.equal(pane.controller.configuration.exit(5000), true, 'late correction does not extend seek');
  assert.equal(pane.controller.configuration.enter(5000), false);
});

test('keyboard and touch have explicit input paths, not a generic unowned fallback', () => {
  const pane = harness();
  assert.equal(pane.controller.configuration.enter(100_000), false);
  pane.controller.armKeyScroll(-1);
  assert.equal(pane.controller.configuration.enter(5000), false);
  assert.equal(pane.controller.configuration.enter(-5000), true);
  pane.advance(400);
  assert.equal(pane.controller.configuration.exit(0), true);
  pane.controller.beginDirectScroll('touch');
  assert.equal(pane.controller.configuration.enter(5000), true);
});

test('rejection diagnostics are bounded and retain the latest measurement identity', () => {
  const rejected = [];
  const pane = harness({ onRejectedSample: (event) => rejected.push(event) });
  pane.controller.armWheelGesture(-125);
  pane.controller.noteGeometryChange({ index: 536, key: 'row-12592', delta: 3051 });
  for (let i = 0; i < 30; i++) pane.controller.configuration.enter(4993);
  assert.equal(rejected.length, 6);
  assert.equal(rejected[0].reason, 'opposite-to-input');
  assert.equal(rejected[0].geometry.key, 'row-12592');
  assert.equal(pane.controller.isActive(), false);
});
