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
