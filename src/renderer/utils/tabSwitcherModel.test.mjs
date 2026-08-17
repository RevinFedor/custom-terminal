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

const projects = [
  {
    projectId: 'p1',
    projectName: 'custom-terminal',
    tabs: [tab('a', 'claude-03'), tab('b', 'run-dev'), tab('c', 'bash')],
  },
  {
    projectId: 'p2',
    projectName: 'gt-editor',
    tabs: [tab('d', 'codex-1'), tab('e', 'план.md')],
  },
];

test('rows follow strict global recency; project headers are TOC separators', () => {
  const rows = buildSwitcherRows({
    projects,
    globalMru: [
      { projectId: 'p2', tabId: 'd' },
      { projectId: 'p1', tabId: 'b' },
      { projectId: 'p1', tabId: 'a' },
    ],
  });
  // d(p2) → b,a(p1) by recency; unranked keep project order: c(p1) then e(p2).
  // p2 header appears TWICE — headers split runs, they don't merge projects.
  assert.deepEqual(rows.map(r => r.kind === 'project' ? `P:${r.projectId}` : `t:${r.tab.id}`), [
    'P:p2', 't:d',
    'P:p1', 't:b', 't:a', 't:c',
    'P:p2', 't:e',
  ]);
});

test('one hop reaches the previous project tab regardless of current project size', () => {
  // User on p2/d; p1/a was previous. p2 has more tabs but the FIRST step from
  // the top must land on a (the globally previous tab), not walk p2's tabs.
  const manyTabsP2 = {
    projectId: 'p2',
    projectName: 'gt-editor',
    tabs: [tab('d'), tab('e'), tab('f'), tab('g'), tab('h')],
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

test('Ctrl+Tab highlights the previous tab even when it is visible in another pane', () => {
  // Two panes hold a and d; the user just clicked from d's pane into a's.
  // The previous entry is d — visible, and exactly the target: committing it
  // jumps focus back to its pane (switchTab's split rule), so one Ctrl+Tab
  // undoes the accidental click. Visits record only APPEARANCES, so that focus
  // click did not rewrite the history.
  const rows = buildSwitcherRows({
    projects,
    globalMru: [
      { projectId: 'p1', tabId: 'a' },
      { projectId: 'p2', tabId: 'd' },
      { projectId: 'p1', tabId: 'b' },
    ],
  });
  const idx = initialCtrlIndex(rows, [
    { projectId: 'p1', tabId: 'a' },
    { projectId: 'p2', tabId: 'd' },
    { projectId: 'p1', tabId: 'b' },
  ], 'a');
  assert.equal(rows[idx].tab.id, 'd', 'the previous tab wins, on screen or not');
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

test('selection skips project headers and wraps', () => {
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
