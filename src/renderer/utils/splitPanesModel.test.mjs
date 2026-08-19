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
  paneHistory,
  restorablePaneHistory,
  dropFromPaneHistory,
  dropTabFromAllPaneHistories,
  splitAvailability,
  emptyPaneByClosedTab,
  PANE_HISTORY_CAP,
  paneTabs,
  paneHoldsTab,
  addTabToPane,
  removeTabFromPane,
  dropTabFromAllPaneStrips,
  reorderPaneTab,
  allPaneTabIds,
  paneIndexHoldingTab,
  arrangePanes,
  swapPanes,
  describeWorkspace,
} from './splitPanesModel.mjs';

const p = (projectId, tabId) => ({ projectId, tabId });
const EMPTY = { projectId: '', tabId: '' };

test('addPane: single mode → two panes, focus on the added one', () => {
  const res = addPane([], 0, p('p1', 'a'), p('p2', 'b'));
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
});

test('addPane: rejects duplicates, but never refuses on count', () => {
  // The count caps were removed 2026-08-17 — *«ограничение на количество окон
  // быть не должно»*. Readability is protected by SPLIT_MIN_FRACTION and by the
  // draggable dividers, which the user can see and control; a hard number only
  // refused a layout they had explicitly asked for.
  const two = [p('p1', 'a'), p('p2', 'b')];
  assert.equal(addPane(two, 0, null, p('p1', 'a')), null, 'a duplicate is still refused');
  let panes = two;
  for (const tabId of ['c', 'd', 'e', 'f', 'g']) {
    const res = addPane(panes, 0, null, p('p1', tabId));
    assert.ok(res, `pane ${tabId} must be accepted`);
    panes = res.panes;
  }
  assert.equal(panes.length, 7);
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
  // …and that unfilled placeholder is now the ONLY reason to refuse: a full
  // layout no longer exists (count caps removed 2026-08-17).
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const fourth = addEmptyPane(three, 0, null);
  assert.ok(fourth, 'a fourth column must be allowed');
  assert.equal(fourth.panes.length, 4);
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

test('sanitizePanes drops dead tabs, collapses <2', () => {
  const alive = new Set(['p1:a', 'p2:b']);
  const exists = (pr, t) => alive.has(`${pr}:${t}`);
  const res = sanitizePanes([p('p1', 'a'), p('p2', 'b'), p('p3', 'dead')], 2, exists);
  assert.deepEqual(res.panes, [p('p1', 'a'), p('p2', 'b')]);
  assert.equal(res.focusedIndex, 1);
  const collapsed = sanitizePanes([p('p1', 'a'), p('p3', 'dead')], 0, exists);
  assert.deepEqual(collapsed, { panes: [], focusedIndex: 0 });
});

test('окно, оставленное пустым, переживает перезапуск', () => {
  // Пока пустая панель существовала только как «нажал деление, ещё не выбрал
  // вкладку», терять её на рестарте было бесплатно. С того момента, как
  // очистка окна стала обычным жестом, это перестало быть правдой: окно,
  // которое пользователь намеренно оставил пустым, — часть его раскладки.
  const exists = (pr, t) => t === 'a';
  const withEmpty = sanitizePanes([p('p1', 'a'), EMPTY], 1, exists);
  assert.equal(withEmpty.panes.length, 2, 'оба окна вернулись');
  assert.equal(withEmpty.panes[1].tabId, '');
  // …но раскладка из одних пустых окон — не раскладка.
  assert.deepEqual(sanitizePanes([EMPTY, EMPTY], 0, exists), { panes: [], focusedIndex: 0 });
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

test('addEmptyPaneVertical refuses a second placeholder', () => {
  const withEmpty = [p('p1', 'a'), EMPTY];
  assert.equal(addEmptyPaneVertical(withEmpty, 0, null, 0, 'below'), null);
});

// THE HISTORY THIS REPLACES, kept because it is a warning about counting the
// wrong thing. The cap started as a flat "at most 3 panes", written when a pane
// and a column were the same thing. Vertical splitting arrived and that number
// silently stopped capping COLUMNS and started capping the whole grid — with
// three columns open, stacking any of them was refused. Reported then: «кнопка,
// отвечающая за разделение, тупо пропала». Splitting it into two caps fixed that
// and multiplied them into a third, invisible limit of six panes, which is what
// the user hit next: *«я открыл 4 окна и новые создать не могу»*. Both caps
// removed 2026-08-17; readability is protected by SPLIT_MIN_FRACTION and the
// draggable dividers, which the user can actually see.
test('stacking a column is never refused on count', () => {
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const res = addEmptyPaneVertical(three, 0, null, 0, 'below');
  assert.ok(res, 'three columns still allow stacking one of them');
  assert.equal(paneColumns(res.panes).length, 3, 'still three columns');
  assert.equal(paneColumns(res.panes)[0].length, 2, 'the first column now has two rows');
  // The placeholder still blocks — that rule is about an UNFINISHED GESTURE,
  // not about size, so it survives the removal of the caps.
  assert.equal(addEmptyPaneVertical(res.panes, 0, null, 0, 'below'), null,
    'the placeholder blocks it now');
  const filled = resolveSplitActivation(res.panes, 1, 'p1', 'd').panes;
  const third = addEmptyPaneVertical(filled, 0, null, 0, 'below');
  assert.ok(third, 'a third row in the same column is allowed');
  assert.equal(paneColumns(third.panes)[0].length, 3);
});

test('a new COLUMN is never refused on count either', () => {
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  assert.ok(addEmptyPane(three, 0, null, 0), 'a fourth column is allowed');
  assert.ok(addPane(three, 0, null, p('p4', 'd')), 'and so is "add to workspace"');
  // Two columns, one of them stacked — a new column still opens beside them.
  const stacked = addEmptyPaneVertical([p('p1', 'a'), p('p2', 'b')], 0, null, 0, 'below').panes;
  const filled = resolveSplitActivation(stacked, 1, 'p1', 'c').panes;
  assert.equal(filled.length, 3, 'three panes');
  assert.ok(addPane(filled, 0, null, p('p4', 'd')));
});

test('splitAvailability: only an unfilled placeholder can refuse', () => {
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  assert.deepEqual(splitAvailability(three, 0), { horizontal: true, vertical: true, reason: null });
  const stackedFirst = addEmptyPaneVertical(three, 0, null, 0, 'below').panes;
  // A placeholder blocks everything until it is filled — an unfinished gesture,
  // not a size limit, so this is the one refusal that survives.
  assert.deepEqual(splitAvailability(stackedFirst, 0),
    { horizontal: false, vertical: false, reason: 'placeholder' });
  const filled = resolveSplitActivation(stackedFirst, 1, 'p1', 'd').panes;
  assert.deepEqual(splitAvailability(filled, 0), { horizontal: true, vertical: true, reason: null },
    'an already stacked column still splits both ways');
  assert.deepEqual(splitAvailability(filled, 2), { horizontal: true, vertical: true, reason: null });
  // Single mode: both directions are open.
  assert.deepEqual(splitAvailability([], 0), { horizontal: true, vertical: true, reason: null });
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
  assert.deepEqual(paneHistory(res.panes[1]), [p('p1', 'b')], 'pane remembers its own previous tab');
  assert.deepEqual(paneHistory(res.panes[0]), [], 'other panes are untouched');
});

// ── Per-pane visit history (the per-pane Ctrl+Tab switcher) ───────────────

test('the history is a LIST: every DEPARTED tab stacks, most recent first', () => {
  // Активация теперь ДОБАВЛЯЕТ чип, а не заменяет, поэтому «ушло с экрана» и
  // «ушло из окна» — разные события, и запоминать надо второе. Чипы убираем
  // явно: это и есть уход из окна.
  let panes = [p('p1', 'a'), p('p1', 'b')];
  for (const tab of ['c', 'd', 'e']) {
    panes = resolveSplitActivation(panes, 1, 'p1', tab).panes;
    const gone = { c: 'b', d: 'c', e: 'd' }[tab];
    panes = removeTabFromPane(panes, 1, gone).panes;
  }
  assert.deepEqual(paneHistory(panes[1]).map((e) => e.tabId), ['d', 'c', 'b']);
});

test('revisiting a tab moves it to the head instead of duplicating', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = resolveSplitActivation(panes, 1, 'p1', 'c').panes;
  panes = removeTabFromPane(panes, 1, 'b').panes;              // history: b
  panes = resolveSplitActivation(panes, 1, 'p1', 'b').panes;   // history: c — 'b' снова здесь
  panes = removeTabFromPane(panes, 1, 'c').panes;
  panes = resolveSplitActivation(panes, 1, 'p1', 'd').panes;
  panes = removeTabFromPane(panes, 1, 'b').panes;              // history: b, c
  assert.deepEqual(paneHistory(panes[1]).map((e) => e.tabId), ['b', 'c']);
});

test('the legacy one-step prev fields read as a one-entry history', () => {
  // Sessions saved before the list existed must restore with their memory.
  const legacy = { projectId: 'p1', tabId: 'file', prevProjectId: 'p1', prevTabId: 'b' };
  assert.deepEqual(paneHistory(legacy), [p('p1', 'b')]);
  const back = restorePanePreviousTab([p('p1', 'a'), legacy], 1, 'file');
  assert.equal(back.panes[1].tabId, 'b');
});

test('the history is capped', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  let previous = 'b';
  for (let i = 0; i < PANE_HISTORY_CAP + 10; i += 1) {
    panes = resolveSplitActivation(panes, 1, 'p1', 't' + i).panes;
    panes = removeTabFromPane(panes, 1, previous).panes;
    previous = 't' + i;
  }
  assert.equal(paneHistory(panes[1]).length, PANE_HISTORY_CAP);
});

test('restorablePaneHistory hides dead tabs and tabs visible in any pane', () => {
  const showThenDrop = (list, tab, gone) => (
    removeTabFromPane(resolveSplitActivation(list, 1, 'p1', tab).panes, 1, gone).panes
  );
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = showThenDrop(panes, 'c', 'b');   // history: b
  panes = showThenDrop(panes, 'd', 'c');   // history: c, b
  panes = showThenDrop(panes, 'e', 'd');   // history: d, c, b
  // 'c' was closed; 'a' shows in pane 0 but is not in this history anyway.
  const alive = (projectId, tabId) => tabId !== 'c';
  assert.deepEqual(
    restorablePaneHistory(panes, 1, alive).map((e) => e.tabId),
    ['d', 'b'],
  );
  // …and stepping back lands on the first RESTORABLE entry, not a dead head.
  const deadHead = showThenDrop(panes, 'f', 'e');  // history: e, d, c, b
  const back = restorePanePreviousTab(deadHead, 1, 'f', (pid, tid) => tid !== 'e');
  assert.equal(back.panes[1].tabId, 'd', 'skips the closed head entry');
});

test('middle-click on a history row forgets the entry without closing the tab', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = removeTabFromPane(resolveSplitActivation(panes, 1, 'p1', 'c').panes, 1, 'b').panes;
  panes = removeTabFromPane(resolveSplitActivation(panes, 1, 'p1', 'd').panes, 1, 'c').panes;
  const res = dropFromPaneHistory(panes, 1, 'c');
  assert.deepEqual(paneHistory(res.panes[1]).map((e) => e.tabId), ['b']);
  assert.equal(dropFromPaneHistory(res.panes, 1, 'nope'), null, 'no change → null, no store write');
});

test('closing a tab purges it from every pane history', () => {
  const showThenDrop = (list, at, tab, gone) => (
    removeTabFromPane(resolveSplitActivation(list, at, 'p1', tab).panes, at, gone).panes
  );
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = showThenDrop(panes, 0, 'x', 'a');   // pane0 history: a
  panes = showThenDrop(panes, 1, 'y', 'b');   // pane1 history: b
  panes = showThenDrop(panes, 1, 'z', 'y');   // pane1 history: y, b
  // 'b' лежит в истории окна 1; проведём его ещё и через окно 0.
  panes = showThenDrop(panes, 0, 'b', 'x');   // pane0 history: x, a
  panes = showThenDrop(panes, 0, 'w', 'b');   // pane0 history: b, x, a
  const res = dropTabFromAllPaneHistories(panes, 'b');
  assert.ok(res);
  assert.ok(!paneHistory(res.panes[0]).some((e) => e.tabId === 'b'));
  assert.ok(!paneHistory(res.panes[1]).some((e) => e.tabId === 'b'));
  assert.equal(dropTabFromAllPaneHistories(res.panes, 'b'), null, 'idempotent');
});

test('sanitizePanes scrubs dead tabs out of surviving histories', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = removeTabFromPane(resolveSplitActivation(panes, 1, 'p1', 'c').panes, 1, 'b').panes;
  panes = removeTabFromPane(resolveSplitActivation(panes, 1, 'p1', 'd').panes, 1, 'c').panes;
  const alive = (pid, tid) => tid !== 'c';
  const res = sanitizePanes(panes, 1, alive);
  assert.deepEqual(paneHistory(res.panes[1]).map((e) => e.tabId), ['b']);
});

