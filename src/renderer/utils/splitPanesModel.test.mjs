import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEmptyPane,
  addPane,
  isEmptyPane,
  paneRects,
  removePaneAt,
  removePaneByTab,
  removePanesByProject,
  resolveSplitActivation,
  sanitizePanes,
} from './splitPanesModel.mjs';

const p = (projectId, tabId) => ({ projectId, tabId });
const EMPTY = { projectId: '', tabId: '' };

test('addPane: single mode → two panes, focus on the added one', () => {
  const res = addPane([], 0, p('p1', 'a'), p('p2', 'b'));
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('addPane: rejects duplicates and >3 panes', () => {
  const two = [p('p1', 'a'), p('p2', 'b')];
  assert.equal(addPane(two, 0, null, p('p1', 'a')), null);
  const three = addPane(two, 0, null, p('p1', 'c')).panes;
  assert.equal(three.length, 3);
  assert.equal(addPane(three, 0, null, p('p1', 'd')), null);
});

test('addPane fills an existing empty placeholder instead of appending', () => {
  const withEmpty = [p('p1', 'a'), EMPTY];
  const res = addPane(withEmpty, 1, null, p('p2', 'b'));
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('activation: visible tab → focus jump; hidden tab → replace focused pane', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  const jump = resolveSplitActivation(panes, 0, 'p2', 'b');
  assert.equal(jump.focusedIndex, 1);
  assert.deepEqual(jump.panes, panes);

  const replace = resolveSplitActivation(panes, 1, 'p3', 'c');
  assert.deepEqual(replace.panes, [p('p1', 'a'), p('p3', 'c')]);
  assert.equal(replace.focusedIndex, 1);
});

test('activation fills a focused empty placeholder', () => {
  const panes = [p('p1', 'a'), EMPTY];
  const res = resolveSplitActivation(panes, 1, 'p2', 'b');
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('addEmptyPane: single → [current, empty] focused on empty; one placeholder max', () => {
  const res = addEmptyPane([], 0, p('p1', 'a'));
  assert.deepEqual(res.panes, [p('p1', 'a'), EMPTY]);
  assert.equal(res.focusedIndex, 1);
  assert.equal(isEmptyPane(res.panes[1]), true);
  assert.equal(addEmptyPane(res.panes, 1, null), null); // second placeholder refused
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  assert.equal(addEmptyPane(three, 0, null), null); // full
});

test('addEmptyPane inserts the placeholder right after the pressed pane', () => {
  const two = [p('p1', 'a'), p('p2', 'b')];
  const fromFirst = addEmptyPane(two, 1, null, 0);
  assert.deepEqual(fromFirst.panes, [p('p1', 'a'), EMPTY, p('p2', 'b')]);
  assert.equal(fromFirst.focusedIndex, 1);
  const fromLast = addEmptyPane(two, 0, null, 1);
  assert.deepEqual(fromLast.panes, [p('p1', 'a'), p('p2', 'b'), EMPTY]);
  assert.equal(fromLast.focusedIndex, 2);
});

test('removePaneAt closes an empty placeholder; [real, empty] collapses', () => {
  const panes = [p('p1', 'a'), EMPTY];
  assert.deepEqual(removePaneAt(panes, 1, 1), { panes: [], focusedIndex: 0 });
  const three = [p('p1', 'a'), p('p2', 'b'), EMPTY];
  const res = removePaneAt(three, 2, 2);
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('removePaneByTab: two panes collapse to single mode', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  assert.deepEqual(removePaneByTab(panes, 1, 'b'), { panes: [], focusedIndex: 0 });
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const res = removePaneByTab(three, 2, 'a');
  assert.deepEqual(res.panes, [p('p2', 'b'), p('p3', 'c')]);
  assert.equal(res.focusedIndex, 1);
});

test('removePaneByTab ignores empty tabId (never matches a placeholder)', () => {
  assert.equal(removePaneByTab([p('p1', 'a'), EMPTY], 0, ''), null);
});

test('removePanesByProject keeps focus on the surviving focused tab', () => {
  const three = [p('p1', 'a'), p('p2', 'b'), p('p1', 'c')];
  const res = removePanesByProject(three, 1, 'p1');
  assert.deepEqual(res, { panes: [], focusedIndex: 0 }); // only one left → collapse
  const four = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const res2 = removePanesByProject(four, 1, 'p1');
  assert.deepEqual(res2.panes, [p('p2', 'b'), p('p3', 'c')]);
  assert.equal(res2.focusedIndex, 0);
});

test('sanitizePanes drops dead tabs and empty placeholders, collapses <2', () => {
  const alive = new Set(['p1:a', 'p2:b']);
  const exists = (pr, t) => alive.has(`${pr}:${t}`);
  const res = sanitizePanes([p('p1', 'a'), p('p2', 'b'), p('p3', 'dead')], 2, exists);
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
  const collapsed = sanitizePanes([p('p1', 'a'), p('p3', 'dead')], 0, exists);
  assert.deepEqual(collapsed, { panes: [], focusedIndex: 0 });
  const withEmpty = sanitizePanes([p('p1', 'a'), EMPTY], 1, exists);
  assert.deepEqual(withEmpty, { panes: [], focusedIndex: 0 });
});

test('paneRects splits width evenly', () => {
  assert.deepEqual(paneRects(2), [
    { leftPct: 0, widthPct: 50 },
    { leftPct: 50, widthPct: 50 },
  ]);
  assert.equal(paneRects(3)[2].leftPct.toFixed(2), '66.67');
});
