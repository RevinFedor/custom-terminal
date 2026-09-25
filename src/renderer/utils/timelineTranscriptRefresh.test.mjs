import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeTimelineEntriesWithSentHandoffs,
  historyNavigationIdentityForTimelineEntry,
  matchesHistorySurfacePresented,
  planTimelineTranscriptRefresh,
  projectTimelineLiveUserMessage,
  projectTimelineSentHandoff,
  recordHistorySurfacePresented,
  readPresentedHistorySurface,
  retireDetachedTimelineSentHandoffs,
  upsertTimelineLiveUserEntries,
  upsertTimelineSentHandoffEntries,
  __resetPresentedHistorySurfacesForTest,
} from './timelineTranscriptRefresh.mjs';

test('live Timeline point navigates by durable source identity while normal rows keep UUID', () => {
  assert.equal(historyNavigationIdentityForTimelineEntry({
    uuid: 'codex-live-temporary-user',
    sourceIdentity: 'codex-user-source-session-14104533',
    isLiveUserProjection: true,
  }), 'codex-user-source-session-14104533');
  assert.equal(historyNavigationIdentityForTimelineEntry({
    uuid: 'codex-user-session-1897',
    sourceIdentity: 'codex-user-source-session-14104533',
  }), 'codex-user-session-1897');
});

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
    ownerKey: 'history-owner-b',
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
  assert.equal(matchesHistorySurfacePresented({
    ...expected,
    detail: { ...expected, ownerKey: 'history-owner-a' },
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
      ownerKey: 'history-owner-a',
    },
    ownerKey: 'history-owner-a',
  }), true);
});

test('records and replays the last presented surface per tab', () => {
  __resetPresentedHistorySurfacesForTest();
  recordHistorySurfacePresented({
    tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-a',
    proof: 'mounted-painted-row',
  });
  const hit = readPresentedHistorySurface({
    tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-a',
  });
  assert.equal(hit?.proof, 'mounted-painted-row');
  assert.equal(
    readPresentedHistorySurface({
      tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-b',
    }),
    null,
  );
  // Identity mismatch (stale session) must NOT replay.
  assert.equal(
    readPresentedHistorySurface({
      tabId: 'tab-1', sessionId: 's-2', toolType: 'claude', ownerKey: 'history-owner-a',
    }),
    null,
  );
  // Unknown tab → nothing.
  assert.equal(
    readPresentedHistorySurface({
      tabId: 'tab-2', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-a',
    }),
    null,
  );
});

