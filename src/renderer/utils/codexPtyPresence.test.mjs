import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_PRESENCE_SNAPSHOT_FIELDS,
  getCodexRuntimeReadSessionId,
  isCodexRuntimeForkReady,
  isCodexRuntimeWriterUsable,
  projectCodexPtyPresence,
  readCodexPtyPresence,
} from './codexPtyPresence.mjs';

const completeSnapshot = (overrides = {}) => ({
  success: true,
  projectId: 'project-1',
  sessionStatus: 'active',
  busy: false,
  inputReady: true,
  liveLifecycle: true,
  sessionId: 'writer-session',
  readSessionId: 'writer-session',
  readIdentitySource: 'live-writer',
  savedSessionId: 'saved-session',
  conversationMaterialized: true,
  timelineCount: 1,
  materializationReason: 'user-history-present',
  canCopySessionId: true,
  hasTerm: true,
  lastNotReady: null,
  startupFailed: false,
  startupError: null,
  manualActionRequired: false,
  manualActionType: null,
  hasWatcher: true,
  catchUpPending: false,
  outcomeKnown: false,
  lastOutcomeReason: null,
  ...overrides,
});

test('an incomplete legacy snapshot is rejected instead of mixing extra IPC generations', () => {
  const legacyRuntimeSnapshot = {
    success: true,
    sessionStatus: 'active',
    busy: false,
    inputReady: true,
    liveLifecycle: true,
    sessionId: 'writer-session',
    savedSessionId: 'saved-session',
    canCopySessionId: true,
  };

  assert.deepEqual(projectCodexPtyPresence(legacyRuntimeSnapshot), {
    complete: false,
    missingFields: [
      'projectId',
      'readSessionId',
      'readIdentitySource',
      'conversationMaterialized',
      'timelineCount',
      'materializationReason',
      'hasTerm',
      'lastNotReady',
      'startupFailed',
      'startupError',
      'manualActionRequired',
      'manualActionType',
      'hasWatcher',
      'catchUpPending',
      'outcomeKnown',
      'lastOutcomeReason',
    ],
    presence: null,
  });
});

test('a complete main snapshot projects lifecycle, readiness, and identity atomically', () => {
  const snapshot = completeSnapshot();
  const result = projectCodexPtyPresence(snapshot);

  assert.equal(result.complete, true);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.presence, {
    status: 'active',
    hasBridge: true,
    isBusy: false,
    hasTerm: true,
    inputReady: true,
    awaiting: false,
    lastNotReady: null,
    startupFailed: false,
    startupError: null,
    manualActionRequired: false,
    manualActionType: null,
    sessionId: 'writer-session',
    conversationMaterialized: true,
    canResume: false,
    canCopySessionId: true,
    timelineCount: 1,
    materializationReason: 'user-history-present',
    runtimeSnapshot: snapshot,
  });
});

test('manual action and startup failure preserve the existing presence precedence', () => {
  const manual = projectCodexPtyPresence(completeSnapshot({
    sessionStatus: 'starting',
    inputReady: false,
    sessionId: 'resume-source',
    manualActionRequired: true,
    manualActionType: 'resume-confirmation',
  }));
  assert.equal(manual.presence.status, 'inactive');
  assert.equal(manual.presence.canResume, true);
  assert.equal(manual.presence.manualActionType, 'resume-confirmation');

  const failed = projectCodexPtyPresence(completeSnapshot({
    sessionStatus: 'unknown',
    inputReady: false,
    startupFailed: true,
    startupError: 'startup-timeout:no-ready-signal',
  }));
  assert.equal(failed.presence.status, 'starting');
  assert.equal(failed.presence.startupFailed, true);
  assert.equal(failed.presence.startupError, 'startup-timeout:no-ready-signal');
});

test('an unresolved watcher keeps the renderer event state without another IPC read', () => {
  const pending = projectCodexPtyPresence(completeSnapshot({
    sessionStatus: 'active',
    busy: false,
    hasWatcher: true,
    catchUpPending: true,
  }), { fallbackBusy: true });
  assert.equal(pending.presence.status, 'active');
  assert.equal(pending.presence.isBusy, true);

  const resolved = projectCodexPtyPresence(completeSnapshot({
    sessionStatus: 'active',
    busy: false,
    hasWatcher: true,
    catchUpPending: false,
  }), { fallbackBusy: true });
  assert.equal(resolved.presence.isBusy, false);
});

test('unknown status stays fail-closed and stopping always disables input', () => {
  const unknown = projectCodexPtyPresence(completeSnapshot({ sessionStatus: 'not-a-status' }));
  assert.equal(unknown.presence.status, 'unknown');

  const stopping = projectCodexPtyPresence(completeSnapshot({
    sessionStatus: 'stopping',
    busy: true,
    inputReady: true,
    manualActionRequired: true,
    startupFailed: true,
  }));
  assert.equal(stopping.presence.status, 'stopping');
  assert.equal(stopping.presence.isBusy, true);
  assert.equal(stopping.presence.inputReady, false);
});

test('null snapshot reports the complete contract required for a one-call projection', () => {
  const result = projectCodexPtyPresence(null);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingFields, [...CODEX_PRESENCE_SNAPSHOT_FIELDS]);
  assert.equal(result.presence, null);
});

test('an explicitly failed main snapshot never produces a renderer presence', () => {
  const result = projectCodexPtyPresence(completeSnapshot({ success: false }));
  assert.deepEqual(result, {
    complete: false,
    missingFields: [],
    presence: null,
  });
});

