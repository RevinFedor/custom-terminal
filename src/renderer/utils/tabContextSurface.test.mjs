import assert from 'node:assert/strict';
import test from 'node:test';
import { tabContextSurface, hiddenWindowTabContextHost, tabContextPaneIndex } from './tabContextSurface.mjs';

test('pane and center context hosts retain their exact surface', () => {
  assert.deepEqual(tabContextSurface('split-pane-header:2:tab:with:colons', 'tab:with:colons'), {
    kind: 'pane',
    paneIndex: 2,
  });
  assert.deepEqual(tabContextSurface('split-pane-header:center:tab-1', 'tab-1'), {
    kind: 'center',
  });
});

test('hidden picker menu captures window identity, not its array position or another copy', () => {
  const host = hiddenWindowTabContextHost(':instance:', 'space:x', 'window:y', 'tab:with:colons');
  const surface = tabContextSurface(host, 'tab:with:colons');
  assert.deepEqual(surface, { kind: 'window', spaceId: 'space:x', windowId: 'window:y' });
  assert.equal(tabContextSurface(host, 'other'), null);
  const pane = { windowId: 'window:y', tabId: '', tabs: [{ tabId: 'tab:with:colons' }] };
  const state = { activeSpaceId: 'space:x', splitPanes: [{ windowId: 'other' }, pane] };
  assert.equal(tabContextPaneIndex(surface, state, 'tab:with:colons'), 1);
  state.splitPanes.reverse();
  assert.equal(tabContextPaneIndex(surface, state, 'tab:with:colons'), 0);
  assert.equal(tabContextPaneIndex(surface, { ...state, activeSpaceId: 'different' }, 'tab:with:colons'), -1);
  assert.equal(tabContextPaneIndex(surface, { ...state, splitPanes: [{ ...pane, windowId: 'different' }] }, 'tab:with:colons'), -1);
  assert.equal(tabContextPaneIndex(surface, state, 'moved-away'), -1);
});

test('sidebar or stale host is not silently treated as a window', () => {
  assert.equal(tabContextSurface(null, 'tab-1'), null);
  assert.equal(tabContextSurface('split-pane-header:0:other', 'tab-1'), null);
  assert.equal(tabContextSurface('split-pane-header:nope:tab-1', 'tab-1'), null);
});
