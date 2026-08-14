import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEmptyPane,
  addPane,
  isEmptyPane,
  paneMapCells,
  paneRects,
  removePaneAt,
  removePaneByTab,
  removePanesByProject,
  resolveSplitActivation,
  sanitizePanes,
  addEmptyPaneVertical,
  paneColumns,
  normalizeColumns,
  paneGridRects,
  paneIsStacked,
  paneMapGrid,
  restorePanePreviousTab,
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
  // Identity only: the replaced pane also carries what it showed before (see
  // the pane-recency tests below), so comparing whole objects would couple this
  // test to that bookkeeping.
  assert.deepEqual(
    replace.panes.map(({ projectId, tabId }) => ({ projectId, tabId })),
    [p('p1', 'a'), p('p3', 'c')],
  );
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
  const collapsed = removePaneAt(panes, 1, 1);
  assert.deepEqual(collapsed.panes, []);
  assert.equal(collapsed.focusedIndex, 0);
  const three = [p('p1', 'a'), p('p2', 'b'), EMPTY];
  const res = removePaneAt(three, 2, 2);
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('removePaneByTab: two panes collapse to single mode', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  const collapsed = removePaneByTab(panes, 1, 'b');
  assert.deepEqual(collapsed.panes, []);
  assert.equal(collapsed.focusedIndex, 0);
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const res = removePaneByTab(three, 2, 'a');
  assert.deepEqual(res.panes, [p('p2', 'b'), p('p3', 'c')]);
  assert.equal(res.focusedIndex, 1);
});

