import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveToastHostTabId,
  visibleToastTabIds,
  isToastVisible,
} from './toastPlacement.mjs';

const pane = (tabId) => ({ projectId: 'p', tabId });

test('split mode: every pane tab is visible, focus is irrelevant', () => {
  // The bug: a toast about pane 0 disappeared the moment pane 1 took focus,
  // although pane 0 is still on screen.
  const ids = visibleToastTabIds({ panes: [pane('a'), pane('b')], effectiveTabId: 'b' });
  assert.deepEqual(ids, ['a', 'b']);
});

test('single mode: the centre tab is the only visible one', () => {
  assert.deepEqual(visibleToastTabIds({ panes: [], effectiveTabId: 'a' }), ['a']);
  assert.deepEqual(visibleToastTabIds({ panes: [], effectiveTabId: null }), []);
});

test('empty placeholder panes contribute no tab', () => {
  const ids = visibleToastTabIds({ panes: [pane('a'), { projectId: '', tabId: '' }], effectiveTabId: 'a' });
  assert.deepEqual(ids, ['a']);
});

test('a tab-scoped toast is hosted by ITS pane', () => {
  const visible = ['a', 'b'];
  assert.equal(resolveToastHostTabId({ tabId: 'a' }, visible), 'a');
  assert.equal(resolveToastHostTabId({ tabId: 'b' }, visible), 'b');
});

test('a global toast has no host — it stays in the window corner', () => {
  assert.equal(resolveToastHostTabId({}, ['a']), null);
  assert.equal(resolveToastHostTabId({ tabId: '' }, ['a']), null);
});

test('a toast for an off-screen tab falls back to the window, never vanishes', () => {
  // Dropping it would silently lose a message about background work.
  assert.equal(resolveToastHostTabId({ tabId: 'zzz' }, ['a', 'b']), null);
  assert.equal(isToastVisible({ tabId: 'zzz' }), true);
});
