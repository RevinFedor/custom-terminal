import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectNativeRewindPreview,
  shouldCaptureDelayedCodexRewindPrefix,
  shouldClearRewindPreviewForOwnerTransition,
  type HistoryRewindPreviewOwner,
} from './historyRewindPreviewOwner.ts';

test('native Rewind moves the target prompt out of History and into draft ownership', () => {
  const source = [
    { uuid: 'before', role: 'assistant' },
    { uuid: 'target', role: 'user' },
    { uuid: 'old-future', role: 'assistant' },
    { uuid: 'local-status', role: 'rewind' },
  ];

  const projected = projectNativeRewindPreview(
    source,
    'target',
    (entry) => entry.uuid === 'local-status',
    (entry) => entry.role === 'user',
  );

  assert.deepEqual(projected.entries.map((entry) => entry.uuid), ['before', 'local-status']);
  assert.equal(projected.hiddenCount, 2, 'the restored target and old future are no longer sent History rows');
  assert.equal(projected.hiddenTurnCount, 1, 'the target is one user turn');
  assert.deepEqual(source.map((entry) => entry.uuid), ['before', 'target', 'old-future', 'local-status']);
});

test('native Rewind preview is a no-op when its exact target is absent', () => {
  const source = [{ uuid: 'before' }];
  const projected = projectNativeRewindPreview(source, 'missing', () => false);
  assert.strictEqual(projected.entries, source);
  assert.equal(projected.hiddenCount, 0);
  assert.equal(projected.hiddenTurnCount, 0);
});

test('rewind preview counts user turns instead of raw assistant records', () => {
  const assistantRecords = Array.from({ length: 300 }, (_, index) => ({
    uuid: 'assistant-' + index,
    role: 'assistant',
  }));
  const source = [
    { uuid: 'before', role: 'assistant' },
    { uuid: 'target', role: 'user' },
    ...assistantRecords,
  ];

  const projected = projectNativeRewindPreview(
    source,
    'target',
    () => false,
    (entry) => entry.role === 'user',
  );

  assert.equal(projected.hiddenCount, 301);
  assert.equal(projected.hiddenTurnCount, 1);
});

test('switching tabs preserves the independently owned rewind previews', () => {
  const transitions: Array<[HistoryRewindPreviewOwner, HistoryRewindPreviewOwner]> = [
    [
      { tabId: 'tab-c', sessionId: 'session-c' },
      { tabId: 'tab-a', sessionId: 'session-a' },
    ],
    [
      { tabId: 'tab-a', sessionId: 'session-a' },
      { tabId: 'tab-b', sessionId: 'session-b' },
    ],
    [
      { tabId: 'tab-b', sessionId: 'session-b' },
      { tabId: 'tab-c', sessionId: 'session-c' },
    ],
  ];

  assert.deepEqual(
    transitions.map(([previous, current]) =>
      shouldClearRewindPreviewForOwnerTransition(previous, current)),
    [false, false, false],
  );
});

test('replacing the session inside one tab invalidates only that tab preview', () => {
  assert.equal(
    shouldClearRewindPreviewForOwnerTransition(
      { tabId: 'tab-a', sessionId: 'session-old' },
      { tabId: 'tab-a', sessionId: 'session-new' },
    ),
    true,
  );
});

test('an unchanged owner does not clear its preview', () => {
  assert.equal(
    shouldClearRewindPreviewForOwnerTransition(
      { tabId: 'tab-a', sessionId: 'session-a' },
      { tabId: 'tab-a', sessionId: 'session-a' },
    ),
    false,
  );
});

test('a tab switch is not a session replacement even when one side has no session yet', () => {
  assert.equal(
    shouldClearRewindPreviewForOwnerTransition(
      { tabId: 'tab-starting', sessionId: null },
      { tabId: 'tab-ready', sessionId: 'session-ready' },
    ),
    false,
  );
});

test('delayed Codex writer proof authorizes the exact retained Rewind prefix', () => {
  const event = {
    tabId: 'tab-a',
    engine: 'codex',
    sessionId: 'child-a',
    previousSessionId: 'source-a',
    writerProven: true,
    writerProof: 'native-rewind-delayed-child',
    writerGeneration: 'rewind-generation-a',
  };
  const preview = {
    sessionId: 'source-a',
    writerGeneration: 'rewind-generation-a',
  };

  assert.equal(shouldCaptureDelayedCodexRewindPrefix({
    tabId: 'tab-a',
    currentSessionId: 'source-a',
    preview,
    event,
  }), true);
  assert.equal(shouldCaptureDelayedCodexRewindPrefix({
    tabId: 'tab-a',
    currentSessionId: 'child-a',
    preview,
    event,
  }), true, 'listener ordering may expose either side of the already-proven transition');
});

test('delayed Codex prefix handoff rejects stale, generic, and cross-tab writer events', () => {
  const base = {
    tabId: 'tab-a',
    currentSessionId: 'source-a',
    preview: {
      sessionId: 'source-a',
      writerGeneration: 'rewind-generation-a',
    },
    event: {
      tabId: 'tab-a',
      engine: 'codex',
      sessionId: 'child-a',
      previousSessionId: 'source-a',
      writerProven: true,
      writerProof: 'native-rewind-delayed-child',
      writerGeneration: 'rewind-generation-a',
    },
  };
  const cases = [
    { event: { ...base.event, tabId: 'tab-b' } },
    { event: { ...base.event, engine: 'claude' } },
    { event: { ...base.event, writerProven: false } },
    { event: { ...base.event, writerProof: 'process-open-rollout' } },
    { event: { ...base.event, previousSessionId: 'other-source' } },
    { event: { ...base.event, sessionId: 'source-a' } },
    { event: { ...base.event, writerGeneration: 'other-generation' } },
    { preview: { ...base.preview, writerGeneration: null } },
    { currentSessionId: 'unrelated-session' },
  ];

  for (const override of cases) {
    assert.equal(
      shouldCaptureDelayedCodexRewindPrefix({
        ...base,
        ...override,
      }),
      false,
    );
  }
});