test('файл, открытый в окне, возвращается СВОИМ ЖЕ чипом', () => {
  // Пока активация заменяла показанную вкладку, открытие файла уносило агента
  // из окна, и «шаг назад» был единственной дорогой обратно. Теперь агент
  // остаётся чипом рядом — возвращаться некуда, туда просто кликают.
  const opened = resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes;
  assert.deepEqual(paneTabs(opened[1]).map((e) => e.tabId), ['b', 'file']);
  assert.equal(restorePanePreviousTab(opened, 1, 'file'), null, 'нечего восстанавливать');
  // Убрали чип файла — показ переходит соседу, тому же агенту.
  const closed = removeTabFromPane(opened, 1, 'file');
  assert.equal(closed.panes[1].tabId, 'b');
  assert.equal(closed.emptied, false, 'окно живо');
});

test('restore returns null when there is nothing to step back to', () => {
  // Caller then falls back to removing the pane, so the gesture is never dead.
  assert.equal(restorePanePreviousTab([p('p1', 'a'), p('p1', 'b')], 0, 'a'), null);
  assert.equal(restorePanePreviousTab([p('p1', 'a')], 0, 'missing'), null);
});

test('restore refuses a tab that was closed meanwhile', () => {
  // Ушедшая из окна вкладка попадает в историю; закрытая не должна из неё
  // вернуться и оставить панель ссылающейся в никуда.
  const opened = removeTabFromPane(
    resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes,
    1, 'b',
  ).panes;
  const alive = (projectId, tabId) => tabId !== 'b'; // 'b' was closed
  assert.equal(restorePanePreviousTab(opened, 1, 'file', alive), null,
    'a dead tab must not come back as an empty pane');
});

