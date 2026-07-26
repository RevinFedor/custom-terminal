import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesHistorySurfacePresented,
  planTimelineTranscriptRefresh,
} from './timelineTranscriptRefresh.mjs';

test('hidden Timeline retains invalidation until Project Home closes', () => {
  const hidden = planTimelineTranscriptRefresh({
    invalidation: true,
    documentVisible: true,
    surfaceVisible: false,
  });
  assert.deepEqual(hidden, { pending: true, refresh: false });

  const stillHidden = planTimelineTranscriptRefresh({
    pending: hidden.pending,
    documentVisible: true,
    surfaceVisible: false,
  });
  assert.deepEqual(stillHidden, { pending: true, refresh: false });

  const returned = planTimelineTranscriptRefresh({
    pending: stillHidden.pending,
    documentVisible: true,
    surfaceVisible: true,
  });
  assert.deepEqual(returned, { pending: false, refresh: true });
});

test('busy invalidation remains pending until both turn and surface are ready', () => {
  const busy = planTimelineTranscriptRefresh({
    invalidation: true,
    isTurnBusy: true,
    documentVisible: true,
    surfaceVisible: true,
  });
  assert.deepEqual(busy, { pending: true, refresh: false });

  const settledUnderHome = planTimelineTranscriptRefresh({
    pending: busy.pending,
    isTurnBusy: false,
    documentVisible: true,
    surfaceVisible: false,
  });
  assert.deepEqual(settledUnderHome, { pending: true, refresh: false });

  assert.deepEqual(planTimelineTranscriptRefresh({
    pending: settledUnderHome.pending,
    isTurnBusy: false,
    documentVisible: true,
    surfaceVisible: true,
  }), { pending: false, refresh: true });
});

test('History presentation gate accepts only the exact Timeline owner', () => {
  const expected = {
    tabId: 'tab-b',
    sessionId: 'session-b',
    toolType: 'codex',
  };
  assert.equal(matchesHistorySurfacePresented({
    ...expected,
    detail: { ...expected, proof: 'mounted-painted-row' },
  }), true);
  assert.equal(matchesHistorySurfacePresented({
    ...expected,
    detail: { ...expected, tabId: 'tab-a' },
  }), false);
  assert.equal(matchesHistorySurfacePresented({
    ...expected,
    detail: { ...expected, sessionId: 'session-a' },
  }), false);
  assert.equal(matchesHistorySurfacePresented({
    ...expected,
    detail: { ...expected, toolType: 'claude' },
  }), false);
});

test('History presentation gate normalizes an absent session id to null', () => {
  assert.equal(matchesHistorySurfacePresented({
    tabId: 'tab-a',
    sessionId: null,
    toolType: 'claude',
    detail: {
      tabId: 'tab-a',
      sessionId: undefined,
      toolType: 'claude',
    },
  }), true);
});
