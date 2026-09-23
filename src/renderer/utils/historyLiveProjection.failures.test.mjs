import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryLivePresentation,
  historyLivePresentationIdentities,
  historyLivePresentationKey,
  reconcileCommittedHistoryLiveProjection,
  reduceHistoryLiveProjection,
} from './historyLiveProjection.mjs';

const message = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const failureEvent = (uuid, kind = 'provider-error', sessionId = 'claude-a') => ({
  type: 'message', toolType: 'claude', sessionId, recordByteOffset: 100,
  message: {
    uuid, sessionId, type: 'assistant', isApiErrorMessage: true,
    timestamp: '2026-09-22T17:41:59.011Z',
    ...(kind === 'usage-limit' ? { error: 'rate_limit', apiErrorStatus: 429 } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: message }] },
  },
});

for (const kind of ['provider-error', 'usage-limit']) {
  test(kind + ': live -> durable preserves one physical row and its existing render key', () => {
    const event = failureEvent('error-1', kind);
    const live = reduceHistoryLiveProjection([], event);
    assert.equal(live.length, 1);
    assert.equal(live[0].role, kind);
    const before = buildHistoryLivePresentation([], live);
    assert.equal(before.length, 1, 'error is visible before the full snapshot arrives');
    const durable = [{ ...live[0] }];
    assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
    assert.equal(historyLivePresentationKey(durable[0]), historyLivePresentationKey(live[0]));
    const committed = reconcileCommittedHistoryLiveProjection(live, durable);
    assert.equal(committed.entries.length, 0);
    const replay = reduceHistoryLiveProjection([], event);
    assert.ok(historyLivePresentationIdentities(replay[0]).some(id => committed.durableIdentities.has(id)),
      'the existing History late-event guard can reject a replay after adoption');
  });

  test(kind + ': replays and refreshes never grow duplicate keys', () => {
    const event = failureEvent('error-1', kind);
    let live = reduceHistoryLiveProjection([], event);
    const durable = [{ ...live[0] }];
    for (let index = 0; index < 30; index++) {
      live = reduceHistoryLiveProjection(live, event);
      const rows = buildHistoryLivePresentation(durable, live);
      assert.equal(rows.length, 1);
      assert.equal(new Set(rows.map(historyLivePresentationKey)).size, rows.length);
      live = reconcileCommittedHistoryLiveProjection(live, durable).entries;
      assert.equal(live.length, 0);
    }
  });

  test(kind + ': identity never collapses a real retry, foreign session or quoted answer', () => {
    const live = reduceHistoryLiveProjection([], failureEvent('error-1', kind));
    for (const durable of [
      reduceHistoryLiveProjection([], failureEvent('error-2', kind)),
      reduceHistoryLiveProjection([], failureEvent('error-1', kind, 'claude-b')),
      [{ ...live[0], role: 'assistant', providerFailure: undefined, serviceCarrier: undefined }],
    ]) {
      assert.equal(buildHistoryLivePresentation(durable, live).length, 2);
      assert.strictEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, live);
    }
    const quoted = failureEvent('quote', kind);
    quoted.message.isApiErrorMessage = false;
    assert.equal(reduceHistoryLiveProjection([], quoted)[0].role, 'assistant');
  });
}

test('Codex provider errors keep source identity and adopt the canonical row', () => {
  const event = failureEvent('codex-error');
  event.toolType = 'codex';
  event.message.type = 'provider-error';
  event.message.__projectionSource = 'codex-rollout-provider-error';
  event.message.sourceIdentity = 'codex-error-source-session-a-100';
  event.message.providerError = { provider: 'codex', kind: 'provider-error' };
  const live = reduceHistoryLiveProjection([], event);
  assert.equal(live[0].sourceIdentity, event.message.sourceIdentity);
  const durable = [{ ...live[0], uuid: 'canonical-alias' }];
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.equal(reconcileCommittedHistoryLiveProjection(live, durable).entries.length, 0);
});
