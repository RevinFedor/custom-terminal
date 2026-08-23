import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSwitcherRows,
  dropFromMru,
  getLayoutVariants,
  initialCtrlIndex,
  selectableIndices,
  shortPath,
  stepIndex,
  touchMru,
  rebuildGlobalTabMru,
} from './tabSwitcherModel.mjs';

const tab = (id, name = id, extra = {}) => ({ id, name, ...extra });
const located = (id, name, workflowId, workflowName) => tab(id, name, {
  workflowId,
  workflowName,
  workflowIcon: `${workflowId}.png`,
});

const projects = [
  {
    projectId: 'p1',
    projectName: 'custom-terminal',
    tabs: [
      located('a', 'claude-03', 'w1', 'main'),
      located('b', 'run-dev', 'w1', 'main'),
      located('c', 'bash', 'w1', 'main'),
    ],
  },
  {
    projectId: 'p2',
    projectName: 'gt-editor',
    tabs: [
      located('d', 'codex-1', 'w2', 'editor'),
      located('e', 'план.md', 'w2', 'editor'),
    ],
  },
];

test('rows follow strict global recency; workflow headers are TOC separators', () => {
  const rows = buildSwitcherRows({
    projects,
    globalMru: [
      { projectId: 'p2', tabId: 'd' },
      { projectId: 'p1', tabId: 'b' },
      { projectId: 'p1', tabId: 'a' },
    ],
  });
  // d(w2) → b,a(w1) by recency; unranked keep project order: c(w1) then e(w2).
  // w2 header appears TWICE — headers split runs, they don't merge workflows.
  assert.deepEqual(rows.map(r => r.kind === 'workflow' ? `W:${r.workflowId}` : `t:${r.tab.id}`), [
    'W:w2', 't:d',
    'W:w1', 't:b', 't:a', 't:c',
    'W:w2', 't:e',
  ]);
});

test('one hop reaches the previous project tab regardless of current project size', () => {
  // User on p2/d; p1/a was previous. p2 has more tabs but the FIRST step from
  // the top must land on a (the globally previous tab), not walk p2's tabs.
  const manyTabsP2 = {
    projectId: 'p2',
    projectName: 'gt-editor',
    tabs: ['d', 'e', 'f', 'g', 'h'].map((id) => located(id, id, 'w2', 'editor')),
  };
  const rows = buildSwitcherRows({
    projects: [projects[0], manyTabsP2],
    globalMru: [
      { projectId: 'p2', tabId: 'd' }, // current
      { projectId: 'p1', tabId: 'a' }, // previous
      { projectId: 'p2', tabId: 'e' },
    ],
  });
  const flat = rows.filter(r => r.kind === 'tab').map(r => r.tab.id);
  assert.deepEqual(flat.slice(0, 3), ['d', 'a', 'e']);
  const idx = initialCtrlIndex(rows, [
    { projectId: 'p2', tabId: 'd' },
    { projectId: 'p1', tabId: 'a' },
  ], 'd');
  assert.equal(rows[idx].tab.id, 'a');
});

test('Ctrl+Tab: row 1 is the anchor, the highlight lands on row 2', () => {
  // The caller (TabSwitcherOverlay::computeRowsFromStores) drops every tab on
  // screen EXCEPT the current one, and pins that one first. So with a (current)
  // and d (other pane) visible, the rows are a, then what cannot be seen — and
  // the highlight lands on b, "where releasing Ctrl takes me".
  const withAnchor = [{
    projectId: 'p1',
    projectName: 'custom-terminal',
    tabs: [
      located('a', 'claude-03', 'w1', 'main'),
      located('b', 'run-dev', 'w1', 'main'),
      located('c', 'bash', 'w1', 'main'),
    ],
  }];
  const mru = [
    { projectId: 'p2', tabId: 'd' },
    { projectId: 'p1', tabId: 'b' },
    { projectId: 'p1', tabId: 'a' },
  ];
  const rows = buildSwitcherRows({ projects: withAnchor, globalMru: mru, pinnedFirstTabId: 'a' });
  // 'a' heads the list although the history ranks it LAST of the three — being
  // looked at is not recorded as a visit, so recency cannot supply the anchor.
  assert.deepEqual(rows.filter(r => r.kind === 'tab').map(r => r.tab.id), ['a', 'b', 'c']);
  const idx = initialCtrlIndex(rows, mru, 'a');
  assert.equal(rows[idx].tab.id, 'b');
  // d is on screen in the other pane → the caller never passes it here.
  assert.ok(!rows.some(r => r.kind === 'tab' && r.tab.id === 'd'));
});

