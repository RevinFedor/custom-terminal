const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEX_NO_FINAL_RESULT_REASON,
  classifyCodexTurnRecord,
  classifyCodexTurnEvent,
  observeCodexTurnRecord,
  projectCodexSuppressedCatchUpPublication,
  reduceCodexTurnOutcomeSummary,
  trackerHasFinalResultForEvent,
} = require('./codex-turn-outcome');

test('task_complete is a natural completion only with a non-empty final result', () => {
  assert.deepEqual(
    classifyCodexTurnEvent('task_complete', { last_agent_message: 'Finished.' }),
    {
      event: 'task_complete',
      busy: false,
      reason: 'task_complete',
      hasFinalResult: true,
    },
  );
});

test('task_complete without a final result is idle with an unknown outcome', () => {
  for (const payload of [
    { last_agent_message: null },
    { last_agent_message: '' },
    { last_agent_message: '   \n' },
    {},
    undefined,
  ]) {
    assert.deepEqual(
      classifyCodexTurnEvent('task_complete', payload),
      {
        event: 'task_complete',
        busy: false,
        reason: CODEX_NO_FINAL_RESULT_REASON,
        hasFinalResult: false,
      },
    );
  }
});

test('same-turn root assistant final_answer proves success when task_complete omits last_agent_message', () => {
  const tracker = {};
  observeCodexTurnRecord(tracker, {
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-ok' },
  });
  observeCodexTurnRecord(tracker, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Completed.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-ok' },
    },
  });
  const payload = { turn_id: 'turn-ok', last_agent_message: null };
  assert.equal(trackerHasFinalResultForEvent(tracker, payload), true);
  assert.equal(classifyCodexTurnEvent('task_complete', payload, {
    hasTrackedFinalResult: trackerHasFinalResultForEvent(tracker, payload),
  }).reason, 'task_complete');
});

test('metadata turn id scopes a root final_answer to the completed turn', () => {
  const tracker = {};
  observeCodexTurnRecord(tracker, {
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-metadata' },
  });
  observeCodexTurnRecord(tracker, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Completed through metadata.' }],
      metadata: { turn_id: 'turn-metadata' },
    },
  });
  assert.equal(
    trackerHasFinalResultForEvent(tracker, { turn_id: 'turn-metadata' }),
    true,
  );
});

test('commentary and another turn final_answer cannot prove current turn success', () => {
  const tracker = {};
  observeCodexTurnRecord(tracker, {
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-current' },
  });
  observeCodexTurnRecord(tracker, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Still working.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-current' },
    },
  });
  observeCodexTurnRecord(tracker, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Old answer.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-other' },
    },
  });
  observeCodexTurnRecord(tracker, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Unscoped answer.' }],
    },
  });
  const payload = { turn_id: 'turn-current', last_agent_message: null };
  assert.equal(trackerHasFinalResultForEvent(tracker, payload), false);
  assert.equal(classifyCodexTurnEvent('task_complete', payload, {
    hasTrackedFinalResult: trackerHasFinalResultForEvent(tracker, payload),
  }).reason, CODEX_NO_FINAL_RESULT_REASON);
});

test('turn_aborted remains an interrupted idle outcome', () => {
  assert.deepEqual(
    classifyCodexTurnEvent('turn_aborted', { last_agent_message: 'ignored' }),
    {
      event: 'turn_aborted',
      busy: false,
      reason: 'turn_aborted',
      hasFinalResult: false,
    },
  );
});

test('task_started remains busy and unrelated legacy events are not classified', () => {
  assert.deepEqual(classifyCodexTurnEvent('task_started'), {
    event: 'task_started',
    busy: true,
    reason: 'task_started',
    hasFinalResult: null,
  });
  assert.equal(classifyCodexTurnEvent(undefined), null);
  assert.equal(classifyCodexTurnEvent('token_count', {}), null);
});

test('sequential catch-up summary preserves failure even when a later turn succeeds', () => {
  const tracker = {};
  const summary = { latest: null, lastAbnormal: null };
  const records = [
    { type: 'event_msg', timestamp: '2026-07-15T19:00:00.000Z', payload: { type: 'task_started', turn_id: 'failed-turn' } },
    { type: 'event_msg', timestamp: '2026-07-15T19:00:01.000Z', payload: { type: 'task_complete', turn_id: 'failed-turn', last_agent_message: '' } },
    { type: 'event_msg', timestamp: '2026-07-15T19:00:02.000Z', payload: { type: 'task_started', turn_id: 'successful-turn' } },
    { type: 'event_msg', timestamp: '2026-07-15T19:00:03.000Z', payload: { type: 'task_complete', turn_id: 'successful-turn', last_agent_message: 'Done.' } },
  ];
  for (const record of records) {
    reduceCodexTurnOutcomeSummary(summary, classifyCodexTurnRecord(tracker, record));
  }
  assert.equal(summary.lastAbnormal.reason, CODEX_NO_FINAL_RESULT_REASON);
  assert.equal(summary.lastAbnormal.turnId, 'failed-turn');
  assert.equal(summary.latest.reason, 'task_complete');
  assert.equal(summary.latest.turnId, 'successful-turn');
});

test('linked catch-up publishes one final lifecycle outcome instead of every historical transition', () => {
  assert.equal(projectCodexSuppressedCatchUpPublication({
    catchUpPublicationsSuppressed: false,
    liveTurnEvents: 8,
    busy: false,
  }), null);
  assert.equal(projectCodexSuppressedCatchUpPublication({
    catchUpPublicationsSuppressed: true,
    liveTurnEvents: 0,
    busy: false,
  }), null);

  assert.deepEqual(projectCodexSuppressedCatchUpPublication({
    catchUpPublicationsSuppressed: true,
    liveTurnEvents: 8,
    busy: false,
    lastEventType: 'task_complete',
    lastEventTs: '2026-07-23T23:59:50.000Z',
    lastOutcomeReason: 'task_complete',
    lastOutcomeHasFinalResult: true,
    lastOutcomeTurnId: 'turn-final',
  }), {
    busy: false,
    reason: 'task_complete',
    outcome: {
      event: 'task_complete',
      busy: false,
      reason: 'task_complete',
      hasFinalResult: true,
    },
    timestamp: '2026-07-23T23:59:50.000Z',
    turnId: 'turn-final',
  });
});
