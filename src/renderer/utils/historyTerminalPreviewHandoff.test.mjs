import test from 'node:test';
import assert from 'node:assert/strict';
import { historyTerminalPreviewHandoffScrollTop } from './historyTerminalPreviewHandoff.mjs';

test('canonical row takes the exact viewport offset previously occupied by preview', () => {
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 10_000,
    scrollHeight: 20_000,
    clientHeight: 1_000,
    targetOffsetPx: 600,
    anchorOffsetPx: -200,
  }), 10_800);
});

test('second pre-paint pass repairs drift caused by removing the Footer', () => {
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 10_800,
    scrollHeight: 18_500,
    clientHeight: 1_000,
    targetOffsetPx: -260,
    anchorOffsetPx: -200,
  }), 10_740);
});

test('bottom-gap fallback remains bounded when a row is near the tail', () => {
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 8_700,
    scrollHeight: 10_000,
    clientHeight: 1_000,
    bottomGapPx: 300,
  }), 8_700);
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    scrollTop: 8_700,
    scrollHeight: 700,
    clientHeight: 1_000,
    bottomGapPx: 300,
  }), 0);
});
