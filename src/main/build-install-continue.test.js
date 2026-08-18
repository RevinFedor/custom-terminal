'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createShutdownInterruptedSnapshot,
  resolveStartupInterruptedSnapshot,
} = require('./build-install-continue');

const project = (tabs) => ({ id: 'project-1', name: 'Project', tabs });
const tab = (patch = {}) => ({
  tabId: 'tab-1',
  name: 'agent',
  tabType: 'terminal',
  wasInterrupted: true,
  overlayDismissed: false,
  ...patch,
});

test('shutdown snapshot preserves exact provider/session identity', () => {
  const snapshot = createShutdownInterruptedSnapshot(new Map([
    ['tab-c', { engine: 'claude', sessionId: 'claude-session' }],
    ['tab-x', { engine: 'codex', sessionId: 'codex-session' }],
  ]), { capturedAt: 123, shutdownPid: 456, reason: 'will-quit' });

  assert.deepEqual(snapshot, {
    version: 1,
    capturedAt: 123,
    shutdownPid: 456,
    reason: 'will-quit',
    targets: [
      { tabId: 'tab-c', provider: 'claude', sessionId: 'claude-session' },
      { tabId: 'tab-x', provider: 'codex', sessionId: 'codex-session' },
    ],
    unresolved: [],
  });
});

test('ambiguous live owner remains an explicit unresolved shutdown target', () => {
  const snapshot = createShutdownInterruptedSnapshot(new Map([
    ['tab-both', { engine: null, sessionId: null, ambiguousOwners: ['claude', 'codex'] }],
  ]));
  assert.deepEqual(snapshot.targets, []);
  assert.deepEqual(snapshot.unresolved, [{ tabId: 'tab-both', reason: 'live-owner-ambiguous' }]);
});

test('exact shutdown snapshot resolves even when legacy row has both bindings', () => {
  const result = resolveStartupInterruptedSnapshot({
    persistedSnapshot: {
      version: 1,
      capturedAt: 100,
      shutdownPid: 9,
      targets: [{ tabId: 'tab-1', provider: 'codex', sessionId: 'codex-live' }],
    },
    projects: [project([tab({ claudeSessionId: 'claude-old', codexSessionId: 'codex-live' })])],
    resolvedAt: 200,
  });

  assert.equal(result.source, 'exact-shutdown-snapshot');
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].provider, 'codex');
  assert.equal(result.targets[0].sessionId, 'codex-live');
  assert.deepEqual(result.unresolved, []);
});

test('exact snapshot does not adopt a row whose session changed or interruption was cleared', () => {
  const persistedSnapshot = {
    version: 1,
    targets: [
      { tabId: 'changed', provider: 'claude', sessionId: 'old' },
      { tabId: 'cleared', provider: 'codex', sessionId: 'codex-1' },
    ],
  };
  const result = resolveStartupInterruptedSnapshot({
    persistedSnapshot,
    projects: [project([
      tab({ tabId: 'changed', claudeSessionId: 'new' }),
      tab({ tabId: 'cleared', codexSessionId: 'codex-1', wasInterrupted: false }),
    ])],
  });

  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.unresolved.map((item) => item.reason), ['session-changed', 'not-interrupted-now']);
});

test('legacy bootstrap accepts only one session binding and rejects ambiguity', () => {
  const result = resolveStartupInterruptedSnapshot({
    projects: [project([
      tab({ tabId: 'claude', claudeSessionId: 'claude-1', commandType: 'codex' }),
      tab({ tabId: 'codex', codexSessionId: 'codex-1', commandType: 'claude' }),
      tab({ tabId: 'both', claudeSessionId: 'claude-2', codexSessionId: 'codex-2', commandType: 'codex' }),
      tab({ tabId: 'label-only', commandType: 'claude' }),
    ])],
  });

  assert.deepEqual(result.targets.map((item) => [item.tabId, item.provider]), [
    ['claude', 'claude'],
    ['codex', 'codex'],
  ]);
  assert.deepEqual(result.unresolved.map((item) => item.tabId), ['both', 'label-only']);
});

test('dismissed and SDK tabs are never continuation targets', () => {
  const result = resolveStartupInterruptedSnapshot({
    projects: [project([
      tab({ tabId: 'dismissed', claudeSessionId: 'c1', overlayDismissed: true }),
      tab({ tabId: 'sdk', claudeSessionId: 'c2', tabType: 'claude-sdk' }),
    ])],
  });
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.unresolved, []);
});
