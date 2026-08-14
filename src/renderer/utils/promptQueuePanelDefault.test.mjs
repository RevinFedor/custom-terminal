import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RUN_AFTER_PANEL_COLLAPSED,
  panelCollapsedIsWorthPersisting,
  resolvePersistedPanelCollapsed,
} from './promptQueuePanelDefault.mjs';

test('a brand-new tab opens collapsed', () => {
  assert.equal(DEFAULT_RUN_AFTER_PANEL_COLLAPSED, true);
  assert.equal(resolvePersistedPanelCollapsed(undefined), true);
  assert.equal(resolvePersistedPanelCollapsed(null), true);
});

test('a row written before this field existed reads as the default, not as expanded', () => {
  // Old rows carry no flag. Reading a missing flag as `false` would silently
  // expand every restored tab and look like the setting was ignored.
  assert.equal(resolvePersistedPanelCollapsed(undefined), DEFAULT_RUN_AFTER_PANEL_COLLAPSED);
});

test('an explicit choice round-trips both ways', () => {
  assert.equal(resolvePersistedPanelCollapsed(false), false);
  assert.equal(resolvePersistedPanelCollapsed(true), true);
});

test('expanding an empty tab is worth saving; collapsing it is not', () => {
  // This is the pair that must never drift: storage skips default-valued empty
  // tabs, so "worth persisting" has to mean exactly "differs from the default".
  assert.equal(panelCollapsedIsWorthPersisting(false), true);
  assert.equal(panelCollapsedIsWorthPersisting(true), false);
  assert.equal(panelCollapsedIsWorthPersisting(undefined), false);
});
