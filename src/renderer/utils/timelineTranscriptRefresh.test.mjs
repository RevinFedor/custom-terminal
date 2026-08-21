import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeTimelineEntriesWithSentHandoffs,
  matchesHistorySurfacePresented,
  planTimelineTranscriptRefresh,
  projectTimelineSentHandoff,
  recordHistorySurfacePresented,
  readPresentedHistorySurface,
  retireDetachedTimelineSentHandoffs,
  upsertTimelineSentHandoffEntries,
  __resetPresentedHistorySurfacesForTest,
} from './timelineTranscriptRefresh.mjs';

function sentHandoff(overrides = {}) {
  return {
    handoffId: 'handoff-a',
    toolType: 'codex',
    sessionIdHint: 'session-a',
    queueStatus: 'sent',
    submittedAt: Date.parse('2026-08-18T22:08:25.131Z'),
    text: '<saved_prompt name="FULL документация">full body</saved_prompt>',
    source: 'history-panel',
    imagePaths: [],
    auditProof: {
      sessionId: 'session-a',
      entryUuid: 'codex-user-session-a-687',
      sourceIdentity: 'codex-user-source-session-a-2232297',
      auditTimestamp: '2026-08-18T22:08:26.286Z',
      actualHash: 'exact-hash',
    },
    ...overrides,
  };
}

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

test('records and replays the last presented surface per tab', () => {
  __resetPresentedHistorySurfacesForTest();
  recordHistorySurfacePresented({
    tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', proof: 'mounted-painted-row',
  });
  const hit = readPresentedHistorySurface({ tabId: 'tab-1', sessionId: 's-1', toolType: 'claude' });
  assert.equal(hit?.proof, 'mounted-painted-row');
  // Identity mismatch (stale session) must NOT replay.
  assert.equal(
    readPresentedHistorySurface({ tabId: 'tab-1', sessionId: 's-2', toolType: 'claude' }),
    null,
  );
  // Unknown tab → nothing.
  assert.equal(
    readPresentedHistorySurface({ tabId: 'tab-2', sessionId: 's-1', toolType: 'claude' }),
    null,
  );
});

test('a newer presentation for the same tab overwrites the old record', () => {
  __resetPresentedHistorySurfacesForTest();
  recordHistorySurfacePresented({ tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', proof: 'a' });
  recordHistorySurfacePresented({ tabId: 'tab-1', sessionId: 's-9', toolType: 'codex', proof: 'b' });
  assert.equal(readPresentedHistorySurface({ tabId: 'tab-1', sessionId: 's-1', toolType: 'claude' }), null);
  assert.equal(
    readPresentedHistorySurface({ tabId: 'tab-1', sessionId: 's-9', toolType: 'codex' })?.proof,
    'b',
  );
});

test('exact SENT handoff projects one lightweight addressable Timeline point while busy', () => {
  const point = projectTimelineSentHandoff(sentHandoff({
    text: 'x'.repeat(70_000),
    imagePaths: [{ id: 1, path: '/tmp/image.png' }],
  }), { toolType: 'codex', sessionId: 'session-a' });
  assert.equal(point.uuid, 'codex-user-session-a-687');
  assert.equal(point.sourceIdentity, 'codex-user-source-session-a-2232297');
  assert.equal(point.handoffId, 'handoff-a');
  assert.equal(point.hasImage, true);
  assert.ok(point.content.length < 2_100);
});

test('queue intent, wrong owner, and receipts without canonical UUID never mint a point', () => {
  assert.equal(projectTimelineSentHandoff(sentHandoff({ queueStatus: 'queued' }), {
    toolType: 'codex', sessionId: 'session-a',
  }), null);
  assert.equal(projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-b',
  }), null);
  assert.equal(projectTimelineSentHandoff(sentHandoff({
    auditProof: {
      sessionId: 'session-a',
      sourceIdentity: 'source-only',
      auditTimestamp: '2026-08-18T22:08:26.286Z',
      actualHash: 'exact-hash',
    },
  }), { toolType: 'codex', sessionId: 'session-a' }), null);
});

