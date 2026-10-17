import test from 'node:test';
import assert from 'node:assert/strict';
import { historyLivePresentationIdentities } from './historyLiveProjection.mjs';
import {
  HISTORY_TERMINAL_PREVIEW_LIVE_LABEL,
  HISTORY_TERMINAL_PREVIEW_SYNC_LABEL,
  HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL,
  filterHistoryTerminalPreviewLiveDuplicate,
  historyTerminalPreviewHandoffAction,
  historyTerminalPreviewHandoffAnchor,
  historyTerminalPreviewHandoffOwnsWrite,
  historyTerminalPreviewHandoffScrollTop,
  historyTerminalPreviewHasNewUserGesture,
  historyTerminalPreviewHasCanonicalIdentity,
  historyTerminalPreviewStatusLabel,
  historyTerminalPreviewHandoffRebaseVerdict,
  historyTerminalPreviewHandoffCoversPreview,
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

test('renderer epoch replacement needs exact canonical data/hash before a new scoped handoff', () => {
  const pending = { ...handoff, phase: 'waiting-row', canonicalIdentity: 'codex-assistant-source-S-829539335',
    canonicalTextHash: '7c340ad9cfc2', previewItemIds: ['item617'] };
  const proof = { previewId: pending.previewId, ownerKey: pending.ownerKey,
    ownerGeneration: 9, presentationVisit: 12, presented: true,
    canonicalInPresentation: true, canonicalTextHash: pending.canonicalTextHash };
  assert.equal(historyTerminalPreviewHandoffRebaseVerdict(pending, proof), 'rebase');
  assert.equal(historyTerminalPreviewHandoffOwnsWrite(pending, proof), false,
    'proof must not grant write authority to the OLD epoch');
  assert.equal(historyTerminalPreviewHandoffOwnsWrite({ ...pending, ownerGeneration: 9, presentationVisit: 12 }, proof), true);
  for (const [patch, reason] of [
    [{ ownerKey: 'other-session' }, 'foreign-owner'],
    [{ previewId: 'other-preview' }, 'foreign-preview'],
    [{ presented: false }, 'hidden'],
    [{ canonicalInPresentation: false }, 'waiting-canonical'],
    [{ canonicalTextHash: 'changed-offset-body' }, 'waiting-canonical-integrity'],
  ]) assert.equal(historyTerminalPreviewHandoffRebaseVerdict(pending, { ...proof, ...patch }), reason);
  assert.equal(historyTerminalPreviewHandoffRebaseVerdict({ ...pending, canonicalTextHash: null }, proof), 'waiting-canonical-integrity');
});

test('ordinary handoff and post-Footer geometry keep their original current scope', () => {
  const scope = { previewId: handoff.previewId, ownerKey: handoff.ownerKey,
    ownerGeneration: handoff.ownerGeneration, presentationVisit: handoff.presentationVisit };
  assert.equal(historyTerminalPreviewHandoffRebaseVerdict(handoff, scope), 'current');
  assert.equal(historyTerminalPreviewHandoffRebaseVerdict({ ...handoff, phase: 'clearing-preview' }, { ...scope, previewId: '' }), 'current');
  assert.equal(historyTerminalPreviewHandoffRebaseVerdict({ ...handoff, phase: 'waiting-row' }, { ...scope, previewId: '' }), 'foreign-preview');
});

test('canonical617 proof cannot own new/unknown response items of the same turn', () => {
  const pending = { ...handoff, previewItemIds: ['saved617'] };
  const preview = { previewId: pending.previewId, responseSegments: [{ itemId: 'saved617' }] };
  assert.equal(historyTerminalPreviewHandoffCoversPreview(pending, preview), true);
  assert.equal(historyTerminalPreviewHandoffCoversPreview(pending, { ...preview,
    responseSegments: [{ itemId: 'unknown245' }, { itemId: 'next-live' }] }), false);
  assert.equal(historyTerminalPreviewHandoffCoversPreview(pending, { ...preview, previewId: 'other-turn' }), false);
});

test('native Claude canonical UUID retires its exact commentary preview across live and durable carriers', () => {
  // Actual H1 failure, Claude 2.1.261. Main clear carries the raw JSONL UUID;
  // History's stable live key wraps it in assistant-uuid:.
  const uuid = 'a48cac1c-5f58-4d3b-b502-20559ef7ef2d';
  const entry = { uuid, role: 'assistant', content: 'Testing the command execution flow.' };
  const target = resolveHistoryTerminalPreviewCanonicalTarget({
    canonicalIdentity: uuid, displayEntries: [entry], displayUnits: [{ kind: 'entry', entry }],
    unitIndexByUuid: new Map([[uuid, 0]]), identitiesForEntry: historyLivePresentationIdentities,
  });
  assert.equal(target?.canonicalUuid, uuid);
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: { ...handoff, canonicalIdentity: uuid, followBottom: true },
    ownsWrite: true, canonicalTarget: target, targetMounted: true,
  }), 'clear-preview');
  const live = { ...entry, uuid: 'live-commentary', sourceIdentity: 'assistant-uuid:' + uuid };
  const unrelated = { ...entry, uuid: 'other', sourceIdentity: 'assistant-uuid:other' };
  assert.deepEqual(filterHistoryTerminalPreviewLiveDuplicate({
    liveEntries: [live, unrelated], canonicalIdentity: uuid,
    identitiesForEntry: historyLivePresentationIdentities,
  }), [unrelated], 'identical text is not identity; only this exact live carrier is retired');
});