test('a newer presentation for the same tab overwrites the old record', () => {
  __resetPresentedHistorySurfacesForTest();
  recordHistorySurfacePresented({
    tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-a', proof: 'a',
  });
  recordHistorySurfacePresented({
    tabId: 'tab-1', sessionId: 's-9', toolType: 'codex', ownerKey: 'history-owner-b', proof: 'b',
  });
  assert.equal(readPresentedHistorySurface({
    tabId: 'tab-1', sessionId: 's-1', toolType: 'claude', ownerKey: 'history-owner-a',
  }), null);
  assert.equal(
    readPresentedHistorySurface({
      tabId: 'tab-1', sessionId: 's-9', toolType: 'codex', ownerKey: 'history-owner-b',
    })?.proof,
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

test('manual terminal user carrier projects an immediately addressable Timeline point while busy', () => {
  const liveEnvelope = (uuid, sourceIdentity, text = 'manual prompt') => ({
    tabId: 'tab-a',
    toolType: 'codex',
    sessionId: 'session-a',
    timestamp: '2026-08-26T00:19:15.982Z',
    recordByteOffset: 14_155_386,
    message: {
      type: 'user',
      uuid,
      sourceIdentity,
      sessionId: 'session-a',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  });
  const point = projectTimelineLiveUserMessage(
    liveEnvelope('codex-user-session-a-372', 'codex-user-source-session-a-14155386'),
    { toolType: 'codex', sessionId: 'session-a' },
  );
  assert.equal(point.uuid, 'codex-user-session-a-372');
  assert.equal(point.sourceIdentity, 'codex-user-source-session-a-14155386');
  assert.equal(point.content, 'manual prompt');
  assert.equal(point.isLiveUserProjection, true);
  assert.equal(point.isSentHandoffProjection, true);

  assert.equal(projectTimelineLiveUserMessage(
    liveEnvelope('codex-user-session-a-372', 'codex-user-source-session-a-14155386'),
    { toolType: 'codex', sessionId: 'other-session' },
  ), null);
  assert.equal(projectTimelineLiveUserMessage({
    ...liveEnvelope('assistant-row', 'assistant-source'),
    message: { type: 'assistant', uuid: 'assistant-row' },
  }, { toolType: 'codex', sessionId: 'session-a' }), null);

  const projectInstructions = liveEnvelope(
    'codex-user-session-a-agents',
    'codex-user-source-session-a-agents',
    '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>safe</INSTRUCTIONS>',
  );
  projectInstructions.message.serviceCarrier = 'project-instructions';
  assert.equal(
    projectTimelineLiveUserMessage(
      projectInstructions,
      { toolType: 'codex', sessionId: 'session-a' },
    ),
    null,
    'provider-owned project instructions never become a Timeline target',
  );

  const interruptedCarrier = liveEnvelope(
    'codex-user-session-a-aborted',
    'codex-user-source-session-a-aborted',
    '<turn_aborted>The user interrupted the previous turn.</turn_aborted>',
  );
  interruptedCarrier.message.serviceCarrier = 'turn-aborted';
  assert.equal(
    projectTimelineLiveUserMessage(
      interruptedCarrier,
      { toolType: 'codex', sessionId: 'session-a' },
    ),
    null,
    'the interruption boundary is a History status, not a Timeline prompt',
  );

  const literalMention = projectTimelineLiveUserMessage(
    liveEnvelope(
      'codex-user-session-a-literal',
      'codex-user-source-session-a-literal',
      'Why did # AGENTS.md instructions appear?',
    ),
    { toolType: 'codex', sessionId: 'session-a' },
  );
  assert.equal(literalMention?.uuid, 'codex-user-session-a-literal');

  const second = projectTimelineLiveUserMessage(
    liveEnvelope('codex-user-session-a-373', 'codex-user-source-session-a-14156000'),
    { toolType: 'codex', sessionId: 'session-a' },
  );
  assert.equal(
    upsertTimelineLiveUserEntries([], [point, second]).length,
    2,
    'byte-identical manual prompts retain distinct exact identities',
  );

  const responsePoint = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const canonicalLive = projectTimelineLiveUserMessage({
    ...liveEnvelope(
      'codex-user-session-a-690',
      'codex-user-source-session-a-2232400',
    ),
    message: {
      ...liveEnvelope('unused', 'unused').message,
      type: 'user',
      uuid: 'codex-user-session-a-690',
      sourceIdentity: 'codex-user-source-session-a-2232400',
      sourceIdentityAliases: ['codex-user-source-session-a-2232297'],
    },
  }, { toolType: 'codex', sessionId: 'session-a' });
  assert.deepEqual(
    upsertTimelineLiveUserEntries([responsePoint], [canonicalLive]).map((entry) => entry.uuid),
    ['codex-user-session-a-690'],
    'canonical live carrier replaces the response-carrier SENT point by exact alias',
  );

  const canonical = {
    uuid: 'codex-user-session-a-400',
    sourceIdentity: 'codex-user-source-session-a-14157000',
    sourceIdentityAliases: ['codex-user-source-session-a-14155386'],
    type: 'user',
    timestamp: '2026-08-26T00:19:15.982Z',
    content: 'manual prompt',
  };
  assert.deepEqual(
    mergeTimelineEntriesWithSentHandoffs([canonical], [], [point]),
    [canonical],
    'the durable canonical row adopts the live point by source alias',
  );
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

test('audited browser completion stays purple until its durable Timeline row arrives', () => {
  const runId = 'd9bb5fe6-13b3-4ece-9c57-2df3bcb7e35e';
  const point = projectTimelineSentHandoff(sentHandoff({
    handoffId: `orchestration-complete:${runId}`,
    source: `codex-orchestration-completion:${runId}`,
    text: `[Оркестрация] Запрос завершён.\nrunId: ${runId}`,
  }), { toolType: 'codex', sessionId: 'session-a' });
  assert.deepEqual(point.semanticTags, [{ kind: 'orchestration', runId, phase: 'unknown' }]);

  const live = { ...point, handoffId: 'live-user:exact', isLiveUserProjection: true, semanticTags: undefined };
  const [busyPoint] = mergeTimelineEntriesWithSentHandoffs([], [point], [live]);
  assert.deepEqual(busyPoint.semanticTags, point.semanticTags);

  const durable = { ...busyPoint, isSentHandoffProjection: false, isLiveUserProjection: false,
    semanticTags: [{ kind: 'orchestration', runId, phase: 'completion' }] };
  assert.deepEqual(mergeTimelineEntriesWithSentHandoffs([durable], [point], [live]), [durable]);

  const staleDurable = { ...durable, semanticTags: undefined };
  const [decorated] = mergeTimelineEntriesWithSentHandoffs([staleDurable], [point], [live]);
  assert.equal(decorated.uuid, durable.uuid);
  assert.deepEqual(decorated.semanticTags, point.semanticTags);
  assert.deepEqual(staleDurable.semanticTags, undefined, 'cached transcript row is not mutated');

  const unrelated = { ...staleDurable, uuid: 'another-user', sourceIdentity: 'another-source' };
  assert.equal(mergeTimelineEntriesWithSentHandoffs([unrelated], [point], [live])[0].semanticTags, undefined);
});

test('orchestration SENT point requires a matching app-owned source and handoff', () => {
  const request = projectTimelineSentHandoff(sentHandoff({
    handoffId: 'orchestration:run-a', source: 'codex-orchestration:source-tab',
  }), { toolType: 'codex', sessionId: 'session-a' });
  assert.deepEqual(request.semanticTags, [{ kind: 'orchestration', runId: 'run-a', phase: 'request' }]);

  for (const source of ['history-panel', 'codex-orchestration-completion:run-b']) {
    const unrelated = projectTimelineSentHandoff(sentHandoff({
      handoffId: 'orchestration-complete:run-a', source,
      text: '[Оркестрация] Запрос завершён. runId: run-a',
    }), { toolType: 'codex', sessionId: 'session-a' });
    assert.equal(unrelated.semanticTags, undefined);
  }
});

test('system SENT projection uses a source tag, not a fake orchestration run', () => {
  for (const source of ['build-install-return', 'codex-capacity-retry']) {
    const point = projectTimelineSentHandoff(sentHandoff({ source }), {
      toolType: 'codex', sessionId: 'session-a',
    });
    assert.deepEqual(point.semanticTags, [{ kind: 'prompt-origin', source: 'system', systemSource: source }]);
  }
  const ordinary = projectTimelineSentHandoff(sentHandoff({
    source: 'history-panel', text: 'build-install-return continue [Оркестрация]',
  }), { toolType: 'codex', sessionId: 'session-a' });
  assert.equal(ordinary.semanticTags, undefined);
});

test('late live carrier preserves system origin only when its exact identity matches the handoff', () => {
  const point = projectTimelineSentHandoff(sentHandoff({ source: 'codex-capacity-retry' }), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const live = { ...point, handoffId: 'live-user:exact', isLiveUserProjection: true, semanticTags: undefined };
  const [merged] = mergeTimelineEntriesWithSentHandoffs([], [point], [live]);
  assert.equal(merged.uuid, point.uuid);
  assert.deepEqual(merged.semanticTags, point.semanticTags);
  const quoted = { ...live, uuid: 'quoted-user', sourceIdentity: 'quoted-source' };
  const entries = mergeTimelineEntriesWithSentHandoffs([], [point], [quoted]);
  assert.equal(entries.length, 2);
  assert.equal(entries.find(entry => entry.uuid === quoted.uuid).semanticTags, undefined);
});

test('automatic system continuations do not count as two new human work prompts', () => {
  const point = projectTimelineSentHandoff(sentHandoff(), {
    toolType: 'codex', sessionId: 'session-a',
  });
  const service = [1, 2].map(n => ({ uuid: `retry-${n}`, type: 'user', content: 'continue',
    timestamp: `2026-08-18T22:09:0${n}.000Z`,
    semanticTags: [{ kind: 'prompt-origin', source: 'system', systemSource: 'codex-capacity-retry' }],
  }));
  assert.deepEqual(retireDetachedTimelineSentHandoffs(service, [point]), [point]);
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
