// Resizable split dividers — the fraction model.
//
// Sizes are fractions beside the panes, normalized at READ time against the
// current structure: a dimension whose stored count matches keeps its
// fractions, one that does not resets to equal. No pane writer knows sizes
// exist — that read-time rule is what these tests pin.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEmptyPaneVertical,
  normalizeSplitSizes,
  packSplitSizes,
  paneGridRects,
  resizeFractions,
  resolveSplitActivation,
  splitDividerDescriptors,
  splitSizesFingerprint,
  SPLIT_MIN_FRACTION,
} from './splitPanesModel.mjs';

const p = (projectId, tabId) => ({ projectId, tabId });

// A 2-column layout where the left column is stacked into two rows:
//   [A|C]  ← columns
//   [B| ]
const stackedLeft = () => {
  const oneCol = addEmptyPaneVertical([], 0, p('p1', 'a'), null, 'below').panes;
  const filled = resolveSplitActivation(oneCol, 1, 'p1', 'b').panes;
  return [...filled, { projectId: 'p1', tabId: 'c', column: 1 }];
};

// ── resizeFractions: the drag math ────────────────────────────────────────

test('dragging a divider moves share between exactly its two neighbours', () => {
  const next = resizeFractions([1 / 3, 1 / 3, 1 / 3], 0, 0.1);
  assert.ok(Math.abs(next[0] - (1 / 3 + 0.1)) < 1e-9);
  assert.ok(Math.abs(next[1] - (1 / 3 - 0.1)) < 1e-9);
  assert.equal(next[2], 1 / 3, 'the third pane is untouched');
  assert.ok(Math.abs(next.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'total preserved');
});

test('neither neighbour can be dragged below the minimum', () => {
  const shrunkRight = resizeFractions([0.5, 0.5], 0, 0.9);
  assert.ok(Math.abs(shrunkRight[1] - SPLIT_MIN_FRACTION) < 1e-9);
  const shrunkLeft = resizeFractions([0.5, 0.5], 0, -0.9);
  assert.ok(Math.abs(shrunkLeft[0] - SPLIT_MIN_FRACTION) < 1e-9);
});

test('a divider between two minimum-size panes refuses to move', () => {
  const tight = [SPLIT_MIN_FRACTION, SPLIT_MIN_FRACTION, 1 - 2 * SPLIT_MIN_FRACTION];
  assert.equal(resizeFractions(tight, 0, 0.05), tight, 'same reference — caller can skip the write');
});

test('an invalid divider index changes nothing', () => {
  const list = [0.5, 0.5];
  assert.equal(resizeFractions(list, 1, 0.1), list, 'last pane has no right neighbour');
  assert.equal(resizeFractions(list, -1, 0.1), list);
});

// ── normalize: sizes survive matching structure, reset on mismatch ────────

test('stored fractions apply when the structure still matches', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  const norm = normalizeSplitSizes(panes, { cols: [0.7, 0.3], rows: [[1], [1]] });
  assert.deepEqual(norm.cols, [0.7, 0.3]);
});

test('a pane count change resets THAT dimension to equal, not the others', () => {
  // Sizes saved for 2 columns, but a third column appeared meanwhile.
  const panes = [p('p1', 'a'), p('p1', 'b'), p('p1', 'c')];
  const norm = normalizeSplitSizes(panes, { cols: [0.7, 0.3], rows: [[1], [1]] });
  assert.deepEqual(norm.cols, [1 / 3, 1 / 3, 1 / 3]);
});

test('row sizes are per column: a mismatch in one column leaves the other alone', () => {
  const panes = stackedLeft();
  const norm = normalizeSplitSizes(panes, {
    cols: [0.6, 0.4],
    rows: [[0.8, 0.2], [0.5, 0.5]], // right column stored 2 rows, actually has 1
  });
  assert.deepEqual(norm.rows[0], [0.8, 0.2], 'matching column keeps its rows');
  assert.deepEqual(norm.rows[1], [1], 'mismatching column resets to equal');
  assert.deepEqual(norm.cols, [0.6, 0.4], 'columns unaffected by the row mismatch');
});

test('garbage sizes degrade to equal, never to NaN geometry', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  assert.deepEqual(normalizeSplitSizes(panes, { cols: [0.5, NaN], rows: [] }).cols, [0.5, 0.5]);
  assert.deepEqual(normalizeSplitSizes(panes, { cols: [0, 1], rows: [] }).cols, [0.5, 0.5],
    'a zero-width pane is not a size, it is a missing pane');
  assert.deepEqual(normalizeSplitSizes(panes, null).cols, [0.5, 0.5]);
});

