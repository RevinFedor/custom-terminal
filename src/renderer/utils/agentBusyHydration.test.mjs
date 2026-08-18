import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAgentBusyHydration } from './agentBusyHydration.mjs';

test('restores an in-flight Claude turn after renderer reload', () => {
  assert.deepEqual(collectAgentBusyHydration({
    tabs: [{ tabId: 'claude-tab' }],
    states: {
      'claude-tab': {
        resolvedToolType: 'claude',
        claudePresence: { status: 'busy', isBusy: true },
      },
    },
  }), [{
    tabId: 'claude-tab',
    engine: 'claude',
    busy: true,
    reason: 'renderer-restore:claude-turn',
  }]);
});

test('restores an idle Claude tab as idle', () => {
  assert.deepEqual(collectAgentBusyHydration({
    tabs: [{ tabId: 'claude-tab' }],
    states: {
      'claude-tab': {
        resolvedToolType: 'claude',
        claudePresence: { status: 'active', isBusy: false },
      },
    },
  }), [{
    tabId: 'claude-tab',
    engine: 'claude',
    busy: false,
    reason: 'renderer-restore:claude-idle',
  }]);
});

test('a busy/idle event observed after the request wins over its snapshot', () => {
  assert.deepEqual(collectAgentBusyHydration({
    tabs: [{ tabId: 'claude-tab' }],
    eventObserved: new Set(['claude-tab']),
    states: {
      'claude-tab': {
        resolvedToolType: 'claude',
        claudePresence: { status: 'busy', isBusy: true },
      },
    },
  }), []);
});

test('keeps Codex watcher and catch-up guards in the same restore batch', () => {
  const states = {
    busy: {
      resolvedToolType: 'codex',
      codexTurn: { hasWatcher: true, catchUpPending: false, busy: true },
    },
    catching: {
      resolvedToolType: 'codex',
      codexTurn: { hasWatcher: true, catchUpPending: true, busy: true },
    },
    idle: {
      resolvedToolType: 'codex',
      codexTurn: {
        hasWatcher: true,
        catchUpPending: false,
        busy: false,
        outcomeKnown: true,
        lastOutcomeReason: 'task_complete',
      },
    },
  };
  assert.deepEqual(collectAgentBusyHydration({
    tabs: Object.keys(states).map((tabId) => ({ tabId })),
    states,
  }), [
    { tabId: 'busy', engine: 'codex', busy: true, reason: 'task_started' },
    { tabId: 'idle', engine: 'codex', busy: false, reason: 'task_complete' },
  ]);
});

test('ambiguous owner never hydrates either provider', () => {
  assert.deepEqual(collectAgentBusyHydration({
    tabs: [{ tabId: 'ambiguous' }],
    states: {
      ambiguous: {
        resolvedToolType: null,
        claudePresence: { isBusy: true },
        codexTurn: { hasWatcher: true, busy: true },
      },
    },
  }), []);
});

