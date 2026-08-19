import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTimelinePromptBoundaries } from './timelinePromptBoundaryMap.mjs';

test('click binding and viewport positions use the real one-based OSC sequence', () => {
  const mapped = mapTimelinePromptBoundaries({
    entryIndices: [0, 1, 2],
    boundaries: [
      { seq: 1, line: 10 },
      { seq: 2, line: 20 },
    ],
  });

  assert.deepEqual([...mapped.positions.entries()], [
    [0, 0],
    [1, 10],
    [2, 20],
  ]);
  assert.deepEqual(mapped.bindings, [
    { entryIndex: 1, promptSeq: 1, line: 10 },
    { entryIndex: 2, promptSeq: 2, line: 20 },
  ]);
});

test('a short live boundary set is aligned to the newest transcript entries', () => {
  const mapped = mapTimelinePromptBoundaries({
    entryIndices: [0, 1, 2, 3, 4],
    boundaries: [
      { seq: 7, line: 100 },
      { seq: 8, line: 200 },
    ],
  });

  assert.deepEqual([...mapped.positions.entries()], [
    [2, 0],
    [3, 100],
    [4, 200],
  ]);
  assert.deepEqual(mapped.bindings.map((binding) => binding.promptSeq), [7, 8]);
});

test('without a live boundary the caller can keep its text-search fallback', () => {
  const mapped = mapTimelinePromptBoundaries({ entryIndices: [0, 1], boundaries: [] });
  assert.equal(mapped.positions.size, 0);
  assert.deepEqual(mapped.bindings, []);
});
