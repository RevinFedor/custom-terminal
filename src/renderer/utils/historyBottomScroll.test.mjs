import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistoryTailPinScheduler,
  isHistoryTailPinned,
  reconcileHistoryTailFollowIntent,
  scheduleHistoryBottomScroll,
} from './historyBottomScroll.mjs';

const createFrameQueue = () => {
  const queue = [];
  return {
    requestFrame: (callback) => queue.push(callback),
    flushOne: () => queue.shift()?.(),
    flush: () => {
      while (queue.length > 0) queue.shift()();
    },
  };
};

test('empty transcript still pixel-scrolls the composer spacer', () => {
  const frames = createFrameQueue();
  const indexCalls = [];
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 640,
    scrollTo: (options) => scrollCalls.push(options),
  };

  scheduleHistoryBottomScroll({
    virtuoso: { scrollToIndex: (options) => indexCalls.push(options) },
    itemCount: 0,
    getScroller: () => scroller,
    requestFrame: frames.requestFrame,
  });
  frames.flush();

  assert.deepEqual(indexCalls, []);
  assert.deepEqual(scrollCalls, [{ top: 640, behavior: 'auto' }]);
});

test('history materializes its final transcript row before pixel scrolling', () => {
  const frames = createFrameQueue();
  const indexCalls = [];
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 900,
    scrollTo: (options) => scrollCalls.push(options),
  };

  scheduleHistoryBottomScroll({
    virtuoso: { scrollToIndex: (options) => indexCalls.push(options) },
    itemCount: 3,
    getScroller: () => scroller,
    smooth: true,
    requestFrame: frames.requestFrame,
  });
  frames.flush();

  assert.deepEqual(indexCalls, [{
    index: 2,
    align: 'end',
    behavior: 'auto',
  }]);
  assert.deepEqual(scrollCalls, [{ top: 900, behavior: 'smooth' }]);
});

test('tail pin predicate is exact instead of treating the 150px arrow zone as pinned', () => {
  assert.equal(isHistoryTailPinned({
    scrollHeight: 1000,
    scrollTop: 496,
    clientHeight: 500,
  }), true);
  assert.equal(isHistoryTailPinned({
    scrollHeight: 1000,
    scrollTop: 495,
    clientHeight: 500,
  }), false);
});

test('content growth preserves tail-follow intent until a real user gesture moves away', () => {
  assert.equal(reconcileHistoryTailFollowIntent({
    currentIntent: true,
    physicalPinned: false,
  }), true, 'a taller streaming footer is not a user scroll');
  assert.equal(reconcileHistoryTailFollowIntent({
    currentIntent: true,
    physicalPinned: false,
    userMovedAway: true,
  }), false);
  assert.equal(reconcileHistoryTailFollowIntent({
    currentIntent: false,
    physicalPinned: true,
  }), false, 'layout still sitting on the old bottom cannot undo an explicit unpin');
  assert.equal(reconcileHistoryTailFollowIntent({
    currentIntent: false,
    physicalPinned: true,
    userReachedBottom: true,
  }), true, 'a real downward gesture reaching the tail re-enables follow');
});

test('live tail pin coalesces updates into one direct pixel scroll on one frame', () => {
  const frames = createFrameQueue();
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 1200,
    scrollTo: (options) => scrollCalls.push(options),
  };
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => scroller,
    requestFrame: frames.requestFrame,
  });

  assert.equal(scheduler.schedule({ shouldPin: true }), true);
  assert.equal(scheduler.schedule({ shouldPin: true }), false);
  assert.equal(scheduler.isPending(), true);
  frames.flush();

  assert.equal(scheduler.isPending(), false);
  assert.deepEqual(scrollCalls, [{ top: 1200, behavior: 'auto' }]);
});

test('send tail pin follows optimistic append and composer collapse until geometry settles', () => {
  const frames = createFrameQueue();
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    scrollTo(options) {
      scrollCalls.push(options);
      this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
    },
  };
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => scroller,
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({
    shouldPin: true,
    settleUntilStable: true,
    minimumSettleFrames: 4,
    maximumSettleFrames: 12,
    requiredStableFrames: 2,
  });

  frames.flushOne();
  scroller.scrollHeight = 1180; // optimistic prompt row committed
  frames.flushOne();
  scroller.clientHeight = 520; // cleared composer became shorter
  scroller.scrollHeight = 1360; // Virtuoso measured the real prompt height
  frames.flushOne();
  assert.equal(scheduler.schedule({
    shouldPin: true,
    settleUntilStable: true,
    minimumSettleFrames: 4,
    maximumSettleFrames: 12,
    requiredStableFrames: 2,
  }), false, 'durable adoption coalesces into the same physical transaction');
  scroller.scrollHeight = 1500; // canonical prompt replaced the optimistic row
  frames.flush();

  assert.equal(scroller.scrollTop, 980);
  assert.equal(isHistoryTailPinned(scroller), true);
  assert.deepEqual(
    scrollCalls.map((call) => call.top),
    [1180, 1360, 1500],
    'the pin must react to every post-send geometry change without no-op writes',
  );
  assert.equal(scheduler.isPending(), false);
});

