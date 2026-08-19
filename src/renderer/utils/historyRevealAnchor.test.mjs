import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeHistoryRevealAnchor } from './historyRevealAnchor.mjs';

const frameQueue = () => {
  const queue = [];
  return {
    requestFrame: (callback) => queue.push(callback),
    flushOne: () => queue.shift()?.(),
    size: () => queue.length,
  };
};

test('clicked header survives immediate and late Virtuoso compensation', () => {
  const frames = frameQueue();
  const writes = [];
  const outcomes = [];
  let headerTop = 476;
  stabilizeHistoryRevealAnchor({
    targetTop: 645,
    readAnchorTop: () => headerTop,
    adjustScrollBy: (delta) => {
      writes.push(delta);
      // Increasing scrollTop moves content up; decreasing it moves content down.
      headerTop -= delta;
    },
    requestFrame: frames.requestFrame,
    onFinish: (outcome) => outcomes.push(outcome),
  });
  assert.deepEqual(writes, [-169], 'the commit correction happens before paint');
  assert.equal(headerTop, 645);

  // Virtuoso's measured-size pass lands one frame later.
  headerTop = 562;
  frames.flushOne();
  assert.deepEqual(writes, [-169, -83]);
  assert.equal(headerTop, 645);
  while (frames.size()) frames.flushOne();
  assert.equal(outcomes[0].reason, 'settled');
  assert.equal(outcomes[0].writes, 2);
});

test('a real user gesture immediately takes position ownership', () => {
  const frames = frameQueue();
  let userGesture = false;
  let writes = 0;
  stabilizeHistoryRevealAnchor({
    targetTop: 100,
    readAnchorTop: () => 100,
    adjustScrollBy: () => { writes += 1; },
    hasUserGesture: () => userGesture,
    requestFrame: frames.requestFrame,
  });
  userGesture = true;
  frames.flushOne();
  assert.equal(writes, 0);
});

test('stability is not declared before a delayed measurement pass', () => {
  const frames = frameQueue();
  const writes = [];
  const outcomes = [];
  let headerTop = 645;
  stabilizeHistoryRevealAnchor({
    targetTop: 645,
    readAnchorTop: () => headerTop,
    adjustScrollBy: (delta) => {
      writes.push(delta);
      headerTop -= delta;
    },
    requestFrame: frames.requestFrame,
    onFinish: (outcome) => outcomes.push(outcome),
  });
  for (let frame = 0; frame < 10; frame += 1) frames.flushOne();
  headerTop = 562; // late Virtuoso measured-size compensation
  frames.flushOne();
  assert.deepEqual(writes, [-83]);
  while (frames.size()) frames.flushOne();
  assert.equal(outcomes[0].reason, 'settled');
});

test('a lost header is bounded and never writes blind scroll deltas', () => {
  const frames = frameQueue();
  const outcomes = [];
  let writes = 0;
  stabilizeHistoryRevealAnchor({
    targetTop: 100,
    readAnchorTop: () => null,
    adjustScrollBy: () => { writes += 1; },
    requestFrame: frames.requestFrame,
    maxFrames: 3,
    onFinish: (outcome) => outcomes.push(outcome),
  });
  while (frames.size()) frames.flushOne();
  assert.equal(writes, 0);
  assert.equal(outcomes[0].reason, 'max-frames');
});
