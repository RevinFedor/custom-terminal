import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStableTerminalViewportOffsets } from './stableTerminalViewport.mjs';

test('inline terminal keeps its geometry and only moves above a growing composer', () => {
  assert.deepEqual(resolveStableTerminalViewportOffsets({
    floating: false,
    bottomInset: 149,
  }), {
    top: 0,
    bottom: 0,
    translateY: -149,
  });
});

test('floating terminal also keeps PTY geometry stable and moves above the composer', () => {
  assert.deepEqual(resolveStableTerminalViewportOffsets({
    floating: true,
    bottomInset: 149,
  }), {
    top: 0,
    bottom: 0,
    translateY: -149,
  });
});

test('invalid and negative composer heights do not move either surface', () => {
  assert.deepEqual(resolveStableTerminalViewportOffsets({
    floating: false,
    bottomInset: -20,
  }), {
    top: 0,
    bottom: 0,
    translateY: 0,
  });
  assert.deepEqual(resolveStableTerminalViewportOffsets({
    floating: true,
    bottomInset: Number.NaN,
  }), {
    top: 0,
    bottom: 0,
    translateY: 0,
  });
});
