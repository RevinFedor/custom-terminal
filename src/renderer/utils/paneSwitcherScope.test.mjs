import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSwitcherScope, paneFrameState, filterProjectsToPaneHistory } from './paneSwitcherScope.mjs';

const panes = [{ projectId: 'p1', tabId: 'a' }, { projectId: 'p1', tabId: 'b' }];

test('a pane that owns the keyboard and has a past gets its OWN list', () => {
  const res = resolveSwitcherScope({ keyboardPaneIndex: 1, panes, paneHistoryCount: 3 });
  assert.equal(res.scope, 'pane');
  assert.equal(res.paneIndex, 1);
});

// The objection this answers: "a fresh pane shows nothing, so the gesture dies
// there". Approved resolution — fall through to the global list.
test('a pane with no past falls through to the global list, never an empty box', () => {
  const res = resolveSwitcherScope({ keyboardPaneIndex: 1, panes, paneHistoryCount: 0 });
  assert.equal(res.scope, 'global');
  assert.equal(res.reason, 'pane-history-empty');
});

test('keyboard in the interface → global, even with panes on screen', () => {
  // Clicking the sidebar or a top bar does not deactivate the tab; it moves the
  // keyboard out of the pane, and Ctrl+Tab follows the keyboard.
  const res = resolveSwitcherScope({ keyboardPaneIndex: -1, panes, paneHistoryCount: 5 });
  assert.equal(res.scope, 'global');
  assert.equal(res.reason, 'no-pane-owner');
});

test('single mode is always global — there is no pane to scope to', () => {
  const res = resolveSwitcherScope({ keyboardPaneIndex: 0, panes: [], paneHistoryCount: 9 });
  assert.equal(res.scope, 'global');
  assert.equal(res.reason, 'single-mode');
});

test('a stale pane index cannot scope to a pane that is gone', () => {
  // Panes shrink (a pane closed while the index was captured in a closure).
  const res = resolveSwitcherScope({ keyboardPaneIndex: 7, panes, paneHistoryCount: 4 });
  assert.equal(res.scope, 'global');
});

test('broken input degrades to global instead of throwing', () => {
  assert.equal(resolveSwitcherScope({}).scope, 'global');
  assert.equal(resolveSwitcherScope({ keyboardPaneIndex: null, panes: null }).scope, 'global');
  assert.equal(
    resolveSwitcherScope({ keyboardPaneIndex: 0, panes, paneHistoryCount: NaN }).scope,
    'global',
    'NaN is not a history',
  );
});

// ── pane-scoped rows ─────────────────────────────────────────────────────

test('the pane list contains ONLY tabs from this pane past, projects with none vanish', () => {
  const projects = [
    { projectId: 'p1', projectName: 'One', tabs: [{ id: 'a' }, { id: 'b' }] },
    { projectId: 'p2', projectName: 'Two', tabs: [{ id: 'c' }] },
  ];
  const history = [{ projectId: 'p1', tabId: 'b' }];
  const res = filterProjectsToPaneHistory(projects, history);
  assert.equal(res.length, 1);
  assert.deepEqual(res[0].tabs.map((t) => t.id), ['b']);
});

test('an empty history yields an empty list — the caller falls back to global', () => {
  const projects = [{ projectId: 'p1', projectName: 'One', tabs: [{ id: 'a' }] }];
  assert.deepEqual(filterProjectsToPaneHistory(projects, []), []);
  assert.deepEqual(filterProjectsToPaneHistory(projects, null), []);
});

// ── frame ────────────────────────────────────────────────────────────────

test('the frame distinguishes "keyboard here" from "active but keyboard elsewhere"', () => {
  assert.equal(paneFrameState({ isFocusedPane: true, keyboardInPane: true }), 'owns-keyboard');
  assert.equal(paneFrameState({ isFocusedPane: true, keyboardInPane: false }), 'active-only');
  assert.equal(paneFrameState({ isFocusedPane: false, keyboardInPane: true }), 'idle');
  assert.equal(paneFrameState({ isFocusedPane: false, keyboardInPane: false }), 'idle');
});