// Collapsing empties the pane list, so the focus index can no longer name the
// tab that stayed on screen — and single mode shows exactly one tab. Without a
// named survivor the caller silently kept the center on the REMOVED tab.
test('collapsing to single mode names the pane that survived', () => {
  const removedFocused = removePaneByTab([p('p1', 'a'), p('p2', 'b')], 1, 'b');
  assert.deepEqual(removedFocused.survivor, p('p1', 'a'));

  const removedOther = removePaneByTab([p('p1', 'a'), p('p2', 'b')], 1, 'a');
  assert.deepEqual(removedOther.survivor, p('p2', 'b'),
    'survivor is the pane that stayed, not simply the first one');

  // A [real, placeholder] pair collapses too — the placeholder is not a tab.
  assert.deepEqual(removePaneAt([p('p1', 'a'), EMPTY], 1, 1).survivor, p('p1', 'a'));

  // While the split SURVIVES, focusedIndex already answers the question.
  assert.equal(removePaneByTab([p('p1', 'a'), p('p2', 'b'), p('p3', 'c')], 2, 'a').survivor, null);
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

test('paneMapCells marks the tab\'s pane by screen position', () => {
  const three = [p('p1', 'a'), p('p2', 'b'), p('p1', 'c')];
  // Middle pane, and it holds focus.
  assert.deepEqual(paneMapCells(three, 1, 'p2', 'b'), [
    { mine: false, state: 'other' },
    { mine: true, state: 'self-focused' },
    { mine: false, state: 'other' },
  ]);
  // Same tab, focus elsewhere → 'self', not 'self-focused'.
  assert.deepEqual(paneMapCells(three, 0, 'p2', 'b'), [
    { mine: false, state: 'other' },
    { mine: true, state: 'self' },
    { mine: false, state: 'other' },
  ]);
  // Last pane keeps its position; cells are always in screen order.
  assert.deepEqual(paneMapCells(three, 2, 'p1', 'c')[2], { mine: true, state: 'self-focused' });
});

test('paneMapCells returns [] for a tab that is in no pane', () => {
  const two = [p('p1', 'a'), p('p2', 'b')];
  assert.deepEqual(paneMapCells(two, 0, 'p3', 'zzz'), []);
  // Same tabId in another project is NOT this tab.
  assert.deepEqual(paneMapCells(two, 0, 'p9', 'a'), []);
});

test('paneMapCells: single mode gives the center tab one focused cell', () => {
  const center = p('p1', 'a');
  assert.deepEqual(paneMapCells([], 0, 'p1', 'a', center), [
    { mine: true, state: 'self-focused' },
  ]);
  assert.deepEqual(paneMapCells([], 0, 'p1', 'other', center), []);
  // No center tab at all (dashboard) → no mark.
  assert.deepEqual(paneMapCells([], 0, 'p1', 'a', null), []);
});

test('paneMapCells clamps a focus index that points outside the panes', () => {
  const two = [p('p1', 'a'), p('p2', 'b')];
  assert.deepEqual(paneMapCells(two, 99, 'p2', 'b')[1], { mine: true, state: 'self-focused' });
  assert.deepEqual(paneMapCells(two, -5, 'p1', 'a')[0], { mine: true, state: 'self-focused' });
});

// ── Two dimensions (vertical split) ───────────────────────────────────────

test('addEmptyPaneVertical: single mode opens a row below / above the center', () => {
  // The assertion that matters is GEOMETRY, not array shape: the earlier
  // version of this test only compared the array and happily passed while the
  // app rendered two side-by-side columns (measured live: 2 x 623px, equal
  // height) instead of one column split in two.
  const below = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below');
  assert.equal(below.focusedIndex, 1);
  assert.equal(paneColumns(below.panes).length, 1, 'one column');
  let rects = paneGridRects(below.panes);
  assert.deepEqual(rects[0], { leftPct: 0, widthPct: 100, topPct: 0, heightPct: 50 });
  assert.deepEqual(rects[1], { leftPct: 0, widthPct: 100, topPct: 50, heightPct: 50 });
  assert.equal(below.panes[1].tabId, '', 'placeholder is the lower row');

  const above = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'above');
  assert.equal(above.focusedIndex, 0);
  assert.equal(paneColumns(above.panes).length, 1);
  rects = paneGridRects(above.panes);
  assert.equal(rects[0].topPct, 0);
  assert.equal(rects[1].topPct, 50);
  assert.equal(above.panes[0].tabId, '', 'placeholder is the upper row');
});

test('addEmptyPaneVertical stacks the new pane INSIDE the anchor column', () => {
  // Two columns: [a | b]. Split b downward → column 1 has two rows.
  const two = [p('p1', 'a'), { ...p('p2', 'b'), column: 1 }];
  const res = addEmptyPaneVertical(two, 1, null, 1, 'below');
  assert.equal(res.panes.length, 3);
  assert.equal(res.panes[2].column, 1, 'placeholder joins column 1, not a new column');
  assert.equal(res.focusedIndex, 2);
  const cols = paneColumns(res.panes);
  assert.equal(cols.length, 2, 'still two columns on screen');
  assert.equal(cols[1].length, 2, 'second column now has two rows');
});

test('addEmptyPaneVertical refuses a second placeholder and a 4th pane', () => {
  const withEmpty = [p('p1', 'a'), EMPTY];
  assert.equal(addEmptyPaneVertical(withEmpty, 0, null, 0, 'below'), null);
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  assert.equal(addEmptyPaneVertical(three, 0, null, 0, 'below'), null);
});

test('addEmptyPane (horizontal) opens a NEW column, shifting later columns right', () => {
  // [a | b(col1)] — split a sideways. The new column must land between them,
  // and b must move to column 2, not stay level with the placeholder.
  const two = [p('p1', 'a'), { ...p('p2', 'b'), column: 1 }];
  const res = addEmptyPane(two, 0, null, 0);
  const cols = paneColumns(res.panes);
  assert.equal(cols.length, 3, 'three columns');
  assert.equal(cols[1][0].pane.tabId, '', 'placeholder is the middle column');
  assert.equal(cols[2][0].pane.tabId, 'b', 'b shifted one column right');
});

test('horizontal split of a stacked pane does not silently join its column', () => {
  // Column 0 has two rows [a, b] — stacking is always explicit; split a sideways.
  const stacked = [{ ...p('p1', 'a'), column: 0 }, { ...p('p1', 'b'), column: 0 }];
  const res = addEmptyPane(stacked, 0, null, 0);
  const cols = paneColumns(res.panes);
  assert.equal(cols.length, 2);
  assert.equal(cols[0].length, 2, 'original column keeps both rows');
  assert.equal(cols[1].length, 1, 'placeholder is alone in the new column');
  assert.equal(cols[1][0].pane.tabId, '');
});

test('normalizeColumns closes a hole left by emptying a middle column', () => {
  // Columns [0, 2] would render as two columns while every index-based rule
  // still believes the second one is number 2. After normalizing there is no
  // hole — and since nothing is stacked, the canonical shape carries no
  // column fields at all, so screen position is what the array says.
  const holed = [p('p1', 'a'), { ...p('p2', 'b'), column: 2 }];
  const fixed = normalizeColumns(holed);
  assert.equal(paneColumns(fixed).length, 2, 'still two columns');
  assert.deepEqual(paneGridRects(fixed)[1],
    { leftPct: 50, widthPct: 50, topPct: 0, heightPct: 100 },
    'second column occupies the right half, not a third of the width');
});

test('removing a pane renumbers the columns that survive', () => {
  // [a(0) | b(1) | c(2)] — remove b. c must slide into the freed column, not
  // stay at index 2 and leave a gap where b used to be.
  const three = [
    p('p1', 'a'),
    { ...p('p2', 'b'), column: 1 },
    { ...p('p3', 'c'), column: 2 },
  ];
  const res = removePaneByTab(three, 0, 'b');
  assert.equal(res.panes.length, 2);
  assert.equal(paneColumns(res.panes).length, 2);
  const rects = paneGridRects(res.panes);
  assert.equal(rects[0].leftPct, 0);
  assert.equal(rects[1].leftPct, 50, 'c moved left into b\'s place');
  assert.equal(rects[1].widthPct, 50);
});

test('removing a stacked row keeps the OTHER column stacked', () => {
  // [a | b over c] with a third pane removed must not flatten the stack.
  const panes = [
    p('p1', 'a'),
    { ...p('p2', 'b'), column: 1 },
    { ...p('p3', 'c'), column: 1 },
  ];
  const res = removePaneByTab(panes, 0, 'a');
  assert.equal(res.panes.length, 2);
  const cols = paneColumns(res.panes);
  assert.equal(cols.length, 1, 'b and c remain one column of two rows');
  assert.equal(cols[0].length, 2);
  const rects = paneGridRects(res.panes);
  assert.equal(rects[0].heightPct, 50);
  assert.equal(rects[1].topPct, 50);
});

test('paneGridRects: one column per column, equal rows inside it', () => {
  // [a | b over c] → left half full height, right half split in two.
  const panes = [
    p('p1', 'a'),
    { ...p('p2', 'b'), column: 1 },
    { ...p('p3', 'c'), column: 1 },
  ];
  const rects = paneGridRects(panes);
  assert.deepEqual(rects[0], { leftPct: 0, widthPct: 50, topPct: 0, heightPct: 100 });
  assert.deepEqual(rects[1], { leftPct: 50, widthPct: 50, topPct: 0, heightPct: 50 });
  assert.deepEqual(rects[2], { leftPct: 50, widthPct: 50, topPct: 50, heightPct: 50 });
});

test('paneGridRects matches the old 1-D geometry when nothing is stacked', () => {
  const flat = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')].map((pane, i) => (
    i === 0 ? pane : { ...pane, column: i }
  ));
  const rects = paneGridRects(flat);
  const old = paneRects(3);
  rects.forEach((r, i) => {
    assert.equal(r.leftPct.toFixed(4), old[i].leftPct.toFixed(4));
    assert.equal(r.widthPct.toFixed(4), old[i].widthPct.toFixed(4));
    assert.equal(r.topPct, 0);
    assert.equal(r.heightPct, 100);
  });
});

