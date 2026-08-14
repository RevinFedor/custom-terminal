import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTerminalViewportIntersection } from './terminalViewportIntersection.mjs';

test('terminal completely translated beyond the viewport is not painted', () => {
  assert.deepEqual(measureTerminalViewportIntersection({
    left: 2529,
    top: 80,
    width: 720,
    height: 900,
    viewportWidth: 1920,
    viewportHeight: 1080,
  }), {
    right: 3249,
    bottom: 980,
    intersectsViewport: false,
  });
});

test('partially clipped terminal still intersects the visible viewport', () => {
  assert.deepEqual(measureTerminalViewportIntersection({
    left: 1500,
    top: -120,
    width: 600,
    height: 900,
    viewportWidth: 1920,
    viewportHeight: 1080,
  }), {
    right: 2100,
    bottom: 780,
    intersectsViewport: true,
  });
});

test('invalid geometry cannot be reported as visible', () => {
  assert.equal(measureTerminalViewportIntersection({
    left: Number.NaN,
    top: 0,
    width: 600,
    height: 900,
    viewportWidth: 1920,
    viewportHeight: 1080,
  }).intersectsViewport, false);
});