test('restore refuses a tab already visible in another pane', () => {
  // Two panes showing one tab is not a layout the workspace allows.
  const opened = removeTabFromPane(
    resolveSplitActivation([p('p1', 'a'), p('p1', 'b')], 1, 'p1', 'file').panes,
    1, 'b',
  ).panes;
  const withDup = [p('p1', 'b'), opened[1]];
  assert.equal(restorePanePreviousTab(withDup, 1, 'file'), null);
});

test('stepping back keeps the pane in its column', () => {
  const stacked = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below').panes;
  const filled = resolveSplitActivation(stacked, 1, 'p1', 'b').panes;
  const withFile = removeTabFromPane(
    resolveSplitActivation(filled, 1, 'p1', 'file').panes,
    1, 'b',
  ).panes;
  const back = restorePanePreviousTab(withFile, 1, 'file');
  assert.equal(paneColumns(back.panes).length, 1, 'still one column');
  assert.equal(paneGridRects(back.panes)[1].topPct, 50, 'still the lower row');
});

// ── Закрытие ВКЛАДКИ ≠ удаление панели ────────────────────────────────────

test('закрытая вкладка оставляет свою панель пустой, а не уносит её', () => {
  // Шрам: вкладку, открытую во второй колонке, закрывали из бокового списка —
  // и вместе с ней пропадала вся панель. Раскладка схлопывалась как побочный
  // эффект удаления совсем другой сущности.
  const three = [p('p1', 'a'), p('p2', 'b'), p('p3', 'c')];
  const res = emptyPaneByClosedTab(three, 0, 'b');
  assert.equal(res.panes.length, 3, 'панель осталась на месте');
  assert.equal(res.panes[1].tabId, '', 'и стала пустой');
  assert.equal(res.emptiedIndex, 1);
  assert.ok(isEmptyPane(res.panes[1]));
});

