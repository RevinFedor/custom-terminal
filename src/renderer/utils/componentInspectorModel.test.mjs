import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMeasurementConnectors,
  formatElementReference,
  formatFrameLabel,
  formatGapBadge,
  formatMeasurementReference,
  isInspectorModifier,
  measureGap,
  parseInspectorStamp,
  resolveLabelPlacement,
} from './componentInspectorModel.mjs';

const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

test('stamp parsing takes fields from the end so paths with colons survive', () => {
  const plain = parseInspectorStamp('src/renderer/components/UI/Tooltip.tsx:407:50:div');
  assert.deepEqual(plain, {
    path: 'src/renderer/components/UI/Tooltip.tsx',
    line: 407, column: 50, name: 'div',
    location: 'src/renderer/components/UI/Tooltip.tsx:407:50',
  });
  const member = parseInspectorStamp('vendor/markdown-editor/dist/index.js:10628:35:Editor.Root');
  assert.equal(member.name, 'Editor.Root');
  assert.equal(member.location, 'vendor/markdown-editor/dist/index.js:10628:35');
  const weird = parseInspectorStamp('src/a:b/File.tsx:12:3:span');
  assert.equal(weird.path, 'src/a:b/File.tsx');
  assert.equal(weird.line, 12);
});

test('stamp parsing rejects absent, short and non-numeric values', () => {
  for (const value of [null, undefined, '', 'src/File.tsx', 'src/File.tsx:12:3', 'src/File.tsx:x:3:div', 'src/File.tsx:12:y:div', ':12:3:div']) {
    assert.equal(parseInspectorStamp(value), null, String(value));
  }
});

test('modifier is physical Option+Shift only', () => {
  assert.equal(isInspectorModifier({ altKey: true, shiftKey: true }), true);
  assert.equal(isInspectorModifier({ altKey: true, shiftKey: true, metaKey: true }), false);
  assert.equal(isInspectorModifier({ altKey: true, shiftKey: true, ctrlKey: true }), false);
  assert.equal(isInspectorModifier({ altKey: true }), false);
  assert.equal(isInspectorModifier({ shiftKey: true }), false);
  assert.equal(isInspectorModifier(null), false);
});

test('gap between separated boxes is the empty corridor, in both directions', () => {
  const a = rect(0, 0, 100, 40);
  const b = rect(160, 0, 50, 40);
  const right = measureGap(a, b);
  assert.equal(right.gapX, 60);
  assert.equal(right.gapY, 0);
  assert.equal(right.overlapY, 40);
  // Reversing the roles keeps the same distance; only the signed deltas flip.
  const left = measureGap(b, a);
  assert.equal(left.gapX, 60);
  assert.equal(left.deltaLeft, -160);
  assert.equal(right.deltaLeft, 160);
});

test('both axes report at once for a diagonal neighbour', () => {
  const gap = measureGap(rect(0, 0, 100, 40), rect(130, 70, 20, 20));
  assert.equal(gap.gapX, 30);
  assert.equal(gap.gapY, 30);
  assert.equal(gap.overlapX, 0);
  assert.equal(gap.overlapY, 0);
  assert.equal(gap.centerX, 90);
  assert.equal(gap.centerY, 60);
});

test('nested and overlapping boxes report zero gap with the shared length', () => {
  const outer = rect(0, 0, 200, 100);
  const inner = rect(20, 30, 60, 20);
  const nested = measureGap(outer, inner);
  assert.equal(nested.gapX, 0);
  assert.equal(nested.gapY, 0);
  assert.equal(nested.overlapX, 60);
  assert.equal(nested.overlapY, 20);
  assert.equal(nested.deltaLeft, 20);
  assert.equal(nested.deltaRight, -120);
  assert.equal(formatGapBadge(nested), 'X 0 (нахлёст 60) · Y 0 (нахлёст 20)');
});

test('touching edges are a real zero, not a negative or a rounding artefact', () => {
  const gap = measureGap(rect(0, 0, 50, 50), rect(50, 0, 50, 50));
  assert.equal(gap.gapX, 0);
  assert.equal(gap.overlapY, 50);
  assert.equal(formatGapBadge(gap), 'X 0px · Y 0 (нахлёст 50)');
  // Subpixel geometry is rounded to 0.1px and never prints "-0".
  const sub = measureGap(rect(0, 0, 10.04, 10), rect(10.0400001, 0, 10, 10));
  assert.equal(sub.gapX, 0);
  assert.ok(!Object.is(sub.gapX, -0));
});