test('presence reader performs exactly one IPC call and returns that snapshot projection', async () => {
  const snapshot = completeSnapshot({
    sessionStatus: 'busy',
    busy: true,
    inputReady: false,
  });
  const calls = [];
  const presence = await readCodexPtyPresence({
    tabId: 'tab-1',
    projectId: 'project-1',
    invoke: async (...args) => {
      calls.push(args);
      return snapshot;
    },
  });

  assert.deepEqual(calls, [[
    'codex:get-runtime-projection',
    { tabId: 'tab-1', projectId: 'project-1' },
  ]]);
  assert.equal(presence.status, 'busy');
  assert.equal(presence.isBusy, true);
  assert.equal(presence.runtimeSnapshot, snapshot);
});

test('presence reader fails closed instead of requesting missing fields separately', async () => {
  let calls = 0;
  await assert.rejects(
    readCodexPtyPresence({
      tabId: 'tab-1',
      invoke: async () => {
        calls += 1;
        return { success: true, sessionStatus: 'active' };
      },
    }),
    /Incomplete Codex runtime snapshot: projectId,busy,inputReady/,
  );
  assert.equal(calls, 1);
});

test('presence reader rejects a snapshot resolved for another project', async () => {
  await assert.rejects(
    readCodexPtyPresence({
      tabId: 'shared-tab-id',
      projectId: 'project-1',
      invoke: async () => completeSnapshot({ projectId: 'project-2' }),
    }),
    /project mismatch/,
  );
});

test('renderer accepts every main-proven mutation-safe writer kind, including a settled Rewind child', () => {
  const initialWriter = completeSnapshot({
    writerConfirmed: true,
    writerStatus: 'adopted',
    writerUsableForMutation: true,
    writerProof: 'process-open-rollout',
    provenWriterSessionId: 'source',
  });
  const settledRewindWriter = completeSnapshot({
    writerConfirmed: true,
    writerStatus: 'adopted',
    writerUsableForMutation: true,
    writerProof: 'native-rewind-settled-writer',
    provenWriterSessionId: 'child',
  });

  assert.equal(isCodexRuntimeWriterUsable(initialWriter), true);
  assert.equal(isCodexRuntimeWriterUsable(settledRewindWriter), true);
});

test('renderer cannot turn an incomplete or main-revoked writer into a mutation target', () => {
  const base = {
    writerConfirmed: true,
    writerStatus: 'adopted',
    writerUsableForMutation: true,
    writerProof: 'native-rewind-settled-writer',
    provenWriterSessionId: 'child',
    canCopySessionId: true,
  };

  assert.equal(isCodexRuntimeWriterUsable({ ...base, writerConfirmed: false }), false);
  assert.equal(isCodexRuntimeWriterUsable({ ...base, writerStatus: 'starting' }), false);
  assert.equal(isCodexRuntimeWriterUsable({ ...base, writerUsableForMutation: false }), false);
  assert.equal(isCodexRuntimeWriterUsable({ ...base, writerProof: null }), false);
  assert.equal(isCodexRuntimeWriterUsable({ ...base, provenWriterSessionId: null }), false);
  assert.equal(isCodexRuntimeWriterUsable({ ...base, canCopySessionId: false }, { requireCopy: true }), false);
});

test('renderer consumes the explicit main read identity without deriving a saved fallback', () => {
  assert.equal(getCodexRuntimeReadSessionId({
    canCopySessionId: true,
    readSessionId: 'resume-source',
    readIdentitySource: 'resume-source',
    liveLifecycle: true,
    sessionId: null,
    savedSessionId: 'resume-source',
    writerUsableForMutation: false,
  }), 'resume-source');
  assert.equal(getCodexRuntimeReadSessionId({
    canCopySessionId: false,
    readSessionId: 'resume-source',
    readIdentitySource: 'resume-source',
    liveLifecycle: true,
    savedSessionId: 'resume-source',
  }), null);
  assert.equal(getCodexRuntimeReadSessionId({
    canCopySessionId: true,
    readSessionId: null,
    readIdentitySource: 'live-writer',
    liveLifecycle: true,
    sessionId: 'stale-writer',
    savedSessionId: 'stale-history',
  }), null);
  assert.equal(getCodexRuntimeReadSessionId({
    canCopySessionId: true,
    readSessionId: 'resume-source',
    readIdentitySource: 'stopped-history',
    liveLifecycle: true,
  }), null);
  assert.equal(getCodexRuntimeReadSessionId({
    canCopySessionId: true,
    readSessionId: 'stopped-session',
    readIdentitySource: 'stopped-history',
    liveLifecycle: false,
  }), 'stopped-session');
});

test('fork readiness ignores inactive presentation labels without a safe writer', () => {
  assert.equal(isCodexRuntimeForkReady({
    liveLifecycle: true,
    manualActionRequired: true,
    sessionStatus: 'inactive',
    writerConfirmed: false,
    writerUsableForMutation: false,
    conversationMaterialized: true,
  }), false);
  assert.equal(isCodexRuntimeForkReady({
    liveLifecycle: false,
    writerConfirmed: false,
    writerUsableForMutation: false,
    conversationMaterialized: true,
  }), true);
  assert.equal(isCodexRuntimeForkReady({
    liveLifecycle: true,
    writerConfirmed: true,
    writerStatus: 'adopted',
    writerUsableForMutation: true,
    writerProof: 'process-open-rollout',
    provenWriterSessionId: 'writer-session',
    conversationMaterialized: true,
  }), true);
  assert.equal(isCodexRuntimeForkReady({
    liveLifecycle: false,
    conversationMaterialized: false,
  }), false);
});
