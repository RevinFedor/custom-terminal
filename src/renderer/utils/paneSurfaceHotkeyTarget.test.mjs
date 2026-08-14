import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePaneSurfaceHotkeyTabId } from './paneSurfaceHotkeyTarget.mjs';

const p = (tabId) => ({ projectId: 'p1', tabId });

test('single mode acts on the active tab, exactly as before', () => {
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({ panes: [], focusedIndex: 0, activeTabId: 'a' }),
    'a',
  );
});

// THE REPORTED BUG (production.log, 21:43 UTC): tab-2403 was dropped into pane 0
// through the pane's recent-tabs list, which deliberately does NOT move focus or
// the centre. Every Cmd+] then toggled tab-3314 — the tab still marked active in
// the OTHER pane — so the pane in front of the user never reacted.
test('a pane filled without focus still owns its own surface shortcut', () => {
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({
      panes: [p('tab-2403'), p('tab-3314')],
      focusedIndex: 0,
      activeTabId: 'tab-3314',
    }),
    'tab-2403',
    'the FOCUSED PANE decides, not the active tab',
  );
});

test('with focus and the active tab agreeing, nothing changes', () => {
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({
      panes: [p('a'), p('b')],
      focusedIndex: 1,
      activeTabId: 'b',
    }),
    'b',
  );
});

test('an empty placeholder pane falls back to the active tab', () => {
  // A placeholder has no surfaces to toggle; the active tab is still visible in
  // some other pane, so the key stays alive instead of doing nothing.
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({
      panes: [p('a'), { projectId: '', tabId: '' }],
      focusedIndex: 1,
      activeTabId: 'a',
    }),
    'a',
  );
});

test('a stale focus index clamps instead of returning nothing', () => {
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({ panes: [p('a'), p('b')], focusedIndex: 9, activeTabId: 'a' }),
    'b',
  );
  assert.equal(
    resolvePaneSurfaceHotkeyTabId({ panes: [p('a'), p('b')], focusedIndex: -3, activeTabId: 'b' }),
    'a',
  );
});

test('broken input degrades to the active tab, never throws', () => {
  assert.equal(resolvePaneSurfaceHotkeyTabId({ panes: null, focusedIndex: null, activeTabId: 'a' }), 'a');
  assert.equal(resolvePaneSurfaceHotkeyTabId({}), null);
});
