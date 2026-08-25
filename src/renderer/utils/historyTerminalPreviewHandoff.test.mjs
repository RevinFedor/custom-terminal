import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_TERMINAL_PREVIEW_LIVE_LABEL,
  HISTORY_TERMINAL_PREVIEW_SYNC_LABEL,
  filterHistoryTerminalPreviewLiveDuplicate,
  historyTerminalPreviewHandoffAction,
  historyTerminalPreviewHandoffAnchor,
  historyTerminalPreviewHandoffOwnsWrite,
  historyTerminalPreviewHandoffScrollTop,
  historyTerminalPreviewHasNewUserGesture,
  historyTerminalPreviewStatusLabel,
  resolveHistoryTerminalPreviewCanonicalTarget,
} from './historyTerminalPreviewHandoff.mjs';

const handoff = {
  previewId: 'preview-1',
  canonicalIdentity: 'source:canonical',
  ownerKey: 'owner-a',
  ownerGeneration: 7,
  presentationVisit: 11,
  gestureGeneration: 3,
  phase: 'waiting-row',
};

test('preview label reflects durable proof without exposing transport details', () => {
  assert.equal(
    historyTerminalPreviewStatusLabel(),
    HISTORY_TERMINAL_PREVIEW_LIVE_LABEL,
  );
  assert.equal(
    historyTerminalPreviewStatusLabel({ canonicalMaterialized: true }),
    HISTORY_TERMINAL_PREVIEW_SYNC_LABEL,
  );
  assert.doesNotMatch(HISTORY_TERMINAL_PREVIEW_LIVE_LABEL, /terminal|jsonl|api/i);
  assert.doesNotMatch(HISTORY_TERMINAL_PREVIEW_SYNC_LABEL, /terminal|jsonl|api/i);
});

test('handoff ownership rejects stale owner, generation, visit and hidden presentation', () => {
  const current = {
    ownerKey: 'owner-a',
    ownerGeneration: 7,
    presentationVisit: 11,
    presented: true,
  };
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(handoff, current), true);
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(handoff, {
    ...current, ownerKey: 'owner-b',
  }), false);
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(handoff, {
    ...current, ownerGeneration: 8,
  }), false);
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(handoff, {
    ...current, presentationVisit: 12,
  }), false);
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(handoff, {
    ...current, presented: false,
  }), false);
});

test('only a physical post-handoff gesture may replace the saved viewport anchor', () => {
  const captured = { ...handoff, gestureGeneration: 22, gestureAt: 12_000 };
  assert.equal(historyTerminalPreviewHasNewUserGesture(captured, {
    gestureGeneration: 23,
    gestureAt: 12_000,
  }), false, 'a generation mismatch without newer input is not user ownership');
  assert.equal(historyTerminalPreviewHasNewUserGesture(captured, {
    gestureGeneration: 23,
    gestureAt: 12_001,
  }), true);
  assert.equal(historyTerminalPreviewHasNewUserGesture(captured, {
    gestureGeneration: 22,
    gestureAt: 12_000,
    pointerActive: true,
  }), true);
});

test('a tail reader follows the bottom instead of fighting to preserve a long row top', () => {
  assert.deepEqual(historyTerminalPreviewHandoffAnchor({
    followBottom: true,
    previewOffsetPx: 288,
    bottomGapPx: 173,
  }), {
    anchorOffsetPx: null,
    bottomGapPx: 0,
  });
  assert.deepEqual(historyTerminalPreviewHandoffAnchor({
    followBottom: false,
    previewOffsetPx: 401,
    bottomGapPx: 276,
  }), {
    anchorOffsetPx: 401,
    bottomGapPx: 276,
  });
});

test('pending preview suppresses only its exact live duplicate, never equal text', () => {
  const exact = { uuid: 'live-1', sourceIdentity: 'source:canonical', content: 'same' };
  const equalText = { uuid: 'live-2', sourceIdentity: 'source:other', content: 'same' };
  const source = [exact, equalText];
  assert.deepEqual(filterHistoryTerminalPreviewLiveDuplicate({
    liveEntries: source,
    canonicalIdentity: 'source:canonical',
    identitiesForEntry: (entry) => [entry.sourceIdentity],
  }), [equalText]);
  assert.equal(filterHistoryTerminalPreviewLiveDuplicate({
    liveEntries: source,
    canonicalIdentity: 'source:missing',
    identitiesForEntry: (entry) => [entry.sourceIdentity],
  }), source, 'no match preserves the original projection reference');
});

test('an absent canonical DOM row never expires the pending handoff', () => {
  for (let frame = 0; frame < 181; frame += 1) {
    assert.equal(historyTerminalPreviewHandoffAction({
      handoff,
      ownsWrite: true,
      canonicalTarget: { canonicalUuid: 'answer-1', unitIndex: 12 },
      targetMounted: false,
    }), 'waiting-mounted-range');
  }
  assert.equal(handoff.phase, 'waiting-row');
});

test('a tail reader may retire the Footer before the exact final row enters the DOM', () => {
  const tailHandoff = { ...handoff, followBottom: true, phase: 'waiting-row' };
  const canonicalTarget = { canonicalUuid: 'answer-1', unitIndex: 12 };
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: tailHandoff,
    ownsWrite: true,
    canonicalTarget,
    targetMounted: false,
  }), 'clear-preview');
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: { ...tailHandoff, phase: 'clearing-preview' },
    ownsWrite: true,
    canonicalTarget,
    targetMounted: false,
  }), 'start-settle');
});

test('an exact mounted row may replace the Footer before the deferred full History refresh', () => {
  const canonicalTarget = { canonicalUuid: 'answer-1', unitIndex: 12 };
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff,
    ownsWrite: true,
    canonicalTarget,
    targetMounted: true,
  }), 'clear-preview');
});

test('a late exact mounted range clears once and enters bounded anchor settlement once', () => {
  const canonicalTarget = { canonicalUuid: 'answer-1', unitIndex: 12 };
  let pending = handoff;
  let previewClears = 0;
  let settlements = 0;
  for (let signal = 0; signal < 4; signal += 1) {
    const action = historyTerminalPreviewHandoffAction({
      handoff: pending,
      ownsWrite: true,
      canonicalTarget,
      targetMounted: true,
    });
    if (action === 'clear-preview') {
      previewClears += 1;
      pending = { ...pending, phase: 'clearing-preview' };
    } else if (action === 'start-settle') {
      settlements += 1;
      pending = { ...pending, phase: 'settling-row' };
    }
  }
  assert.equal(previewClears, 1);
  assert.equal(settlements, 1);
  assert.equal(pending.phase, 'settling-row');
});

test('collapsed group resolves an exact member identity to its mounted unit row', () => {
  const first = { uuid: 'tool-1', sourceIdentity: 'source:tool-1' };
  const canonical = { uuid: 'tool-2', sourceIdentity: 'source:canonical' };
  const units = [{ kind: 'group', key: 'group-1', entries: [first, canonical] }];
  const target = resolveHistoryTerminalPreviewCanonicalTarget({
    canonicalIdentity: 'source:canonical',
    displayEntries: [first, canonical],
    displayUnits: units,
    unitIndexByUuid: new Map([['tool-1', 0], ['tool-2', 0]]),
    identitiesForEntry: (entry) => [entry.sourceIdentity],
  });
  assert.deepEqual(target, {
    canonicalUuid: 'tool-2',
    unitIndex: 0,
    domUuid: 'tool-1',
    groupKey: 'group-1',
    presentationKind: 'group',
  });
});

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
