import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_VIEW_STATE_LIMIT,
  readComposerViewMemory,
  rememberComposerView,
  shouldRecordComposerViewEvent,
} from './composerViewState.mjs';

test('composer view memory rejects corrupt records and normalizes positions', () => {
  assert.deepEqual(readComposerViewMemory({
    good: { selectionStart: 4.8, selectionEnd: 9.2, scrollTop: 12.5, updatedAt: 7 },
    bad: { selectionStart: -1, selectionEnd: 0, scrollTop: 0 },
  }), {
    good: { selectionStart: 4, selectionEnd: 9, scrollTop: 12.5, updatedAt: 7 },
  });
});

test('composer view memory merges selection and scroll and caps oldest tabs', () => {
  let memory = {};
  for (let index = 0; index < COMPOSER_VIEW_STATE_LIMIT + 3; index += 1) {
    memory = rememberComposerView(memory, `tab-${index}`, {
      selectionStart: index,
      selectionEnd: index,
      scrollTop: index * 2,
    }, index + 1);
  }
  assert.equal(Object.keys(memory).length, COMPOSER_VIEW_STATE_LIMIT);
  assert.equal(memory['tab-0'], undefined);
  const updated = rememberComposerView(memory, 'tab-202', { scrollTop: 999 }, 1000);
  assert.deepEqual(updated['tab-202'], {
    selectionStart: 202,
    selectionEnd: 202,
    scrollTop: 999,
    updatedAt: 1000,
  });
});

const reverseView = {
  selectionStart: 3,
  selectionEnd: 8,
  selectionAnchor: 8,
  selectionHead: 3,
  scrollTop: 12.5,
  updatedAt: 7,
};

const legacyView = {
  selectionStart: 3,
  selectionEnd: 8,
  scrollTop: 12.5,
  updatedAt: 7,
};

test('backward selection survives remember, JSON persistence and hydration', () => {
  const memory = rememberComposerView({}, 'tab-a', reverseView, 7);
  assert.deepEqual(memory, { 'tab-a': reverseView });
  assert.deepEqual(readComposerViewMemory(JSON.parse(JSON.stringify(memory))), memory);
});

test('legacy records retain their exact fallback shape, including descending ranges', () => {
  const descending = { ...legacyView, selectionStart: 8, selectionEnd: 3 };
  const memory = { forward: legacyView, descending };
  assert.deepEqual(readComposerViewMemory(JSON.parse(JSON.stringify(memory))), memory);
  assert.deepEqual(rememberComposerView(memory, 'descending', { scrollTop: 20 }, 9).descending, {
    ...descending, scrollTop: 20, updatedAt: 9,
  });
});

test('direction pair matches normalized bounds without reordering legacy start/end', () => {
  assert.deepEqual(readComposerViewMemory({
    descending: { ...reverseView, selectionStart: 8.9, selectionEnd: 3.2 },
    fractional: { ...reverseView, selectionStart: 3.2, selectionEnd: 8.9 },
    caret: { ...legacyView, selectionStart: 3, selectionEnd: 3, selectionAnchor: 3, selectionHead: 3 },
  }), {
    descending: { ...reverseView, selectionStart: 8, selectionEnd: 3 },
    fractional: reverseView,
    caret: { ...legacyView, selectionStart: 3, selectionEnd: 3, selectionAnchor: 3, selectionHead: 3 },
  });
});

test('malformed, incomplete and mismatched direction pairs preserve valid legacy records', () => {
  const invalidPairs = [
    { selectionAnchor: 8 },
    { selectionHead: 3 },
    { selectionAnchor: '8', selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: '3' },
    { selectionAnchor: null, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: null },
    { selectionAnchor: true, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: false },
    { selectionAnchor: 8.1, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: 3.1 },
    { selectionAnchor: -1, selectionHead: 8 },
    { selectionAnchor: 8, selectionHead: -1 },
    { selectionAnchor: NaN, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: Infinity },
    { selectionAnchor: Number.MAX_SAFE_INTEGER + 1, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: Number.MAX_SAFE_INTEGER + 1 },
    { selectionAnchor: 8, selectionHead: 4 },
    { selectionAnchor: 7, selectionHead: 3 },
    { selectionAnchor: 3, selectionHead: 3 },
  ];
  for (const pair of invalidPairs) {
    assert.deepEqual(readComposerViewMemory({ 'tab-a': { ...legacyView, ...pair } }), {
      'tab-a': legacyView,
    });
  }
});

