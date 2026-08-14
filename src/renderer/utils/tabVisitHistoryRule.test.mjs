import assert from 'node:assert/strict';
import test from 'node:test';

import { isVisitWorthRecording, onScreenTabIds } from './tabVisitHistoryRule.mjs';

const pane = (tabId) => ({ projectId: 'p', tabId });

test('switching focus between two visible panes is NOT a visit', () => {
  // The reported problem: clicking the neighbouring pane rewrote the history,
  // and Ctrl+Tab then offered the tab already on screen.
  const visible = ['a', 'b'];
  assert.equal(isVisitWorthRecording({ tabId: 'a', visibleTabIds: visible }), false);
  assert.equal(isVisitWorthRecording({ tabId: 'b', visibleTabIds: visible }), false);
});

test('bringing a hidden tab onto a surface IS a visit', () => {
  assert.equal(isVisitWorthRecording({ tabId: 'c', visibleTabIds: ['a', 'b'] }), true);
});

test('single mode still records every real switch', () => {
  // One visible tab: switching to any other tab makes it appear, so the old
  // behaviour is unchanged where there are no panes.
  assert.equal(isVisitWorthRecording({ tabId: 'b', visibleTabIds: ['a'] }), true);
  assert.equal(isVisitWorthRecording({ tabId: 'a', visibleTabIds: ['a'] }), false);
});

test('nothing on screen yet — a first activation is a visit', () => {
  assert.equal(isVisitWorthRecording({ tabId: 'a', visibleTabIds: [] }), true);
});

test('a missing tab id is never a visit', () => {
  assert.equal(isVisitWorthRecording({ tabId: '', visibleTabIds: ['a'] }), false);
});

test('on-screen tabs: panes win, otherwise the centre tab', () => {
  assert.deepEqual(onScreenTabIds({ panes: [pane('a'), pane('b')], centerTabId: 'b' }), ['a', 'b']);
  assert.deepEqual(onScreenTabIds({ panes: [], centerTabId: 'a' }), ['a']);
  assert.deepEqual(onScreenTabIds({ panes: [], centerTabId: null }), []);
  // An empty placeholder pane shows no tab.
  assert.deepEqual(onScreenTabIds({ panes: [pane('a'), { projectId: '', tabId: '' }], centerTabId: 'a' }), ['a']);
});
