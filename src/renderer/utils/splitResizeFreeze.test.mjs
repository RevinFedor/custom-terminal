import assert from 'node:assert/strict';
import test from 'node:test';
import { paneResizeFreezeBox } from './splitResizeFreeze.mjs';

test('content keeps its exact pixel box while the pane wrapper moves', () => {
  assert.deepEqual(
    paneResizeFreezeBox(
      { left: 100.25, top: 40.5 },
      { left: 102.25, top: 72.75, width: 640.5, height: 500.25 },
    ),
    { left: 2, top: 32.25, width: 640.5, height: 500.25 },
  );
});

test('zero or unknown content geometry does not arm a broken freeze', () => {
  assert.equal(paneResizeFreezeBox({ left: 0, top: 0 }, { left: 0, top: 0, width: 0, height: 10 }), null);
  assert.equal(paneResizeFreezeBox({ left: 0, top: 0 }, { left: 0, top: 0, width: 10 }), null);
});
