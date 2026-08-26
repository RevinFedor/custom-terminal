import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickHistoryGestureAnchorCandidate,
  shouldArmHistoryGestureAnchor,
} from './historyGestureAnchor.mjs';
import { stabilizeHistoryRevealAnchor } from './historyRevealAnchor.mjs';

const frames = () => {
  const queue = [];
  return {
    requestFrame: (callback) => queue.push(callback),
    flush: () => { while (queue.length > 0) queue.shift()(); },
  };
};

test('only a real wheel movement with stable total height arms the anchor', () => {
  const base = {
    inputAt: 100,
    now: 120,
    direction: 'up',
    deltaTop: -62,
    previousScrollHeight: 180016,
    scrollHeight: 180016,
    machineOwned: false,
    presented: true,
  };
  assert.equal(shouldArmHistoryGestureAnchor(base), true);
  assert.equal(shouldArmHistoryGestureAnchor({ ...base, scrollHeight: 181128 }), false);
  assert.equal(shouldArmHistoryGestureAnchor({ ...base, deltaTop: 62 }), false);
  assert.equal(shouldArmHistoryGestureAnchor({ ...base, machineOwned: true }), false);
});

test('anchor is selected near the viewport centre so overscan retains it', () => {
  const picked = pickHistoryGestureAnchorCandidate([
    { identity: 'top', top: -20, bottom: 80 },
    { identity: 'middle', top: 410, bottom: 560 },
    { identity: 'bottom', top: 900, bottom: 1050 },
  ], 0, 1000);
  assert.equal(picked?.identity, 'middle');
});

for (const incident of [
  { name: 'tab-4196 +1112 height / +384.5 scroll correction', drift: -384.5 },
  { name: 'tab-812 -333 height / -331 scroll correction', drift: 331 },
]) {
  test(`${incident.name} is returned to the user-owned semantic frame`, () => {
    const queue = frames();
    const writes = [];
    let anchorTop = 450;
    stabilizeHistoryRevealAnchor({
      targetTop: 450,
      readAnchorTop: () => anchorTop,
      adjustScrollBy: (delta, source) => {
        writes.push({ delta, source });
        anchorTop -= delta;
      },
      requestFrame: queue.requestFrame,
      minimumFrames: 2,
      maxFrames: 3,
      stableFramesRequired: 2,
    });
    anchorTop += incident.drift;
    queue.flush();
    assert.equal(anchorTop, 450);
    assert.equal(writes.length, 1);
  });
}
