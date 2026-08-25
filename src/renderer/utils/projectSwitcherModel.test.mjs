import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_ROW_ID,
  buildProjectSwitcherRows,
  initialProjectIndex,
  stepProjectIndex,
} from './projectSwitcherModel.mjs';

const meta = (id) => ({ name: id.toUpperCase(), icon: `${id}.png` });
const ids = (rows) => rows.map((row) => row.id);

test('rows follow project recency and keep colored project metadata', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b', 'c'],
    projectHistory: ['c', 'a', 'b'],
    currentProjectId: 'b',
    meta,
  });
  assert.deepEqual(ids(rows), ['b', 'a', 'c', HOME_ROW_ID]);
  assert.equal(rows[0].icon, 'b.png');
});

test('the current sidebar project is pinned to row 1', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b', 'c'],
    projectHistory: ['c', 'b', 'a'],
    currentProjectId: 'c',
    meta,
  });
  assert.equal(rows[0].id, 'c');
  assert.equal(rows[0].current, true);
  assert.deepEqual(ids(rows).slice(1), ['a', 'b', HOME_ROW_ID]);
});

test('the highlight starts on the freshest destination that is not current', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b'],
    projectHistory: ['b', 'a'],
    currentProjectId: 'a',
    meta,
  });
  assert.equal(initialProjectIndex(rows), 1);
  assert.equal(rows[1].id, 'b');
});

test('Home remains reachable and can be the anchor', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b'],
    projectHistory: ['a', 'b'],
    onDashboard: true,
    meta,
  });
  assert.equal(rows[0].id, HOME_ROW_ID);
  assert.equal(rows[0].current, true);
  assert.equal(rows[initialProjectIndex(rows)].id, 'b');
});

test('dashboard with no projects has no target', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: [],
    projectHistory: [],
    onDashboard: true,
    meta,
  });
  assert.deepEqual(ids(rows), [HOME_ROW_ID]);
  assert.equal(initialProjectIndex(rows), -1);
});

test('never-activated projects retain titlebar order after ranked rows', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['fresh', 'x', 'y'],
    projectHistory: ['fresh'],
    currentProjectId: 'fresh',
    meta,
  });
  assert.deepEqual(ids(rows), ['fresh', 'x', 'y', HOME_ROW_ID]);
});

test('stepping wraps in both directions', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b'],
    projectHistory: ['b', 'a'],
    currentProjectId: 'a',
    meta,
  });
  assert.equal(stepProjectIndex(rows, rows.length - 1, +1), 0);
  assert.equal(stepProjectIndex(rows, 0, -1), rows.length - 1);
});

test('duplicate open-project IDs cannot create duplicate rows', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'a', 'b'],
    projectHistory: ['a'],
    currentProjectId: 'a',
    meta,
  });
  assert.deepEqual(ids(rows), ['a', 'b', HOME_ROW_ID]);
});