test('the anchor heads the list even with no history at all', () => {
  const rows = buildSwitcherRows({ projects, globalMru: [], pinnedFirstTabId: 'e' });
  const first = rows.find(r => r.kind === 'tab');
  assert.equal(first.tab.id, 'e');
  assert.equal(rows[0].kind, 'workflow', 'its workflow header still comes first');
  assert.equal(rows[0].workflowId, 'w2');
});

test('nothing but the anchor selects NOTHING — never the current tab', () => {
  // Every other tab is on screen, so the caller passes only the anchor. Picking
  // it would re-activate the tab the user is already on, which is not a no-op:
  // activation switches the project view and yanks the sidebar to that row.
  const onlyAnchor = [{ projectId: 'p1', projectName: 'custom-terminal', tabs: [located('a', 'a', 'w1', 'main')] }];
  const rows = buildSwitcherRows({
    projects: onlyAnchor,
    globalMru: [{ projectId: 'p1', tabId: 'a' }],
    pinnedFirstTabId: 'a',
  });
  assert.equal(initialCtrlIndex(rows, [{ projectId: 'p1', tabId: 'a' }], 'a'), -1);
});

test('single mode: the previous tab wins', () => {
  const rows = buildSwitcherRows({
    projects,
    globalMru: [{ projectId: 'p2', tabId: 'd' }, { projectId: 'p1', tabId: 'a' }],
  });
  assert.equal(rows[initialCtrlIndex(rows, [
    { projectId: 'p2', tabId: 'd' },
    { projectId: 'p1', tabId: 'a' },
  ], 'd')].tab.id, 'a');
});

test('an empty history falls back to any non-active tab', () => {
  const rows = buildSwitcherRows({ projects, globalMru: [] });
  const idx = initialCtrlIndex(rows, [], 'a');
  assert.notEqual(rows[idx].tab.id, 'a', 'must not preselect the active tab');
});

test('selection skips workflow headers and wraps', () => {
  const rows = buildSwitcherRows({ projects, globalMru: [{ projectId: 'p1', tabId: 'a' }] });
  const sel = selectableIndices(rows);
  assert.equal(rows[sel[0]].kind, 'tab');
  // Step from the last selectable wraps to the first, never landing on a header.
  const last = sel[sel.length - 1];
  const next = stepIndex(rows, last, +1);
  assert.equal(next, sel[0]);
  const prev = stepIndex(rows, sel[0], -1);
  assert.equal(prev, last);
});

test('initial ctrl highlight = globally previous tab across projects', () => {
  const rows = buildSwitcherRows({
    projects,
    globalMru: [
      { projectId: 'p1', tabId: 'a' }, // current
      { projectId: 'p2', tabId: 'd' }, // previous → expected initial
    ],
  });
  const idx = initialCtrlIndex(rows, [
    { projectId: 'p1', tabId: 'a' },
    { projectId: 'p2', tabId: 'd' },
  ], 'a');
  assert.equal(rows[idx].tab.id, 'd');
});

test('query filters by tab name in both layouts; project-name match keeps its tabs', () => {
  // 'кгт' typed in RU maps to 'run' in EN layout.
  const rows = buildSwitcherRows({ projects, globalMru: [], query: 'кгт' });
  assert.deepEqual(rows.filter(r => r.kind === 'tab').map(r => r.tab.id), ['b']);

  const byProject = buildSwitcherRows({ projects, globalMru: [], query: 'gt-editor' });
  assert.deepEqual(byProject.filter(r => r.kind === 'tab').map(r => r.tab.id), ['d', 'e']);

  const byWorkflow = buildSwitcherRows({ projects, globalMru: [], query: 'editor' });
  assert.deepEqual(byWorkflow.filter(r => r.kind === 'tab').map(r => r.tab.id), ['d', 'e']);
});

test('a tab with no placement remains available under the neutral workflow group', () => {
  const rows = buildSwitcherRows({
    projects: [{ projectId: 'p1', projectName: 'custom-terminal', tabs: [tab('loose', 'loose tab')] }],
    globalMru: [],
  });
  assert.equal(rows[0].kind, 'workflow');
  assert.equal(rows[0].workflowId, '__workflow_unplaced__');
  assert.equal(rows[0].workflowName, 'Не размещены');
  assert.equal(rows[1].kind, 'tab');
  assert.equal(rows[1].projectId, 'p1');
});

