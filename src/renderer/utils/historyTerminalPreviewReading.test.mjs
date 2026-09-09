import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyTerminalPreviewHandoffAnchor,
  historyTerminalPreviewHandoffAction,
  historyTerminalPreviewHandoffScrollTop,
  captureHistoryTerminalPreviewHandoffAnchor,
  readHistoryTerminalPreviewReadingTop,
} from './historyTerminalPreviewHandoff.mjs';

const olderRow = { identity: 'entry:older-answer', top: -120, bottom: 1400 };
const capture = (overrides = {}) => historyTerminalPreviewHandoffAnchor({
  followBottom: false,
  viewportHeightPx: 1007,
  previewOffsetPx: 1619,
  previewHeightPx: 180,
  readingRows: [olderRow],
  ...overrides,
});

test('23:51 production: saving an off-screen preview does not scroll the older answer by -148px', () => {
  const anchor = capture({ bottomGapPx: 786 });
  const next = historyTerminalPreviewHandoffScrollTop({
    scrollTop: 299639, scrollHeight: 301555, clientHeight: 1007,
    // The old path chooses the canonical response at 1471 instead of the
    // unchanged older row. Its literal result was 299491 (-148px).
    targetOffsetPx: anchor.anchorKind === 'reading-row' ? olderRow.top : 1471,
    ...anchor,
  });
  assert.equal(next, 299639);
  assert.equal(anchor.anchorKind, 'reading-row');
  assert.equal(anchor.readingUnitKey, olderRow.identity);
  assert.equal(anchor.bottomGapPx, null);
});

test('a preview touching the bottom of the viewport does not steal the reading row in its centre', () => {
  const anchor = capture({ previewOffsetPx: 700, previewHeightPx: 400,
    readingRows: [{ ...olderRow, bottom: 650 }] });
  assert.equal(anchor.anchorKind, 'reading-row');
  assert.equal(anchor.anchorOffsetPx, olderRow.top);
});

test('reading inside a long live response preserves that response through canonical replacement', () => {
  const anchor = capture({ previewOffsetPx: -200, previewHeightPx: 2000, readingRows: [] });
  assert.equal(anchor.anchorKind, 'preview');
  assert.equal(anchor.anchorOffsetPx, -200);
  assert.equal(anchor.readingUnitKey, null);
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 10000, scrollHeight: 20000, clientHeight: 1007,
    targetOffsetPx: -270, ...anchor,
  }), 9930);
});

test('a preview entirely above the viewport does not own the visible row below it', () => {
  const anchor = capture({ previewOffsetPx: -700, previewHeightPx: 200 });
  assert.equal(anchor.anchorKind, 'reading-row');
});

test('an explicit tail reader follows the physical bottom without a row-top constraint', () => {
  const anchor = capture({ followBottom: true });
  assert.equal(anchor.anchorKind, 'tail');
  assert.equal(anchor.anchorOffsetPx, null);
  assert.equal(anchor.bottomGapPx, 0);
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 10000, scrollHeight: 14000, clientHeight: 1000,
    targetOffsetPx: -700, ...anchor,
  }), 13000);
});

test('unknown geometry neither follows the hidden response nor falls back to bottom-gap', () => {
  const anchor = capture({ previewOffsetPx: null, previewHeightPx: null,
    readingRows: [], bottomGapPx: 786 });
  assert.equal(anchor.anchorKind, 'stationary');
  assert.equal(anchor.anchorOffsetPx, null);
  assert.equal(anchor.bottomGapPx, null);
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 10000, scrollHeight: 14000, clientHeight: 1000,
    targetOffsetPx: null, ...anchor,
  }), 10000);
});

test('a missing target is not coordinate zero and cannot cause a blind compensation', () => {
  for (const value of [null, undefined, '', Number.NaN]) {
    assert.equal(historyTerminalPreviewHandoffScrollTop({
      scrollTop: 10000, scrollHeight: 20000, clientHeight: 1000,
      anchorKind: 'reading-row', anchorOffsetPx: 200, targetOffsetPx: value,
    }), 10000);
  }
});

test('reading elsewhere retires an exact preview without waiting for the off-screen canonical DOM', () => {
  for (const anchorKind of ['reading-row', 'stationary', 'tail']) {
    const handoff = { phase: 'waiting-row', anchorKind, followBottom: anchorKind === 'tail' };
    assert.equal(historyTerminalPreviewHandoffAction({
      handoff, ownsWrite: true, canonicalTarget: null,
      canonicalInPresentation: true, targetMounted: false,
    }), 'clear-preview');
    assert.equal(historyTerminalPreviewHandoffAction({
      handoff: { ...handoff, phase: 'clearing-preview' }, ownsWrite: true,
      canonicalInPresentation: true, targetMounted: false,
    }), 'start-settle');
  }
});

test('a visible preview still waits for its exact replacement row', () => {
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: { phase: 'waiting-row', anchorKind: 'preview', followBottom: false },
    ownsWrite: true, canonicalInPresentation: true,
    canonicalTarget: { unitIndex: 42 }, targetMounted: false,
  }), 'waiting-mounted-range');
});

test('scroll and presentation rebase can select another reader instead of preserving the old preview', () => {
  const before = capture({ previewOffsetPx: -200, previewHeightPx: 2000, readingRows: [] });
  const after = capture();
  assert.equal(before.anchorKind, 'preview');
  assert.equal(after.anchorKind, 'reading-row');
  const hidden = capture({ viewportHeightPx: 0, readingRows: [] });
  assert.equal(hidden.anchorKind, 'stationary');
  assert.equal(capture().anchorKind, 'reading-row');
});

test('committed row identity survives a changed virtual index without choosing a neighboring row', () => {
  let rowTop = 80;
  const row = { getAttribute: () => 'committed-reading-unit', closest: () => wrapper };
  const wrapper = { querySelector: () => row, getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 900 }) };
  const scroller = {
    isConnected: true, clientHeight: 500, contains: (node) => node === wrapper,
    getBoundingClientRect: () => ({ top: 100, bottom: 600 }),
    querySelectorAll: (selector) => selector === '[data-item-index]' ? [wrapper] : [row],
  };
  const snapshot = captureHistoryTerminalPreviewHandoffAnchor({
    scroller, previewNode: { getBoundingClientRect: () => ({ top: 1400, height: 300 }) },
  });
  assert.equal(snapshot.readingUnitKey, 'committed-reading-unit');
  assert.equal(snapshot.anchorOffsetPx, -20);
  rowTop = 120;
  assert.equal(readHistoryTerminalPreviewReadingTop(scroller, snapshot.readingUnitKey), 20);
  assert.equal(readHistoryTerminalPreviewReadingTop(scroller, 'missing-unit'), null);
});

test('hidden capture and explicit tail do not force geometry reads', () => {
  const cannotRead = { getBoundingClientRect: () => { throw new Error('unexpected geometry read'); } };
  assert.equal(captureHistoryTerminalPreviewHandoffAnchor({ scroller: null, previewNode: cannotRead }).anchorKind, 'stationary');
  assert.equal(captureHistoryTerminalPreviewHandoffAnchor({ scroller: cannotRead, previewNode: cannotRead, followBottom: true }).anchorKind, 'tail');
});
