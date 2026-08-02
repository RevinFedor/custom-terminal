import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetScrollTop,
  getRememberedScrollTop,
  readScrollMemory,
  rememberScrollTop,
} from './filePreviewScrollMemory.mjs';

test('a remembered position comes back for the same file', () => {
  const memory = rememberScrollTop({}, '/p/readme.md', 420, 1000);
  assert.equal(getRememberedScrollTop(memory, '/p/readme.md'), 420);
  assert.equal(getRememberedScrollTop(memory, '/p/other.md'), 0);
});

test('the same file opened from tab or sidebar shares one position', () => {
  // Both surfaces key on the absolute path, so there is nothing to reconcile.
  const memory = rememberScrollTop({}, '/p/readme.md', 300, 1000);
  assert.equal(getRememberedScrollTop(memory, '/p/readme.md'), 300);
});

test('scrolling back to the top drops the entry instead of storing a zero', () => {
  const scrolled = rememberScrollTop({}, '/p/a.md', 150, 1000);
  const backToTop = rememberScrollTop(scrolled, '/p/a.md', 0, 2000);
  assert.deepEqual(backToTop, {});
});

test('an unchanged position returns the same map so nothing is re-saved', () => {
  const memory = rememberScrollTop({}, '/p/a.md', 150, 1000);
  assert.equal(rememberScrollTop(memory, '/p/a.md', 150, 2000), memory);
  // Sub-pixel jitter rounds to the same integer and must not trigger a save.
  assert.equal(rememberScrollTop(memory, '/p/a.md', 150.4, 2000), memory);
  const empty = {};
  assert.equal(rememberScrollTop(empty, '/p/a.md', 0, 1000), empty);
});

test('the oldest files are evicted once the cap is reached', () => {
  let memory = {};
  for (let i = 0; i < 5; i++) memory = rememberScrollTop(memory, `/p/f${i}.md`, 100 + i, i + 1, 3);
  assert.deepEqual(Object.keys(memory).sort(), ['/p/f2.md', '/p/f3.md', '/p/f4.md']);
});

test('stored data survives a reload and tolerates junk', () => {
  const restored = readScrollMemory({
    '/p/a.md': { top: 240, at: 5 },
    '/p/legacy.md': 90,
    '/p/zero.md': { top: 0, at: 5 },
    '/p/bad.md': { top: 'nonsense' },
    '': { top: 10 },
  });
  assert.deepEqual(restored, {
    '/p/a.md': { top: 240, at: 5 },
    '/p/legacy.md': { top: 90, at: 0 },
  });
  assert.deepEqual(readScrollMemory(null), {});
});

test('forgetting one file leaves the rest intact', () => {
  const memory = rememberScrollTop(rememberScrollTop({}, '/p/a.md', 10, 1), '/p/b.md', 20, 2);
  assert.deepEqual(Object.keys(forgetScrollTop(memory, '/p/a.md')), ['/p/b.md']);
  assert.equal(forgetScrollTop(memory, '/p/missing.md'), memory);
});
