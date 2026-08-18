import assert from 'node:assert/strict';
import test from 'node:test';

import { isVisitWorthRecording, onScreenTabIds } from './tabVisitHistoryRule.mjs';

const pane = (tabId) => ({ projectId: 'p', tabId });

test('freshness follows FOCUS — a tab already on screen still counts', () => {
  // The defect this replaces: gating the record on "did it appear" froze the
  // rank of any tab living in a pane. It could be worked in all day without one
  // recorded event (it never appeared — it was already there), and leaving the
  // screen is not an event either, so every unrelated activation pushed it a
  // place further down. Reported live as *«вкладка отходит всё назад и назад»*:
  // the tab just worked in showed up tenth in Ctrl+Tab.
  assert.equal(isVisitWorthRecording({ tabId: 'a' }), true);
  assert.equal(isVisitWorthRecording({ tabId: 'b' }), true);
});

test('bringing a hidden tab onto a surface counts too', () => {
  assert.equal(isVisitWorthRecording({ tabId: 'c' }), true);
});

test('a missing tab id is never a visit', () => {
  assert.equal(isVisitWorthRecording({ tabId: '' }), false);
  assert.equal(isVisitWorthRecording({}), false);
});

test('visibility does not gate recording — it is a separate question', () => {
  // Passing the old argument must change nothing: whether a tab may be OFFERED
  // as a return target is decided by the switcher over its own rows
  // (TabSwitcherOverlay::computeRowsFromStores), not here. Keeping both answers
  // in one flag is exactly what broke it twice, in opposite directions.
  assert.equal(isVisitWorthRecording({ tabId: 'a', visibleTabIds: ['a', 'b'] }), true);
  assert.equal(isVisitWorthRecording({ tabId: 'a', visibleTabIds: [] }), true);
});

test('on-screen tabs: panes win, otherwise the centre tab', () => {
  assert.deepEqual(onScreenTabIds({ panes: [pane('a'), pane('b')], centerTabId: 'b' }), ['a', 'b']);
  assert.deepEqual(onScreenTabIds({ panes: [], centerTabId: 'a' }), ['a']);
  assert.deepEqual(onScreenTabIds({ panes: [], centerTabId: null }), []);
  // An empty placeholder pane shows no tab.
  assert.deepEqual(onScreenTabIds({ panes: [pane('a'), { projectId: '', tabId: '' }], centerTabId: 'a' }), ['a']);
});