test('layout variants include original, en and ru projections', () => {
  assert.ok(getLayoutVariants('Ghbdtn').includes('привет'));
  assert.ok(getLayoutVariants('привет').includes('ghbdtn'));
});

test('touchMru moves entry to head, dropFromMru removes it', () => {
  let mru = touchMru([], 'p1', 'a');
  mru = touchMru(mru, 'p2', 'd');
  mru = touchMru(mru, 'p1', 'a');
  assert.deepEqual(mru.map(e => e.tabId), ['a', 'd']);
  assert.deepEqual(dropFromMru(mru, 'd').map(e => e.tabId), ['a']);
});

test('shortPath collapses HOME and long tails', () => {
  assert.equal(shortPath('/Users/x/Desktop/proj', '/Users/x'), '~/Desktop/proj');
  assert.equal(shortPath('/a/b/c/d/e'), '…/d/e');
});

// ── restore: durable visit order ──────────────────────────────────────────
const T = (projectId, tabId, lastActivatedAt) => ({ projectId, tabId, lastActivatedAt });

test('rebuildGlobalTabMru orders by durable stamp, newest first, across projects', () => {
  const tabs = [
    T('p1', 'a', 1000),
    T('p2', 'b', 3000),
    T('p3', 'c', 2000),
  ];
  assert.deepEqual(rebuildGlobalTabMru(tabs, []), [
    { projectId: 'p2', tabId: 'b' },
    { projectId: 'p3', tabId: 'c' },
    { projectId: 'p1', tabId: 'a' },
  ]);
});

test('rebuildGlobalTabMru does NOT shrink when the saved array is short', () => {
  // The live bug: 10 projects' worth of tabs, saved array down to 2 entries.
  // Every stamped tab must still be ranked.
  const tabs = Array.from({ length: 10 }, (_, i) => T('p' + i, 'tab' + i, 5000 - i));
  const saved = [{ projectId: 'p0', tabId: 'tab0' }, { projectId: 'p1', tabId: 'tab1' }];
  const out = rebuildGlobalTabMru(tabs, saved);
  assert.equal(out.length, 10);
  assert.deepEqual(out[0], { projectId: 'p0', tabId: 'tab0' }); // newest stamp
});

test('rebuildGlobalTabMru is idempotent — repeated restores cannot erode it', () => {
  const tabs = [T('p1', 'a', 1000), T('p2', 'b', 2000)];
  const once = rebuildGlobalTabMru(tabs, []);
  const twice = rebuildGlobalTabMru(tabs, once);
  const thrice = rebuildGlobalTabMru(tabs, twice);
  assert.deepEqual(twice, once);
  assert.deepEqual(thrice, once);
});

test('rebuildGlobalTabMru falls back to saved order for unstamped tabs only', () => {
  const tabs = [
    T('p1', 'stamped', 9000),
    T('p2', 'old2'),           // no stamp — legacy row
    T('p2', 'old1'),           // no stamp — legacy row
    T('p3', 'never'),          // no stamp, absent from saved → not ranked
  ];
  const saved = [{ projectId: 'p2', tabId: 'old1' }, { projectId: 'p2', tabId: 'old2' }];
  assert.deepEqual(rebuildGlobalTabMru(tabs, saved), [
    { projectId: 'p1', tabId: 'stamped' }, // stamps always outrank legacy order
    { projectId: 'p2', tabId: 'old1' },
    { projectId: 'p2', tabId: 'old2' },
  ]);
});

test('rebuildGlobalTabMru ignores closed tabs and respects the cap', () => {
  // Only open tabs are passed in, so a tab that vanished simply is not there.
  assert.deepEqual(rebuildGlobalTabMru([], [{ projectId: 'p1', tabId: 'gone' }]), []);
  const many = Array.from({ length: 80 }, (_, i) => T('p', 't' + i, 100000 - i));
  assert.equal(rebuildGlobalTabMru(many, []).length, 60);
});

test('rebuildGlobalTabMru is deterministic on identical stamps', () => {
  const tabs = [T('p1', 'b', 1000), T('p1', 'a', 1000)];
  assert.deepEqual(rebuildGlobalTabMru(tabs, []), [
    { projectId: 'p1', tabId: 'a' },
    { projectId: 'p1', tabId: 'b' },
  ]);
});