test('fractions with float drift renormalize to an exact total of 1', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  const norm = normalizeSplitSizes(panes, { cols: [0.7001, 0.3001], rows: [[1], [1]] });
  assert.ok(Math.abs(norm.cols.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

// ── pack: the stored form is null for an untouched layout ─────────────────

test('an equal split stores nothing — same absent-default rule as `column`', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  assert.equal(packSplitSizes(panes, { cols: [0.5, 0.5], rows: [[1], [1]] }), null);
  assert.equal(packSplitSizes(panes, null), null);
  assert.equal(packSplitSizes([], { cols: [1], rows: [[1]] }), null, 'single mode stores nothing');
});

test('a dragged layout packs, and packing re-normalizes against the panes', () => {
  const panes = [p('p1', 'a'), p('p1', 'b')];
  const packed = packSplitSizes(panes, { cols: [0.7, 0.3], rows: [[1], [1]] });
  assert.deepEqual(packed.cols, [0.7, 0.3]);
  // Sizes for a structure that no longer exists pack to null (self-cleaning).
  assert.equal(packSplitSizes(panes, { cols: [0.2, 0.3, 0.5], rows: [[1], [1], [1]] }), null);
});

// ── geometry with sizes ───────────────────────────────────────────────────

test('paneGridRects without sizes is byte-identical to the pre-resize geometry', () => {
  const panes = [p('p1', 'a'), p('p1', 'b'), p('p1', 'c')];
  assert.deepEqual(paneGridRects(panes), paneGridRects(panes, null));
  assert.deepEqual(paneGridRects(panes)[1], { leftPct: 100 / 3, widthPct: 100 / 3, topPct: 0, heightPct: 100 });
});

test('column fractions become pane widths, row fractions become heights', () => {
  const panes = stackedLeft();
  const rects = paneGridRects(panes, { cols: [0.6, 0.4], rows: [[0.75, 0.25], [1]] });
  assert.deepEqual(rects[0], { leftPct: 0, widthPct: 60, topPct: 0, heightPct: 75 });
  assert.deepEqual(rects[1], { leftPct: 0, widthPct: 60, topPct: 75, heightPct: 25 });
  assert.deepEqual(rects[2], { leftPct: 60, widthPct: 40, topPct: 0, heightPct: 100 });
});

// ── divider descriptors ───────────────────────────────────────────────────

test('N columns have N-1 column dividers, at the accumulated boundaries', () => {
  const panes = [p('p1', 'a'), p('p1', 'b'), p('p1', 'c')];
  const divs = splitDividerDescriptors(panes, { cols: [0.5, 0.3, 0.2], rows: [[1], [1], [1]] });
  const colDivs = divs.filter((d) => d.kind === 'col');
  assert.equal(colDivs.length, 2);
  assert.deepEqual(colDivs.map((d) => d.xPct), [50, 80]);
  assert.deepEqual(colDivs.map((d) => d.id), ['col:0', 'col:1']);
});

test('a row divider spans exactly its own column', () => {
  const panes = stackedLeft();
  const divs = splitDividerDescriptors(panes, { cols: [0.6, 0.4], rows: [[0.75, 0.25], [1]] });
  const rowDivs = divs.filter((d) => d.kind === 'row');
  assert.equal(rowDivs.length, 1, 'only the stacked column has a divider');
  assert.deepEqual(rowDivs[0], {
    id: 'row:0:0', kind: 'row', columnIndex: 0, dividerIndex: 0,
    yPct: 75, leftPct: 0, widthPct: 60,
  });
});

test('single mode and a lone pane have no dividers', () => {
  assert.deepEqual(splitDividerDescriptors([], null), []);
  assert.deepEqual(splitDividerDescriptors([p('p1', 'a')], null), []);
});

// ── fingerprint ───────────────────────────────────────────────────────────

test('fingerprint distinguishes sizes and is stable for equal inputs', () => {
  const a = splitSizesFingerprint({ cols: [0.7, 0.3], rows: [[1], [1]] });
  const b = splitSizesFingerprint({ cols: [0.7, 0.3], rows: [[1], [1]] });
  const c = splitSizesFingerprint({ cols: [0.6, 0.4], rows: [[1], [1]] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(splitSizesFingerprint(null), '');
});