test('пустеющая панель сохраняет свою колонку', () => {
  // Геометрия — это то, что построил пользователь; удалял он вкладку.
  const stacked = addEmptyPaneVertical([p('p1', 'a'), p('p2', 'b')], 0, null, 0, 'below').panes;
  const filled = resolveSplitActivation(stacked, 1, 'p1', 'c').panes;
  const res = emptyPaneByClosedTab(filled, 0, 'c');
  assert.equal(res.panes.length, 3);
  const emptied = res.panes[res.emptiedIndex];
  assert.equal(emptied.tabId, '');
  assert.equal(emptied.column, 0, 'осталась в своей колонке');
});

test('ДВА окна ведут себя так же, как три: второе остаётся пустым', () => {
  // Шрам: первая версия здесь схлопывала сплит из двух в одиночный режим,
  // рассуждая «одна живая панель плюс заглушка — это сплит из одного». Но это
  // вопрос про РАСКЛАДКУ, а жест вообще не про неё. Два окна — самый частый
  // случай, и правило схлопывания съедало именно его: пользователь убирал
  // вкладку, а второе окно закрывалось.
  const res = emptyPaneByClosedTab([p('p1', 'a'), p('p2', 'b')], 1, 'b');
  assert.equal(res.panes.length, 2, 'оба окна на месте');
  assert.equal(res.panes[0].tabId, 'a');
  assert.equal(res.panes[1].tabId, '', 'второе окно просто опустело');
  assert.equal(res.emptiedIndex, 1);
});

test('вкладка не из панели ничего не меняет', () => {
  assert.equal(emptyPaneByClosedTab([p('p1', 'a'), p('p2', 'b')], 0, 'zzz'), null);
  assert.equal(emptyPaneByClosedTab([], 0, 'a'), null);
});

// ── Полоса вкладок в одном окне ───────────────────────────────────────────
//
// Окно перестало быть «одна вкладка» и стало «список вкладок, одна показана».
// Тесты ниже держат ровно эту границу: что меняет состав полосы, а что — только
// то, какая из уже лежащих в ней вкладок сейчас на экране.

