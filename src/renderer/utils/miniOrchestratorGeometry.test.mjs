import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMiniPanel, resizeMiniPanel, moveMiniPanel } from './miniOrchestratorGeometry.mjs';
const viewport = { width: 1000, height: 800 };
const rect = { left: 500, top: 100, width: 420, height: 400 };
test('west, south and southwest preserve the opposite edges', () => {
  const west = resizeMiniPanel(rect, 'left', -100, 99, viewport);
  assert.equal(west.left, 400); assert.equal(west.width, 520); assert.equal(west.left + west.width, 920); assert.equal(west.height, 400);
  const south = resizeMiniPanel(rect, 'bottom', 99, 100, viewport);
  assert.equal(south.left, 500); assert.equal(south.width, 420); assert.equal(south.top, 100); assert.equal(south.height, 500);
  const corner = resizeMiniPanel(rect, 'left-bottom', -100, 100, viewport);
  assert.deepEqual(corner, { left: 400, top: 100, width: 520, height: 500 });
});
test('viewport clamps; move does not change size or accumulate hidden displacement', () => {
  const atEdge = moveMiniPanel(rect, 1000, 1000, viewport);
  assert.equal(atEdge.width, rect.width); assert.equal(atEdge.height, rect.height);
  const reverse = moveMiniPanel(atEdge, -1, -1, viewport);
  assert.equal(reverse.left, atEdge.left - 1); assert.equal(reverse.top, atEdge.top - 1);
  const small = { left: 10, top: 10, width: 240, height: 90 };
  assert.equal(moveMiniPanel(small, 1, 1, viewport).height, 90);
  assert.equal(resizeMiniPanel(small, 'left', 0, 0, viewport).width, 240);
  assert.ok(fitMiniPanel(rect, { width: 260, height: 220 }).width <= 244);
});
