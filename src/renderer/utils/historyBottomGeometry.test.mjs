import test from 'node:test';
import assert from 'node:assert';
import {
  historyContentDistanceFromBottom,
  isHistoryAtContentBottom,
} from './historyBottomGeometry.mjs';

test('History bottom is the one physical content edge', () => {
  const scroller = { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 };
  assert.equal(historyContentDistanceFromBottom(scroller), 100);
  assert.equal(historyContentDistanceFromBottom(null), Number.POSITIVE_INFINITY);
});

test('the shared bottom threshold distinguishes tail from a real reading position', () => {
  assert.equal(isHistoryAtContentBottom({
    scrollHeight: 1000, scrollTop: 796, clientHeight: 200,
  }), true);
  assert.equal(isHistoryAtContentBottom({
    scrollHeight: 1000, scrollTop: 790, clientHeight: 200,
  }), false);
  assert.equal(isHistoryAtContentBottom(null), false);
});

test('measured composer growth is the only temporary bottom slack', () => {
  const afterGrowth = { scrollHeight: 5000, scrollTop: 4634, clientHeight: 340 };
  assert.equal(isHistoryAtContentBottom(afterGrowth), false);
  assert.equal(isHistoryAtContentBottom(afterGrowth, { slackPx: 26 }), true);

  const readerAwayFromTail = { scrollHeight: 5000, scrollTop: 4000, clientHeight: 340 };
  assert.equal(isHistoryAtContentBottom(readerAwayFromTail, { slackPx: 26 }), false);
});
