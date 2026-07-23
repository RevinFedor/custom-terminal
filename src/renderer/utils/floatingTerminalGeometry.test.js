import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dragFloatingTerminalRect,
  resizeFloatingTerminalRect,
} from './floatingTerminalGeometry.mjs';

const bounds = { width: 1000, height: 800 };
const start = { x: 200, y: 120, width: 500, height: 320 };

test('drag clamps a floating terminal to every stage edge', () => {
  assert.deepEqual(dragFloatingTerminalRect(start, { x: -900, y: -900 }, bounds), {
    ...start,
    x: 0,
    y: 0,
  });
  assert.deepEqual(dragFloatingTerminalRect(start, { x: 900, y: 900 }, bounds), {
    ...start,
    x: 500,
    y: 480,
  });
});

test('all eight resize handles keep the opposite edges fixed', () => {
  const cases = [
    ['n', { x: 0, y: -40 }, ['left', 'right', 'bottom']],
    ['ne', { x: 40, y: -40 }, ['left', 'bottom']],
    ['e', { x: 40, y: 0 }, ['left', 'top', 'bottom']],
    ['se', { x: 40, y: 40 }, ['left', 'top']],
    ['s', { x: 0, y: 40 }, ['left', 'right', 'top']],
    ['sw', { x: -40, y: 40 }, ['right', 'top']],
    ['w', { x: -40, y: 0 }, ['right', 'top', 'bottom']],
    ['nw', { x: -40, y: -40 }, ['right', 'bottom']],
  ];
  const edge = (rect, name) => name === 'left' ? rect.x
    : name === 'right' ? rect.x + rect.width
      : name === 'top' ? rect.y
        : rect.y + rect.height;

  for (const [direction, delta, fixedEdges] of cases) {
    const next = resizeFloatingTerminalRect(start, direction, delta, bounds);
    for (const fixed of fixedEdges) {
      assert.equal(edge(next, fixed), edge(start, fixed), `${direction} changed ${fixed}`);
    }
  }
});

test('resize obeys percentage limits and stage bounds', () => {
  const huge = resizeFloatingTerminalRect(start, 'se', { x: 5000, y: 5000 }, bounds);
  assert.equal(huge.width, 800);
  assert.equal(huge.height, 640);
  assert.ok(huge.x + huge.width <= bounds.width);
  assert.ok(huge.y + huge.height <= bounds.height);

  const tiny = resizeFloatingTerminalRect(start, 'nw', { x: 5000, y: 5000 }, bounds);
  assert.equal(tiny.width, 300);
  assert.equal(tiny.height, 160);
  assert.equal(tiny.x + tiny.width, start.x + start.width);
  assert.equal(tiny.y + tiny.height, start.y + start.height);
});