test('полоса: одиночное окно хранится в старой форме, вторая вкладка её создаёт', () => {
  const one = [p('p1', 'a'), p('p2', 'b')];
  // Одна вкладка — поля `tabs` нет вовсе: сессии, записанные до полосы,
  // восстанавливаются байт в байт (то же правило, что у `column`).
  assert.equal('tabs' in one[0], false);
  assert.deepEqual(paneTabs(one[0]), [p('p1', 'a')]);

  const grown = addTabToPane(one, 0, 'p1', 'c');
  assert.deepEqual(grown.panes[0].tabs, [p('p1', 'a'), p('p1', 'c')]);
  // Показана новая, и `tabId` по-прежнему значит «что на экране» — ради этого
  // ни один старый читатель не переписывался.
  assert.equal(grown.panes[0].tabId, 'c');
  // Соседнее окно не тронуто.
  assert.equal(grown.panes[1], one[1]);
});

test('полоса помнит проект каждой вкладки — окна кросс-проектные', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  const res = addTabToPane(panes, 0, 'p9', 'z');
  assert.deepEqual(res.panes[0].tabs, [p('p1', 'a'), p('p9', 'z')]);
  // Проект самой панели следует за показанной вкладкой — именно это значение
  // читают все существующие потребители `pane.projectId`.
  assert.equal(res.panes[0].projectId, 'p9');
});

test('клик по вкладке, которой нигде нет, ДОБАВЛЯЕТ её в конец полосы', () => {
  const panes = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p1', 'c').panes;
  // Показана 'c', в полосе [a, c].
  const res = resolveSplitActivation(panes, 0, 'p1', 'zzz');
  assert.deepEqual(res.panes[0].tabs, [p('p1', 'a'), p('p1', 'c'), p('p1', 'zzz')]);
  assert.equal(res.panes[0].tabId, 'zzz');
  // Замена уносила из окна вкладку, которую человек туда сам положил. От
  // бесконечного роста полосу держит другое правило: вкладка, уже лежащая в
  // каком-то окне, не добавляется второй раз (её показывают там, где она есть),
  // значит каждая попадает сюда ровно один раз.
});

test('активация вкладки, у которой уже есть чип, идёт В ЕЁ окно', () => {
  const panes = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p1', 'c').panes;
  // Фокус на втором окне, активируем 'a' — она чип первого окна.
  const res = resolveSplitActivation(panes, 1, 'p1', 'a');
  assert.equal(res.focusedIndex, 0, 'фокус переходит к окну вкладки');
  assert.equal(res.panes[0].tabId, 'a');
  // Состав обеих полос не изменился: вкладка не выдёргивается в чужое окно.
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a', 'c']);
  assert.equal(res.panes[1].tabId, 'b');
});

test('уже показанная вкладка: только фокус, ничего не переписывается', () => {
  const panes = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p1', 'c').panes;
  const res = resolveSplitActivation(panes, 1, 'p1', 'c');
  assert.equal(res.panes, panes, 'массив тот же по ссылке');
  assert.equal(res.focusedIndex, 0);
});

test('закрытие чипа: показ переходит к СОСЕДУ, окно остаётся', () => {
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 0, 'p1', 'c').panes;
  panes = addTabToPane(panes, 0, 'p1', 'd').panes; // [a, c, d], показана d
  const mid = removeTabFromPane(panes, 0, 'c');
  assert.deepEqual(paneTabs(mid.panes[0]).map((e) => e.tabId), ['a', 'd']);
  assert.equal(mid.panes[0].tabId, 'd', 'показанная не менялась — убрали другой чип');

  const shown = removeTabFromPane(mid.panes, 0, 'd');
  // Соседа справа нет — берём слева. Не «самую свежую» и не «первую»: полоса
  // это карта, и после закрытия глаз уже там, где сосед.
  assert.equal(shown.panes[0].tabId, 'a');
  assert.equal(shown.emptied, false);
});

test('последний чип ушёл — окно пустеет, но не закрывается', () => {
  const panes = [p('p1', 'a'), p('p2', 'b')];
  const res = removeTabFromPane(panes, 0, 'a');
  assert.equal(res.emptied, true);
  assert.equal(isEmptyPane(res.panes[0]), true);
  assert.equal(res.panes.length, 2, 'окно осталось: очистить содержимое ≠ закрыть окно');
});

test('закрытая вкладка исчезает из ВСЕХ полос', () => {
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 1, 'p1', 'a2').panes;
  const res = dropTabFromAllPaneStrips(panes, 'a2');
  assert.deepEqual(paneTabs(res.panes[1]).map((e) => e.tabId), ['b']);
  assert.equal(dropTabFromAllPaneStrips(panes, 'нет-такой'), null);
});

test('вкладка живёт ровно в одном окне', () => {
  const panes = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p1', 'c').panes;
  // Один живой терминал нельзя нарисовать в двух местах, поэтому «добавить в
  // рабочую область» отказывает и для НЕпоказанного чипа тоже.
  assert.equal(addPane(panes, 0, null, p('p1', 'c')), null);
  assert.equal(paneIndexHoldingTab(panes, 'c'), 0);
  assert.deepEqual(allPaneTabIds(panes), ['a', 'c', 'b']);
});

