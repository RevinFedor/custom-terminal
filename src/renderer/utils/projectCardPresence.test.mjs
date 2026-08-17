import assert from 'node:assert/strict';
import test from 'node:test';

import { projectCardPresence } from './projectCardPresence.mjs';

const pane = (projectId, tabId) => ({ projectId, tabId });

test('the sidebar project is focused, whatever the panes show', () => {
  assert.equal(projectCardPresence({
    projectId: 'p1',
    focusedProjectId: 'p1',
    panes: [pane('p2', 'a')],
  }), 'focused');
});

// THE CASE THIS EXISTS FOR: a pane shows another project's tab, so that project
// is on screen and being worked in — but its card looked as idle as a project
// not opened in a week.
test('a project visible in a pane but not selected reads as on-screen', () => {
  assert.equal(projectCardPresence({
    projectId: 'p2',
    focusedProjectId: 'p1',
    panes: [pane('p1', 'a'), pane('p2', 'b')],
  }), 'on-screen');
});

test('a project in no pane stays idle', () => {
  assert.equal(projectCardPresence({
    projectId: 'p3',
    focusedProjectId: 'p1',
    panes: [pane('p1', 'a'), pane('p2', 'b')],
  }), 'idle');
});

test('an empty placeholder pane shows no project', () => {
  assert.equal(projectCardPresence({
    projectId: 'p2',
    focusedProjectId: 'p1',
    panes: [pane('p1', 'a'), { projectId: '', tabId: '' }],
  }), 'idle');
  // …and a placeholder that still carries a stale projectId does not count
  // either: without a tab there is nothing on screen.
  assert.equal(projectCardPresence({
    projectId: 'p2',
    focusedProjectId: 'p1',
    panes: [pane('p2', '')],
  }), 'idle');
});

test('single mode: the centre can belong to another project', () => {
  // Activating a tab moves the centre, not the sidebar — so this is the same
  // situation as a pane, with one surface.
  assert.equal(projectCardPresence({
    projectId: 'p2',
    focusedProjectId: 'p1',
    panes: [],
    centerProjectId: 'p2',
  }), 'on-screen');
  assert.equal(projectCardPresence({
    projectId: 'p3',
    focusedProjectId: 'p1',
    panes: [],
    centerProjectId: 'p2',
  }), 'idle');
});

test('missing input degrades to idle', () => {
  assert.equal(projectCardPresence({}), 'idle');
  assert.equal(projectCardPresence({ projectId: 'p1', panes: null }), 'idle');
});


// The fourth tier — 'working', a contour for the ACTIVE tab's project — was
// removed with the one-pointer model (2026-08-17): the sidebar follows every
// activation, so the focused card and the working card are the same card
// outside a transient explicit parking. Three states must stay three.
test('there is no working tier: the active tab project reads as plain on-screen while parked', () => {
  assert.equal(projectCardPresence({
    projectId: 'p2',
    focusedProjectId: 'p1',
    panes: [pane('p1', 'a'), pane('p2', 'b')],
  }), 'on-screen');
});
