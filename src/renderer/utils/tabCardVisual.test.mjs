import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTabCardBackground,
  resolveTabCardTextColor,
  resolveTabCardMetrics,
} from './tabCardVisual.mjs';

// Stand-in for tabChrome's adjustRgbaAlpha: records what was asked of it, so
// the tests can assert "brightened ITS OWN colour" rather than a literal.
const adjust = (color, delta) => `${color}+${delta}`;

test('an uncoloured tab gets a neutral tint on hover', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'transparent', hasColor: false, hovered: true }, adjust),
    'rgba(255,255,255,0.12)',
  );
});

// THE BUG: the pane header painted a flat white wash over the tab on hover, so
// a green tab flashed a washed-out grey-green and read as a different widget
// than the same tab in the sidebar. Hover must brighten the tab's own colour.
test('a coloured tab brightens its OWN colour on hover, never a white wash', () => {
  const bg = resolveTabCardBackground({ bgColor: 'rgba(16,80,60,0.5)', hasColor: true, hovered: true }, adjust);
  assert.equal(bg, 'rgba(16,80,60,0.5)+0.08');
  assert.ok(!bg.includes('255,255,255'), 'hover must not replace the colour with white');
});

test('active outranks hover and selected', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'c', hasColor: true, active: true, hovered: true, selected: true }, adjust),
    'c+0.25',
  );
});

test('selected outranks hover', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'c', hasColor: true, selected: true, hovered: true }, adjust),
    'c+0.1',
  );
});

test('a resting coloured tab shows its colour unchanged', () => {
  assert.equal(resolveTabCardBackground({ bgColor: 'c', hasColor: true }, adjust), 'c');
});

test('a resting uncoloured tab keeps a faint plate, not transparency', () => {
  assert.equal(resolveTabCardBackground({ bgColor: 'transparent', hasColor: false }, adjust), 'rgba(255,255,255,0.04)');
});

test('the name is dim at rest and bright once the card matters', () => {
  assert.equal(resolveTabCardTextColor({}), '#888');
  assert.equal(resolveTabCardTextColor({ hovered: true }), '#fff');
  assert.equal(resolveTabCardTextColor({ active: true }), '#fff');
  assert.equal(resolveTabCardTextColor({ selected: true }), '#fff');
});

const geo = { paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 4 };

test('metrics come from the user settings, not from per-surface literals', () => {
  const m = resolveTabCardMetrics(geo, { fontSize: 14 });
  assert.equal(m.borderRadius, 6);
  assert.equal(m.fontSize, 14);
  assert.equal(m.padding, '3px 6px 3px 6px');
});

test('a status marker widens the left inset so the name clears it', () => {
  assert.equal(resolveTabCardMetrics(geo, { fontSize: 14, hasStatusMarker: true }).padding, '3px 6px 3px 16px');
});

test('a visible task lane shifts padding up, keeping the text centred', () => {
  assert.equal(resolveTabCardMetrics(geo, { fontSize: 14, showTaskLane: true }).padding, '1px 6px 5px 6px');
});

// THE OTHER BUG: the squares sat inside the card's bottom edge instead of
// across it. They mark the boundary — sitting fully inside says nothing.
test('the task lane hangs BELOW the bottom edge, not inside it', () => {
  assert.ok(resolveTabCardMetrics(geo, { fontSize: 14, showTaskLane: true }).laneBottomPx < 0);
});

test('the overhang never reaches the next card', () => {
  const m = resolveTabCardMetrics({ ...geo, gap: 4 }, { fontSize: 14, nextCardClearancePx: 1 });
  assert.equal(m.laneBottomPx, -3); // 4px gap − 1px clearance
});

test('with no gap between cards the lane stops overhanging entirely', () => {
  assert.equal(resolveTabCardMetrics({ ...geo, gap: 0 }, { fontSize: 14 }).laneBottomPx, 0);
});

test('missing or broken settings degrade to defaults instead of NaN', () => {
  const m = resolveTabCardMetrics(undefined, {});
  assert.equal(m.padding, '3px 6px 3px 6px');
  assert.equal(m.fontSize, 14);
  assert.ok(Number.isFinite(m.laneBottomPx));
  const bad = resolveTabCardMetrics({ paddingX: 'x', gap: null }, { fontSize: 'y' });
  assert.ok(!bad.padding.includes('NaN'));
  assert.equal(bad.fontSize, 14);
});
