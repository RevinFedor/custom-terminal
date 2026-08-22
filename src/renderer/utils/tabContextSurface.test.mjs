import assert from 'node:assert/strict';
import test from 'node:test';
import { tabContextSurface } from './tabContextSurface.mjs';

test('pane and center context hosts retain their exact surface', () => {
  assert.deepEqual(tabContextSurface('split-pane-header:2:tab:with:colons', 'tab:with:colons'), {
    kind: 'pane',
    paneIndex: 2,
  });
  assert.deepEqual(tabContextSurface('split-pane-header:center:tab-1', 'tab-1'), {
    kind: 'center',
  });
});

test('sidebar or stale host is not silently treated as a window', () => {
  assert.equal(tabContextSurface(null, 'tab-1'), null);
  assert.equal(tabContextSurface('split-pane-header:0:other', 'tab-1'), null);
  assert.equal(tabContextSurface('split-pane-header:nope:tab-1', 'tab-1'), null);
});