test('a real upward gesture cancels an in-progress settling tail pin', () => {
  const frames = createFrameQueue();
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    scrollTo(options) {
      scrollCalls.push(options);
      this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
    },
  };
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => scroller,
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({
    shouldPin: true,
    settleUntilStable: true,
    minimumSettleFrames: 4,
    maximumSettleFrames: 12,
  });
  frames.flushOne();
  assert.equal(scheduler.cancel(), true);
  scroller.scrollHeight = 1400;
  frames.flush();

  assert.equal(scrollCalls.length, 0);
  assert.equal(scroller.scrollTop, 600, 'the cancelled transaction must not pull the reader down');
  assert.equal(scheduler.isPending(), false);
});

test('a settling tail pin remains bounded under continuous layout churn', () => {
  const frames = createFrameQueue();
  const scrollCalls = [];
  const scroller = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 500,
    scrollTo(options) {
      scrollCalls.push(options);
      this.scrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
      this.scrollHeight += 20; // another asynchronous measurement landed
    },
  };
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => scroller,
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({
    shouldPin: true,
    settleUntilStable: true,
    minimumSettleFrames: 2,
    maximumSettleFrames: 5,
    requiredStableFrames: 2,
  });
  frames.flush();

  assert.equal(scrollCalls.length, 5);
  assert.equal(scheduler.isPending(), false);
});

test('a settling tail transaction cannot continue in a replacement owner', () => {
  const frames = createFrameQueue();
  const writes = [];
  const scrollerA = {
    scrollHeight: 1200,
    clientHeight: 400,
    scrollTop: 700,
    scrollTo: (options) => writes.push({ owner: 'A', ...options }),
  };
  const scrollerB = {
    scrollHeight: 2400,
    clientHeight: 400,
    scrollTop: 2000,
    scrollTo: (options) => writes.push({ owner: 'B', ...options }),
  };
  let currentScroller = scrollerA;
  let ownerToken = 'owner-a';
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => currentScroller,
    getOwnerToken: () => ownerToken,
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({
    shouldPin: true,
    settleUntilStable: true,
    minimumSettleFrames: 4,
    maximumSettleFrames: 12,
  });
  frames.flushOne();
  currentScroller = scrollerB;
  ownerToken = 'owner-b';
  frames.flush();

  assert.deepEqual(writes, [{ owner: 'A', top: 1200, behavior: 'auto' }]);
  assert.equal(scheduler.isPending(), false);
});

test('upward user intent cancels a pending live tail pin', () => {
  const frames = createFrameQueue();
  const scrollCalls = [];
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => ({
      scrollHeight: 1200,
      scrollTo: (options) => scrollCalls.push(options),
    }),
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({ shouldPin: true });
  assert.equal(scheduler.cancel(), true);
  frames.flush();

  assert.deepEqual(scrollCalls, []);
  assert.equal(scheduler.isPending(), false);
});

test('live tail pin does not schedule when the viewport was not exactly pinned', () => {
  const frames = createFrameQueue();
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => {
      throw new Error('scroller must not be read');
    },
    requestFrame: frames.requestFrame,
  });

  assert.equal(scheduler.schedule({ shouldPin: false }), false);
  frames.flush();
});

test('a pending tail pin stays with the scroller that scheduled it', () => {
  const frames = createFrameQueue();
  const writes = [];
  const scrollerA = {
    scrollHeight: 1200,
    scrollTo: (options) => writes.push({ owner: 'A', ...options }),
  };
  const scrollerB = {
    scrollHeight: 2400,
    scrollTo: (options) => writes.push({ owner: 'B', ...options }),
  };
  let currentScroller = scrollerA;
  const scheduler = createHistoryTailPinScheduler({
    getScroller: () => currentScroller,
    requestFrame: frames.requestFrame,
  });

  scheduler.schedule({ shouldPin: true });
  currentScroller = scrollerB;
  frames.flush();

  assert.deepEqual(
    writes,
    [],
    'an operation armed by owner A must be rejected after the mounted scroller becomes B',
  );
});

test('the delayed final pixel scroll cannot cross an owner remount', () => {
  const frames = createFrameQueue();
  const writes = [];
  const scrollerA = {
    scrollHeight: 900,
    scrollTo: (options) => writes.push({ owner: 'A', ...options }),
  };
  const scrollerB = {
    scrollHeight: 1800,
    scrollTo: (options) => writes.push({ owner: 'B', ...options }),
  };
  let currentScroller = scrollerA;

  scheduleHistoryBottomScroll({
    virtuoso: { scrollToIndex: () => {} },
    itemCount: 3,
    getScroller: () => currentScroller,
    requestFrame: frames.requestFrame,
  });
  currentScroller = scrollerB;
  frames.flush();

  assert.deepEqual(
    writes,
    [],
    'the second-frame footer correction belongs to A and must not write into B',
  );
});