test('положить вкладку в окно значит ЗАБРАТЬ её из прежнего', () => {
  // Живой терминал — один узел, и рисует его то окно, которое вкладку
  // показывает. Второе окно, назвавшее ту же вкладку, теряет вообще всё, включая
  // шапку: человек видит чёрный прямоугольник и говорит «окно тупо пропало».
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 1, 'p2', 'b2').panes; // окно 1: [b, b2]
  const res = addTabToPane(panes, 0, 'p2', 'b2');   // «перенести b2 в окно 0»
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a', 'b2']);
  assert.deepEqual(paneTabs(res.panes[1]).map((e) => e.tabId), ['b'], 'чип переезжает, а не копируется');
  assert.equal(paneIndexHoldingTab(res.panes, 'b2'), 0);
  // Проект чипа переезжает вместе с ним: полосы кросс-проектные.
  assert.equal(res.panes[0].projectId, 'p2');
  assert.deepEqual(res.emptied, [], 'прежнее окно не опустело — там остался b');
});

test('окно, отдавшее последний чип, становится «нет вкладки», а не закрывается', () => {
  // Ровно то, чего человек и ждёт: «должна была переместиться, а на её месте —
  // отсутствие вкладок».
  const res = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p2', 'b');
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a', 'b']);
  assert.equal(isEmptyPane(res.panes[1]), true);
  assert.equal(res.panes.length, 2, 'окно осталось на своём месте');
  // Индексы не поехали — и место, куда клали, всё ещё то самое.
  assert.deepEqual(res.emptied, [1]);
});

test('перенос в окно, где чип уже лежит: просто показать', () => {
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 0, 'p1', 'c').panes; // окно 0: [a, c], показана c
  const res = addTabToPane(panes, 0, 'p1', 'a');
  assert.equal(res.panes[0].tabId, 'a');
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a', 'c'], 'порядок полосы не трогаем');
  // Показана и лежит здесь же — менять нечего.
  assert.equal(addTabToPane(res.panes, 0, 'p1', 'a'), null);
});

test('восстановление снимает дубликат: показывающее окно оставляет вкладку себе', () => {
  // Раскладка приходит с диска и может быть старше правила «одна вкладка — одно
  // окно». Пережить перезапуск такое состояние не должно.
  const saved = [
    { projectId: 'p1', tabId: 'a', tabs: [p('p1', 'a'), p('p2', 'b')] }, // b лежит чипом
    { projectId: 'p2', tabId: 'b' },                                     // и показана здесь
  ];
  const res = sanitizePanes(saved, 0, () => true);
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a']);
  assert.deepEqual(paneTabs(res.panes[1]).map((e) => e.tabId), ['b'], 'право у того, кто рисует');
  assert.equal(res.panes.length, 2);
});

test('карта окон: полая клетка — «лежит здесь, но показана другая»', () => {
  const panes = addTabToPane([p('p1', 'a'), p('p2', 'b')], 0, 'p1', 'c').panes;
  // 'c' показана в первом окне, 'a' в нём же лежит чипом.
  assert.deepEqual(paneMapCells(panes, 0, 'p1', 'c'), [
    { mine: true, state: 'self-focused' },
    { mine: false, state: 'other' },
  ]);
  assert.deepEqual(paneMapCells(panes, 0, 'p1', 'a'), [
    { mine: true, state: 'held' },
    { mine: false, state: 'other' },
  ]);
  // Та же вкладка в другом проекте — не эта вкладка.
  assert.deepEqual(paneMapCells(panes, 0, 'p9', 'a'), []);
});

test('перетаскивание чипа меняет порядок, но не показ', () => {
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 0, 'p1', 'c').panes;
  panes = addTabToPane(panes, 0, 'p1', 'd').panes; // [a, c, d], показана d
  const res = reorderPaneTab(panes, 0, 'd', 0);
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['d', 'a', 'c']);
  assert.equal(res.panes[0].tabId, 'd');
  assert.equal(reorderPaneTab(res.panes, 0, 'd', 0), null, 'сдвиг на место — не запись');
});

test('закрытие проекта убирает его чипы, а окно с чужими остаётся', () => {
  let panes = [p('p1', 'a'), p('p2', 'b'), p('p1', 'c')];
  panes = addTabToPane(panes, 0, 'p2', 'x').panes; // окно 0: [a(p1), x(p2)]
  const res = removePanesByProject(panes, 0, 'p1');
  // Окно 0 выжило на чужом чипе; окно, целиком принадлежавшее p1, ушло.
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['x']);
  assert.equal(res.panes.length, 2);
});

