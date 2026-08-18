import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_ROW_ID,
  buildProjectSwitcherRows,
  initialProjectIndex,
  stepProjectIndex,
} from './projectSwitcherModel.mjs';

const meta = (id) => ({ name: id.toUpperCase() });
const ids = (rows) => rows.map((r) => r.id);

test('rows follow recency, newest first, and always end with Home', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b', 'c'],
    // Store shape: oldest first. The switcher reads it the other way round.
    projectHistory: ['c', 'a', 'b'],
    currentProjectId: 'b',
    meta,
  });
  assert.deepEqual(ids(rows), ['b', 'a', 'c', HOME_ROW_ID]);
});

test('row 1 is where you are, even when recency puts it elsewhere', () => {
  // Same anchor rule as the tab switcher: without it the panel opens straight
  // onto the target and row 1 reads as "current" while pointing somewhere else.
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b', 'c'],
    projectHistory: ['c', 'b', 'a'], // a is freshest
    currentProjectId: 'c',           // …but we are standing in c
    meta,
  });
  assert.equal(rows[0].id, 'c');
  assert.equal(rows[0].current, true);
  assert.deepEqual(ids(rows).slice(1), ['a', 'b', HOME_ROW_ID]);
});

test('the highlight starts on row 2 — the freshest place that is not here', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'b'],
    projectHistory: ['b', 'a'],
    currentProjectId: 'a',
    meta,
  });
  assert.equal(initialProjectIndex(rows), 1);
  assert.equal(rows[1].id, 'b');
});

test('Home is a destination like any other, and can be the anchor', () => {
  // Standing on the dashboard, Home is where you ARE — so it heads the list and
  // the highlight moves to the freshest project.
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

test('nowhere else to go → nothing is selected', () => {
  // One project and we are in it: the only other row is Home… which means there
  // IS somewhere to go. The empty case is the dashboard with no projects open.
  const rows = buildProjectSwitcherRows({
    openProjectIds: [],
    projectHistory: [],
    onDashboard: true,
    meta,
  });
  assert.deepEqual(ids(rows), [HOME_ROW_ID]);
  assert.equal(initialProjectIndex(rows), -1);
});

test('never-activated projects keep the caller order, after the ranked ones', () => {
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
  assert.equal(rows.length, 3);
  assert.equal(stepProjectIndex(rows, 2, +1), 0);
  assert.equal(stepProjectIndex(rows, 0, -1), 2);
  assert.equal(stepProjectIndex(rows, 1, +1), 2);
});

test('duplicates in the open list cannot produce duplicate rows', () => {
  const rows = buildProjectSwitcherRows({
    openProjectIds: ['a', 'a', 'b'],
    projectHistory: ['a'],
    currentProjectId: 'a',
    meta,
  });
  assert.deepEqual(ids(rows), ['a', 'b', HOME_ROW_ID]);
});