test('canonical UUID or source alias replaces the light point without fuzzy text matching', () => {
  const responsePoint = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const promotedCanonical = {
    uuid: 'codex-user-session-a-690',
    sourceIdentity: 'codex-user-source-session-a-2232400',
    sourceIdentityAliases: ['codex-user-source-session-a-2232297'],
    type: 'user',
    timestamp: '2026-08-18T22:08:26.300Z',
    content: 'canonical body',
  };
  assert.deepEqual(
    mergeTimelineEntriesWithSentHandoffs([promotedCanonical], [responsePoint]),
    [promotedCanonical],
  );

  const sameTextDifferentIdentity = {
    ...promotedCanonical,
    uuid: 'different-user',
    sourceIdentity: 'different-source',
    sourceIdentityAliases: [],
    content: responsePoint.content,
  };
  assert.equal(
    mergeTimelineEntriesWithSentHandoffs([sameTextDifferentIdentity], [responsePoint]).length,
    2,
  );
});

test('byte-identical consecutive sends keep distinct handoff identities', () => {
  const first = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const second = projectTimelineSentHandoff(sentHandoff({
    handoffId: 'handoff-b',
    auditProof: {
      ...sentHandoff().auditProof,
      entryUuid: 'codex-user-session-a-688',
      sourceIdentity: 'codex-user-source-session-a-2232399',
    },
  }), { toolType: 'codex', sessionId: 'session-a' });
  assert.deepEqual(
    upsertTimelineSentHandoffEntries([], [first, second]).map((entry) => entry.handoffId),
    ['handoff-a', 'handoff-b'],
  );
});

test('Loop uses the same SENT projection and keeps its semantic origin tag', () => {
  const point = projectTimelineSentHandoff(sentHandoff({ source: 'prompt-loop' }), {
    toolType: 'codex', sessionId: 'session-a',
  });
  assert.deepEqual(point.semanticTags, [{ kind: 'prompt-origin', source: 'loop' }]);
});

test('точка «отправлено», которую разговор обогнал на два хода, снимается', () => {
  // Запись ушла с активной ветки (rewind / компакт / правка истории). Опознать
  // её нечем никогда, а по такой точке нельзя ни скопировать, ни выделить: все
  // действия ищут запись по идентификатору ВНУТРИ ветки и молча не находят.
  const point = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const laterPrompt = (uuid, iso) => ({
    uuid, type: 'user', timestamp: iso, content: 'later',
  });

  // Один более поздний запрос — ещё гонка: расшифровку могли просто не успеть
  // перечитать, и снимать точку рано.
  assert.equal(
    retireDetachedTimelineSentHandoffs(
      [laterPrompt('later-1', '2026-08-18T22:09:00.000Z')],
      [point],
    ).length,
    1,
  );

  // Два — разговор демонстративно ушёл дальше без неё.
  assert.equal(
    retireDetachedTimelineSentHandoffs(
      [
        laterPrompt('later-1', '2026-08-18T22:09:00.000Z'),
        laterPrompt('later-2', '2026-08-18T22:10:00.000Z'),
      ],
      [point],
    ).length,
    0,
  );

  // Ветка ПЕРЕД точкой ничего не доказывает: свежая отправка всегда новее всего,
  // что уже записано.
  assert.equal(
    retireDetachedTimelineSentHandoffs(
      [
        laterPrompt('older-1', '2026-08-18T22:00:00.000Z'),
        laterPrompt('older-2', '2026-08-18T22:01:00.000Z'),
      ],
      [point],
    ).length,
    1,
  );

  // Нечитаемое время — не судим: убрать доставленную точку хуже, чем подержать
  // лишнюю.
  assert.equal(
    retireDetachedTimelineSentHandoffs(
      [
        laterPrompt('later-1', '2026-08-18T22:09:00.000Z'),
        laterPrompt('later-2', '2026-08-18T22:10:00.000Z'),
      ],
      [{ ...point, timestamp: 'не дата' }],
    ).length,
    1,
  );
});

test('обогнанная точка не доживает до ленты, а живая — доживает', () => {
  const point = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const prompt = (uuid, iso) => ({ uuid, type: 'user', timestamp: iso, content: 'later' });

  assert.deepEqual(
    mergeTimelineEntriesWithSentHandoffs(
      [
        prompt('later-1', '2026-08-18T22:09:00.000Z'),
        prompt('later-2', '2026-08-18T22:10:00.000Z'),
      ],
      [point],
    ).map((entry) => entry.uuid),
    ['later-1', 'later-2'],
  );

  // Ровно один ход вперёд — точка ещё в ленте (иначе исчезала бы нормальная
  // отправка, пока расшифровка догоняет).
  assert.equal(
    mergeTimelineEntriesWithSentHandoffs(
      [prompt('later-1', '2026-08-18T22:09:00.000Z')],
      [point],
    ).length,
    2,
  );
});