test('native identity adaptation preserves opaque source aliases and never uses equal text or user UUIDs', () => {
  const uuid = 'a48cac1c-5f58-4d3b-b502-20559ef7ef2d';
  const matches = (entry, id) => historyTerminalPreviewHasCanonicalIdentity(entry, id, historyLivePresentationIdentities);
  assert.equal(matches({ role: 'assistant', uuid }, uuid), true);
  assert.equal(matches({ role: 'assistant', uuid }, 'assistant-uuid:' + uuid), true);
  assert.equal(matches({ role: 'assistant', uuid: 'different', sourceIdentity: uuid }, uuid), true);
  assert.equal(matches({ role: 'assistant', uuid: 'different', sourceIdentity: 'codex-assistant-source:42' }, 'codex-assistant-source:42'), true);
  assert.equal(matches({ role: 'user', uuid }, uuid), false);
  assert.equal(matches({ role: 'assistant', uuid: 'other', content: 'same' }, uuid), false);
  assert.equal(matches({ role: 'assistant', uuid }, ''), false);
});

test('raw canonical UUID inside a collapsed group resolves to its visible group header', () => {
  const first = { uuid: 'group-head', role: 'assistant', content: 'first' };
  const canonical = { uuid: 'a48cac1c-5f58-4d3b-b502-20559ef7ef2d', role: 'assistant', content: 'second' };
  const target = resolveHistoryTerminalPreviewCanonicalTarget({
    canonicalIdentity: canonical.uuid, displayEntries: [first, canonical],
    displayUnits: [{ kind: 'group', key: 'G', entries: [first, canonical] }],
    unitIndexByUuid: new Map([[first.uuid, 0], [canonical.uuid, 0]]),
    identitiesForEntry: historyLivePresentationIdentities,
  });
  assert.equal(target?.domUuid, 'group-head');
  assert.equal(historyTerminalPreviewHandoffAction({ handoff: { ...handoff, followBottom: false },
    ownsWrite: true, canonicalTarget: target, targetMounted: false }), 'waiting-mounted-range');
});

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
  assert.equal(historyTerminalPreviewStatusLabel({ phase: 'settled' }),
    HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL);
  assert.equal(historyTerminalPreviewStatusLabel({ deliveryState: 'unknown' }),
    HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL);
  assert.equal(historyTerminalPreviewStatusLabel({ phase: 'settled', canonicalMaterialized: true }),
    HISTORY_TERMINAL_PREVIEW_SYNC_LABEL);
  assert.equal(historyTerminalPreviewStatusLabel({ phase: 'streaming', deliveryState: 'saved' }),
    HISTORY_TERMINAL_PREVIEW_SYNC_LABEL, 'canonical held for presentation is not ongoing generation');
  assert.doesNotMatch(HISTORY_TERMINAL_PREVIEW_UNCONFIRMED_LABEL, /live|saved|terminal|jsonl|api/i);
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
    anchorKind: 'tail', readingUnitKey: null,
    anchorOffsetPx: null,
    bottomGapPx: 0,
  });
  assert.deepEqual(historyTerminalPreviewHandoffAnchor({
    followBottom: false,
    previewOffsetPx: 401,
    previewHeightPx: 500,
    viewportHeightPx: 1000,
  }), {
    anchorKind: 'preview', readingUnitKey: null,
    anchorOffsetPx: 401,
    bottomGapPx: null,
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

  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: tailHandoff,
    ownsWrite: true,
    canonicalTarget: null,
    canonicalInPresentation: true,
    targetMounted: false,
  }), 'clear-preview', 'the exact tail projection does not depend on a unit-map/DOM race');
  assert.equal(historyTerminalPreviewHandoffAction({
    handoff: tailHandoff,
    ownsWrite: true,
    canonicalTarget: null,
    canonicalInPresentation: false,
    targetMounted: false,
  }), 'waiting-canonical', 'a tail still needs exact durable presentation proof');
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
    anchorKind: 'preview',
    scrollTop: 10_000,
    scrollHeight: 20_000,
    clientHeight: 1_000,
    targetOffsetPx: 600,
    anchorOffsetPx: -200,
  }), 10_800);
});

test('second pre-paint pass repairs drift caused by removing the Footer', () => {
  assert.equal(historyTerminalPreviewHandoffScrollTop({
    anchorKind: 'preview',
    scrollTop: 10_800,
    scrollHeight: 18_500,
    clientHeight: 1_000,
    targetOffsetPx: -260,
    anchorOffsetPx: -200,
  }), 10_740);
});

test('unknown anchor holds the current position and accepts a genuinely shorter document', () => {
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