test('same-range direction changes are saved and identical direction is a no-op', () => {
  const memory = { 'tab-a': reverseView };
  for (const patch of [
    { selectionAnchor: 3, selectionHead: 8 },
    { selectionStart: 3, selectionEnd: 8, selectionAnchor: 3, selectionHead: 8 },
  ]) {
    const next = rememberComposerView(memory, 'tab-a', patch, 10);
    assert.notEqual(next, memory);
    assert.deepEqual(next['tab-a'], { ...reverseView, selectionAnchor: 3, selectionHead: 8, updatedAt: 10 });
    assert.deepEqual(readComposerViewMemory(JSON.parse(JSON.stringify(next))), next);
    assert.equal(rememberComposerView(next, 'tab-a', patch, 11), next);
    assert.deepEqual(rememberComposerView(next, 'tab-a', { selectionAnchor: 8, selectionHead: 3 }, 12)['tab-a'], {
      ...reverseView, updatedAt: 12,
    });
  }
  assert.deepEqual(rememberComposerView({ 'tab-a': legacyView }, 'tab-a', {
    selectionAnchor: 8, selectionHead: 3,
  }, 10)['tab-a'], { ...reverseView, updatedAt: 10 });
});

test('range patches drop stale direction even when either or both range values are unchanged', () => {
  const memory = { 'tab-a': reverseView };
  for (const patch of [
    { selectionStart: 3 },
    { selectionEnd: 8 },
    { selectionStart: 3, selectionEnd: 8 },
    { selectionStart: 3, selectionEnd: 8, selectionAnchor: 8 },
    { selectionStart: 3, selectionEnd: 8, selectionAnchor: '8', selectionHead: 3 },
    { selectionStart: 3, selectionEnd: 8, selectionAnchor: 8, selectionHead: 4 },
  ]) {
    const next = rememberComposerView(memory, 'tab-a', patch, 10);
    assert.notEqual(next, memory);
    assert.deepEqual(next['tab-a'], { ...legacyView, updatedAt: 10 });
  }
  assert.deepEqual(rememberComposerView(memory, 'tab-a', { selectionStart: 4, selectionEnd: 9 }, 10)['tab-a'], {
    ...legacyView, selectionStart: 4, selectionEnd: 9, updatedAt: 10,
  });
  assert.deepEqual(rememberComposerView(memory, 'tab-a', {
    selectionStart: 4, selectionEnd: 9, selectionAnchor: 9, selectionHead: 4,
  }, 10)['tab-a'], {
    ...reverseView, selectionStart: 4, selectionEnd: 9, selectionAnchor: 9, selectionHead: 4, updatedAt: 10,
  });
});

test('partial or invalid pure pair patches never reuse a stale half', () => {
  const memory = { 'tab-a': reverseView };
  for (const patch of [
    { selectionAnchor: 8 },
    { selectionHead: 3 },
    { selectionAnchor: undefined, selectionHead: 3 },
    { selectionAnchor: 8, selectionHead: undefined },
    { selectionAnchor: 9, selectionHead: 4 },
  ]) {
    assert.deepEqual(rememberComposerView(memory, 'tab-a', patch, 10)['tab-a'], {
      ...legacyView, updatedAt: 10,
    });
  }
});

test('scroll-only updates retain direction and unchanged scroll retains memory identity', () => {
  const memory = { 'tab-a': reverseView };
  const next = rememberComposerView(memory, 'tab-a', { scrollTop: 20 }, 10);
  assert.deepEqual(next['tab-a'], { ...reverseView, scrollTop: 20, updatedAt: 10 });
  assert.equal(rememberComposerView(next, 'tab-a', { scrollTop: 20 }, 11), next);
  assert.equal(rememberComposerView(next, 'tab-a', {}, 11), next);
  assert.deepEqual(memory['tab-a'], reverseView);
});

test('invalid range patches are complete no-ops, retaining direction and scroll', () => {
  const memory = { 'tab-a': reverseView };
  for (const patch of [
    { selectionStart: -1 },
    { selectionEnd: -1 },
    { selectionStart: NaN },
    { selectionEnd: Infinity },
    { selectionStart: 'invalid' },
  ]) {
    assert.equal(rememberComposerView(memory, 'tab-a', {
      ...patch, scrollTop: 99, selectionAnchor: 3, selectionHead: 8,
    }, 10), memory);
  }
  assert.equal(rememberComposerView(memory, '', { scrollTop: 99 }, 10), memory);
});

test('direction-only update refreshes bounded-memory order before eviction', () => {
  const memory = Object.fromEntries(Array.from({ length: COMPOSER_VIEW_STATE_LIMIT }, (_, index) => [
    `tab-${index}`, { ...reverseView, updatedAt: index + 1 },
  ]));
  const reordered = rememberComposerView(memory, 'tab-0', { selectionAnchor: 3, selectionHead: 8 }, 1000);
  assert.equal(Object.keys(reordered).at(-1), 'tab-0');
  const capped = rememberComposerView(reordered, 'new-tab', reverseView, 1001);
  assert.equal(Object.keys(capped).length, COMPOSER_VIEW_STATE_LIMIT);
  assert.equal(capped['tab-1'], undefined);
  assert.deepEqual(capped['tab-0'], { ...reverseView, selectionAnchor: 3, selectionHead: 8, updatedAt: 1000 });
});

test('composer view events are ignored during owner restoration and for stale owners', () => {
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-a', null), true);
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-a', 'tab-a'), false);
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-b', null), false);
  assert.equal(shouldRecordComposerViewEvent('', 'tab-b', null), false);
});