test('восстановление чистит полосу, а не выбрасывает окно целиком', () => {
  let panes = [p('p1', 'a'), p('p2', 'b')];
  panes = addTabToPane(panes, 0, 'p1', 'dead').panes; // показана мёртвая
  const alive = (projectId, tabId) => tabId !== 'dead';
  const res = sanitizePanes(panes, 0, alive);
  // Раньше мёртвая ПОКАЗАННАЯ вкладка убивала окно вместе с живыми чипами.
  assert.deepEqual(paneTabs(res.panes[0]).map((e) => e.tabId), ['a']);
  assert.equal(res.panes[0].tabId, 'a');
  assert.equal(res.panes.length, 2);
});

// ── Раскладка целиком, одним вызовом (для Terminal MCP) ───────────────────
//
// Всё, что выше, — ЖЕСТЫ: один клик и его защиты. Вызывающий по API не делает
// жестов, он называет раскладку целиком. Собирать её из жестов — это четыре
// обращения, каждое из которых может наполовину не удаться, а защита «одна
// пустая панель за раз» вторую и вовсе отклонит.

test('раскладка: две вкладки — два окна справа', () => {
  const res = arrangePanes([], 0, {
    side: 'right',
    windows: [[p('p1', 'codex')], [p('p1', 'claude')]],
  }, p('p1', 'a'));
  // Центр стал первым окном, два новых встали справа, по колонке на каждое.
  assert.deepEqual(res.panes.map((x) => x.tabId), ['a', 'codex', 'claude']);
  assert.equal(res.panes.every((x) => x.column === undefined), true, 'чисто горизонтально — колонки не хранятся');
  assert.equal(res.focusedIndex, 1, 'фокус на первом созданном');
});

test('раскладка: две вкладки — ОДНО окно с двумя чипами', () => {
  // Та же просьба, но «внутри одного окна». Вложенность списка и есть эта
  // разница — отдельный флаг не нужен.
  const res = arrangePanes([], 0, {
    side: 'right',
    windows: [[p('p1', 'codex'), p('p1', 'claude')]],
  }, p('p1', 'a'));
  assert.equal(res.panes.length, 2);
  assert.deepEqual(paneTabs(res.panes[1]).map((e) => e.tabId), ['codex', 'claude']);
  assert.equal(res.panes[1].tabId, 'codex', 'показан первый названный');
});

test('раскладка: деление по горизонтали кладёт окна в одну колонку', () => {
  const res = arrangePanes([], 0, {
    side: 'right',
    divide: 'rows',
    windows: [[p('p1', 'codex')], [p('p1', 'claude')]],
  }, p('p1', 'a'));
  // Оба новых окна — строки одной колонки, а не две колонки.
  assert.equal(res.panes[1].column, res.panes[2].column);
  assert.notEqual(res.panes[0].column, res.panes[1].column);
});

test('раскладка: названная вкладка ПЕРЕЕЗЖАЕТ, а не копируется', () => {
  const panes = [p('p1', 'a'), p('p1', 'codex')];
  const res = arrangePanes(panes, 0, {
    side: 'right',
    windows: [[p('p1', 'codex')]],
  });
  // Вкладка живёт в одном окне: старое место освободилось и исчезло вместе с
  // ним — оно показывало ровно ту вкладку, которую переставляли.
  assert.equal(res.panes.filter((x) => x.tabId === 'codex').length, 1);
  assert.deepEqual(res.panes.map((x) => x.tabId), ['a', 'codex']);
});

test('раскладка: пустое окно пользователя не трогается', () => {
  const panes = [p('p1', 'a'), EMPTY];
  const res = arrangePanes(panes, 0, {
    side: 'right',
    windows: [[p('p1', 'codex')]],
  });
  // Пустое окно оставлено намеренно — оно не мусор от этой перестановки.
  assert.equal(res.panes.some(isEmptyPane), true);
});

test('раскладка: слева — значит слева', () => {
  const res = arrangePanes([p('p1', 'a')], 0, {
    side: 'left',
    windows: [[p('p1', 'codex')]],
  });
  assert.deepEqual(res.panes.map((x) => x.tabId), ['codex', 'a']);
});

test('описание раскладки идёт в ЭКРАННОМ порядке', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = addEmptyPaneVertical(panes, 0, null, 0, 'below').panes; // колонка 0: a, пусто
  const view = describeWorkspace(panes, 0);
  assert.equal(view.split, true);
  assert.deepEqual(view.windows.map((w) => [w.column, w.row]), [[0, 0], [0, 1], [1, 0]]);
  assert.equal(view.windows[1].empty, true);
});

test('описание: одиночный режим — одно окно с одной вкладкой', () => {
  const view = describeWorkspace([], 0, p('p1', 'a'));
  assert.equal(view.split, false);
  assert.deepEqual(view.windows[0].tabs, [p('p1', 'a')]);
  assert.equal(view.windows[0].focused, true);
});