test('paneIsStacked tells a short pane from a full-height one', () => {
  const panes = [
    p('p1', 'a'),
    { ...p('p2', 'b'), column: 1 },
    { ...p('p3', 'c'), column: 1 },
  ];
  assert.equal(paneIsStacked(panes, 0), false);
  assert.equal(paneIsStacked(panes, 1), true);
  assert.equal(paneIsStacked(panes, 2), true);
});

test('paneMapGrid mirrors a stacked layout instead of flattening it', () => {
  const panes = [
    p('p1', 'a'),
    { ...p('p2', 'b'), column: 1 },
    { ...p('p3', 'c'), column: 1 },
  ];
  // Focus on c (index 2), asking about c.
  const grid = paneMapGrid(panes, 2, 'p3', 'c');
  assert.equal(grid.length, 2, 'two columns');
  assert.equal(grid[0].length, 1);
  assert.equal(grid[1].length, 2, 'second column drawn as two stacked cells');
  assert.deepEqual(grid[1][1], { mine: true, state: 'self-focused' });
  assert.deepEqual(grid[1][0], { mine: false, state: 'other' });
});

test('paneMapGrid: tab in no pane → empty, single mode → one cell', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  assert.deepEqual(paneMapGrid(panes, 0, 'p9', 'zzz'), []);
  assert.deepEqual(paneMapGrid([], 0, 'p1', 'a', p('p1', 'a')), [[{ mine: true, state: 'self-focused' }]]);
});

