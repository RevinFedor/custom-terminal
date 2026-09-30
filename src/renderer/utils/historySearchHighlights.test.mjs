import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistorySearchHighlights, HISTORY_SEARCH_HIGHLIGHT as allName,
  HISTORY_SEARCH_CURRENT_HIGHLIGHT as currentName } from './historySearchHighlights.mjs';

test('closing or refreshing one chat preserves the other chat ranges', () => {
  const highlights = new Map();
  const registry = createHistorySearchHighlights(highlights, Set);
  const a = {}, b = {}, a1 = {}, a2 = {}, b1 = {};
  registry.set(a, [a1], [a1]);
  registry.set(b, [b1], [b1]);
  assert.deepEqual([...highlights.get(allName)], [a1, b1]);
  registry.set(a, [a2], []);
  assert.deepEqual([...highlights.get(allName)], [a2, b1]);
  assert.deepEqual([...highlights.get(currentName)], [b1]);
  registry.clear(a);
  assert.deepEqual([...highlights.get(allName)], [b1]);
  registry.clear(b);
  assert.equal(highlights.size, 0);
});

test('empty search and stale owner cleanup cannot clear a newer owner', () => {
  const highlights = new Map();
  const registry = createHistorySearchHighlights(highlights, Set);
  const old = {}, next = {}, range = {};
  registry.set(next, [range], [range]);
  const published = highlights.get(allName);
  registry.set(old, [], []);
  registry.clear(old);
  assert.equal(highlights.get(allName), published);
  registry.set(next, [], []);
  assert.equal(highlights.size, 0);
});

test('a large visible set does not spread ranges into constructor arguments', () => {
  const highlights = new Map();
  class NoArgumentsHighlight extends Set {
    constructor(...args) { assert.equal(args.length, 0); super(); }
  }
  const registry = createHistorySearchHighlights(highlights, NoArgumentsHighlight);
  const ranges = Array.from({ length: 2000 }, () => ({}));
  registry.set({}, ranges, [ranges.at(-1)]);
  assert.equal(highlights.get(allName).size, ranges.length);
  assert.deepEqual([...highlights.get(currentName)], [ranges.at(-1)]);
});
