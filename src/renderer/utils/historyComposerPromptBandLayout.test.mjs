import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS,
  HISTORY_COMPOSER_PROMPT_CHIP_MAX_WIDTH_PX,
  resolveHistoryComposerPromptBandLayout,
} from './historyComposerPromptBandLayout.mjs';

test('prompt chips retain their natural width until three rows need a tighter share', () => {
  assert.deepEqual(resolveHistoryComposerPromptBandLayout(3), {
    itemCount: 3,
    columns: 1,
    gapPx: 5,
    maxRows: 3,
    itemMaxWidth: 'min(168px, calc(100% - 0px))',
    maxHeight: 'calc(3.6em + 22px)',
  });
  assert.equal(HISTORY_COMPOSER_PROMPT_CHIP_MAX_WIDTH_PX, 168);
});

test('the width share guarantees no more than three row-major rows', () => {
  for (let count = 1; count <= 120; count += 1) {
    const layout = resolveHistoryComposerPromptBandLayout(count);
    assert.ok(Math.ceil(count / layout.columns) <= HISTORY_COMPOSER_PROMPT_BAND_MAX_ROWS);
  }
  assert.equal(resolveHistoryComposerPromptBandLayout(4).itemMaxWidth,
    'min(168px, calc(50% - 2.5px))');
  assert.equal(resolveHistoryComposerPromptBandLayout(7).itemMaxWidth,
    'min(168px, calc(33.333333% - 3.333333px))');
});

