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

test('projects appear once as headers, tabs ordered by global MRU', () => {
  const rows = buildSwitcherRows({
    projects,
    globalMru: [
      { projectId: 'p2', tabId: 'd' },
      { projectId: 'p1', tabId: 'b' },
      { projectId: 'p1', tabId: 'a' },
    ],
  });
  assert.deepEqual(rows.map(r => r.kind === 'project' ? `P:${r.projectId}` : `t:${r.tab.id}`), [
    'P:p2', 't:d', 't:e',
    'P:p1', 't:b', 't:a', 't:c',
  ]);
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