test('«сверху» и «справа, разделив на два» — разные просьбы', () => {
  const base = [p('p1', 'a'), p('p1', 'b')];
  // «сверху»: новые окна встают в колонку САМОГО якоря.
  const above = arrangePanes(base, 0, {
    side: 'above',
    windows: [[p('p1', 'x')]],
  });
  assert.equal(above.panes[0].column, above.panes[1].column, 'x встал над a, в его колонке');
  assert.deepEqual(above.panes.map((e) => e.tabId), ['x', 'a', 'b']);

  // «справа, раздели на два»: НОВАЯ колонка справа, поделённая на строки.
  const right = arrangePanes(base, 0, {
    side: 'right',
    divide: 'rows',
    windows: [[p('p1', 'x')], [p('p1', 'y')]],
  });
  const cols = right.panes.map((e) => e.column);
  assert.equal(cols[1], cols[2], 'x и y — строки одной колонки');
  assert.notEqual(cols[0], cols[1], 'и это НЕ колонка якоря');
  assert.equal(cols[3], cols[1] + 1, 'колонка b сдвинулась ровно на одну');
});

test('раскладка: переставили ОДИН чип — окно с остальными живо', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = addTabToPane(panes, 1, 'p1', 'c').panes; // второе окно: [b, c]
  const res = arrangePanes(panes, 0, {
    side: 'right',
    windows: [[p('p1', 'c')]],
  });
  // Ушёл только 'c'. Окно 'b' не «потеряло последний чип» и осталось.
  assert.equal(res.panes.some((x) => x.tabId === 'b'), true);
  assert.deepEqual(res.panes.map((x) => x.tabId), ['a', 'c', 'b']);
});

test('раскладка: якорь может исчезнуть — тогда он же и переставляется', () => {
  // Просьба «эту вкладку — справа», когда стоишь в её же окне: окно исчезает
  // вместе с последним чипом, и относительно чего ставить — уже нечего.
  // Раскладка не должна на этом падать.
  const res = arrangePanes([p('p1', 'a'), p('p1', 'b')], 0, {
    side: 'right',
    windows: [[p('p1', 'a')]],
  });
  assert.deepEqual(res.panes.map((x) => x.tabId), ['b', 'a']);
  assert.equal(res.focusedIndex, 1);
});

// ── Обмен окон местами ────────────────────────────────────────────────────

test('обмен: два окна меняются содержимым целиком, вместе со своими полосами', () => {
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = addTabToPane(panes, 0, 'p1', 'c').panes; // первое окно: [a, c]
  const res = swapPanes(panes, 0, 0, 1);
  // Полоса уехала ЦЕЛИКОМ, а не одной показанной вкладкой.
  assert.deepEqual(paneTabs(res.panes[1]).map((e) => e.tabId), ['a', 'c']);
  assert.equal(res.panes[0].tabId, 'b');
  // Показанной в первом окне была 'c' (её туда и положили) — она и переезжает.
  assert.equal(res.panes[1].tabId, 'c', 'показанная вкладка переезжает с полосой');
});

test('обмен: фокус едет за содержимым', () => {
  const res = swapPanes([p('p1', 'a'), p('p1', 'b')], 0, 0, 1);
  assert.equal(res.focusedIndex, 1);
  const back = swapPanes([p('p1', 'a'), p('p1', 'b')], 1, 0, 1);
  assert.equal(back.focusedIndex, 0);
  const other = swapPanes([p('p1', 'a'), p('p1', 'b'), p('p1', 'c')], 2, 0, 1);
  assert.equal(other.focusedIndex, 2, 'чужой фокус не трогаем');
});

test('обмен: МЕСТО остаётся за окном — колонка не переезжает с содержимым', () => {
  // Колонка 0 из двух строк + колонка 1 одной строкой. Меняем строку из первой
  // колонки со вторым столбцом: сетка обязана остаться той же самой.
  let panes = [p('p1', 'a'), p('p1', 'b')];
  panes = addEmptyPaneVertical(panes, 0, null, 0, 'below').panes;
  panes = panes.map((x) => (x.tabId ? x : { ...x, projectId: 'p1', tabId: 'z' }));
  const before = panes.map((x) => x.column);
  const res = swapPanes(panes, 0, 0, panes.length - 1);
  assert.deepEqual(res.panes.map((x) => x.column), before, 'сетка не перекроилась');
});

test('обмен: одно и то же окно — ничего не происходит', () => {
  assert.equal(swapPanes([p('p1', 'a'), p('p1', 'b')], 0, 1, 1), null);
  assert.equal(swapPanes([p('p1', 'a')], 0, 0, 5), null);
});
