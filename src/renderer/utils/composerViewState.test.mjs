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

test('composer view events are ignored during owner restoration and for stale owners', () => {
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-a', null), true);
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-a', 'tab-a'), false);
  assert.equal(shouldRecordComposerViewEvent('tab-a', 'tab-b', null), false);
  assert.equal(shouldRecordComposerViewEvent('', 'tab-b', null), false);
});