test('connectors are drawn only for axes that have a gap, inside the corridor', () => {
  const horizontal = buildMeasurementConnectors(rect(0, 0, 100, 40), rect(160, 10, 50, 20));
  assert.equal(horizontal.length, 1);
  assert.deepEqual(horizontal[0], { axis: 'x', x: 100, y: 20, length: 60, label: '60px' });

  const diagonal = buildMeasurementConnectors(rect(0, 0, 100, 40), rect(130, 70, 20, 20));
  assert.deepEqual(diagonal.map(segment => segment.axis), ['x', 'y']);
  assert.equal(diagonal[0].length, 30);
  assert.equal(diagonal[1].length, 30);
  // No horizontal overlap, so the vertical segment sits midway between the two
  // horizontal centres (50 and 140).
  assert.equal(diagonal[1].x, 95);

  // A box above/left of the anchor draws from the other side.
  const back = buildMeasurementConnectors(rect(200, 200, 50, 50), rect(100, 200, 50, 50));
  assert.equal(back.length, 1);
  assert.equal(back[0].x, 150);
  assert.equal(back[0].length, 50);

  assert.deepEqual(buildMeasurementConnectors(rect(0, 0, 100, 100), rect(10, 10, 10, 10)), []);
});

test('label placement never leaves the viewport and flips below when needed', () => {
  const viewport = { width: 1000, height: 600 };
  const above = resolveLabelPlacement(rect(40, 200, 120, 30), viewport);
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 178);
  assert.equal(above.left, 40);

  const top = resolveLabelPlacement(rect(40, 2, 120, 30), viewport);
  assert.equal(top.placement, 'below');
  assert.equal(top.top, 36);

  const farRight = resolveLabelPlacement(rect(950, 300, 40, 20), viewport);
  assert.equal(farRight.left, 640); // 1000 - 360 label width
  const offBottom = resolveLabelPlacement(rect(10, 590, 40, 400), viewport);
  assert.ok(offBottom.top <= viewport.height - 18);
});

test('element payload keeps the established clipboard format and truncates HTML', () => {
  const stamp = parseInspectorStamp('src/renderer/components/Workspace/TabCard.tsx:91:7:button');
  assert.equal(
    formatElementReference(stamp, '<button class="x">Hi</button>'),
    '<button class="x">Hi</button>\n\nin <button> at src/renderer/components/Workspace/TabCard.tsx:91:7',
  );
  assert.equal(
    formatElementReference(stamp, ''),
    '<button> at src/renderer/components/Workspace/TabCard.tsx:91:7',
  );
  const long = formatElementReference(stamp, 'a'.repeat(5000));
  assert.ok(long.includes('...(truncated)'));
  assert.ok(long.indexOf('\n\nin <button>') <= 1200 + '\n  ...(truncated)'.length);
});

test('measurement payload names both elements, the gap and the signed edges', () => {
  const anchor = { stamp: parseInspectorStamp('src/A.tsx:10:2:div'), rect: rect(0, 0, 100, 40) };
  const target = { stamp: parseInspectorStamp('src/B.tsx:20:4:span'), rect: rect(160, 70, 50, 20) };
  const lines = formatMeasurementReference(anchor, target).split('\n');
  assert.equal(lines[0], 'A <div> at src/A.tsx:10:2  100×40 @ (0, 0)');
  assert.equal(lines[1], 'B <span> at src/B.tsx:20:4  50×20 @ (160, 70)');
  assert.equal(lines[2], 'gap x 60px · gap y 30px');
  assert.equal(lines[3], 'edges: left +160 · right +110 · top +70 · bottom +50');
  assert.equal(lines[4], 'centers: x +135 · y +60');

  const overlapping = formatMeasurementReference(
    { stamp: parseInspectorStamp('src/A.tsx:1:1:div'), rect: rect(0, 0, 200, 100) },
    { stamp: parseInspectorStamp('src/B.tsx:2:2:div'), rect: rect(20, 30, 60, 20) },
  );
  assert.match(overlapping, /gap x 0px · gap y 0px \(overlap x 60px · overlap y 20px\)/);
});

test('frame label carries location, tag and rounded size', () => {
  const stamp = parseInspectorStamp('src/renderer/App.tsx:5:1:section');
  assert.equal(formatFrameLabel(stamp, rect(0, 0, 120.44, 32.06)), 'src/renderer/App.tsx:5:1 · section · 120.4×32.1');
});
