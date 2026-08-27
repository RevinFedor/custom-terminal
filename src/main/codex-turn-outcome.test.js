const test = require('node:test');
const assert = require('node:assert/strict');

const {
  armCodexSuppressedCatchUpRelease,
  CODEX_NO_FINAL_RESULT_REASON,
  classifyCodexTurnRecord,
  classifyCodexTurnEvent,
  completeCodexSuppressedCatchUpRelease,
  configureCodexCatchUpSuppression,
  deferCodexSourceProofRelease,
  isCodexInputReadyTurnEndEvent,
  observeCodexTurnRecord,
  prepareCodexSourceProofReplay,
  projectCodexSuppressedCatchUpPublication,
  reduceCodexTurnOutcomeSummary,
  takeCodexSourceProofReleaseAtScanBoundary,
  trackerHasFinalResultForEvent,
} = require('./codex-turn-outcome');
const {
  classifyCodexWriterAdoption,
  isCodexResumeSourceAuditPending,
} = require('./codex-writer-ownership');
const {
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');

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

test('only terminal turn outcomes establish post-turn input readiness', () => {
  assert.equal(isCodexInputReadyTurnEndEvent('task_complete'), true);
  assert.equal(isCodexInputReadyTurnEndEvent('turn_aborted'), true);
  assert.equal(isCodexInputReadyTurnEndEvent('task_started'), false);
  assert.equal(isCodexInputReadyTurnEndEvent('thread_rolled_back'), false);
  assert.equal(isCodexInputReadyTurnEndEvent(null), false);
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

test('provisional resume source publishes append-in-place lifecycle exactly once after writer proof', () => {
  const state = {
    offset: 120,
    catchUpPending: false,
    liveTurnEvents: 0,
    busy: false,
  };
  configureCodexCatchUpSuppression(state, {
    suppressBusy: true,
    suppressPublic: true,
  });
  assert.equal(state.publicTurnStateSuppressed, true);
  assert.equal(state.catchUpPublicationsSuppressed, true);

  assert.equal(armCodexSuppressedCatchUpRelease(state, {
    targetOffset: 240,
    kind: 'source-proof-replay',
  }), true);
  state.offset = 240;
  state.liveTurnEvents = 1;
  state.busy = true;
  state.lastEventType = 'task_started';
  state.lastEventTs = '2026-07-24T09:51:32.520Z';
  state.lastOutcomeReason = 'task_started';
  state.lastOutcomeTurnId = 'turn-live';

  const released = completeCodexSuppressedCatchUpRelease(state);
  assert.deepEqual(released, {
    released: true,
    publication: {
      busy: true,
      reason: 'task_started',
      outcome: {
        event: 'task_started',
        busy: true,
        reason: 'task_started',
        hasFinalResult: null,
      },
      timestamp: '2026-07-24T09:51:32.520Z',
      turnId: 'turn-live',
    },
    kind: 'source-proof-replay',
    targetOffset: 240,
  });
  assert.equal(state.publicTurnStateSuppressed, false);
  assert.equal(state.catchUpPublicationsSuppressed, false);
  assert.equal(state.catchUpPending, false);
  assert.deepEqual(completeCodexSuppressedCatchUpRelease(state), {
    released: false,
    publication: null,
  });

  const completed = classifyCodexTurnEvent('task_complete', {
    turn_id: 'turn-live',
    last_agent_message: 'Done.',
  });
  assert.deepEqual(completed, {
    event: 'task_complete',
    busy: false,
    reason: 'task_complete',
    hasFinalResult: true,
  });
  assert.deepEqual([
    released.publication.busy,
    completed.busy,
  ], [true, false]);
});

test('matched image carrier releases the already observed Resume task_started exactly once', () => {
  const imagePath = '/tmp/noted-terminal-codex-image-input/f2daf846013d0ea3bb2f6ec9ec4f5e6afc624f76403a62c8aeb0f2d82e30ac35.png';
  const audit = {
    expectedText: `before ${imagePath} after`,
    expectedLen: 13 + imagePath.length,
    expectedHash: 'expected-provider-transform',
    expectedImagePaths: [imagePath],
  };
  const actualText = `<image name=[Image #1] path="${imagePath}"> [Image] </image>`
    + 'before [Image #1] after';
  const matched = selectCodexPendingPromptAudit([audit], {
    actualText,
    actualHash: 'materialized-provider-transform',
  });
  assert.equal(matched?.audit, audit);
  assert.equal(matched?.canonicalMatch?.reason, 'codex_image_placeholder_canonical');

  const discovery = {
    sourceMode: 'resume',
    sourceSessionId: 'source-session',
    launchId: 'launch-1',
    provisionalSubmitReservation: {
      sourceSessionId: 'source-session',
      launchId: 'launch-1',
      requiresUserMessageAudit: true,
      auditMatched: false,
    },
  };
  assert.equal(isCodexResumeSourceAuditPending({
    sourceMode: 'resume',
    sourceSessionId: 'source-session',
    launchId: 'launch-1',
    discovery,
  }), true);

  // task_started has already been read from the held source rollout, but must
  // not reach the UI until the exact post-Enter user carrier above is proven.
  const held = {
    offset: 240,
    liveTurnEvents: 1,
    busy: true,
    lastEventType: 'task_started',
    lastEventTs: '2026-08-17T16:40:33.281Z',
    lastOutcomeReason: 'task_started',
    lastOutcomeTurnId: 'turn-production',
  };
  configureCodexCatchUpSuppression(held, {
    suppressBusy: true,
    suppressPublic: true,
  });
  discovery.provisionalSubmitReservation.auditMatched = true;
  const stillPending = isCodexResumeSourceAuditPending({
    sourceMode: 'resume',
    sourceSessionId: 'source-session',
    launchId: 'launch-1',
    discovery,
  });
  assert.equal(stillPending, false);
  assert.deepEqual(classifyCodexWriterAdoption({
    sourceMode: 'resume',
    sourceMatch: 'source-in-place',
    linkedBoundaryFound: true,
    resumeSubmitAuditPending: stillPending,
  }), {
    status: 'commit',
    sourceSettled: true,
  });

  assert.equal(armCodexSuppressedCatchUpRelease(held, {
    targetOffset: 240,
    kind: 'source-proof-replay',
  }), true);
  const released = completeCodexSuppressedCatchUpRelease(held);
  assert.equal(released.released, true);
  assert.deepEqual(released.publication, {
    busy: true,
    reason: 'task_started',
    outcome: {
      event: 'task_started',
      busy: true,
      reason: 'task_started',
      hasFinalResult: null,
    },
    timestamp: '2026-08-17T16:40:33.281Z',
    turnId: 'turn-production',
  });
  assert.deepEqual(completeCodexSuppressedCatchUpRelease(held), {
    released: false,
    publication: null,
  }, 'the held task start cannot be published twice');
});

test('suppressed replay stays provisional until the exact held byte range is read successfully', () => {
  const state = {
    offset: 120,
    catchUpPending: false,
    liveTurnEvents: 1,
    busy: true,
    lastEventType: 'task_started',
  };
  armCodexSuppressedCatchUpRelease(state, {
    targetOffset: 240,
    kind: 'source-proof-replay',
  });

  assert.deepEqual(completeCodexSuppressedCatchUpRelease(state), {
    released: false,
    publication: null,
  });
  state.offset = 240;
  assert.deepEqual(completeCodexSuppressedCatchUpRelease(state, {
    scanSucceeded: false,
  }), {
    released: false,
    publication: null,
  });
  assert.equal(state.publicTurnStateSuppressed, true);
  assert.equal(state.catchUpPublicationsSuppressed, true);
});

test('suppressed replay with start and completion publishes only the final idle outcome', () => {
  const state = {
    offset: 300,
    catchUpPending: true,
    liveTurnEvents: 2,
    busy: false,
    lastEventType: 'task_complete',
    lastEventTs: '2026-07-24T09:53:06.774Z',
    lastOutcomeReason: 'task_complete',
    lastOutcomeHasFinalResult: true,
    lastOutcomeTurnId: 'turn-finished',
  };
  armCodexSuppressedCatchUpRelease(state, {
    targetOffset: 300,
    kind: 'source-proof-replay',
  });

  const released = completeCodexSuppressedCatchUpRelease(state);
  assert.equal(released.released, true);
  assert.equal(released.publication.busy, false);
  assert.equal(released.publication.reason, 'task_complete');
});

test('writer proof waits for an in-flight source scan before rewinding the held range', () => {
  const state = {
    scanning: true,
    offset: 200,
    partial: '',
    sourceObservationLaunchId: 'launch-live',
    sourceWriterProofPending: true,
    sourceWriterReplayOffset: 100,
    sourceWriterReplayPartial: 'held-partial',
    sourceAuditPartial: 'audit-only-partial',
    sourceAuditPartialStartOffset: 275,
    catchUpGeneration: 4,
  };

  const deferred = deferCodexSourceProofRelease(state, {
    sessionId: 'session-source',
    reason: 'process-open-rollout',
    launchId: 'launch-live',
  });
  assert.equal(deferred.deferred, true);
  assert.equal(state.sourceObservationLaunchId, 'launch-live');
  assert.equal(state.offset, 200);

  // A later source chunk finishes while ownership is still provisional. It is
  // held with the first chunk instead of being parsed as a public live delta.
  state.offset = 300;
  state.scanning = false;
  const request = takeCodexSourceProofReleaseAtScanBoundary(state);
  assert.deepEqual(request, {
    sessionId: 'session-source',
    reason: 'process-open-rollout',
    launchId: 'launch-live',
  });

  const replay = prepareCodexSourceProofReplay(state);
  assert.deepEqual(replay, {
    prepared: true,
    launchId: 'launch-live',
    replayOffset: 100,
    targetOffset: 300,
  });
  assert.equal(state.sourceObservationLaunchId, null);
  assert.equal(state.offset, 100);
  assert.equal(state.partial, 'held-partial');
  assert.equal(state.sourceAuditPartial, '');
  assert.equal(state.sourceAuditPartialStartOffset, 300);
  assert.equal(state.releasePublicSuppressionTargetOffset, 300);
  assert.equal(state.publicTurnStateSuppressed, true);
  assert.equal(state.catchUpPublicationsSuppressed, true);

  state.offset = 299;
  assert.equal(completeCodexSuppressedCatchUpRelease(state).released, false);
  state.offset = 300;
  assert.equal(completeCodexSuppressedCatchUpRelease(state).released, true);
});