test('a legacy layout (no column fields) restores as side-by-side columns', () => {
  // This is the compatibility contract: every session saved before the second
  // dimension existed was N panes in a row, and must come back as N columns —
  // not as one column of N stacked rows.
  const legacy = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  assert.equal(paneColumns(legacy).length, 3);
  paneGridRects(legacy).forEach((r) => {
    assert.equal(r.topPct, 0);
    assert.equal(r.heightPct, 100);
  });
});

test('a purely horizontal result stores NO column fields (legacy shape kept)', () => {
  // Storage stays byte-identical while nothing is stacked, so old and new
  // sessions cannot diverge in the saved layout.
  const res = addEmptyPane([p('p1', 'a'), p('p2', 'b')], 0, null, 0);
  res.panes.forEach((pane) => {
    assert.equal('column' in pane, false, JSON.stringify(pane));
  });
});

test('filling a stacked placeholder keeps it in its column', () => {
  // Live repro before the fix: a column split into two 409px rows, then the
  // lower row filled by clicking a sidebar tab — the layout silently became
  // two 623px columns side by side, because activation rewrote the pane
  // without its column.
  const stacked = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below').panes;
  const filled = resolveSplitActivation(stacked, 1, 'p2', 'b');
  assert.equal(paneColumns(filled.panes).length, 1, 'still ONE column');
  const rects = paneGridRects(filled.panes);
  assert.equal(rects[0].heightPct, 50);
  assert.equal(rects[1].topPct, 50);
  assert.equal(rects[1].widthPct, 100, 'lower row keeps full width');
});

test('addPane into a stacked placeholder keeps its column too', () => {
  const stacked = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below').panes;
  const res = addPane(stacked, 1, null, p('p2', 'b'));
  assert.equal(paneColumns(res.panes).length, 1);
  assert.equal(paneGridRects(res.panes)[1].topPct, 50);
});

// ── Pane-level recency (middle-click a file pane) ─────────────────────────

test('opening a tab in a pane records what that pane showed before', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  const res = resolveSplitActivation(panes, 1, 'p1', 'file');
  assert.equal(res.panes[1].tabId, 'file');
  assert.equal(res.panes[1].prevTabId, 'b', 'pane remembers its own previous tab');
  assert.equal(res.panes[0].prevTabId, undefined, 'other panes are untouched');
});

test('middle-click on a file pane steps back instead of removing the pane', () => {
  const opened = resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes;
  const back = restorePanePreviousTab(opened, 1, 'file');
  assert.ok(back, 'expected a restore, not null');
  assert.equal(back.panes.length, 2, 'the pane still exists');
  assert.equal(back.panes[1].tabId, 'b');
  // ...and the gesture is a toggle: the file is now the previous one.
  const again = restorePanePreviousTab(back.panes, 1, 'b');
  assert.equal(again.panes[1].tabId, 'file');
});

test('restore returns null when there is nothing to step back to', () => {
  // Caller then falls back to removing the pane, so the gesture is never dead.
  assert.equal(restorePanePreviousTab([p('p1', 'a'), p('p1', 'b')], 0, 'a'), null);
  assert.equal(restorePanePreviousTab([p('p1', 'a')], 0, 'missing'), null);
});

test('restore refuses a tab that was closed meanwhile', () => {
  const opened = resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes;
  const alive = (projectId, tabId) => tabId !== 'b'; // 'b' was closed
  assert.equal(restorePanePreviousTab(opened, 1, 'file', alive), null,
    'a dead tab must not come back as an empty pane');
});

test('restore refuses a tab already visible in another pane', () => {
  // Two panes showing one tab is not a layout the workspace allows.
  const opened = resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes;
  const withDup = [p('p1', 'b'), opened[1]];
  assert.equal(restorePanePreviousTab(withDup, 1, 'file'), null);
});

test('stepping back keeps the pane in its column', () => {
  const stacked = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below').panes;
  const filled = resolveSplitActivation(stacked, 1, 'p1', 'b').panes;
  const withFile = resolveSplitActivation(filled, 1, 'p1', 'file').panes;
  const back = restorePanePreviousTab(withFile, 1, 'file');
  assert.equal(paneColumns(back.panes).length, 1, 'still one column');
  assert.equal(paneGridRects(back.panes)[1].topPct, 50, 'still the lower row');
});
